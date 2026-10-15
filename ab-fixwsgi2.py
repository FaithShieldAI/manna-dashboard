#!/usr/bin/env python3
"""Fix WSGI to load apps via explicit file paths, avoiding app.py name collision."""
import sys

WSGI_PATH = '/var/www/muse4_pythonanywhere_com_wsgi.py'

with open(WSGI_PATH) as f:
    lines = f.readlines()

# Find and replace the Armor Bearer loading section
# We need to replace the sys.path-based import with importlib-based loading
out = []
in_armor_section = False
armor_replaced = False

for i, line in enumerate(lines):
    # Detect start of armor bearer section
    if 'Armor Bearer Flask app' in line and 'mounted at /armorbearer/' in line:
        in_armor_section = True
        out.append(line)
        continue
    
    if in_armor_section and not armor_replaced:
        # Skip the old sys.path-based loading code until we hit the except or end
        # Look for the try: line that starts the import block
        if '_armor_dir' in line or 'sys.path.insert' in line or line.strip() == 'try:':
            continue
        if 'from app import app as _armor_app' in line:
            # Replace with importlib-based loading
            out.append("try:\n")
            out.append("    import importlib.util\n")
            out.append("    _armor_spec = importlib.util.spec_from_file_location(\n")
            out.append("        '_armor_app_module', '/home/muse4/armorbearer/app.py')\n")
            out.append("    _armor_mod = importlib.util.module_from_spec(_armor_spec)\n")
            out.append("    sys.modules['_armor_app_module'] = _armor_mod\n")
            out.append("    _armor_spec.loader.exec_module(_armor_mod)\n")
            out.append("    _sustained_mounts['/armorbearer'] = _armor_mod.app\n")
            armor_replaced = True
            continue
        if "_sustained_mounts['/armorbearer']" in line and '_armor_app' in line:
            continue
        if line.strip().startswith('except'):
            in_armor_section = False
            out.append(line)
            continue
        # Skip other lines in the armor section until replaced
        continue
    
    out.append(line)

with open(WSGI_PATH, 'w') as f:
    f.writelines(out)

print("WSGI fixed with importlib" if armor_replaced else "WARNING: armor section not found/replaced")
