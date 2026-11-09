"""AlertHub API entry point. See ../docs/PROJECT_GUIDE.md for the feature map."""

import json
import os
from datetime import datetime, timedelta, timezone
from threading import Lock
from uuid import uuid4

import jwt
import mysql.connector
from flask import Flask, g, jsonify, request, send_file
from flask_cors import CORS
from flask_socketio import SocketIO, join_room
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

# Load shared database helpers that bind user values as SQL parameters.
from alerthub.database import db, init_db, query
from alerthub.security import create_authenticator

# Create the Flask app and apply request-size, signing-key, and allowed-origin settings.
app = Flask(__name__)
# Reject request bodies larger than the supported incident attachment size.
app.config['MAX_CONTENT_LENGTH'] = 9 * 1024 * 1024
# Sign JWTs with the deployment secret configured in Backend/.env.
app.config['SECRET_KEY'] = os.getenv('JWT_SECRET', 'change-this-development-secret')
# Limit browser API access to the configured frontend origin or origins.
CORS(app, origins=os.getenv('FRONTEND_ORIGIN', 'http://localhost:5173').split(','))
# Configure Socket.IO to accept live connections from the same trusted frontend origins.
socketio = SocketIO(
    app,
    cors_allowed_origins=os.getenv(
        'FRONTEND_ORIGIN',
        'http://localhost:5173',
    ).split(','),
    async_mode='threading',
)
socket_users = {}
socket_users_lock = Lock()
# Apply one shared JWT, blocked-account, and role check to protected routes.
auth = create_authenticator(query, app.config["SECRET_KEY"])




# Normalize database timestamps before returning incidents through JSON or sockets.
def incident_dict(row):
    """Convert every incident datetime to JSON-safe ISO text for API and socket events."""
    for key, value in row.items():
        if isinstance(value, datetime):
            row[key] = value.isoformat()
    return row


# Load incident ownership and assignee fields for access checks and live updates.
def get_incident(incident_id):
    """Return an incident with its reporter and assigned staff names."""
    return query(
        """
        SELECT i.*, u.name AS reporter_name, s.name AS assignee_name
        FROM incidents i
        JOIN users u ON u.id = i.reporter_id
        LEFT JOIN users s ON s.id = i.assigned_to
        WHERE i.id = %s
        """,
        (incident_id,),
        one=True,
    )


# Health and authentication endpoints start the normal HTTP API surface.
@app.get('/api/health')
def health():
    """Check whether the API can reach its configured MySQL database."""
    try:
        query('SELECT 1', one=True)
        return jsonify(status='ok', database='connected')
    except mysql.connector.Error as exc:
        return jsonify(status='degraded', database='unavailable', error=str(exc)), 503


# Public registration permits only user and staff roles and stores a password hash.
@app.post('/api/auth/register')
def register():
    """Create a user or staff account while keeping public admin signup disabled."""
    body = request.get_json(silent=True) or {}
    name_value = body.get('name', '')
    email_value = body.get('email', '')
    password = body.get('password', '')
    role = body.get('role', 'user')

    if not all(isinstance(value, str) for value in (name_value, email_value, password)):
        return jsonify(error='Name, email, and password must be text'), 400
    if role not in ('user', 'staff'):
        return jsonify(error='Choose a valid account type'), 400

    name, email = name_value.strip(), email_value.strip().lower()
    if not name or len(name) > 120 or '@' not in email or len(email) > 190 or len(password) < 8:
        return jsonify(
            error='Name, email and a password of at least 8 characters are required'
        ), 400

    try:
        user_id = query(
            'INSERT INTO users(name,email,password_hash,role) VALUES(%s,%s,%s,%s)',
            (name, email, generate_password_hash(password), role),
            commit=True,
        )
        return token_response(user_id)
    except mysql.connector.IntegrityError:
        return jsonify(error='An account with this email already exists'), 409


# Verify credentials and blocked status before issuing a signed session token.
@app.post('/api/auth/login')
def login():
    """Verify account credentials and return a signed session token."""
    body = request.get_json(silent=True) or {}
    email = (body.get('email') or '').strip().lower()
    password = body.get('password', '')
    user = query(
        'SELECT * FROM users WHERE email=%s',
        (email,),
        one=True,
    )
    if not user or not check_password_hash(user['password_hash'], password):
        return jsonify(error='Email or password is incorrect'), 401
    if user['blocked']:
        return jsonify(error='This account has been blocked. Contact your AlertHub administrator for access.'), 403
    return token_response(user['id'])


# Sign a short-lived JWT after registration or successful login.
def token_response(user_id):
    """Build the shared login/register response with a twelve-hour JWT."""
    user = query(
        'SELECT id,name,email,role FROM users WHERE id=%s',
        (user_id,),
        one=True,
    )
    expires_at = datetime.now(timezone.utc) + timedelta(hours=12)
    token = jwt.encode(
        {'sub': str(user['id']), 'exp': expires_at},
        app.config['SECRET_KEY'],
        algorithm='HS256',
    )
    return jsonify(token=token, user=user), 200


# Resolve the VAPID private key from a configured path without exposing its contents.
def vapid_private_key_path():
    """Resolve the local VAPID PEM path independently of the backend launch directory."""
    configured_path = os.getenv('VAPID_PRIVATE_KEY', '').strip()
    if not configured_path:
        return ''
    if os.path.isabs(configured_path):
        return configured_path
    return os.path.join(os.path.dirname(__file__), configured_path)


def push_setup_message():
    """Explain why browser push cannot send messages yet, without exposing key material."""
    if not os.getenv('VAPID_PUBLIC_KEY') or not os.path.isfile(vapid_private_key_path()):
        return 'Configure the VAPID keys in Backend/.env to enable browser push.'
    try:
        from pywebpush import webpush  # noqa: F401
    except ImportError:
        return 'Install backend dependencies with: pip install -r requirements.txt.'
    return ''


# Deliver push messages only to subscriptions owned by the selected member IDs.
def send_push(user_ids, title, body, url='/'):
    """Send optional browser push messages to subscribed workspace members."""
    public_key = os.getenv('VAPID_PUBLIC_KEY')
    private_key = vapid_private_key_path()
    subject = os.getenv('VAPID_SUBJECT', 'mailto:admin@example.com')
    if push_setup_message():
        return

    # Build only the placeholder count dynamically; subscription IDs remain bound values.
    if user_ids:
        placeholders = ','.join(['%s'] * len(user_ids))
        subscriptions = query(
            'SELECT user_id,subscription_json FROM push_subscriptions '
            f'WHERE user_id IN ({placeholders})',
            tuple(user_ids),
        )
    else:
        subscriptions = []

    from pywebpush import WebPushException, webpush

    for row in subscriptions:
        subscription = json.loads(row['subscription_json'])
        message = json.dumps({'title': title, 'body': body, 'url': url})
        try:
            webpush(
                subscription_info=subscription,
                data=message,
                vapid_private_key=private_key,
                vapid_claims={'sub': subject},
            )
        except WebPushException as exc:
            response = getattr(exc, 'response', None)
            if response and response.status_code in (404, 410):
                query(
                    'DELETE FROM push_subscriptions WHERE user_id=%s AND endpoint=%s',
                    (row['user_id'], subscription['endpoint']),
                    commit=True,
                )
            else:
                app.logger.warning('Push delivery failed: %s', exc)


