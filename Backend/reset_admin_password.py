"""Set a new password for an existing AlertHub admin account."""
#python reset_admin_password.py admin@example.com

import sys
from getpass import getpass

from werkzeug.security import generate_password_hash

from app import query

def main():
    """Find an admin by email and securely replace their password hash."""
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python reset_admin_password.py admin@example.com')

    email = sys.argv[1].strip().lower()
    admin = query(
        "SELECT id, name FROM users WHERE email=%s AND role='admin'",
        (email,),
        one=True,
    )
    if not admin:
        raise SystemExit('No admin account found for that email address.')

    password = getpass('New admin password (8+ characters): ')
    confirmation = getpass('Confirm new password: ')
    if len(password) < 8:
        raise SystemExit('Password must be at least 8 characters.')
    if password != confirmation:
        raise SystemExit('Passwords do not match; no change was made.')

    query(
        'UPDATE users SET password_hash=%s WHERE id=%s',
        (generate_password_hash(password), admin['id']),
        commit=True,
    )
    print(f"Password updated for admin account: {admin['name']} ({email})")


if __name__ == '__main__':
    main()
