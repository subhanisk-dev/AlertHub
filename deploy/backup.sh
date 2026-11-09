#!/usr/bin/env bash
set -euo pipefail

# Create timestamped database and evidence backups outside the Docker volumes.
backup_dir="${BACKUP_DIR:-./backups}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"

docker compose --env-file .env.production exec -T db sh -c \
  'exec mysqldump --single-transaction --routines --triggers -u "$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' \
  | gzip -c > "$backup_dir/alerthub-database-$timestamp.sql.gz"

docker compose --env-file .env.production exec -T backend \
  tar -czf - -C /var/lib/alerthub/uploads . \
  > "$backup_dir/alerthub-uploads-$timestamp.tar.gz"

printf 'Created backups in %s\n' "$backup_dir"
