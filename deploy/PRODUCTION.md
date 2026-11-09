# Deploy AlertHub for a client

This deployment runs the React site, Flask API, Socket.IO, SLA worker, and MySQL with Docker Compose. Caddy obtains and renews HTTPS certificates for the public domain. MySQL and uploads use persistent Docker volumes.

## Before setup

- A Linux server with Docker Engine and the Docker Compose plugin.
- A domain whose DNS `A` record points to the server's public IPv4 address. Add an `AAAA` record only if the server accepts IPv6 traffic.
- Public inbound ports 80 and 443 open in the server firewall.
- Node.js installed temporarily on the deployment machine for generating VAPID keys.

The supplied Compose configuration keeps MySQL and Flask private to the Docker network. Only the HTTPS reverse proxy publishes ports.

## Configure production secrets

From the repository root, copy `.env.production.example` to `.env.production`. Set `PUBLIC_DOMAIN` and `FRONTEND_ORIGIN` to the exact client domain, then generate separate 32-byte hex secrets for the JWT, migration database account, and MySQL root. Use one additional 32-byte hex secret for `MYSQL_RUNTIME_PASSWORD`; Compose uses that same value to create the restricted runtime database account and configure Flask.

Generate each value with Node.js:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Paste each generated value into its matching field in `.env.production`, reusing the runtime password only for `MYSQL_RUNTIME_PASSWORD`. Keep `VITE_API_URL` empty to use same-origin API and WebSocket routing. Keep `DB_NAME=alerthub`; the runtime account grants are scoped to that database.

Generate the browser push key pair once on the deployment machine:

```sh
node Backend/generate_vapid_keys.mjs
mkdir -p secrets
cp Backend/vapid_private.pem secrets/vapid_private.pem
chmod 600 secrets/vapid_private.pem
```

Copy `VAPID_PUBLIC_KEY` from the ignored `Backend/.env` into `.env.production`. Keep `secrets/vapid_private.pem` private and out of Git. Use the same VAPID pair for later releases so existing push subscriptions remain valid.

## Start the hosted services

Run from the repository root after DNS is pointing at the server:

```sh
docker compose --env-file .env.production up --build -d
```

Compose starts MySQL, applies the schema through the separate migration account, creates a restricted CRUD-only API database user, starts Flask with one threaded Gunicorn worker, builds the minified React site, and puts Caddy in front to serve HTTPS. The single backend worker keeps in-memory Socket.IO presence and the SLA task consistent.

Create the first administrator interactively:

```sh
docker compose --env-file .env.production exec backend python create_admin.py "Workspace Admin" admin@your-domain.com
```

The command prompts for the password so it is not saved in shell history.

## Confirm deployment

- Visit `https://alerts.example.com` and sign in with the new admin account.
- Visit `https://alerts.example.com/api/health`; expect `{"database":"connected","status":"ok"}`.
- Register a user and staff account, assign a report, and confirm live status and notification updates over Socket.IO.
- Upload and retrieve an attachment, then restart the containers and confirm the file is still present.
- Enable browser push over HTTPS and send a test incident update.
- Run Lighthouse against the HTTPS domain after the production deployment, not Vite's development port 5173.

Useful operations:

```sh
docker compose --env-file .env.production ps
docker compose --env-file .env.production logs -f backend proxy
docker compose --env-file .env.production up --build -d
bash deploy/backup.sh
```

## Data and schema maintenance

`mysql_data` stores the MySQL database and `uploads` stores incident evidence. Back up both volumes and keep copies outside the server. `deploy/backup.sh` creates compressed database and upload backups.

The backend image runs as a non-root Linux user. Its database credentials can select, insert, update, and delete rows only. Schema changes run in the one-off `migrate` service using the separate database-scoped migration account. Back up MySQL before applying a migration to client data.

This Compose stack is a single-host deployment. It intentionally runs one Gunicorn worker because the current presence registry and SLA scheduler are process-local. Running multiple backend replicas requires shared Socket.IO coordination and moving the SLA scheduler to a single dedicated worker.