# Browser push endpoints expose the public key and save member subscriptions.
@app.get('/api/push/public-key')
def push_public_key():
    """Expose the public VAPID key used by the browser Push API."""
    key = os.getenv('VAPID_PUBLIC_KEY')
    if not key or push_setup_message():
        return jsonify(error='Browser push is not configured'), 503
    return jsonify(publicKey=key), 200


# Keep subscription status private to the authenticated account.
@app.get('/api/push/status')
@auth()
def push_status():
    """Check whether the signed-in member has a saved browser push endpoint."""
    subscription = query(
        'SELECT id FROM push_subscriptions WHERE user_id=%s LIMIT 1',
        (g.user['id'],),
        one=True,
    )
    setup_message = push_setup_message()
    return jsonify(
        enabled=bool(subscription),
        configured=not setup_message,
        setup_message=setup_message,
    ), 200


# Associate browser subscriptions only with the authenticated account.
@app.post('/api/push/subscribe')
@auth()
def push_subscribe():
    """Store the signed-in user's browser push subscription."""
    if push_setup_message():
        return jsonify(error='Browser push is not configured'), 503
    body = request.get_json(silent=True) or {}
    subscription = body.get('subscription') or {}
    endpoint = subscription.get('endpoint')
    if not endpoint or not subscription.get('keys'):
        return jsonify(error='Invalid browser subscription'), 400

    query(
        'INSERT INTO push_subscriptions(user_id,endpoint,subscription_json) '
        'VALUES(%s,%s,%s) ON DUPLICATE KEY UPDATE '
        'user_id=VALUES(user_id),subscription_json=VALUES(subscription_json)',
        (g.user['id'], endpoint, json.dumps(subscription)),
        commit=True,
    )
    return jsonify(ok=True)


# Prevent members from deleting another account's push subscription.
@app.delete('/api/push/subscribe')
@auth()
def push_unsubscribe():
    """Remove only the signed-in member's browser push subscription."""
    body = request.get_json(silent=True) or {}
    endpoint = body.get('endpoint')
    if not isinstance(endpoint, str) or not endpoint:
        return jsonify(error='A browser subscription endpoint is required'), 400

    query(
        'DELETE FROM push_subscriptions WHERE user_id=%s AND endpoint=%s',
        (g.user['id'], endpoint),
        commit=True,
    )
    return jsonify(ok=True), 200


# Return account details only after the shared JWT check succeeds.
@app.get('/api/auth/me')
@auth()
def current_user():
    """Return the current user's trusted account details."""
    return jsonify(g.user)


# Require the current password before allowing sensitive profile or password changes.
@app.patch('/api/auth/me')
@auth()
def update_current_user():
    """Update any signed-in member's profile or password after password verification."""
    body = request.get_json(silent=True) or {}
    name = body.get('name')
    email = body.get('email')
    current_password = body.get('current_password')
    new_password = body.get('new_password', '')
    new_password_confirmation = body.get('new_password_confirmation', '')

    if not all(isinstance(value, str) for value in (
        name,
        email,
        current_password,
        new_password,
        new_password_confirmation,
    )):
        return jsonify(error='Profile details must be text'), 400
    name = name.strip()
    email = email.strip().lower()
    if not name or len(name) > 120:
        return jsonify(error='Name must contain 1 to 120 characters'), 400
    if '@' not in email or len(email) > 190:
        return jsonify(error='Enter a valid email address'), 400
    if new_password and len(new_password) < 8:
        return jsonify(error='New password must be at least 8 characters'), 400
    # Reject a password change if the new password was entered inconsistently.
    if new_password and new_password != new_password_confirmation:
        return jsonify(error='The new passwords do not match'), 400

    account = query(
        'SELECT id,password_hash FROM users WHERE id=%s',
        (g.user['id'],),
        one=True,
    )
    # Verify the current password before changing credentials or account details.
    if not account or not check_password_hash(account['password_hash'], current_password):
        return jsonify(error='Current password is incorrect'), 401

    fields = ['name=%s', 'email=%s']
    values = [name, email]
    if new_password:
        fields.append('password_hash=%s')
        values.append(generate_password_hash(new_password))

    try:
        query(
            f"UPDATE users SET {','.join(fields)} WHERE id=%s",
            tuple(values + [g.user['id']]),
            commit=True,
        )
    except mysql.connector.IntegrityError:
        return jsonify(error='That email address is already in use'), 409

    updated_user = query(
        'SELECT id,name,email,role FROM users WHERE id=%s',
        (g.user['id'],),
        one=True,
    )
    return jsonify(updated_user)


# Account administration and staff lookup support role-based assignment.
# Restrict workspace-wide member data to administrators.
@app.get('/api/admin/users')
@auth(roles=['admin'])
def admin_users():
    """List workspace accounts and show whether staff have live connections."""
    users = query(
        'SELECT id,name,email,role,blocked,created_at FROM users ORDER BY created_at DESC'
    )
    # Count unique reported or assigned incidents for each workspace member by status.
    incident_counts = query(
        'SELECT member_incidents.member_id, '
        "COUNT(CASE WHEN member_incidents.status='Pending' THEN 1 END) AS pending_count, "
        "COUNT(CASE WHEN member_incidents.status='In Progress' THEN 1 END) AS in_progress_count, "
        "COUNT(CASE WHEN member_incidents.status='Resolved' THEN 1 END) AS resolved_count, "
        "COUNT(CASE WHEN member_incidents.status='Closed' THEN 1 END) AS closed_count "
        'FROM ('
        'SELECT assigned_to AS member_id,id AS incident_id,status FROM incidents '
        'WHERE assigned_to IS NOT NULL'
        ') AS member_incidents GROUP BY member_incidents.member_id'
    )
    counts_by_member = {item['member_id']: item for item in incident_counts}
    with socket_users_lock:
        online_staff_ids = {
            item['id']
            for item in socket_users.values()
            if item['role'] == 'staff'
        }

    for user in users:
        if user['created_at']:
            user['created_at'] = user['created_at'].isoformat()
        user['online'] = user['id'] in online_staff_ids
        user.update(counts_by_member.get(user['id'], {}))
        for field in ('pending_count', 'in_progress_count', 'resolved_count', 'closed_count'):
            user.setdefault(field, 0)
    return jsonify(users)


# Allow only administrators to change another member's role or blocked state.
@app.patch('/api/admin/users/<int:user_id>')
@auth(roles=['admin'])
def manage_user(user_id):
    """Change a member's role or block access, then revoke old sessions."""
    body = request.get_json(silent=True) or {}
    fields = []
    args = []

    # Update columns come from this fixed allow-list; submitted values use placeholders.
    if 'role' in body:
        if body['role'] not in ('user', 'staff', 'admin'):
            return jsonify(error='Invalid role'), 400
        if user_id == g.user['id'] and body['role'] != 'admin':
            return jsonify(error='You cannot remove your own admin role'), 400
        fields.append('role=%s')
        args.append(body['role'])

    if 'blocked' in body:
        if not isinstance(body['blocked'], bool):
            return jsonify(error='blocked must be true or false'), 400
        if user_id == g.user['id'] and body['blocked']:
            return jsonify(error='You cannot block your own account'), 400
        fields.append('blocked=%s')
        args.append(body['blocked'])

    if not fields:
        return jsonify(error='No supported user fields provided'), 400

    # Column names are selected above from fixed options; all values stay parameterized.
    args.append(user_id)
    query(
        'UPDATE users SET ' + ','.join(fields) + ' WHERE id=%s',
        tuple(args),
        commit=True,
    )
    user = query(
        'SELECT id,name,email,role,blocked,created_at FROM users WHERE id=%s',
        (user_id,),
        one=True,
    )
    if not user:
        return jsonify(error='User not found'), 404
    if user['created_at']:
        user['created_at'] = user['created_at'].isoformat()
    if 'role' in body or 'blocked' in body:
        socketio.emit(
            'auth:revoked',
            {'reason': 'Your workspace access changed. Sign in again.'},
            to=f'user:{user_id}',
        )
    return jsonify(user)


