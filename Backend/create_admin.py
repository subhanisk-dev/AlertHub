"""Create the initial admin. Usage: python create_admin.py name email password"""
#python create_admin.py "Admin Name" admin@example.com

import sys
from getpass import getpass
from werkzeug.security import generate_password_hash
from alerthub.config import APP_ENV
from app import init_db, query

if len(sys.argv) not in (3,4):
    raise SystemExit('Usage: python create_admin.py "Admin name" admin@example.com [password]')
password=sys.argv[3] if len(sys.argv)==4 else getpass('Admin password (8+ characters): ')
if len(password) < 8:
    raise SystemExit('Password must be at least 8 characters.')
# Local setup may create the database; production migrations run as a separate deployment step.
if APP_ENV != 'production':
    init_db()
query("INSERT INTO users(name,email,password_hash,role) VALUES(%s,%s,%s,'admin')", (sys.argv[1], sys.argv[2].lower(), generate_password_hash(password)), commit=True)
print('Admin account created.')
