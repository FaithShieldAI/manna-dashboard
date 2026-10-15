#!/usr/bin/env python3
"""Clear __pycache__ directories."""
import shutil
import os

for d in ['/home/muse4/sustained', '/home/muse4/armorbearer']:
    p = os.path.join(d, '__pycache__')
    if os.path.exists(p):
        shutil.rmtree(p)
        print(f"Cleared {p}")
    else:
        print(f"No cache at {p}")
