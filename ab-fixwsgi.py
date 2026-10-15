#!/usr/bin/env python3
"""Fix the incomplete Armor Bearer section in the WSGI file."""
import sys

WSGI_PATH = '/var/www/muse4_pythonanywhere_com_wsgi.py'

with open(WSGI_PATH) as f:
    content = f.read()

# The file ends with "try:" (incomplete). Add the missing body.
old_tail = "try:"
new_tail = """try:
    from app import app as _armor_app
    _sustained_mounts['/armorbearer'] = _armor_app
except Exception:
    traceback.print_exc()"""

if content.rstrip().endswith(old_tail):
    # Replace the trailing incomplete try: with the complete block
    content = content.rstrip()
    content = content[: -len(old_tail)] + new_tail + "\n"
    with open(WSGI_PATH, 'w') as f:
        f.write(content)
    print("WSGI fixed: Armor Bearer route added")
else:
    print("WSGI already complete or unexpected state")
    sys.exit(1)