# Return active staff accounts only so admins cannot assign work to other roles.
@app.get('/api/users/staff')
@auth()
def staff_list():
    """List active staff members who can receive incident assignments."""
    staff_members = query(
        "SELECT id,name,email FROM users "
        "WHERE role='staff' AND blocked=FALSE ORDER BY name"
    )
    return jsonify(staff_members)


# Incident routes enforce private visibility and manage report lifecycles.
# Apply role-specific ownership filters before returning incidents to the browser.
@app.get('/api/incidents')
@auth()
def incidents_list():
    """List incidents visible to this role and apply supported filters."""
    filters, args = [], []
    # Filter columns are fixed in code; all values from the URL stay bound parameters.
    if g.user['role'] == 'user':
        filters.append('i.reporter_id=%s')
        args.append(g.user['id'])
    if g.user['role'] == 'staff':
        if request.args.get('scope') == 'reported':
            filters.append('i.reporter_id=%s')
        else:
            filters.append('i.assigned_to=%s')
        args.append(g.user['id'])

    for column, key in (
        ('status', 'status'),
        ('category', 'category'),
        ('priority', 'priority'),
    ):
        if request.args.get(key):
            filters.append(f'i.{column}=%s')
            args.append(request.args[key])

    search_text = request.args.get('q')
    if search_text:
        filters.append(
            '(i.title LIKE %s OR i.description LIKE %s OR i.location LIKE %s)'
        )
        search_pattern = f'%{search_text}%'
        args.extend([search_pattern] * 3)

    where = (' WHERE ' + ' AND '.join(filters)) if filters else ''
    sql = (
        'SELECT i.*, u.name AS reporter_name, s.name AS assignee_name '
        'FROM incidents i '
        'JOIN users u ON u.id = i.reporter_id '
        'LEFT JOIN users s ON s.id = i.assigned_to'
        f'{where} '
        "ORDER BY FIELD(i.priority, 'Critical', 'High', 'Medium', 'Low'), "
        'i.created_at DESC'
    )
    rows = query(sql, tuple(args))
    return jsonify([incident_dict(row) for row in rows])


# Accept reports from users and staff while validating fields and limiting spam.
@app.post('/api/incidents')
@auth(roles=['user', 'staff'])
def create_incident():
    """Validate and broadcast incident reports submitted by users or staff."""
    body = request.get_json(silent=True) or {}
    required_fields = ('title', 'description', 'category', 'location')
    missing_fields = any(
        not isinstance(body.get(field), str) or not body[field].strip()
        for field in required_fields
    )
    if missing_fields:
        return jsonify(error='Title, description, category and location are required'), 400

    too_long = (
        len(body['title']) > 180
        or len(body['description']) > 12000
        or len(body['location']) > 180
        or len(body['category']) > 60
    )
    if too_long:
        return jsonify(error='One or more incident fields are too long'), 400

    allowed_categories = ('IT & Network', 'Facilities', 'Security', 'Equipment', 'Other')
    if body['category'] not in allowed_categories:
        return jsonify(error='Invalid incident category'), 400

    # Limit reports to five per minute per member to reduce spam.
    recent_reports = query(
        'SELECT id FROM incidents '
        'WHERE reporter_id=%s AND created_at > NOW() - INTERVAL 1 MINUTE',
        (g.user['id'],),
    )
    if len(recent_reports) >= 5:
        return jsonify(error='Please wait before submitting another report'), 429

    active_maintenance = query(
        'SELECT title FROM maintenance_windows '
        'WHERE active=TRUE AND starts_at<=NOW() AND ends_at>=NOW() '
        'AND (category IS NULL OR category=%s) ORDER BY ends_at LIMIT 1',
        (body['category'],),
        one=True,
    )
    if active_maintenance:
        return jsonify(
            error=f"Reporting is paused during scheduled maintenance: {active_maintenance['title']}"
        ), 423

    priority = body.get('priority', 'Medium')
    allowed_priorities = ('Low', 'Medium', 'High', 'Critical')
    if priority not in allowed_priorities:
        return jsonify(error='Invalid priority'), 400

    incident_values = (
        body['title'].strip(),
        body['description'].strip(),
        body['category'].strip(),
        priority,
        body['location'].strip(),
        g.user['id'],
        priority,
    )
    incident_id = query(
        "INSERT INTO incidents "
        '(title,description,category,priority,location,reporter_id,sla_due_at) '
        "VALUES(%s,%s,%s,%s,%s,%s,"
        "IF(%s='Critical',DATE_ADD(NOW(),INTERVAL 2 HOUR),NULL))",
        incident_values,
        commit=True,
    )
    query(
        'INSERT INTO audit_log(incident_id,actor_id,action,detail) '
        'VALUES(%s,%s,%s,%s)',
        (incident_id, g.user['id'], 'created', 'Incident reported'),
        commit=True,
    )

    # Share the new incident with the admin dashboard and its reporting user.
    incident = incident_dict(get_incident(incident_id))
    socketio.emit('incident:new', incident, to='admins')
    socketio.emit('incident:changed', incident, to=f'user:{g.user["id"]}')

    for admin in query("SELECT id FROM users WHERE role='admin' AND blocked=FALSE"):
        query(
            'INSERT INTO notifications(user_id,incident_id,message) '
            'VALUES(%s,%s,%s)',
            (admin['id'], incident_id, f"New {priority.lower()} incident: {body['title'].strip()}"),
            commit=True,
        )

    admins = query("SELECT id FROM users WHERE role='admin' AND blocked=FALSE")
    send_push(
        [admin['id'] for admin in admins],
        'New incident reported',
        body['title'].strip(),
        f'/?incident={incident_id}',
    )
    return jsonify(incident), 201


# Limit duplicate suggestions to incidents the current member is allowed to view.
@app.get('/api/incidents/similar')
@auth()
def similar_incidents():
    """Suggest similar open reports the current member is allowed to see."""
    title = (request.args.get('title') or '').strip()
    location = (request.args.get('location') or '').strip()
    category = (request.args.get('category') or '').strip()
    if len(title) < 4:
        return jsonify([])

    # The similarity query is limited to incidents visible to the signed-in role.
    clauses = ["i.status NOT IN ('Resolved','Closed')"]
    args = []
    if g.user['role'] == 'user':
        clauses.append('i.reporter_id=%s')
        args.append(g.user['id'])
    if g.user['role'] == 'staff':
        clauses.append('(i.assigned_to=%s OR i.reporter_id=%s)')
        args.extend([g.user['id'], g.user['id']])

    clauses.append(
        '(LOWER(i.title) LIKE %s OR '
        '(LOWER(i.category)=LOWER(%s) AND LOWER(i.location)=LOWER(%s)))'
    )
    args.extend([f'%{title.lower()}%', category.lower(), location.lower()])
    sql = (
        'SELECT i.id,i.title,i.category,i.status,i.location,i.created_at '
        'FROM incidents i WHERE ' + ' AND '.join(clauses) +
        ' ORDER BY i.created_at DESC LIMIT 5'
    )
    rows = query(sql, tuple(args))
    return jsonify([incident_dict(row) for row in rows])


