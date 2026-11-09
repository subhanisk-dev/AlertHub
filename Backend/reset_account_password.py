# Purpose: Reset a selected account password from a trusted server console.
# Role: Restore access without email delivery or exposing the new password in shell history.
"""Let an administrator reset any AlertHub account without sending email."""

import sys
from getpass import getpass
from werkzeug.security import generate_password_hash
from app import query


def main():
    # Require an exact account email so the password change is deliberate.
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python reset_account_password.py member@example.com")

    email = sys.argv[1].strip().lower()
    member = query(
        "SELECT id, name, role FROM users WHERE email=%s",
        (email,),
        one=True,
    )
    if not member:
        raise SystemExit("No account found for that email address.")

    # Read passwords without echoing them to the terminal or command history.
    password = getpass("New password (8+ characters): ")
    confirmation = getpass("Confirm new password: ")
    if len(password) < 8:
        raise SystemExit("Password must be at least 8 characters.")
    if password != confirmation:
        raise SystemExit("Passwords do not match; no change was made.")

    query(
        "UPDATE users SET password_hash=%s WHERE id=%s",
        (generate_password_hash(password), member["id"]),
        commit=True,
    )
    print(f"Password updated for {member['role']} account: {member['name']} ({email})")


if __name__ == "__main__":
    main()
