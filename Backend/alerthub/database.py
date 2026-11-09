"""Centralize MySQL connections, parameterized queries, and schema setup."""

import os
from pathlib import Path
import mysql.connector
from .config import DB_NAME


# Connect to the configured MySQL database for a single unit of work.
def db():
    return mysql.connector.connect(
        host=os.getenv('DB_HOST', 'localhost'),
        port=int(os.getenv('DB_PORT', '3306')),
        user=os.getenv('DB_USER', 'root'),
        password=os.getenv('DB_PASSWORD', ''),
        database=DB_NAME,
    )


# Execute parameterized SQL and close its resources after every request.
def query(sql, args=(), one=False, commit=False):
    conn = db()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute(sql, args)
        result = (cur.fetchone() if one else cur.fetchall()) if cur.with_rows else None
        if commit:
            conn.commit()
            return cur.lastrowid or result
        return result
    finally:
        cur.close()
        conn.close()


# Create missing tables from the shared project schema during startup.
def init_db():
    connection = mysql.connector.connect(
        host=os.getenv('DB_HOST', 'localhost'),
        port=int(os.getenv('DB_PORT', '3306')),
        user=os.getenv('DB_USER', 'root'),
        password=os.getenv('DB_PASSWORD', ''),
    )
    try:
        cursor = connection.cursor()
        cursor.execute(
            f'CREATE DATABASE IF NOT EXISTS `{DB_NAME}` '
            'CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
        )
        connection.database = DB_NAME
        schema_path = Path(__file__).resolve().parents[2] / 'Database' / 'schema.sql'
        schema = schema_path.read_text(encoding='utf-8')
        schema = '\n'.join(line for line in schema.splitlines() if not line.lstrip().startswith('--'))
        statements = [part.strip() for part in schema.split(';') if part.strip()]
        for statement in statements:
            if statement.upper().startswith(('CREATE DATABASE', 'USE ')):
                continue
            cursor.execute(statement)
        ensure_columns(cursor)
        connection.commit()
    finally:
        cursor.close()
        connection.close()


# Add fields introduced by newer releases without changing existing incident data.
def ensure_columns(cursor):
    migrations = {
        "users": {"blocked": "BOOLEAN NOT NULL DEFAULT FALSE"},
        "incidents": {
            "assigned_to": "INT NULL",
            "resolution_notes": "TEXT NULL",
            "rating": "TINYINT NULL",
            "feedback": "VARCHAR(1000) NULL",
            "sla_due_at": "DATETIME NULL",
            "escalated_at": "DATETIME NULL",
            "resolved_at": "DATETIME NULL",
        },
        "notifications": {
            "incident_id": "INT NULL",
            "read_at": "DATETIME NULL",
        },
    }
    for table_name, columns in migrations.items():
        for column_name, column_definition in columns.items():
            cursor.execute(
                "SELECT COUNT(*) AS column_count "
                "FROM INFORMATION_SCHEMA.COLUMNS "
                "WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s AND COLUMN_NAME=%s",
                (DB_NAME, table_name, column_name),
            )
            if cursor.fetchone()[0] == 0:
                cursor.execute(
                    f"ALTER TABLE `{table_name}` ADD COLUMN `{column_name}` {column_definition}"
                )
