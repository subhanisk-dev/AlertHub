#!/bin/sh
set -eu

# Restrict the API's database user to row operations; schema changes use the separate migrator.
case "${MYSQL_RUNTIME_PASSWORD:-}" in
    ''|*[!a-fA-F0-9]*)
        echo "MYSQL_RUNTIME_PASSWORD must be a non-empty hexadecimal secret." >&2
        exit 1
        ;;
esac

if [ "${#MYSQL_RUNTIME_PASSWORD}" -lt 32 ]; then
    echo "MYSQL_RUNTIME_PASSWORD must contain at least 32 hexadecimal characters." >&2
    exit 1
fi

case "${MYSQL_DATABASE:-}" in
    ''|*[!a-zA-Z0-9_]*)
        echo "MYSQL_DATABASE may contain only letters, numbers, and underscores." >&2
        exit 1
        ;;
esac

mysql --protocol=socket -uroot -p"${MYSQL_ROOT_PASSWORD}" <<SQL
CREATE USER IF NOT EXISTS 'alerthub_runtime'@'%' IDENTIFIED BY '${MYSQL_RUNTIME_PASSWORD}';
ALTER USER 'alerthub_runtime'@'%' IDENTIFIED BY '${MYSQL_RUNTIME_PASSWORD}';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${MYSQL_DATABASE}\`.* TO 'alerthub_runtime'@'%';
FLUSH PRIVILEGES;
SQL