# Hide incidents outside the signed-in member's ownership or assignment scope.
@app.get('/api/incidents/<int:incident_id>')
@auth()
def incident_detail(incident_id):
    """Return an accessible incident with its comments, files, and audit history."""
    incident = get_incident(incident_id)
    if not incident:
        return jsonify(error='Incident not found'), 404
    if g.user['role'] == 'user' and incident['reporter_id'] != g.user['id']:
        return jsonify(error='Incident not found'), 404
    staff_is_reporter = g.user['role'] == 'staff' and incident['reporter_id'] == g.user['id']
    staff_is_assignee = g.user['role'] == 'staff' and incident['assigned_to'] == g.user['id']
    if g.user['role'] == 'staff' and not (staff_is_reporter or staff_is_assignee):
        return jsonify(error='Incident not found'), 404

    # Load the discussion while hiding internal admin notes from the reporter.
    comment_sql = (
        'SELECT c.id,c.body,c.created_at,u.id AS user_id,u.name AS user_name,u.role '
        'FROM comments c JOIN users u ON u.id=c.user_id WHERE c.incident_id=%s'
    )
    if g.user['role'] == 'user' or staff_is_reporter:
        comment_sql += " AND u.role != 'admin'"
    comment_sql += ' ORDER BY c.created_at'
    incident = incident_dict(incident)
    incident['comments'] = query(comment_sql, (incident_id,))
    for comment in incident['comments']:
        comment['created_at'] = comment['created_at'].isoformat()

    # Audit history is internal, so only staff and admins receive assignment details.
    if g.user['role'] == 'admin' or staff_is_assignee:
        incident['audit'] = query(
            'SELECT a.action,a.detail,a.created_at,u.name AS actor_name '
            'FROM audit_log a JOIN users u ON u.id=a.actor_id '
            'WHERE a.incident_id=%s ORDER BY a.created_at DESC',
            (incident_id,),
        )
        for row in incident['audit']:
            row['created_at'] = row['created_at'].isoformat()
    incident['attachments'] = query(
        'SELECT id,filename,mime_type,size_bytes,uploaded_by,created_at '
        'FROM attachments WHERE incident_id=%s ORDER BY created_at',
        (incident_id,),
    )
    for item in incident['attachments']:
        item['created_at'] = item['created_at'].isoformat()
        item['url'] = f"/api/attachments/{item['id']}"
    return jsonify(incident)


