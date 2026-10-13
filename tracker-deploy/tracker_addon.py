"""Addon routes for the D2RM Analytics tracker.

The deployed analytics-server.py predates these endpoints, so they are
defined here and wired up from wsgi.py:

  GET /                                     status / dashboard page
  GET /api/visits?site=&days=&limit=&offset= paginated visit data
  GET /api/sites                            tracked sites with totals
"""

import sqlite3

from flask import g, jsonify, request, Response


def register(app, base):
    """Register the addon routes on the base tracker Flask app.

    `base` is the loaded analytics-server module (provides DB_PATH,
    ALLOWED_SITES and _range_args); `app` is its Flask instance.
    """
    DB_PATH = base.DB_PATH
    _range_args = base._range_args

    def get_db():
        db = getattr(g, "_db", None)
        if db is None:
            db = g._db = sqlite3.connect(DB_PATH)
            db.row_factory = sqlite3.Row
        return db

    @app.route("/")
    def index():
        db = get_db()
        n = db.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        sites = ", ".join(sorted(base.ALLOWED_SITES))
        return Response(
            "<!doctype html>\n"
            "<html lang=\"en\">\n"
            "<head><meta charset=\"utf-8\">"
            "<title>D2RM Analytics</title>"
            "<style>body{font-family:system-ui,sans-serif;max-width:46rem;"
            "margin:3rem auto;padding:0 1rem;color:#1a1a1a}"
            "code{background:#f2f2f2;padding:.1rem .35rem;border-radius:4px}"
            "</style></head>\n"
            "<body>\n"
            "<h1>D2RM Analytics</h1>\n"
            "<p>Tracker is running. <strong>" + str(n) + "</strong> events "
            "recorded for: " + sites + ".</p>\n"
            "<h2>Endpoints</h2>\n"
            "<ul>\n"
            "<li><code>POST /collect</code> &mdash; ingest a visit/event</li>\n"
            "<li><code>GET /tracker.js</code> &mdash; client tracking snippet</li>\n"
            "<li><code>GET /api/health</code> &mdash; service health</li>\n"
            "<li><code>GET /api/visits?site=&amp;days=&amp;limit=&amp;offset=</code>"
            " &mdash; visit data</li>\n"
            "<li><code>GET /api/sites</code> &mdash; tracked sites</li>\n"
            "<li><code>GET /api/stats?site=&amp;days=</code> &mdash; KPI summary</li>\n"
            "</ul>\n"
            "</body></html>\n",
            mimetype="text/html",
        )

    @app.route("/api/visits")
    def api_visits():
        args, err_body, err_code = _range_args()
        if err_body is not None:
            return err_body, err_code
        site, days, now, start, prev_start = args
        try:
            limit = max(1, min(500, int(request.args.get("limit", "100"))))
        except ValueError:
            limit = 100
        try:
            offset = max(0, int(request.args.get("offset", "0")))
        except ValueError:
            offset = 0
        w = "site = ? AND " if site else ""
        p = [site] if site else []
        db = get_db()
        total = db.execute(
            "SELECT COUNT(*) FROM events WHERE " + w +
            "ts >= ? AND ts < ? AND type='pageview'",
            p + [start, now]).fetchone()[0]
        rows = db.execute(
            "SELECT ts, site, sid, page, title, referrer, ref_host, device,"
            " browser, os, screen, lang, country, city, duration, engaged,"
            " utm_source, utm_medium, utm_campaign, event_name"
            " FROM events WHERE " + w +
            "ts >= ? AND ts < ? AND type='pageview'"
            " ORDER BY ts DESC LIMIT ? OFFSET ?",
            p + [start, now, limit, offset]).fetchall()
        visits = [{
            "ts": r["ts"],
            "site": r["site"],
            "sid": r["sid"],
            "page": r["page"],
            "title": r["title"],
            "referrer": r["referrer"],
            "referrer_host": r["ref_host"],
            "device": r["device"],
            "browser": r["browser"],
            "os": r["os"],
            "screen": r["screen"],
            "lang": r["lang"],
            "country": r["country"],
            "city": r["city"],
            "duration_s": r["duration"],
            "engaged": bool(r["engaged"]),
            "utm_source": r["utm_source"],
            "utm_medium": r["utm_medium"],
            "utm_campaign": r["utm_campaign"],
            "event_name": r["event_name"],
        } for r in rows]
        return jsonify({
            "ok": True,
            "site": site or "all",
            "days": days,
            "total": total,
            "limit": limit,
            "offset": offset,
            "visits": visits,
        })

    @app.route("/api/sites")
    def api_sites():
        db = get_db()
        rows = db.execute(
            "SELECT site, COUNT(*) AS events,"
            " COUNT(DISTINCT sid) AS visitors, MAX(ts) AS last_ts"
            " FROM events GROUP BY site").fetchall()
        by_site = {r["site"]: r for r in rows}
        sites = []
        for s in sorted(base.ALLOWED_SITES):
            r = by_site.get(s)
            sites.append({
                "site": s,
                "events": r["events"] if r is not None else 0,
                "visitors": r["visitors"] if r is not None else 0,
                "last_ts": r["last_ts"] if r is not None else None,
            })
        return jsonify({"ok": True, "sites": sites})
