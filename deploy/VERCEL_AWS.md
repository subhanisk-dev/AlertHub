# Put the React frontend on Vercel and the Flask API on AWS

This setup serves the React app from Vercel and runs Flask, Socket.IO, MySQL, and uploaded files on one AWS EC2 Ubuntu server using native Linux services.

## What you need

- An AWS EC2 Ubuntu 24.04 server with a stable public IP (an Elastic IP is easiest for DNS).
- A domain name, with an API subdomain such as `api.example.com` pointed at the EC2 public IP.
- An AWS security group allowing SSH from your own IP and TCP ports 80 and 443 from the internet. Do not open MySQL port 3306 publicly.
- A Vercel project connected to this GitHub repository.

## Configure Vercel

In Vercel, import the repository and set **Root Directory** to `Frontend`. Use the Vite framework preset, build command `npm run build`, and output directory `dist`.

Add a Production environment variable:

```text
VITE_API_URL=https://api.example.com
```

Replace the example hostname with your real API subdomain and redeploy the Vercel project after changing this value. The `Frontend/vercel.json` file serves the `/status` React route and adds browser security headers.

## Prepare the EC2 server

Connect over SSH, then install the native services:

```bash
sudo apt update
sudo apt install -y git python3-venv python3-dev build-essential default-libmysqlclient-dev mysql-server
```

Install Caddy using its official Ubuntu repository instructions at https://caddyserver.com/docs/install#debian-ubuntu-raspbian. Caddy will obtain and renew HTTPS certificates for the API subdomain.

Create the service account and persistent upload directory:

```bash
sudo adduser --system --group --home /opt/alerthub alerthub
sudo mkdir -p /opt/alerthub /var/lib/alerthub/uploads /etc/alerthub
sudo chown -R alerthub:alerthub /opt/alerthub /var/lib/alerthub
```

Clone the public project and install its pinned Python dependencies:

```bash
sudo -u alerthub git clone https://github.com/subhanisk-dev/AlertHub.git /opt/alerthub/source
sudo -u alerthub python3 -m venv /opt/alerthub/venv
sudo -u alerthub /opt/alerthub/venv/bin/pip install -r /opt/alerthub/source/Backend/requirements.txt
```

The systemd service expects the backend code at `/opt/alerthub/Backend`; place the cloned folders there:

```bash
sudo cp -a /opt/alerthub/source/Backend /opt/alerthub/Backend
sudo cp -a /opt/alerthub/source/Database /opt/alerthub/Database
sudo chown -R root:alerthub /opt/alerthub/Backend /opt/alerthub/Database
sudo chmod -R o-rwx /opt/alerthub/Backend /opt/alerthub/Database
```

## Configure MySQL and the application

Create a database and two local-only accounts: the migrator can apply schema changes, while the running API account can only read and change rows.

Generate three separate 64-character hexadecimal secrets on your own computer: one for `JWT_SECRET`, one for the MySQL runtime password, and one for the migration password. Run this command three times and keep the results private:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Open the local MySQL console on EC2:

```bash
sudo mysql
```

Paste the SQL below after replacing both password placeholders with the generated values, then type `exit`:

```sql
CREATE DATABASE alerthub CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'alerthub_migrator'@'127.0.0.1' IDENTIFIED BY 'REPLACE_WITH_MIGRATION_PASSWORD';
GRANT ALL PRIVILEGES ON alerthub.* TO 'alerthub_migrator'@'127.0.0.1';
CREATE USER 'alerthub_runtime'@'127.0.0.1' IDENTIFIED BY 'REPLACE_WITH_RUNTIME_PASSWORD';
GRANT SELECT, INSERT, UPDATE, DELETE ON alerthub.* TO 'alerthub_runtime'@'127.0.0.1';
FLUSH PRIVILEGES;
```

Copy the environment template and edit it with your actual domain, Vercel production URL, secrets, and the **same** database passwords used above:

```bash
sudo cp /opt/alerthub/source/deploy/aws/alerthub.env.example /etc/alerthub/alerthub.env
sudo nano /etc/alerthub/alerthub.env
sudo chown root:alerthub /etc/alerthub/alerthub.env
sudo chmod 640 /etc/alerthub/alerthub.env
```

Set `PUBLIC_DOMAIN=api.example.com` and `FRONTEND_ORIGIN=https://your-project.vercel.app`. If you also connect a custom domain to Vercel, add both HTTPS origins separated by a comma. Never put the API hostname in `FRONTEND_ORIGIN` unless the browser frontend itself is hosted there.

Reuse the VAPID key pair already in `Backend/.env` and `Backend/vapid_private.pem`. If you do not have one yet, generate it once from the project root on your Windows computer:

```powershell
node Backend\generate_vapid_keys.mjs
Select-String '^VAPID_PUBLIC_KEY=' Backend\.env
```

Copy the private key from a PowerShell window on your Windows computer to the EC2 home directory:

```powershell
scp "Backend\vapid_private.pem" <EC2_USERNAME>@<EC2_PUBLIC_IP>:vapid_private.pem
```

Then install it securely on EC2:

```bash
chmod 600 ~/vapid_private.pem
sudo install -o root -g alerthub -m 640 ~/vapid_private.pem /etc/alerthub/vapid_private.pem
rm ~/vapid_private.pem
```

Use the matching `VAPID_PUBLIC_KEY` already set for the app. Do not generate a new pair for each deployment, because saved browser subscriptions depend on it.

Apply the schema with the migrator account:

```bash
sudo -u alerthub env APP_ENV=production DB_HOST=127.0.0.1 DB_PORT=3306 DB_NAME=alerthub DB_USER=alerthub_migrator DB_PASSWORD='MIGRATION_PASSWORD' /opt/alerthub/venv/bin/python /opt/alerthub/Backend/migrate_database.py
```

Replace `MIGRATION_PASSWORD` with the same migrator password used in MySQL.

## Start Flask and configure HTTPS

Install the supplied service files and set Caddy's API hostname:

```bash
sudo cp /opt/alerthub/source/deploy/aws/alerthub.service /etc/systemd/system/alerthub.service
sudo cp /opt/alerthub/source/deploy/aws/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/api.example.com/your-real-api-domain.example/' /etc/alerthub/alerthub.env
sudo sed -i 's/api.example.com/your-real-api-domain.example/' /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl enable caddy alerthub
sudo systemctl restart caddy
sudo systemctl start alerthub
```

Check service status and logs:

```bash
sudo systemctl status alerthub --no-pager
sudo journalctl -u alerthub -n 100 --no-pager
curl https://api.example.com/api/health
```

Create the first admin account:

```bash
sudo -u alerthub bash -c 'set -a; source /etc/alerthub/alerthub.env; set +a; /opt/alerthub/venv/bin/python /opt/alerthub/Backend/create_admin.py "Workspace Admin" admin@example.com'
```

The command reads the runtime database password from the protected environment file. Replace the example email; it prompts for the admin password.

## Important behavior

- Vercel can serve the frontend while EC2 is stopped, but API requests, login, uploads, live events, and push delivery will be unavailable until EC2 starts again.
- EC2 stop/start releases its default public IPv4 address. Use an Elastic IP or update DNS each time before Caddy can serve the API hostname.
- The MySQL database and uploaded evidence live on the EC2 EBS volume. Do not terminate the instance or delete its volumes unless you have verified backups.
- Back up both MySQL and `/var/lib/alerthub/uploads` to storage outside this instance before using real client data.
- Keep the single Gunicorn worker. Socket.IO presence and the SLA background task are currently process-local.
