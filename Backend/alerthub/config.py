"""Load and validate environment-backed application settings."""

import os
import re
from dotenv import load_dotenv

# Load local environment variables before reading the database configuration.
load_dotenv()

# Validate the database name because SQL parameters cannot safely bind identifiers.
DB_NAME = os.getenv("DB_NAME", "alerthub")
if not re.fullmatch(r"[A-Za-z0-9_]+", DB_NAME):
    raise RuntimeError("DB_NAME may contain only letters, numbers, and underscores.")

# Keep development defaults separate from deployment settings and reject weak production secrets.
APP_ENV = os.getenv("APP_ENV", "development").strip().lower()
if APP_ENV not in {"development", "production"}:
    raise RuntimeError("APP_ENV must be either development or production.")


def validate_production_settings():
    """Stop production startup when required secrets or trusted origins are missing."""
    if APP_ENV != "production":
        return

    jwt_secret = os.getenv("JWT_SECRET", "").strip()
    if len(jwt_secret) < 32 or jwt_secret.startswith("REPLACE_"):
        raise RuntimeError("Production requires a random JWT_SECRET with at least 32 characters.")

    # Validate only the two MySQL accounts used by the API and schema migration.
    secret_names = ["DB_PASSWORD", "MIGRATION_DB_PASSWORD"]
    weak_secrets = [
        name
        for name in secret_names
        if len(os.getenv(name, "").strip()) < 32
        or os.getenv(name, "").strip().startswith("REPLACE_")
    ]
    if weak_secrets:
        raise RuntimeError(f"Replace production secrets: {', '.join(weak_secrets)}.")

    frontend_origins = [
        origin.strip().rstrip("/")
        for origin in os.getenv("FRONTEND_ORIGIN", "").split(",")
        if origin.strip()
    ]
    public_domain = os.getenv("PUBLIC_DOMAIN", "").strip().lower()
    domain_label = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
    if not public_domain or not re.fullmatch(rf"{domain_label}(?:\.{domain_label})+", public_domain):
        raise RuntimeError("Production requires PUBLIC_DOMAIN for HTTPS and origin validation.")
    if not frontend_origins or any(
        not origin.startswith("https://")
        or origin == "*"
        or "localhost" in origin
        or "127.0.0.1" in origin
        for origin in frontend_origins
    ):
        raise RuntimeError("Production FRONTEND_ORIGIN must list trusted public HTTPS origins.")
    required_settings = (
        "DB_HOST",
        "DB_USER",
        "DB_PASSWORD",
        "VAPID_PUBLIC_KEY",
        "VAPID_PRIVATE_KEY",
        "VAPID_SUBJECT",
    )
    missing = [name for name in required_settings if not os.getenv(name, "").strip()]
    if missing:
        raise RuntimeError(f"Missing production settings: {', '.join(missing)}.")

    if os.getenv("VAPID_PUBLIC_KEY", "").startswith("REPLACE_"):
        raise RuntimeError("Set VAPID_PUBLIC_KEY to the public half of your VAPID key pair.")
    if not os.path.isfile(os.getenv("VAPID_PRIVATE_KEY", "")):
        raise RuntimeError("The configured VAPID private key file is missing from its mounted secret.")

    if os.getenv("FLASK_DEBUG", "0").strip().lower() in {"1", "true", "yes"}:
        raise RuntimeError("FLASK_DEBUG must be disabled in production.")