# Allow admins to manage incidents and staff to update only their assigned work.
@app.patch('/api/incidents/<int:incident_id>')
@auth(roles=['admin','staff'])
def update_incident(incident_id):
    """Update status, assignment, or resolution notes and emit live events."""
    body = request.get_json(silent=True) or {}
    current = get_incident(incident_id)
    if not current:
        return jsonify(error='Incident not found'), 404
    if g.user['role'] == 'staff' and current['assigned_to'] != g.user['id']:
        return jsonify(error='Incident not found'), 404
    if g.user['role'] == 'staff' and 'assigned_to' in body:
        return jsonify(error='Only admins can assign incidents'), 403

    # Update columns come from fixed code paths; all submitted values stay parameterized.
    fields, args, audit = [], [], []
    status_changed = False
    if 'status' in body:
        if not isinstance(body['status'], str):
            return jsonify(error='Invalid status'), 400

        status = body['status'].replace('In progress','In Progress')
        allowed_statuses = ('Pending', 'In Progress', 'Resolved', 'Closed')
        if status not in allowed_statuses:
            return jsonify(error='Invalid status'), 400

        # Staff resolution completes the ticket as Closed and immediately notifies everyone.
        if g.user['role'] == 'staff' and status == 'Resolved':
            status = 'Closed'

        status_changed = status != current['status']
        fields.extend([
            'status=%s',
            "resolved_at=IF(%s IN ('Resolved','Closed'),COALESCE(resolved_at,NOW()),NULL)",
        ])
        args.extend([status, status])
        audit.append(('status', f'{current["status"]} → {status}'))

    if 'assigned_to' in body:
        try:
            assigned = int(body['assigned_to']) if body['assigned_to'] else None
        except (TypeError, ValueError):
            return jsonify(error='Invalid assignee'), 400

        if assigned:
            eligible_member = query(
                "SELECT id FROM users WHERE id=%s "
                "AND role='staff' AND blocked=FALSE",
                (assigned,),
                one=True,
            )
            if not eligible_member:
                return jsonify(error='Assignee must be an active staff member'), 400

        fields.append('assigned_to=%s')
        args.append(assigned)
        audit.append(('assignment', f'Assigned to {assigned or "nobody"}'))

        # Start a pending incident when an admin assigns it to an active staff member.
        if assigned and current['status'] == 'Pending' and 'status' not in body:
            fields.extend([
                'status=%s',
                "resolved_at=IF(%s IN ('Resolved','Closed'),COALESCE(resolved_at,NOW()),NULL)",
            ])
            args.extend(['In Progress', 'In Progress'])
            audit.append(('status', f'{current["status"]} → In Progress'))
            status_changed = True

    if 'resolution_notes' in body:
        notes = body['resolution_notes']
        if not isinstance(notes, str) or len(notes) > 4000:
            return jsonify(error='Resolution notes must be 4000 characters or fewer'), 400
        fields.append('resolution_notes=%s')
        args.append(notes)
        if notes.strip():
            audit.append(('resolution', notes.strip()[:1000]))

    if fields:
        query(
            'UPDATE incidents SET ' + ','.join(fields) + ' WHERE id=%s',
            tuple(args + [incident_id]),
            commit=True,
        )
        for action, detail in audit:
            query(
                'INSERT INTO audit_log(incident_id,actor_id,action,detail) '
                'VALUES(%s,%s,%s,%s)',
                (incident_id, g.user['id'], action, detail),
                commit=True,
            )

    # Broadcast the saved incident so every authorized view stays in sync.
    incident = incident_dict(get_incident(incident_id))
    assignment_changed = (
        'assigned_to' in body
        and current.get('assigned_to') != incident.get('assigned_to')
    )
    if assignment_changed and current.get('assigned_to'):
        old_assignee_id = current['assigned_to']
        old_incident_notifications = query(
            'SELECT id FROM notifications '
            'WHERE user_id=%s AND incident_id=%s',
            (old_assignee_id, incident_id),
        )
        if old_incident_notifications:
            notification_ids = [item['id'] for item in old_incident_notifications]
            query(
                'DELETE FROM notifications '
                'WHERE user_id=%s AND incident_id=%s',
                (old_assignee_id, incident_id),
                commit=True,
            )
            # Remove every alert for this incident from the previous worker's bell immediately.
            socketio.emit(
                'notification:removed',
                {'ids': notification_ids, 'incident_id': incident_id},
                to=f'user:{old_assignee_id}',
            )

    if incident['status'] in ('Resolved', 'Closed'):
        team_notifications = query(
            'SELECT id,user_id FROM notifications '
            'WHERE incident_id=%s AND user_id IN '
            '(SELECT id FROM users WHERE role IN (%s,%s))',
            (incident_id, 'admin', 'staff'),
        )
        if team_notifications:
            # Remove completed-incident alerts from admins' and staff members' saved centers.
            query(
                'DELETE FROM notifications WHERE incident_id=%s AND user_id IN '
                '(SELECT id FROM users WHERE role IN (%s,%s))',
                (incident_id, 'admin', 'staff'),
                commit=True,
            )
            removed_by_member = {}
            for item in team_notifications:
                removed_by_member.setdefault(item['user_id'], []).append(item['id'])
            for member_id, notification_ids in removed_by_member.items():
                socketio.emit(
                    'notification:removed',
                    {'ids': notification_ids, 'incident_id': incident_id},
                    to=f'user:{member_id}',
                )

    if assignment_changed:
        # Replace an outdated assignee notice with the current assignment for the reporter.
        old_reporter_assignment_notices = query(
            'SELECT id FROM notifications WHERE user_id=%s AND incident_id=%s '
            'AND message LIKE %s',
            (incident['reporter_id'], incident_id, 'Your incident assignment:%'),
        )
        if old_reporter_assignment_notices:
            old_notice_ids = [item['id'] for item in old_reporter_assignment_notices]
            query(
                'DELETE FROM notifications WHERE user_id=%s AND incident_id=%s '
                'AND message LIKE %s',
                (incident['reporter_id'], incident_id, 'Your incident assignment:%'),
                commit=True,
            )
            socketio.emit(
                'notification:removed',
                {'ids': old_notice_ids, 'incident_id': incident_id},
                to=f'user:{incident["reporter_id"]}',
            )

        if incident['status'] not in ('Resolved', 'Closed'):
            if incident.get('assigned_to'):
                message = f'Your incident assignment: {incident["assignee_name"]}'
            else:
                message = 'Your incident assignment: currently unassigned'
            notification_id = query(
                'INSERT INTO notifications(user_id,incident_id,message) '
                'VALUES(%s,%s,%s)',
                (incident['reporter_id'], incident_id, message),
                commit=True,
            )
            # Send the saved assignment update to the reporter's bell immediately.
            reporter_notice = query(
                'SELECT id,incident_id,message,read_at,created_at '
                'FROM notifications WHERE id=%s AND user_id=%s',
                (notification_id, incident['reporter_id']),
                one=True,
            )
            if reporter_notice:
                reporter_notice['created_at'] = reporter_notice['created_at'].isoformat()
                reporter_notice['read_at'] = None
                socketio.emit(
                    'notification:new',
                    reporter_notice,
                    to=f'user:{incident["reporter_id"]}',
                )

    socketio.emit('incident:changed', incident, to=f'user:{incident["reporter_id"]}')
    socketio.emit('incident:changed', incident, to='admins')
    if incident.get('assigned_to'):
        socketio.emit(
            'incident:changed',
            incident,
            to=f'staff:{incident["assigned_to"]}',
        )
    # Tell the previous assignee to remove work that has been reassigned or unassigned.
    if assignment_changed and current.get('assigned_to'):
        socketio.emit(
            'incident:changed',
            incident,
            to=f'user:{current["assigned_to"]}',
        )

    if status_changed:
        message = f"{incident['title']} is now {incident['status']}"
        # Remove outdated status alerts so the reporter's bell reflects only the latest state.
        old_status_notices = query(
            'SELECT id FROM notifications WHERE user_id=%s AND incident_id=%s '
            'AND message LIKE %s',
            (incident['reporter_id'], incident_id, '% is now %'),
        )
        if old_status_notices:
            old_status_ids = [item['id'] for item in old_status_notices]
            query(
                'DELETE FROM notifications WHERE user_id=%s AND incident_id=%s '
                'AND message LIKE %s',
                (incident['reporter_id'], incident_id, '% is now %'),
                commit=True,
            )
            socketio.emit(
                'notification:removed',
                {'ids': old_status_ids, 'incident_id': incident_id},
                to=f'user:{incident["reporter_id"]}',
            )
        notification_id = query(
            'INSERT INTO notifications(user_id,incident_id,message) '
            'VALUES(%s,%s,%s)',
            (incident['reporter_id'], incident_id, message),
            commit=True,
        )
        # Tell the reporter only after MySQL has saved the notification.
        saved_notification = query(
            'SELECT id,incident_id,message,read_at,created_at '
            'FROM notifications WHERE id=%s AND user_id=%s',
            (notification_id, incident['reporter_id']),
            one=True,
        )
        if saved_notification:
            saved_notification['created_at'] = saved_notification['created_at'].isoformat()
            saved_notification['read_at'] = None
            socketio.emit(
                'notification:new',
                saved_notification,
                to=f'user:{incident["reporter_id"]}',
            )
        send_push(
            [incident['reporter_id']],
            'Incident status updated',
            message,
            f'/?incident={incident_id}',
        )
    if (
        assignment_changed
        and incident.get('assigned_to')
        and incident['status'] not in ('Resolved', 'Closed')
    ):
        message = f'You were assigned: {incident["title"]}'
        notification_id = query(
            'INSERT INTO notifications(user_id,incident_id,message) '
            'VALUES(%s,%s,%s)',
            (incident['assigned_to'], incident_id, message),
            commit=True,
        )
        # Push the saved assignment notification to the new owner's bell immediately.
        saved_notification = query(
            'SELECT id,incident_id,message,read_at,created_at '
            'FROM notifications WHERE id=%s AND user_id=%s',
            (notification_id, incident['assigned_to']),
            one=True,
        )
        if saved_notification:
            saved_notification['created_at'] = saved_notification['created_at'].isoformat()
            saved_notification['read_at'] = None
            socketio.emit(
                'notification:new',
                saved_notification,
                to=f'user:{incident["assigned_to"]}',
            )
    return jsonify(incident)


# Discussion, feedback, and attachments keep incident evidence together.
# Enforce incident visibility and hide internal admin notes from reporters.
@app.post('/api/incidents/<int:incident_id>/comments')
@auth()
def add_comment(incident_id):
    """Save a permitted discussion comment and notify the incident team."""
    incident = get_incident(incident_id)
    body = request.get_json(silent=True) or {}
    message = str(body.get('body', '')).strip()
    if not incident:
        return jsonify(error='Incident not found'), 404
    if g.user['role'] == 'user' and incident['reporter_id'] != g.user['id']:
        return jsonify(error='Incident not found'), 404
    if g.user['role'] == 'staff' and incident['assigned_to'] != g.user['id'] and incident['reporter_id'] != g.user['id']:
        return jsonify(error='Incident not found'), 404
    if not message or len(message) > 4000:
        return jsonify(error='Comment must contain 1 to 4000 characters'), 400

    comment_id = query(
        'INSERT INTO comments(incident_id,user_id,body) VALUES(%s,%s,%s)',
        (incident_id, g.user['id'], message),
        commit=True,
    )
    comment = query(
        'SELECT c.id,c.body,c.created_at,u.id AS user_id,u.name AS user_name,u.role '
        'FROM comments c JOIN users u ON u.id=c.user_id WHERE c.id=%s',
        (comment_id,),
        one=True,
    )
    comment['created_at'] = comment['created_at'].isoformat()

    recipients = {incident['reporter_id'], incident.get('assigned_to')}
    # Admin comments are internal team notes and never notify the reporting user.
    if g.user['role'] == 'admin':
        recipients.discard(incident['reporter_id'])
    else:
        recipients.update(
            item['id']
            for item in query("SELECT id FROM users WHERE role='admin' AND blocked=FALSE")
        )
    recipients.discard(g.user['id'])
    recipients.discard(None)
    for recipient in recipients:
        query(
            'INSERT INTO notifications(user_id,incident_id,message) '
            'VALUES(%s,%s,%s)',
            (recipient, incident_id, f"New comment on {incident['title']}"),
            commit=True,
        )
    event = {'incident_id': incident_id, 'comment': comment}
    # Keep admin-authored internal comments out of the reporter's live feed.
    if g.user['role'] != 'admin':
        socketio.emit('comment:new', event, to=f'user:{incident["reporter_id"]}')
    socketio.emit('comment:new', event, to='admins')
    if incident.get('assigned_to'):
        socketio.emit(
            'comment:new',
            event,
            to=f'staff:{incident["assigned_to"]}',
        )
    return jsonify(comment), 201


