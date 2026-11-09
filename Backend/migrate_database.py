# Purpose: Apply the shared MySQL schema and additive column migrations.
# Role: Let deployment update database structure with a separate migration account.
"""Apply the shared MySQL schema and safe additive migrations as a one-off deploy step."""

from alerthub.database import init_db


def main():
    # Migrations use a database-scoped account and never create a server database.
    init_db(create_database=False)
    print("AlertHub database schema is up to date.")


if __name__ == "__main__":
    main()
