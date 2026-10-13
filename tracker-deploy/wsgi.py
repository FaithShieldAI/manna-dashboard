"""Production WSGI entrypoint for the D2RM Analytics Server.

Initializes the SQLite DB on startup, then exposes the Flask app
for gunicorn / Railway / Render / Fly.io.

Run locally:
    gunicorn wsgi:app --bind 0.0.0.0:5058
"""
import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "analytics_server", os.path.join(HERE, "analytics-server.py"))
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

_mod.init_db()
app = _mod.app

# Addon routes (/, /api/visits, /api/sites) that the base server file
# predates. Registered here so the tracker serves them at the root.
_addon_spec = importlib.util.spec_from_file_location(
    "tracker_addon", os.path.join(HERE, "tracker_addon.py"))
_addon = importlib.util.module_from_spec(_addon_spec)
_addon_spec.loader.exec_module(_addon)
_addon.register(app, _mod)

# Railway/Render/Fly inject PORT; default for local runs.
port = int(os.environ.get("PORT", os.environ.get("ANALYTICS_PORT", "5058")))