# Accept feedback only from the user who reported a completed incident.
@app.post('/api/incidents/<int:incident_id>/rating')
@auth(roles=['user'])
def rate_incident(incident_id):
    """Save the reporting user's rating after the incident is resolved."""
    body = request.get_json(silent=True) or {}
    rating = body.get('rating')
    feedback = str(body.get('feedback', '')).strip()
    incident = get_incident(incident_id)

    if not incident or incident['reporter_id'] != g.user['id']:
        return jsonify(error='Incident not found'), 404
    if incident['status'] not in ('Resolved', 'Closed'):
        return jsonify(error='You can rate an incident after it is resolved'), 409
    if not isinstance(rating, int) or isinstance(rating, bool) or not 1 <= rating <= 5:
        return jsonify(error='Rating must be between 1 and 5'), 400

    query(
        'UPDATE incidents SET rating=%s,feedback=%s WHERE id=%s',
        (rating, feedback[:1000], incident_id),
        commit=True,
    )
    query(
        'INSERT INTO audit_log(incident_id,actor_id,action,detail) '
        'VALUES(%s,%s,%s,%s)',
        (incident_id, g.user['id'], 'feedback', f'{rating}/5'),
        commit=True,
    )
    return jsonify(rating=rating, feedback=feedback[:1000])


# Store uploaded proof in one private folder and accept only known safe file types.
UPLOAD_DIR = os.path.join(os.path.dirname(__file__), 'uploads')
ALLOWED_UPLOADS = {'image/jpeg', 'image/png', 'image/webp', 'application/pdf'}


# Check ownership, file type, and size before storing incident attachments.
@app.post('/api/incidents/<int:incident_id>/attachments')
@auth()
def upload_attachment(incident_id):
    """Store a safe, size-limited proof file and share its metadata."""
    incident = get_incident(incident_id)
    if not incident:
        return jsonify(error='Incident not found'), 404
    if g.user['role'] == 'user' and incident['reporter_id'] != g.user['id']:
        return jsonify(error='Incident not found'), 404
    if g.user['role'] == 'staff' and incident['assigned_to'] != g.user['id'] and incident['reporter_id'] != g.user['id']:
        return jsonify(error='Incident not found'), 404

    uploaded = request.files.get('file')
    if not uploaded or not uploaded.filename:
        return jsonify(error='Choose a file to upload'), 400
    if uploaded.mimetype not in ALLOWED_UPLOADS:
        return jsonify(error='Use a JPG, PNG, WebP, or PDF file'), 415

    # Check file size before saving and generate a random storage name.
    uploaded.stream.seek(0, os.SEEK_END)
    size = uploaded.stream.tell()
    uploaded.stream.seek(0)
    if size > 8 * 1024 * 1024:
        return jsonify(error='Files must be 8 MB or smaller'), 413

    safe_filename = secure_filename(uploaded.filename)
    extension = os.path.splitext(safe_filename)[1].lower()
    storage_name = f'{uuid4().hex}{extension}'
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    uploaded.save(os.path.join(UPLOAD_DIR, storage_name))

    attachment_id = query(
        'INSERT INTO attachments '
        '(incident_id,uploaded_by,filename,storage_name,mime_type,size_bytes) '
        'VALUES(%s,%s,%s,%s,%s,%s)',
        (
            incident_id,
            g.user['id'],
            safe_filename[:255],
            storage_name,
            uploaded.mimetype,
            size,
        ),
        commit=True,
    )
    data = {
        'id': attachment_id,
        'incident_id': incident_id,
        'filename': safe_filename,
        'mime_type': uploaded.mimetype,
        'size_bytes': size,
        'url': f'/api/attachments/{attachment_id}',
    }

    # Notify every role already allowed to view this incident.
    socketio.emit('attachment:new', data, to=f'user:{incident["reporter_id"]}')
    socketio.emit('attachment:new', data, to='admins')
    if incident.get('assigned_to'):
        socketio.emit(
            'attachment:new',
            data,
            to=f'staff:{incident["assigned_to"]}',
        )
    return jsonify(data), 201


# Verify incident access before serving a private uploaded file.
@app.get('/api/attachments/<int:attachment_id>')
@auth()
def get_attachment(attachment_id):
    """Stream an attachment only to a member with incident access."""
    attachment = query(
        'SELECT a.*,i.reporter_id,i.assigned_to '
        'FROM attachments a JOIN incidents i ON i.id=a.incident_id '
        'WHERE a.id=%s',
        (attachment_id,),
        one=True,
    )
    if not attachment:
        return jsonify(error='Attachment not found'), 404
    if g.user['role'] == 'user' and attachment['reporter_id'] != g.user['id']:
        return jsonify(error='Attachment not found'), 404
    if g.user['role'] == 'staff' and attachment['assigned_to'] != g.user['id'] and attachment['reporter_id'] != g.user['id']:
        return jsonify(error='Attachment not found'), 404

    file_path = os.path.join(UPLOAD_DIR, attachment['storage_name'])
    return send_file(
        file_path,
        mimetype=attachment['mime_type'],
        download_name=attachment['filename'],
        as_attachment=False,
    )


# Notifications and maintenance routes keep workspace members informed.
# Return only the signed-in member's notification records.
@app.get('/api/notifications')
@auth()
def notification_list():
    """List the signed-in user's newest notifications."""
    if g.user['role'] in ('admin', 'staff'):
        # Clear old team alerts for incidents completed before live cleanup existed.
        query(
            'DELETE FROM notifications WHERE user_id=%s AND incident_id IN '
            "(SELECT id FROM incidents WHERE status IN ('Resolved','Closed'))",
            (g.user['id'],),
            commit=True,
        )

    rows = query(
        'SELECT id,incident_id,message,read_at,created_at '
        'FROM notifications WHERE user_id=%s AND read_at IS NULL '
        'ORDER BY created_at DESC LIMIT 100',
        (g.user['id'],),
    )
    for row in rows:
        if row['read_at']:
            row['read_at'] = row['read_at'].isoformat()
        row['created_at'] = row['created_at'].isoformat()
    return jsonify(rows)


# Mark a notification read only when it belongs to the signed-in member.
@app.patch('/api/notifications/<int:notification_id>')
@auth()
def mark_notification_read(notification_id):
    """Mark one notification as read without changing another user's record."""
    query(
        'UPDATE notifications SET read_at=NOW() WHERE id=%s AND user_id=%s',
        (notification_id, g.user['id']),
        commit=True,
    )
    return jsonify(ok=True)


