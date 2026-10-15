#!/usr/bin/env python3
"""Test loading both apps via importlib, report exact errors."""
import sys
import importlib.util
import traceback

def test_load(name, path, attr='app'):
    print(f"=== Testing {name} from {path} ===")
    try:
        spec = importlib.util.spec_from_file_location(f'_test_{name}', path)
        mod = importlib.util.module_from_spec(spec)
        # Add the app's directory to sys.path for its imports
        import os
        d = os.path.dirname(path)
        if d not in sys.path:
            sys.path.insert(0, d)
        sys.modules[f'_test_{name}'] = mod
        spec.loader.exec_module(mod)
        app = getattr(mod, attr, None)
        print(f"OK: loaded, {attr}={type(app).__name__ if app else 'MISSING'}")
    except Exception as e:
        print(f"FAILED: {type(e).__name__}: {e}")
        traceback.print_exc()
    print()

test_load('sustained', '/home/muse4/sustained/app.py', 'app')
# Sustained WSGI uses .application, try both
test_load('sustained-app-attr', '/home/muse4/sustained/app.py', 'application')
test_load('armorbearer', '/home/muse4/armorbearer/app.py', 'app')
