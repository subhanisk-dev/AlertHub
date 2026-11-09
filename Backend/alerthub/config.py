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
