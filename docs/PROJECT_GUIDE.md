# AlertHub project guide

Use this guide to find the existing feature before changing it. Keep the current API, role access, status transitions, live events, and user experience working when extending a feature.

## Project map

| Area | Main files | Responsibility |
| --- | --- | --- |
| Backend entry point and API routes | `Backend/app.py` | Creates the Flask and Socket.IO services, registers API endpoints, and starts the SLA worker while keeping `python app.py` as the local command. |
| Backend settings and database | `Backend/alerthub/config.py`, `Backend/alerthub/database.py` | Loads validated environment settings, parameterized SQL helpers, and initializes MySQL from the shared schema. |
| Backend authentication | `Backend/alerthub/security.py` | Provides the shared JWT, blocked-account, and role authorization decorator used by API routes. |
| Database definition | `Database/schema.sql`, `Backend/alerthub/database.py` → `init_db()` | MySQL table definitions and startup initialization. Keep the schema file as the source of table structure. |
| Frontend application shell | `Frontend/src/App.jsx` | Session state, role navigation, shared incident state, API actions, and live event handling. |
| Frontend API and socket helpers | `Frontend/src/services/alertHubApi.js` | Authenticated fetches, Socket.IO connection, status labels, and database-to-UI incident mapping. |
| Frontend pages | `Frontend/src/pages/` | Authentication, overview and analytics, incident search, maintenance, and public status pages. |
| Frontend reusable components | `Frontend/src/components/` | Incident tables and boards, incident details, comments, and resolution controls. |
| Frontend role and workspace features | `Frontend/src/features/people/`, `notifications/`, `settings/` | Member access management, notification center, and workspace preferences with their own UI logic. |
| Frontend styles | `Frontend/src/App.css`, `Frontend/src/index.css` | App component styling and global reset/theme styles. |
| Local configuration | `Backend/.env.example`, `Frontend/.env.local` | Backend secrets and services, and frontend API origin. Keep real secrets in ignored local files. |

## Feature lookup

| Feature | Frontend | Backend entry points |
| --- | --- | --- |
| Sign in and registration (password recovery by email is disabled) | `pages/AuthScreen.jsx`, `services/alertHubApi.js` | `/api/auth/*`, `alerthub/security.py` → `create_authenticator()`, `token_response()` |
| User and staff incident reporting | `App.jsx`, `components/IncidentDetails.jsx` | `create_incident()`, `incident_detail()` |
| Staff assignments and status changes | `pages/IncidentListPage.jsx`, `components/DashboardWidgets.jsx` | `update_incident()`, `staff_list()` |
| Comments, files, and ratings | `components/IncidentDetails.jsx` | `add_comment()`, `upload_attachment()`, `get_attachment()`, `rate_incident()` |
| Notifications and push | `features/notifications/NotificationCenter.jsx`, `features/settings/SettingsPage.jsx`, `public/sw.js` | `notification_list()`, notification routes, `push_*()`, `send_push()` |
| People and account access | `features/people/PeoplePage.jsx` | `admin_users()`, `manage_user()` |
| Analytics | `pages/OverviewPage.jsx` | `analytics()` |
| Scheduled maintenance and public status | `pages/MaintenancePage.jsx`, `pages/PublicStatus.jsx` | maintenance routes, `public_status()` |
| SLA escalation | `features/notifications/NotificationCenter.jsx` | `sla_escalation_worker()` persists notifications and emits Socket.IO and optional push events. |

## Role rules to preserve

- **User:** can report incidents and see only incidents they reported. They do not see internal audit details or admin-only comments.
- **Staff:** can report incidents, see their own reports separately from assigned incidents, and update only incidents assigned to them. Staff resolution closes the incident.
- **Admin:** manages all incidents, assignments, people, maintenance, and workspace analytics. Admin accounts cannot submit incident reports.
- Enforce access in backend routes with `@auth(roles=...)` and incident ownership checks. Frontend visibility alone is not an access control.

## Live update flow

1. Save the change to MySQL using `query(sql, args, commit=True)`.
2. Build the event payload from the saved database row.
3. Emit to the smallest authorized Socket.IO room: `user:<id>`, `staff:<id>`, or `admins`.
4. Persist bell notifications before emitting `notification:new`. Emit `notification:removed` when an alert becomes stale.
5. Handle the event in `App.jsx`, update relevant local state, and deduplicate by database ID where the same event can arrive through both HTTP and Socket.IO.

Current status values are `Pending`, `In Progress`, `Resolved`, and `Closed`. Assigning a pending incident to staff starts it as `In Progress`; staff resolving an incident changes it to `Closed`.

## Adding or changing a feature

1. Search this guide and the listed files first; extend the current feature path instead of creating a duplicate route or component.
2. Keep route validation and role/ownership checks in the backend. Keep display and interaction code in the matching frontend page or component.
3. Pass all user-provided SQL values as `%s` parameters. Only use fixed, allow-listed SQL identifiers.
4. If data shape changes, update `Database/schema.sql`, `init_db()`, and any API/UI mappings that use the field.
5. If state changes live, emit after the database commit and update every relevant client role and room.
6. Add a short, plain-language comment for non-obvious feature behavior. Prefer clear names and small functions over comments that repeat the code.
7. Keep functions small and move shared backend responsibilities into `Backend/alerthub/` or shared React behavior into `Frontend/src/services/` and `Frontend/src/features/`.
8. Preserve existing role behavior, notification lifecycle, and status transitions. Check user, staff, and admin flows after cross-role changes.

## Local checks

From `Frontend/`:

```powershell
npm run lint
npm run build
```

From `Backend/`:

```powershell
python -m py_compile app.py alerthub/config.py alerthub/database.py alerthub/security.py
```

For a complete workflow check, run MySQL and Flask, then use the UI as user, staff, and admin accounts. Verify both assigned and reported staff incidents, live status changes, notification cleanup, and access restrictions.
