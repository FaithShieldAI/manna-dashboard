#!/usr/bin/env python3
"""Diagnose WSGI file structure."""
WSGI_PATH = '/var/www/muse4_pythonanywhere_com_wsgi.py'

with open(WSGI_PATH) as f:
    content = f.read()

print("=== WSGI length:", len(content), "chars ===")
print()
print("=== Lines containing 'app' import or mount ===")
for i, line in enumerate(content.split('\n'), 1):
    if ('import app' in line or '_mounts[' in line or 'spec_from_file' in line 
        or 'DispatcherMiddleware' in line or 'sys.path' in line):
        print(f"{i}: {line}")