# Expose workspace maintenance windows to authenticated members.
@app.get('/api/maintenance')
@auth(roles=['admin'])
def list_maintenance():
    """List scheduled maintenance windows for the admin workspace page."""
    rows = query(
        'SELECT id,title,description,category,starts_at,ends_at,active '
        'FROM maintenance_windows ORDER BY starts_at DESC'
    )
    for row in rows:
        row['starts_at'] = row['starts_at'].isoformat()
        row['ends_at'] = row['ends_at'].isoformat()
    return jsonify(rows)


# Restrict maintenance scheduling to admins and validate the time window.
@app.post('/api/maintenance')
@auth(roles=['admin'])
def create_maintenance():
    """Schedule a service window and broadcast it to connected clients."""
    body = request.get_json(silent=True) or {}
    try:
        start = datetime.fromisoformat(body.get('starts_at', ''))
        end = datetime.fromisoformat(body.get('ends_at', ''))
    except ValueError:
        return jsonify(error='Provide valid start and end times'), 400

    title = str(body.get('title', '')).strip()
    category = body.get('category')
    allowed_categories = ('IT & Network', 'Facilities', 'Security', 'Equipment', 'Other', None)
    if not title or end <= start:
        return jsonify(error='Title and a valid time window are required'), 400
    if category not in allowed_categories:
        return jsonify(error='Invalid maintenance scope'), 400

    item_id = query(
        'INSERT INTO maintenance_windows '
        '(title,description,category,starts_at,ends_at,created_by) '
        'VALUES(%s,%s,%s,%s,%s,%s)',
        (
            title,
            str(body.get('description', ''))[:2000],
            category,
            start,
            end,
            g.user['id'],
        ),
        commit=True,
    )
    maintenance_event = {
        'id': item_id,
        'title': title,
        'starts_at': start.isoformat(),
        'ends_at': end.isoformat(),
    }
    # Omitting a room broadcasts the schedule to all connected clients.
    socketio.emit('maintenance:changed', maintenance_event)
    return jsonify(
        id=item_id,
        title=title,
        category=category,
        starts_at=start.isoformat(),
        ends_at=end.isoformat(),
        active=True,
    ), 201


# Restrict maintenance edits to admins and persist only validated fields.
@app.patch('/api/maintenance/<int:maintenance_id>')
@auth(roles=['admin'])
def update_maintenance(maintenance_id):
    """Edit a scheduled service window and broadcast the updated schedule."""
    body = request.get_json(silent=True) or {}
    try:
        start = datetime.fromisoformat(body.get('starts_at', ''))
        end = datetime.fromisoformat(body.get('ends_at', ''))
    except (TypeError, ValueError):
        return jsonify(error='Provide valid start and end times'), 400

    title = str(body.get('title', '')).strip()
    description = str(body.get('description', ''))[:2000]
    category = body.get('category')
    allowed_categories = ('IT & Network', 'Facilities', 'Security', 'Equipment', 'Other', None)
    if not title or len(title) > 180 or end <= start:
        return jsonify(error='Title and a valid time window are required'), 400
    if category not in allowed_categories:
        return jsonify(error='Invalid maintenance scope'), 400

    existing = query(
        'SELECT id FROM maintenance_windows WHERE id=%s',
        (maintenance_id,),
        one=True,
    )
    if not existing:
        return jsonify(error='Maintenance window not found'), 404

    query(
        'UPDATE maintenance_windows '
        'SET title=%s,description=%s,category=%s,starts_at=%s,ends_at=%s,active=TRUE '
        'WHERE id=%s',
        (title, description, category, start, end, maintenance_id),
        commit=True,
    )
    maintenance_event = {
        'id': maintenance_id,
        'title': title,
        'description': description,
        'category': category,
        'starts_at': start.isoformat(),
        'ends_at': end.isoformat(),
        'active': True,
    }
    # Omitting a room broadcasts the schedule to all connected clients.
    socketio.emit('maintenance:changed', maintenance_event)
    return jsonify(maintenance_event), 200


# Restrict maintenance cancellation to admins.
@app.delete('/api/maintenance/<int:maintenance_id>')
@auth(roles=['admin'])
def cancel_maintenance(maintenance_id):
    """Cancel a maintenance window without erasing its audit history."""
    existing = query(
        'SELECT id FROM maintenance_windows WHERE id=%s',
        (maintenance_id,),
        one=True,
    )
    if not existing:
        return jsonify(error='Maintenance window not found'), 404

    query(
        'UPDATE maintenance_windows SET active=FALSE WHERE id=%s',
        (maintenance_id,),
        commit=True,
    )
    socketio.emit(
        'maintenance:changed',
        {'id': maintenance_id, 'active': False},
    )
    return jsonify(ok=True, id=maintenance_id, active=False), 200


# Public status and analytics summarize service health and team workload.
@app.get('/api/status/public')
def public_status():
    """Return aggregate service health and the next active maintenance window."""
    counts = query(
        "SELECT COUNT(*) total, "
        "CAST(COALESCE(SUM(status NOT IN ('Resolved','Closed')),0) AS UNSIGNED) active, "
        "CAST(COALESCE(SUM(status='Resolved'),0) AS UNSIGNED) resolved FROM incidents",
        one=True,
    )
    maintenance = query(
        'SELECT title,description,category,starts_at,ends_at '
        'FROM maintenance_windows '
        'WHERE active=TRUE AND ends_at>NOW() ORDER BY starts_at LIMIT 1',
        one=True,
    )
    if maintenance:
        for key in ('starts_at', 'ends_at'):
            maintenance[key] = maintenance[key].isoformat()
    status = 'maintenance' if maintenance else 'operational'
    return jsonify(status=status, counts=counts, maintenance=maintenance)


# Keep staff analytics scoped to their own assigned incidents.
@app.get('/api/analytics')
@auth(roles=['admin','staff'])
def analytics():
    """Build workspace analytics for admins and assignment-only analytics for staff."""
    is_staff = g.user['role'] == 'staff'
    # Keep staff analytics restricted to incidents currently assigned to that member.
    scope_clause = ' WHERE assigned_to=%s' if is_staff else ''
    scope_args = (g.user['id'],) if is_staff else ()
    totals = query(
        "SELECT COUNT(*) total, "
        "CAST(COALESCE(SUM(status='Pending'),0) AS UNSIGNED) pending, "
        "CAST(COALESCE(SUM(status='In Progress'),0) AS UNSIGNED) in_progress, "
        "CAST(COALESCE(SUM(status='Resolved'),0) AS UNSIGNED) resolved, "
        "CAST(COALESCE(SUM(status='Closed'),0) AS UNSIGNED) closed, "
        'CAST(ROUND(AVG(CASE WHEN resolved_at IS NOT NULL THEN '
        'TIMESTAMPDIFF(MINUTE,created_at,resolved_at) END)) AS UNSIGNED) '
        'avg_resolution_minutes, '
        'CAST(COALESCE(SUM(escalated_at IS NOT NULL),0) AS UNSIGNED) escalated '
        'FROM incidents' + scope_clause,
        scope_args,
        one=True,
    )
    categories = query(
        'SELECT category,COUNT(*) count FROM incidents' + scope_clause +
        ' GROUP BY category ORDER BY count DESC',
        scope_args,
    )
    if is_staff:
        activity = query(
            'SELECT DATE(created_at) day,COUNT(*) reported FROM incidents '
            'WHERE assigned_to=%s AND created_at>=CURRENT_DATE-INTERVAL 29 DAY '
            'GROUP BY DATE(created_at) ORDER BY day',
            (g.user['id'],),
        )
        performance = query(
            "SELECT u.id,u.name,"
            "COUNT(CASE WHEN i.status='In Progress' THEN 1 END) in_progress,"
            "COUNT(CASE WHEN i.status='Resolved' THEN 1 END) resolved,"
            "COUNT(CASE WHEN i.status='Closed' THEN 1 END) closed FROM users u "
            "LEFT JOIN incidents i ON i.assigned_to=u.id "
            'WHERE u.id=%s GROUP BY u.id,u.name',
            (g.user['id'],),
        )
    else:
        activity = query(
            'SELECT DATE(created_at) day,COUNT(*) reported FROM incidents '
            'WHERE created_at>=CURRENT_DATE-INTERVAL 29 DAY '
            'GROUP BY DATE(created_at) ORDER BY day'
        )
        performance = query(
            "SELECT u.id,u.name,"
            "COUNT(CASE WHEN i.status='Pending' THEN 1 END) pending,"
            "COUNT(CASE WHEN i.status='In Progress' THEN 1 END) in_progress,"
            "COUNT(CASE WHEN i.status='Resolved' THEN 1 END) resolved,"
            "COUNT(CASE WHEN i.status='Closed' THEN 1 END) closed FROM users u "
            "LEFT JOIN incidents i ON i.assigned_to=u.id "
            "WHERE u.role='staff' "
            'GROUP BY u.id,u.name ORDER BY resolved DESC LIMIT 10'
        )

    # Fill in quiet days so the activity chart always has a complete month.
    activity_by_day = {row['day']: row['reported'] for row in activity}
    today = datetime.now().date()
    activity_series = []
    for days_ago in range(29, -1, -1):
        day = today - timedelta(days=days_ago)
        activity_series.append({
            'day': day.isoformat(),
            'reported': activity_by_day.get(day, 0),
        })

    return jsonify(
        totals=totals,
        categories=categories,
        staff=performance,
        activity=activity_series,
    )


