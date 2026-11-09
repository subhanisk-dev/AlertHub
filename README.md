# AlertHub

AlertHub is an incident reporting and response workspace. Users report issues and follow updates; staff work on assigned reports; admins manage the queue, team access, maintenance windows, and service analytics. The interface uses warm ivory surfaces, burnt orange actions, and espresso navigation.

For a code map, feature lookup, role rules, and safe extension steps, see [the project guide](docs/PROJECT_GUIDE.md).

For a production deployment with Docker, MySQL, HTTPS, persistent uploads, and live WebSockets, see [the production deployment guide](deploy/PRODUCTION.md).

## Run locally

### 1. Start MySQL and configure the backend

MySQL Server must be running. Copy `Backend/.env.example` to `Backend/.env` if you do not already have a local `.env`; set the MySQL values and a strong `JWT_SECRET`. The existing local `.env` is kept out of source control.

```powershell
cd Backend
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
python create_admin.py "Workspace Admin" admin@example.com
python app.py
```

The first startup creates the database and tables. To use a new environment instead of the bundled virtual environment, create and activate one with `python -m venv .venv` and `.\.venv\Scripts\Activate.ps1` first. `Database/schema.sql` is also available for manual setup. Register normal accounts in the UI, then use **People & access** to promote staff and admins.

### 2. Start the React app

```powershell
cd Frontend
npm install
npm run dev
```

Open the Vite URL, usually `http://localhost:5173`. Set `VITE_API_URL` in `Frontend/.env.local` if Flask is hosted somewhere other than `http://localhost:5000`.

Vite proxies `/api` and `/socket.io` to Flask during local development. Remote preview hosts are not allow-listed; add a specific trusted hostname and backend origin only when you intend to share the development app.

## Working flows

- **User:** register or sign in, submit a report with an optional image/document, receive live status and discussion updates, and rate a resolved incident.
- **Staff:** report incidents and see those separately from assigned work; update only assigned incidents, add comments, and attach proof of work.
- **Admin:** see the incident queue, assign staff, manage account roles/access, schedule maintenance, review analytics, audit events, and export a CSV. Admin accounts cannot report incidents.
- **Realtime:** authenticated Socket.IO connections join private user, staff, or admin rooms. New reports, assignments, status changes, comments, attachments, and SLA escalations emit events without polling.
- **Operations:** MySQL stores incidents, comments, ratings, assignments, notifications, audit events, maintenance windows, and push subscriptions. Critical pending reports escalate after two hours. The public status UI is available at `/status`.

## Browser push notifications

AlertHub does not send email. Incident updates, assignments, and SLA escalations use in-app notifications, Socket.IO, and optional browser push. Forgotten passwords can be reset by an administrator with `python Backend/reset_account_password.py member@example.com`; the new password is entered interactively and no email is sent.

Browser push requires the `pywebpush` dependency and a VAPID key pair. Install backend requirements, then run `node Backend/generate_vapid_keys.mjs` from the project root. The script saves the public key and private PEM path in the ignored `Backend/.env` and stores the private key in the ignored `Backend/vapid_private.pem`. Keep the private key secret. Members can then enable or disable push under **Settings**. Push requires HTTPS in deployed environments (localhost is accepted for development).

Admins can edit or cancel maintenance windows from **Maintenance**. Cancelling preserves the history but removes the window from public status and report-pausing checks.

## API overview

Auth: `POST /api/auth/register`, `POST /api/auth/login`, `GET/PATCH /api/auth/me`. Incident endpoints: `GET/POST /api/incidents`, `GET /api/incidents?scope=reported` for staff-submitted incidents, `GET/PATCH /api/incidents/:id`, `POST /api/incidents/:id/comments`, `POST /api/incidents/:id/attachments`, `POST /api/incidents/:id/rating`, and `GET /api/incidents/similar`. Admin endpoints include `/api/admin/users`, `GET/POST/PATCH/DELETE /api/maintenance`, and `/api/analytics`. Push endpoints include `GET /api/push/public-key`, authenticated `GET /api/push/status`, and authenticated `POST/DELETE /api/push/subscribe`. Public endpoints: `GET /api/health`, `GET /api/status/public`. Protected HTTP requests send `Authorization: Bearer <token>`; Socket.IO auth sends `{ token }`.

Uploads accept JPG, PNG, WebP, or PDF files up to 8 MB and are stored under `Backend/uploads`. Back up that directory with the MySQL database. Keep secrets in `.env`, use HTTPS in deployment, and replace development keys before sharing the service.

## SQL injection protection

Backend queries use MySQL Connector's `%s` placeholders for values through the shared `query(sql, args)` helper. Keep user input in `args`; do not insert request values into SQL with f-strings, `+`, or string formatting. When a SQL identifier must be dynamic, select it from a fixed allow-list. The configured database name is checked against a safe identifier pattern before schema creation.

```python
user = query(
    'SELECT id, name FROM users WHERE email=%s',
    (email,),
    one=True,
)
```