# Escalate overdue critical reports and notify admins while the backend is running.
def sla_escalation_worker():
    """Check pending critical reports each minute and escalate overdue work."""
    while True:
        try:
            overdue = query(
                "SELECT * FROM incidents WHERE priority='Critical' "
                "AND status='Pending' AND sla_due_at<=NOW() "
                'AND escalated_at IS NULL'
            )
            for row in overdue:
                query(
                    'UPDATE incidents SET escalated_at=NOW() '
                    'WHERE id=%s AND escalated_at IS NULL',
                    (row['id'],),
                    commit=True,
                )
                admins = query(
                    "SELECT id FROM users WHERE role='admin' AND blocked=FALSE"
                )
                message = (
                    f"Critical incident {row['id']} has breached its "
                    f"2-hour response SLA: {row['title']}"
                )

                for admin in admins:
                    query(
                        'INSERT INTO notifications(user_id,incident_id,message) '
                        'VALUES(%s,%s,%s)',
                        (admin['id'], row['id'], message),
                        commit=True,
                    )

                incident = incident_dict(get_incident(row['id']))
                socketio.emit('incident:escalated', incident, to='admins')
                send_push(
                    [admin['id'] for admin in admins],
                    'Critical incident escalated',
                    message,
                    f'/?incident={row["id"]}',
                )
                if admins:
                    query(
                        'INSERT INTO audit_log(incident_id,actor_id,action,detail) '
                        'VALUES(%s,%s,%s,%s)',
                        (
                            row['id'],
                            admins[0]['id'],
                            'sla_escalated',
                            'Critical incident exceeded the 2-hour SLA',
                        ),
                        commit=True,
                    )
        except Exception:
            app.logger.exception('SLA escalation sweep failed')
        # Wake once per minute, then check for newly overdue critical reports.
        socketio.sleep(60)


# Socket handlers authenticate members and relay scoped live events.
@socketio.on('connect')
# Authenticate socket clients and join only the rooms their roles are allowed to access.
def socket_connect(auth_data):
    """Authenticate a browser socket and join role-scoped private rooms."""
    try:
        data = auth_data if isinstance(auth_data, dict) else {}
        decoded = jwt.decode(
            data.get('token', ''),
            app.config['SECRET_KEY'],
            algorithms=['HS256'],
        )
        user = query(
            'SELECT id,role,blocked FROM users WHERE id=%s',
            (int(decoded['sub']),),
            one=True,
        )
        if not user or user['blocked']:
            return False

        with socket_users_lock:
            socket_users[request.sid] = user
        join_room(f'user:{user["id"]}')
        if user['role'] == 'admin':
            join_room('admins')
        if user['role'] == 'staff':
            join_room(f'staff:{user["id"]}')
            socketio.emit(
                'staff:presence',
                {'user_id': user['id'], 'online': True},
                to='admins',
            )
    # Expired or malformed tokens are expected sign-in states, not server errors.
    except (jwt.InvalidTokenError, KeyError, TypeError, ValueError):
        return False
    except Exception:
        # Keep unexpected database or server failures visible for diagnosis.
        app.logger.exception('Socket connection authentication failed')
        return False


@socketio.on('disconnect')
# Clear staff presence after their last authenticated socket disconnects.
def socket_disconnect():
    """Clear staff presence when their last active socket closes."""
    with socket_users_lock:
        user = socket_users.pop(request.sid, None)
    if not user or user['role'] != 'staff':
        return

    with socket_users_lock:
        another_socket_is_open = any(
            item['id'] == user['id']
            for item in socket_users.values()
        )
    if not another_socket_is_open:
        socketio.emit(
            'staff:presence',
            {'user_id': user['id'], 'online': False},
            to='admins',
        )


@socketio.on('incident:typing')
# Relay typing activity only to members who can access the selected incident.
def incident_typing(payload):
    """Relay typing state only to members who can view the incident."""
    payload = payload or {}
    try:
        incident_id = int(payload.get('incident_id'))
    except (TypeError, ValueError):
        return

    with socket_users_lock:
        user = socket_users.get(request.sid)
    incident = get_incident(incident_id)
    if not user or not incident:
        return
    if user['role'] == 'user' and incident['reporter_id'] != user['id']:
        return
    if user['role'] == 'staff' and incident['assigned_to'] != user['id']:
        return

    member = query(
        'SELECT name FROM users WHERE id=%s',
        (user['id'],),
        one=True,
    )
    event = {
        'incident_id': incident_id,
        'user_id': user['id'],
        'name': member['name'],
        'typing': bool(payload.get('typing')),
    }

    # Send typing state only to members who can access this incident.
    socketio.emit(
        'incident:typing',
        event,
        to=f'user:{incident["reporter_id"]}',
        skip_sid=request.sid,
    )
    if incident.get('assigned_to'):
        socketio.emit(
            'incident:typing',
            event,
            to=f'staff:{incident["assigned_to"]}',
            skip_sid=request.sid,
        )
    socketio.emit('incident:typing', event, to='admins', skip_sid=request.sid)


# Local startup initializes MySQL, starts SLA checks, and serves HTTP plus WebSockets.
if __name__ == '__main__':
    try:
        init_db()
    except mysql.connector.Error as exc:
        raise SystemExit(f'MySQL is not ready: {exc}. Configure Backend/.env and start MySQL.')
    socketio.start_background_task(sla_escalation_worker)
    socketio.run(
        app,
        host=os.getenv('HOST', '127.0.0.1'),
        port=int(os.getenv('PORT', '5000')),
        debug=os.getenv('FLASK_DEBUG') == '1',
        use_reloader=False,
        allow_unsafe_werkzeug=True,
    )
