from flask_wtf.csrf import CSRFProtect
from urllib.parse import urlparse

# Simple in-memory login rate limiter: max 5 attempts per IP per 15 minutes
import time as _time
_login_attempts = {}
def _check_rate_limit(ip):
    now = _time.time()
    attempts = _login_attempts.get(ip, [])
    attempts = [t for t in attempts if now - t < 900]  # 15 min window
    _login_attempts[ip] = attempts
    return len(attempts) < 5
def _record_attempt(ip):
    _login_attempts.setdefault(ip, []).append(_time.time())
#!/usr/bin/env python3
"""Armor Bearer affiliate platform — Phase 2.

Auth (affiliate + app_creator roles) + referral links + QR codes +
click tracking + affiliate dashboard + creator dashboard +
app submission + affiliate voting (50% approval).

Local dev:
    ARMORBEARER_DEV=1 python3 app.py
    # then open http://127.0.0.1:5060  (demo login: demo@armorbearer.app)

Production: mount under muse4.pythonanywhere.com/armorbearer/ via
DispatcherMiddleware. DO NOT deploy without Michael's permission.

Commission rule: 10% recurring for life, AFTER app store fees.
"""
import os
import io
import json
import sqlite3
import secrets
import hashlib
from datetime import datetime, timezone, timedelta

import bcrypt
import qrcode
from flask_limiter.util import get_remote_address
from flask_limiter import Limiter  # FIX 2026-10-15: Limiter was never imported by name
import flask_limiter
from flask_mail import Mail, Message
from flask import (
    Flask, request, redirect, url_for, render_template,
    jsonify, session, send_file, g, flash,
)

# ---------------------------------------------------------------- config
HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "armorbearer.db")
QR_DIR = os.path.join(HERE, "static", "qr")
os.makedirs(QR_DIR, exist_ok=True)

DEV = os.environ.get("ARMORBEARER_DEV", "") == "1"

app = Flask(__name__)
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SECURE'] = True

# --- Rate limiter: exactly ONE Flask-Limiter instance (PATCH 3) ---
# NOTE: login() also keeps its in-memory _check_rate_limit (defense in depth).
limiter = Limiter(get_remote_address, app=app, default_limits=[])

# --- Outbound mail (password reset via Brevo SMTP) ---
# Configure on the server via env: MAIL_SERVER/MAIL_PORT/MAIL_USERNAME/
# MAIL_PASSWORD/MAIL_DEFAULT_SENDER. Never commit credentials.
app.config['MAIL_SERVER'] = os.environ.get('MAIL_SERVER', 'smtp-relay.brevo.com')
app.config['MAIL_PORT'] = int(os.environ.get('MAIL_PORT', '587') or 587)
app.config['MAIL_USE_TLS'] = True
app.config['MAIL_USERNAME'] = os.environ.get('MAIL_USERNAME')
app.config['MAIL_PASSWORD'] = os.environ.get('MAIL_PASSWORD')
app.config['MAIL_DEFAULT_SENDER'] = os.environ.get(
    'MAIL_DEFAULT_SENDER', 'Armor Bearer <noreply@armorbearer.d2rm.com>')
mail = Mail(app)

RESET_TOKEN_TTL = timedelta(hours=1)  # password-reset tokens: 1 hour, single use

# --- Security headers: stamped on every response ---
@app.after_request
def set_security_headers(response):
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    # NOTE: 'unsafe-inline' on styles is temporary — pages still carry inline
    # <style> blocks. Drop it once all styles move to external CSS.
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: https://i.ytimg.com https://img.youtube.com; "
        "font-src 'self'"
    )
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
    return response

def get_secret():
    p = os.path.join(HERE, ".secret")
    if os.path.exists(p):
        return open(p, "rb").read()
    s = secrets.token_bytes(32)
    open(p, "wb").write(s)
    return s

app.secret_key = get_secret()

# Public base URL used inside QR codes / referral links. Overridable.
PUBLIC_BASE = os.environ.get("ARMORBEARER_PUBLIC_BASE", "").rstrip("/")

MILESTONES = [100, 1_000, 5_000, 10_000, 50_000, 100_000, 500_000, 1_000_000]
MILESTONE_BONUSES = {100: 500, 1_000: 1_000, 5_000: 5_000, 10_000: 10_000, 50_000: 50_000, 100_000: 100_000, 500_000: 500_000, 1_000_000: 1_000_000}

# ---------------------------------------------------------------- vetting config
UPLOAD_DIR = os.path.join(HERE, "static", "videos")
os.makedirs(UPLOAD_DIR, exist_ok=True)
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024  # 100MB per upload
ALLOWED_VIDEO_EXTS = {"mp4"}
MAX_UPLOADS_PER_AFFILIATE = 2

NOTIFY_EMAIL = os.environ.get("ARMORBEARER_NOTIFY_EMAIL", "michael@faithshield.ai")

# ---------------------------------------------------------------- db
def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB)
        g.db.row_factory = sqlite3.Row
    return g.db

@app.teardown_appcontext
def close_db(_e):
    d = g.pop("db", None)
    if d is not None:
        d.close()

def init_db():
    c = db()
    c.executescript("""
    CREATE TABLE IF NOT EXISTS users(
        id INTEGER PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        pw_hash BLOB NOT NULL,
        role TEXT NOT NULL DEFAULT 'affiliate',   -- affiliate | app_creator | admin
        name TEXT DEFAULT '',
        stripe_acct_id TEXT DEFAULT '',
        created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS password_resets(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_resets_token ON password_resets(token_hash);
    CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id);
    CREATE TABLE IF NOT EXISTS affiliates(
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        ref_code TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
        approved_at TEXT DEFAULT '',
        approval_seen INTEGER NOT NULL DEFAULT 0,
        joined_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS affiliate_videos(
        id INTEGER PRIMARY KEY,
        affiliate_id INTEGER REFERENCES affiliates(user_id),
        kind TEXT NOT NULL,            -- upload | scraped | social_link
        filename TEXT DEFAULT '',      -- uploads: stored file under static/videos/<uid>/
        video_url TEXT DEFAULT '',     -- scraped/social: original URL
        title TEXT DEFAULT '',
        thumbnail_url TEXT DEFAULT '',
        platform TEXT DEFAULT '',      -- youtube | tiktok | instagram
        created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notifications(
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,            -- pending_affiliate | ...
        to_email TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',  -- queued | sent | failed
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        sent_at TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS affiliate_profiles(
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        niche TEXT DEFAULT '',
        platform_size TEXT DEFAULT '',
        promo_idea TEXT DEFAULT '',
        dismissed INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS apps(
        id INTEGER PRIMARY KEY,
        creator_id INTEGER REFERENCES users(id),
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        price_mo REAL NOT NULL DEFAULT 8.99,
        description TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
        votes_yes INTEGER NOT NULL DEFAULT 0,
        votes_no INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS votes(
        app_id INTEGER REFERENCES apps(id),
        affiliate_id INTEGER REFERENCES affiliates(user_id),
        vote TEXT NOT NULL,                        -- yes | no
        voted_at TEXT NOT NULL,
        PRIMARY KEY (app_id, affiliate_id)
    );
    CREATE TABLE IF NOT EXISTS clicks(
        id INTEGER PRIMARY KEY,
        ref_code TEXT NOT NULL,
        app_id INTEGER,
        ip_hash TEXT NOT NULL,
        ua_hash TEXT NOT NULL,
        ts TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversions(
        id INTEGER PRIMARY KEY,
        click_id INTEGER REFERENCES clicks(id),
        affiliate_id INTEGER REFERENCES affiliates(user_id),
        app_id INTEGER REFERENCES apps(id),
        sub_id TEXT DEFAULT '',
        amount_net REAL NOT NULL,                  -- revenue AFTER app store fees
        ts TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS commissions(
        id INTEGER PRIMARY KEY,
        affiliate_id INTEGER REFERENCES affiliates(user_id),
        app_id INTEGER REFERENCES apps(id),
        period TEXT NOT NULL,                      -- YYYY-MM
        subs_active INTEGER NOT NULL DEFAULT 0,
        amount REAL NOT NULL DEFAULT 0,            -- 10% of net
        status TEXT NOT NULL DEFAULT 'pending',    -- pending | paid
        paid_at TEXT
    );
    CREATE TABLE IF NOT EXISTS payouts(
        id INTEGER PRIMARY KEY,
        affiliate_id INTEGER REFERENCES affiliates(user_id),
        period TEXT NOT NULL,
        amount REAL NOT NULL,
        stripe_transfer_id TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',    -- pending | sent | failed
        created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS milestones(
        id INTEGER PRIMARY KEY,
        affiliate_id INTEGER REFERENCES affiliates(user_id),
        app_id INTEGER REFERENCES apps(id),
        level INTEGER NOT NULL,
        bonus_amount REAL NOT NULL,
        awarded_at TEXT NOT NULL
    );
    """)
    # One-time migration: grandfather pre-vetting 'active' affiliates as approved.
    try:
        c.execute("UPDATE affiliates SET status='approved' WHERE status='active'")
    except sqlite3.Error:
        pass
    for _col in ("approved_at TEXT DEFAULT ''", "approval_seen INTEGER DEFAULT 0"):
        try:
            c.execute(f"ALTER TABLE affiliates ADD COLUMN {_col}")
        except sqlite3.Error:
            pass  # already migrated
    c.commit()
    seed_apps()

def now_iso():
    return datetime.now(timezone.utc).isoformat()

# ---------------------------------------------------------------- auth helpers
def get_user(uid):
    return db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()

def current_user():
    uid = session.get("uid")
    return get_user(uid) if uid else None

def login_required(role=None):
    def deco(f):
        from functools import wraps
        @wraps(f)
        def w(*a, **k):
            u = current_user()
            if not u:
                return redirect(url_for("login", next=request.path))
            if role and u["role"] != role and u["role"] != "admin":
                return "Forbidden", 403
            return f(u, *a, **k)
        return w
    return deco

def make_ref_code():
    return secrets.token_urlsafe(6).replace("-", "x").replace("_", "y")[:8]

# ---------------------------------------------------------------- vetting helpers
def aff_status_of(user_id):
    row = db().execute(
        "SELECT status FROM affiliates WHERE user_id=?", (user_id,)).fetchone()
    return row["status"] if row else None

def _yt_channel_id(url):
    """Best-effort YouTube channel-ID extraction. Returns None if unresolved."""
    import re
    # SSRF guard: only allow youtube.com / youtu.be hosts
    try:
        _host = urlparse(url or "").hostname or ""
    except Exception:
        return None
    if _host not in ("youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"):
        return None
    m = re.search(r"youtube\.com/channel/(UC[\w-]{22})", url or "")
    if m:
        return m.group(1)
    m = re.search(r"youtube\.com/(?:@|c/|user/)([\w.\-]+)", url or "")
    if not m:
        return None
    try:
        import requests
        r = requests.get(url, timeout=10, headers={"User-Agent": "Mozilla/5.0"})
        m2 = re.search(r'"channelId":"(UC[\w-]{22})"', r.text) or \
             re.search(r"channel_id=(UC[\w-]{22})", r.text)
        return m2.group(1) if m2 else None
    except Exception:
        return None

def scrape_youtube_recent(youtube_url, limit=3):
    """Pull up to `limit` most recent videos via the public channel RSS feed.
    No API key needed. Returns list of {title, video_url, thumbnail_url, published}."""
    cid = _yt_channel_id(youtube_url)
    if not cid:
        return []
    try:
        import requests
        import xml.etree.ElementTree as ET
        r = requests.get(
            f"https://www.youtube.com/feeds/videos.xml?channel_id={cid}", timeout=10)
        r.raise_for_status()
        ns = {"a": "http://www.w3.org/2005/Atom",
              "m": "http://search.yahoo.com/mrss/"}
        root = ET.fromstring(r.content)
        out = []
        for e in root.findall("a:entry", ns)[:limit]:
            title = (e.findtext("a:title", default="", namespaces=ns) or "").strip()
            link = e.find("a:link", ns)
            url = link.get("href") if link is not None else ""
            pub = (e.findtext("a:published", default="", namespaces=ns) or "")[:10]
            thumb = e.find("m:group/m:thumbnail", ns)
            turl = thumb.get("url") if thumb is not None else ""
            if url:
                out.append({"title": title, "video_url": url,
                            "thumbnail_url": turl, "published": pub})
        return out
    except Exception:
        return []

def record_social_videos(user_id, youtube_url="", tiktok_url="", instagram_url=""):
    """Store scraped/social video refs for vetting review. Best-effort, never raises."""
    d = db()
    try:
        def _exists(u):
            return d.execute(
                "SELECT 1 FROM affiliate_videos WHERE affiliate_id=? AND video_url=?",
                (user_id, u)).fetchone()

        yt = (youtube_url or "").strip()
        if yt:
            vids = scrape_youtube_recent(yt)
            if vids:
                for v in vids:
                    if not _exists(v["video_url"]):
                        d.execute(
                            "INSERT INTO affiliate_videos(affiliate_id, kind, video_url, title,"
                            " thumbnail_url, platform, created_at) VALUES(?,?,?,?,?,?,?)",
                            (user_id, "scraped", v["video_url"], v["title"],
                             v["thumbnail_url"], "youtube", now_iso()))
            elif not _exists(yt):
                d.execute(
                    "INSERT INTO affiliate_videos(affiliate_id, kind, video_url, title,"
                    " platform, created_at) VALUES(?,?,?,?,?,?)",
                    (user_id, "social_link", yt, "YouTube channel (auto-pull failed)",
                     "youtube", now_iso()))
        for platform, surl in (("tiktok", tiktok_url), ("instagram", instagram_url)):
            surl = (surl or "").strip()
            if surl and not _exists(surl):
                d.execute(
                    "INSERT INTO affiliate_videos(affiliate_id, kind, video_url, title,"
                    " platform, created_at) VALUES(?,?,?,?,?,?)",
                    (user_id, "social_link", surl,
                     f"{platform.title()} profile (manual review)", platform, now_iso()))
        d.commit()
    except Exception as e:
        print(f"[vetting] social scrape failed for user {user_id}: {e}")

# ---------------------------------------------------------------- notifications
def _smtp_config():
    host = os.environ.get("ARMORBEARER_SMTP_HOST", "").strip()
    if not host:
        return None
    return {
        "host": host,
        "port": int(os.environ.get("ARMORBEARER_SMTP_PORT", "587") or 587),
        "user": os.environ.get("ARMORBEARER_SMTP_USER", ""),
        "password": os.environ.get("ARMORBEARER_SMTP_PASS", ""),
        "from": os.environ.get("ARMORBEARER_SMTP_FROM", "") or
                os.environ.get("ARMORBEARER_SMTP_USER", ""),
        "tls": os.environ.get("ARMORBEARER_SMTP_TLS", "1") != "0",
    }

def send_email(to_email, subject, body):
    """Send via SMTP if configured. Returns True on success, False otherwise."""
    cfg = _smtp_config()
    if not cfg:
        return False
    try:
        import smtplib
        from email.message import EmailMessage
        msg = EmailMessage()
        msg["From"] = cfg["from"]
        msg["To"] = to_email
        msg["Subject"] = subject
        msg.set_content(body)
        with smtplib.SMTP(cfg["host"], cfg["port"], timeout=15) as s:
            if cfg["tls"]:
                s.starttls()
            if cfg["user"]:
                s.login(cfg["user"], cfg["password"])
            s.send_message(msg)
        return True
    except Exception as e:
        print(f"[notify] smtp failed: {e}")
        return False

def drain_notifications(limit=20):
    """Attempt delivery of queued notifications. Returns count sent."""
    d = db()
    rows = d.execute(
        "SELECT * FROM notifications WHERE status='queued' ORDER BY id LIMIT ?",
        (limit,)).fetchall()
    sent = 0
    for r in rows:
        if send_email(r["to_email"], r["subject"], r["body"]):
            d.execute("UPDATE notifications SET status='sent', sent_at=? WHERE id=?",
                      (now_iso(), r["id"]))
            sent += 1
        else:
            d.execute("UPDATE notifications SET attempts=attempts+1 WHERE id=?",
                      (r["id"],))
    d.commit()
    return sent

def notify_admin_new_pending(user_id):
    """Queue + attempt an email to Michael about a new pending affiliate.
    Best-effort: never raises, always records to the outbox table."""
    d = db()
    try:
        u = get_user(user_id)
        aff = d.execute("SELECT * FROM affiliates WHERE user_id=?",
                        (user_id,)).fetchone()
        if not u or not aff or aff["status"] != "pending":
            return
        vids = d.execute(
            "SELECT kind, video_url, title, platform FROM affiliate_videos "
            "WHERE affiliate_id=? ORDER BY created_at", (user_id,)).fetchall()
        base = PUBLIC_BASE or "https://muse4.pythonanywhere.com/armorbearer"
        lines = [
            "New Armor Bearer affiliate is pending review.",
            "",
            f"Name:   {u['name'] or '(none)'}",
            f"Email:  {u['email']}",
            f"Joined: {aff['joined_at'][:16].replace('T', ' ')} UTC",
            "",
            "Videos / social links for review:",
        ]
        if vids:
            for v in vids:
                label = {"upload": "Uploaded video", "scraped": "YouTube (auto-pulled)",
                         "social_link": "Profile link"}.get(v["kind"], v["kind"])
                lines.append(f"  - [{label}] {v['title'] or v['video_url']} :: {v['video_url']}")
        else:
            lines.append("  (none provided yet — affiliate was asked to upload 1-2 videos)")
        lines += [
            "",
            f"Review now: {base}/admin/affiliates",
            "",
            "Approve or reject from the admin review page. Approved affiliates get",
            "their referral link + QR code activated immediately.",
        ]
        body = "\n".join(lines)
        subject = f"[Armor Bearer] New affiliate pending review: {u['name'] or u['email']}"
        cur = d.execute(
            "INSERT INTO notifications(kind, to_email, subject, body, status, created_at)"
            " VALUES('pending_affiliate',?,?,?,'queued',?)",
            (NOTIFY_EMAIL, subject, body, now_iso()))
        d.commit()
        if send_email(NOTIFY_EMAIL, subject, body):
            d.execute("UPDATE notifications SET status='sent', sent_at=? WHERE id=?",
                      (now_iso(), cur.lastrowid))
            d.commit()
    except Exception as e:
        print(f"[notify] failed for user {user_id}: {e}")

def base_url():
    if PUBLIC_BASE:
        return PUBLIC_BASE
    # App is mounted at /armorbearer on PythonAnywhere — include the prefix
    return request.host_url.rstrip("/") + "/armorbearer"

def ensure_affiliate(user_id, link_base=None):
    """Create affiliate row + QR code if missing. New affiliates start 'pending'
    vetting; QR/link stay gated until an admin approves. Returns ref_code."""
    d = db()
    row = d.execute("SELECT ref_code FROM affiliates WHERE user_id=?", (user_id,)).fetchone()
    if row:
        return row["ref_code"]
    for _ in range(5):
        code = make_ref_code()
        try:
            d.execute(
                "INSERT INTO affiliates(user_id, ref_code, status, joined_at)"
                " VALUES(?,?, 'pending',?)",
                (user_id, code, now_iso()))
            d.commit()
            break
        except sqlite3.IntegrityError:
            continue
    base = link_base or (PUBLIC_BASE if PUBLIC_BASE else "http://localhost:5060")
    qr_path = os.path.join(QR_DIR, f"{code}.png")
    img = qrcode.make(f"{base}/r/{code}")
    img.save(qr_path)
    return code

# ---------------------------------------------------------------- routes
@app.route("/")
def index():
    u = current_user()
    if u:
        return redirect(url_for("dashboard"))
    return render_template("index.html")
@app.route("/leaderboard")
def leaderboard():
    d = db()
    leaders = d.execute("SELECT u.name, a.ref_code, COALESCE(SUM(c.amount),0) as earned, COALESCE(SUM(c.subs_active),0) as subs FROM users u JOIN affiliates a ON a.user_id=u.id LEFT JOIN commissions c ON c.affiliate_id=u.id WHERE a.status='approved' GROUP BY u.id, u.name, a.ref_code HAVING earned > 0 ORDER BY earned DESC LIMIT 25").fetchall()
    return render_template("leaderboard.html", leaders=leaders)

@app.route("/terms")
def terms():
    return render_template("terms.html")


@app.route("/privacy")
def privacy():
    return render_template("privacy.html")



def _valid_password(pw):
    """12-72 chars, at least one letter and one number. Signup + reset."""
    return (isinstance(pw, str) and 12 <= len(pw) <= 72
            and len(pw.encode("utf-8")) <= 72
            and any(c.isalpha() for c in pw)
            and any(c.isdigit() for c in pw))

@app.route("/signup", methods=["GET", "POST"])
@limiter.limit("5 per hour", methods=["POST"])  # FIX 2026-10-15: signup had no rate limiting
def signup():
    # 30-second signup: name + email + password only. Everything else
    # (niche, audience size, socials, promo idea, role) moves to the
    # dismissible "Complete your profile" step on the dashboard.
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()[:254]
        pw = request.form.get("password", "")
        name = request.form.get("name", "").strip()[:100]
        if not email or "@" not in email or not _valid_password(pw):
            return render_template("signup.html", error="Valid email and a 12+ character password with at least one letter and one number are required.")
        d = db()
        if d.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
            return render_template("signup.html", error="If this email is not already registered, an account has been created.")
        pw_hash = bcrypt.hashpw(pw.encode(), bcrypt.gensalt(12))
        cur = d.execute(
            "INSERT INTO users(email, pw_hash, role, name, created_at) VALUES(?,?,?,?,?)",
            (email, pw_hash, "affiliate", name, now_iso()))
        d.commit()
        uid = cur.lastrowid
        ensure_affiliate(uid, link_base=base_url())
        # Eyes-on-every-decision: notify Michael about the new pending affiliate.
        notify_admin_new_pending(uid)
        session["uid"] = uid
        return redirect(url_for("dashboard"))
    return render_template("signup.html")

@app.route("/login", methods=["GET", "POST"])
@limiter.limit("10/minute;100/hour", methods=["POST"])  # PATCH 3: brute-force protection
def login():
    if request.method == "POST":
        # Rate limiter: block brute force
        _ip = request.remote_addr or "unknown"
        if not _check_rate_limit(_ip):
            return render_template("login.html", err="Too many attempts. Try again in 15 minutes."), 429
        _record_attempt(_ip)
        email = request.form.get("email", "").strip().lower()
        pw = request.form.get("password", "")
        d = db()
        u = d.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        if u and bcrypt.checkpw(pw.encode(), u["pw_hash"]):
            session["uid"] = u["id"]
            if u["role"] == "affiliate":
                ensure_affiliate(u["id"], link_base=base_url())
            nxt = request.args.get("next") or url_for("dashboard")
            # Open redirect guard: only allow relative URLs
            _p = urlparse(nxt)
            if _p.scheme or _p.netloc or not nxt.startswith('/'):
                nxt = url_for("dashboard")
            return redirect(nxt)
        return render_template("login.html", err="Invalid email or password.")
    return render_template("login.html")

@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("index"))

# ---------------------------------------------------------------- password reset
# Routes are /forgot-password and /reset/<token> (NO /armorbearer <redacted> —
# the app is mounted via DispatcherMiddleware). Templates forgot_password.html
# and reset_password.html are deployed; both forms carry csrf_token().

def _hash_token(token: str) -> str:
    """SHA-256 hex of the plaintext token. Plaintext is never stored."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()

def generate_reset_token(user_id: int, ip: str) -> str:
    """Create a single-use 1-hour token. Returns PLAINTEXT (emailed only)."""
    token = secrets.token_urlsafe(32)          # ~43 chars, 256 bits
    token_hash = _hash_token(token)
    expires_at = (datetime.now(timezone.utc) + RESET_TOKEN_TTL).isoformat()
    d = db()
    d.execute(
        "INSERT INTO password_resets (user_id, token_hash, expires_at, created_ip)"
        " VALUES (?, ?, ?, ?)",
        (user_id, token_hash, expires_at, ip),
    )
    d.commit()
    return token

def find_valid_reset(token: str):
    """Return the reset row if valid (exists, unused, unexpired), else None."""
    if not token or len(token) > 128:
        return None
    presented = _hash_token(token)
    row = db().execute(
        "SELECT id, user_id, expires_at FROM password_resets"
        " WHERE token_hash = ? AND used_at IS NULL",
        (presented,),
    ).fetchone()
    if not row:
        return None
    # ISO-8601 UTC strings from now_iso() sort lexicographically.
    if row["expires_at"] < datetime.now(timezone.utc).isoformat():
        return None
    return row

def mark_reset_used(reset_id: int):
    db().execute(
        "UPDATE password_resets SET used_at = ? WHERE id = ?",
        (now_iso(), reset_id),
    )
    db().commit()

def revoke_user_resets(user_id: int):
    """Invalidate ALL outstanding tokens for a user (after a reset)."""
    db().execute(
        "UPDATE password_resets SET used_at = ?"
        " WHERE user_id = ? AND used_at IS NULL",
        (now_iso(), user_id),
    )
    db().commit()

def send_reset_email(to_email: str, to_name: str, token: str):
    """Send the reset email via Brevo. NEVER log the token or full URL."""
    # base_url() is mount-aware: https://muse4.pythonanywhere.com/armorbearer
    reset_url = base_url() + url_for("reset_password", token=token)
    subject = "Reset your Armor Bearer password"
    text_body = (
        "Hi %s,\n\n"
        "We got a request to reset the password for your Armor Bearer affiliate account.\n\n"
        "Reset your password here (expires in 1 hour, one-time use):\n%s\n\n"
        "Didn't ask for this? Just ignore this email \u2014 your password stays the same.\n\n"
        "\u2014 Armor Bearer / D2RM" % (to_name or "there", reset_url)
    )
    html_body = (
        "<p>Hi %s,</p>"
        "<p>We got a request to reset the password for your Armor Bearer affiliate account.</p>"
        '<p><a href="%s" style="display:inline-block;background:#d32535;color:#fff;'
        'text-decoration:none;font-weight:bold;padding:12px 26px;border-radius:8px;">'
        "Reset my password</a></p>"
        "<p>This link expires in <strong>1 hour</strong> and can only be used once.</p>"
        "<p>Didn&rsquo;t ask for this? Just ignore this email &mdash; your password stays the same.</p>"
        "<p>&mdash; Armor Bearer / D2RM</p>" % (to_name or "there", reset_url)
    )
    msg = Message(subject=subject, recipients=[to_email])
    msg.body = text_body
    msg.html = html_body
    mail.send(msg)

@app.route("/forgot-password", methods=["GET", "POST"])
@limiter.limit("5/hour", methods=["POST"])
def forgot_password():
    """Identical response whether or not the email exists (no enumeration)."""
    if session.get("uid"):
        return redirect(url_for("dashboard"))
    if request.method == "GET":
        return render_template("forgot_password.html")
    email = (request.form.get("email") or "").strip().lower()[:254]
    ip = get_remote_address()
    user = db().execute(
        "SELECT id, email, name FROM users WHERE email = ?", (email,)
    ).fetchone()
    if user:
        token = generate_reset_token(user["id"], ip)
        try:
            send_reset_email(user["email"], user["name"], token)
        except Exception:
            # Never leak SMTP failures; the response stays identical.
            app.logger.exception("password reset email failed")
    else:
        # Constant-time dummy work to blunt timing-based enumeration.
        _hash_token(secrets.token_urlsafe(32))
    return render_template("forgot_password.html", sent=True, email=email)

@app.route("/reset/<token>", methods=["GET", "POST"])
@limiter.limit("10/hour", methods=["POST"])
def reset_password(token):
    reset_row = find_valid_reset(token or "")
    if not reset_row:
        return render_template("reset_password.html", invalid=True)
    if request.method == "GET":
        return render_template("reset_password.html")
    pw1 = request.form.get("password") or ""
    pw2 = request.form.get("password2") or ""
    if not _valid_password(pw1):
        return render_template("reset_password.html",
                               err="Password must be 12+ characters with at least one letter and one number.")
    if pw1 != pw2:
        return render_template("reset_password.html",
                               err="Passwords don't match.")
    d = db()
    # Re-check unused (race-safe single consumption).
    fresh = d.execute(
        "SELECT id, user_id FROM password_resets"
        " WHERE id = ? AND used_at IS NULL",
        (reset_row["id"],),
    ).fetchone()
    if not fresh:
        return render_template("reset_password.html", invalid=True)
    # bcrypt hash as BYTES into the pw_hash BLOB — exactly like signup().
    new_hash = bcrypt.hashpw(pw1.encode("utf-8"), bcrypt.gensalt(12))
    d.execute("UPDATE users SET pw_hash = ? WHERE id = ?",
              (new_hash, fresh["user_id"]))
    mark_reset_used(fresh["id"])
    revoke_user_resets(fresh["user_id"])  # kill other outstanding tokens
    d.commit()
    # Do NOT auto-login. Flash + redirect to login.
    flash("Password updated \u2014 please log in with your new password.")
    return redirect(url_for("login"))

@app.route("/dashboard")
@login_required()
def dashboard(u):
    d = db()
    error = session.pop("dash_error", None)
    if u["role"] == "affiliate":
        aff = d.execute("SELECT * FROM affiliates WHERE user_id=?", (u["id"],)).fetchone()
        code = aff["ref_code"] if aff else ensure_affiliate(u["id"])
        aff_status = aff["status"] if aff else "pending"
        approval_seen = bool(aff["approval_seen"]) if aff else False
        videos = d.execute(
            "SELECT * FROM affiliate_videos WHERE affiliate_id=? ORDER BY created_at",
            (u["id"],)).fetchall()
        uploads = [v for v in videos if v["kind"] == "upload"]
        show_approval_banner = aff_status == "approved" and not approval_seen
        # Post-signup profile nudge: show until filled in or dismissed.
        prof = d.execute(
            "SELECT * FROM affiliate_profiles WHERE user_id=?", (u["id"],)).fetchone()
        show_profile_prompt = not (prof and (prof["dismissed"] or prof["niche"]
                                             or prof["platform_size"] or prof["promo_idea"]))
        clicks = d.execute("SELECT COUNT(*) c FROM clicks WHERE ref_code=?", (code,)).fetchone()["c"]
        convs = d.execute(
            "SELECT COUNT(*) c, COALESCE(SUM(amount_net),0) s FROM conversions c "
            "JOIN affiliates a ON a.user_id=c.affiliate_id WHERE a.ref_code=?", (code,)).fetchone()
        earned = d.execute(
            "SELECT COALESCE(SUM(amount),0) s FROM commissions WHERE affiliate_id=?", (u["id"],)).fetchone()["s"]
        paid = d.execute(
            "SELECT COALESCE(SUM(amount),0) s FROM payouts WHERE affiliate_id=? AND status='sent'",
            (u["id"],)).fetchone()["s"]
        recent_clicks = d.execute(
            "SELECT ts FROM clicks WHERE ref_code=? ORDER BY ts DESC LIMIT 10", (code,)).fetchall()
        ms = d.execute(
            "SELECT level, bonus_amount, awarded_at FROM milestones WHERE affiliate_id=? ORDER BY level",
            (u["id"],)).fetchall()
        subs_active = d.execute(
            "SELECT COALESCE(SUM(subs_active),0) s FROM commissions WHERE affiliate_id=?", (u["id"],)).fetchone()["s"]
        next_ms = next((m for m in MILESTONES if m > (subs_active or 0)), None)
        return render_template("dashboard_affiliate.html", user=u, code=code,
                               base=base_url(), clicks=clicks,
                               conv_count=convs["c"], conv_net=convs["s"],
                               earned=earned, paid=paid,
                               recent_clicks=recent_clicks, milestones=ms,
                               subs_active=subs_active or 0, next_ms=next_ms,
                               all_milestones=MILESTONES,
                               aff_status=aff_status, videos=videos,
                               uploads=uploads,
                               max_uploads=MAX_UPLOADS_PER_AFFILIATE,
                               show_approval_banner=show_approval_banner,
                               show_profile_prompt=show_profile_prompt,
                               error=error)
    # app_creator / admin: Phase 2 creator dashboard with per-app performance
    my_apps = d.execute("SELECT * FROM apps WHERE creator_id=? ORDER BY created_at DESC", (u["id"],)).fetchall()
    app_stats = []
    for a in my_apps:
        convs = d.execute(
            "SELECT COUNT(*) c, COALESCE(SUM(amount_net),0) s FROM conversions WHERE app_id=?",
            (a["id"],)).fetchone()
        subs = d.execute(
            "SELECT COALESCE(SUM(subs_active),0) s FROM commissions WHERE app_id=?",
            (a["id"],)).fetchone()["s"]
        total_votes = (a["votes_yes"] or 0) + (a["votes_no"] or 0)
        pct = round(100 * a["votes_yes"] / total_votes) if total_votes else 0
        app_stats.append({
            "app": a, "conversions": convs["c"], "revenue_net": convs["s"],
            "subs_active": subs or 0, "total_votes": total_votes, "yes_pct": pct,
        })
    return render_template("dashboard_creator.html", user=u, apps=my_apps, app_stats=app_stats)

# ---------------------------------------------------------------- apps + voting
SEED_APPS = [
    {
        "name": "FaithShield AI",
        "url": "https://faithshieldai.netlify.app",
        "price_mo": 8.99,
        "description": "AI-powered Bible study and faith companion. Affiliates earn 10% recurring for life per referred subscriber.",
    },
    {
        "name": "Sustained",
        "url": "https://muse4.pythonanywhere.com/sustained/",
        "price_mo": 199.00,
        "description": "Definitive legal research repository — statutes, UCC, Constitution, case law. Affiliates earn 10% recurring for life per referred subscriber.",
    },
        {"name": "Manna", "url": "https://manna-staging.onrender.com/", "price_mo": 50.00, "description": "Big agency data, little guy money. AI-powered marketing dashboard with lead collection, email analytics, and campaign tracking. Affiliates earn 10% recurring for life per referred subscriber."},

]

def seed_apps():
    """Seed the first votable apps (idempotent). Called from init_db."""
    d = db()
    for a in SEED_APPS:
        if not d.execute("SELECT 1 FROM apps WHERE name=?", (a["name"],)).fetchone():
            d.execute(
                "INSERT INTO apps(name, url, price_mo, description, status, created_at) "
                "VALUES(?,?,?,?, 'pending', ?)",
                (a["name"], a["url"], a["price_mo"], a["description"], now_iso()))
    d.commit()

def recalc_approval(app_id):
    """An app is approved when it has at least one vote and yes >= 50%."""
    d = db()
    row = d.execute(
        "SELECT votes_yes, votes_no FROM apps WHERE id=?", (app_id,)).fetchone()
    if not row:
        return
    total = (row["votes_yes"] or 0) + (row["votes_no"] or 0)
    status = "approved" if (total > 0 and row["votes_yes"] / total >= 0.5) else "pending"
    d.execute("UPDATE apps SET status=? WHERE id=?", (status, app_id))
    d.commit()

@app.route("/apps/submit", methods=["GET", "POST"])
@login_required()
def app_submit(u):
    """Phase 2: App creators submit their app for affiliate voting."""
    if u["role"] not in ("app_creator", "admin"):
        return "Only app creators can submit apps.", 403
    if request.method == "POST":
        name = request.form.get("name", "").strip()
        url = request.form.get("url", "").strip()
        description = request.form.get("description", "").strip()
        try:
            price_mo = float(request.form.get("price_mo", "0") or 0)
        except ValueError:
            price_mo = 0
        if not name or not url or price_mo <= 0:
            return render_template("app_submit.html", user=u,
                                   error="App name, URL, and a price above $0 are required.")
        if not (url.startswith("http://") or url.startswith("https://")):
            url = "https://" + url
        d = db()
        d.execute(
            "INSERT INTO apps(creator_id, name, url, price_mo, description, status, created_at) "
            "VALUES(?,?,?, ?,?, 'pending', ?)",
            (u["id"], name, url, price_mo, description, now_iso()))
        d.commit()
        return redirect(url_for("dashboard"))
    return render_template("app_submit.html", user=u)

@app.route("/apps")
@login_required()
def apps(u):
    """Affiliate voting page — every app up for approval, with vote counts."""
    d = db()
    all_apps = d.execute(
        "SELECT * FROM apps WHERE status IN ('pending','approved') ORDER BY created_at").fetchall()
    my_votes = {}
    can_vote = False
    if u["role"] == "affiliate":
        st = aff_status_of(u["id"])
        can_vote = (st == "approved")
        rows = d.execute(
            "SELECT app_id, vote FROM votes v JOIN affiliates a ON a.user_id=v.affiliate_id "
            "WHERE a.user_id=?", (u["id"],)).fetchall()
        my_votes = {r["app_id"]: r["vote"] for r in rows}
    return render_template("apps.html", user=u, apps=all_apps, my_votes=my_votes,
                           can_vote=can_vote)

@app.route("/apps/<int:app_id>/vote", methods=["POST"])
@login_required()
def vote(u, app_id):
    """Cast or change a yes/no vote. One vote per affiliate per app."""
    if u["role"] != "affiliate" and u["role"] != "admin":
        return "Only affiliates can vote.", 403
    v = request.form.get("vote", "").strip().lower()
    if v not in ("yes", "no"):
        return "Invalid vote.", 400
    d = db()
    target = d.execute("SELECT id FROM apps WHERE id=?", (app_id,)).fetchone()
    if not target:
        return "App not found.", 404
    aff = d.execute("SELECT user_id, status FROM affiliates WHERE user_id=?", (u["id"],)).fetchone()
    if not aff:
        return "Affiliate record missing.", 400
    if aff["status"] != "approved":
        return "Voting unlocks after your affiliate account is approved.", 403
    old = d.execute(
        "SELECT vote FROM votes WHERE app_id=? AND affiliate_id=?", (app_id, u["id"])).fetchone()
    if old:
        if old["vote"] == v:
            return redirect(url_for("apps"))
        d.execute("UPDATE votes SET vote=?, voted_at=? WHERE app_id=? AND affiliate_id=?",
                  (v, now_iso(), app_id, u["id"]))
        d.execute(f"UPDATE apps SET votes_{old['vote']} = votes_{old['vote']} - 1 WHERE id=?", (app_id,))
    else:
        d.execute("INSERT INTO votes(app_id, affiliate_id, vote, voted_at) VALUES(?,?,?,?)",
                  (app_id, u["id"], v, now_iso()))
    d.execute(f"UPDATE apps SET votes_{v} = votes_{v} + 1 WHERE id=?", (app_id,))
    d.commit()
    recalc_approval(app_id)
    return redirect(url_for("apps"))

# ---------------------------------------------------------------- vetting: videos
@app.route("/affiliate/videos/upload", methods=["POST"])
@login_required()
def upload_video(u):
    """Pending affiliates upload 1-2 MP4s (max 100MB each) for manual review."""
    if u["role"] != "affiliate":
        return "Forbidden", 403
    d = db()
    n = d.execute(
        "SELECT COUNT(*) c FROM affiliate_videos WHERE affiliate_id=? AND kind='upload'",
        (u["id"],)).fetchone()["c"]
    if n >= MAX_UPLOADS_PER_AFFILIATE:
        session["dash_error"] = f"You can upload at most {MAX_UPLOADS_PER_AFFILIATE} videos."
        return redirect(url_for("dashboard"))
    f = request.files.get("video")
    if not f or not f.filename:
        session["dash_error"] = "Choose a video file to upload."
        return redirect(url_for("dashboard"))
    ext = f.filename.rsplit(".", 1)[-1].lower() if "." in f.filename else ""
    if ext not in ALLOWED_VIDEO_EXTS:
        session["dash_error"] = "Only .mp4 videos are accepted (max 100MB)."
        return redirect(url_for("dashboard"))
    udir = os.path.join(UPLOAD_DIR, str(u["id"]))
    os.makedirs(udir, exist_ok=True)
    fname = f"{secrets.token_hex(8)}.mp4"
    try:
        f.save(os.path.join(udir, fname))
    except Exception as e:
        session["dash_error"] = f"Upload failed: {e}"
        return redirect(url_for("dashboard"))
    d.execute(
        "INSERT INTO affiliate_videos(affiliate_id, kind, filename, title, created_at)"
        " VALUES(?,?,?,?,?)",
        (u["id"], "upload", fname, f.filename, now_iso()))
    d.commit()
    return redirect(url_for("dashboard"))

@app.route("/affiliate/videos/<int:vid>/delete", methods=["POST"])
@login_required()
def delete_video(u, vid):
    d = db()
    v = d.execute("SELECT * FROM affiliate_videos WHERE id=?", (vid,)).fetchone()
    if not v:
        return "Not found", 404
    if v["affiliate_id"] != u["id"] and u["role"] != "admin":
        return "Forbidden", 403
    if v["kind"] == "upload" and v["filename"]:
        p = os.path.join(UPLOAD_DIR, str(v["affiliate_id"]), v["filename"])
        if os.path.exists(p):
            os.remove(p)
    d.execute("DELETE FROM affiliate_videos WHERE id=?", (vid,))
    d.commit()
    return redirect(request.referrer or url_for("dashboard"))

@app.route("/affiliate/video/<int:vid>")
@login_required()
def serve_video(u, vid):
    """Stream an uploaded vetting video — owner or admin only."""
    d = db()
    v = d.execute("SELECT * FROM affiliate_videos WHERE id=?", (vid,)).fetchone()
    if not v or v["kind"] != "upload":
        return "Not found", 404
    if v["affiliate_id"] != u["id"] and u["role"] != "admin":
        return "Forbidden", 403
    p = os.path.join(UPLOAD_DIR, str(v["affiliate_id"]), v["filename"])
    if not os.path.exists(p):
        return "File missing", 404
    return send_file(p, mimetype="video/mp4")

@app.route("/affiliate/social", methods=["POST"])
@login_required()
def add_social(u):
    """Let affiliates add/refresh their social profile URLs after signup."""
    if u["role"] != "affiliate":
        return "Forbidden", 403
    record_social_videos(
        u["id"],
        request.form.get("youtube_url", ""),
        request.form.get("tiktok_url", ""),
        request.form.get("instagram_url", ""))
    return redirect(url_for("dashboard"))

@app.route("/profile/save", methods=["POST"])
@login_required()
def save_profile(u):
    """Post-signup 'Complete your profile' — dismissible, never a blocker."""
    d = db()
    niche = request.form.get("niche", "").strip()
    platform_size = request.form.get("platform_size", "").strip()
    promo_idea = request.form.get("promo_idea", "").strip()
    role = request.form.get("role", "affiliate")
    if role not in ("affiliate", "app_creator"):
        role = "affiliate"
    d.execute(
        "INSERT INTO affiliate_profiles(user_id, niche, platform_size, promo_idea, dismissed, updated_at)"
        " VALUES(?,?,?,?,0,?)"
        " ON CONFLICT(user_id) DO UPDATE SET niche=excluded.niche,"
        " platform_size=excluded.platform_size, promo_idea=excluded.promo_idea,"
        " dismissed=0, updated_at=excluded.updated_at",
        (u["id"], niche, platform_size, promo_idea, now_iso()))
    if role == "app_creator" and u["role"] == "affiliate":
        # They signed up as an affiliate but want the creator side.
        d.execute("UPDATE users SET role='app_creator' WHERE id=?", (u["id"],))
        d.execute("DELETE FROM affiliate_videos WHERE affiliate_id=?", (u["id"],))
        d.execute("DELETE FROM affiliates WHERE user_id=?", (u["id"],))
    d.commit()
    return redirect(url_for("dashboard"))

@app.route("/profile/dismiss", methods=["POST"])
@login_required()
def dismiss_profile(u):
    """'Skip for now' on the profile prompt — hides it for good."""
    d = db()
    d.execute(
        "INSERT INTO affiliate_profiles(user_id, niche, platform_size, promo_idea, dismissed, updated_at)"
        " VALUES(?,?,?,?,1,?)"
        " ON CONFLICT(user_id) DO UPDATE SET dismissed=1, updated_at=excluded.updated_at",
        (u["id"], "", "", "", now_iso()))
    d.commit()
    return redirect(url_for("dashboard"))

@app.route("/dashboard/dismiss-approval", methods=["POST"])
@login_required()
def dismiss_approval(u):
    db().execute("UPDATE affiliates SET approval_seen=1 WHERE user_id=?", (u["id"],))
    db().commit()
    return redirect(url_for("dashboard"))

# ---------------------------------------------------------------- vetting: admin review
@app.route("/admin/affiliates")
@login_required(role="admin")
def admin_affiliates(u):
    """Eyes-on-every-decision: review pending affiliates with their videos."""
    d = db()
    def _rows(status):
        rows = d.execute(
            "SELECT a.*, us.email, us.name, us.created_at AS u_created "
            "FROM affiliates a JOIN users us ON us.id=a.user_id "
            "WHERE a.status=? ORDER BY a.joined_at", (status,)).fetchall()
        out = []
        for r in rows:
            vids = d.execute(
                "SELECT * FROM affiliate_videos WHERE affiliate_id=? ORDER BY created_at",
                (r["user_id"],)).fetchall()
            out.append({"aff": r, "videos": vids,
                        "uploads": [v for v in vids if v["kind"] == "upload"],
                        "links": [v for v in vids if v["kind"] != "upload"]})
        return out
    counts = {s: d.execute("SELECT COUNT(*) c FROM affiliates WHERE status=?", (s,)).fetchone()["c"]
              for s in ("pending", "approved", "rejected")}
    return render_template("admin_affiliates.html", user=u,
                           pending=_rows("pending"), approved=_rows("approved"),
                           rejected=_rows("rejected"), counts=counts)

@app.route("/admin/affiliates/<int:uid>/approve", methods=["POST"])
@login_required(role="admin")
def admin_approve(u, uid):
    d = db()
    d.execute(
        "UPDATE affiliates SET status='approved', approved_at=?, approval_seen=0 WHERE user_id=?",
        (now_iso(), uid))
    d.commit()
    ensure_affiliate(uid, link_base=base_url())  # no-op if row exists; ensures QR file
    d2 = db()
    row = d2.execute("SELECT ref_code FROM affiliates WHERE user_id=?", (uid,)).fetchone()
    if row:
        qp = os.path.join(QR_DIR, f"{row['ref_code']}.png")
        if not os.path.exists(qp):
            img = qrcode.make(f"{base_url()}/r/{row['ref_code']}")
            img.save(qp)
    return redirect(url_for("admin_affiliates"))

@app.route("/admin/affiliates/<int:uid>/reject", methods=["POST"])
@login_required(role="admin")
def admin_reject(u, uid):
    d = db()
    d.execute("UPDATE affiliates SET status='rejected' WHERE user_id=?", (uid,))
    d.commit()
    return redirect(url_for("admin_affiliates"))

@app.route("/r/<code>")
def ref_redirect(code):
    """Affiliate referral link. Logs the click, redirects to affiliate hub.
    Pending affiliates see a 'pending approval' notice instead — no clicks logged."""
    d = db()
    aff = d.execute("SELECT user_id, status FROM affiliates WHERE ref_code=?", (code,)).fetchone()
    if not aff:
        return "Invalid referral link.", 404
    if aff["status"] == "pending":
        return render_template("pending_link.html"), 200
    if aff["status"] != "approved":
        return "Invalid referral link.", 404
    ip = request.headers.get("X-Forwarded-For", request.remote_addr or "")
    ip_hash = hashlib.sha256(ip.encode()).hexdigest()[:16]
    ua_hash = hashlib.sha256((request.headers.get("User-Agent", "")).encode()).hexdigest()[:16]
    # basic dedup: same ip+ua within 24h counts once
    recent = d.execute(
        "SELECT 1 FROM clicks WHERE ref_code=? AND ip_hash=? AND ua_hash=? "
        "AND ts > datetime('now','-1 day') LIMIT 1", (code, ip_hash, ua_hash)).fetchone()
    if not recent:
        d.execute("INSERT INTO clicks(ref_code, ip_hash, ua_hash, ts) VALUES(?,?,?,?)",
                  (code, ip_hash, ua_hash, now_iso()))
        d.commit()
    # Phase 1: redirect to the affiliate's QR/landing hub. Phase 2: /r/<code>/<app>
    return redirect(f"{base_url()}/hub/{code}")

@app.route("/hub/<code>")
def hub(code):
    d = db()
    aff = d.execute(
        "SELECT a.ref_code, a.status, u.name FROM affiliates a JOIN users u ON u.id=a.user_id WHERE a.ref_code=?",
        (code,)).fetchone()
    if not aff:
        return "Invalid link.", 404
    if aff["status"] == "pending":
        return render_template("pending_link.html"), 200
    if aff["status"] != "approved":
        return "Invalid link.", 404
    apps = d.execute("SELECT * FROM apps WHERE status='approved' ORDER BY created_at DESC").fetchall()
    return render_template("hub.html", code=code, name=aff["name"], apps=apps, base=base_url())

def pending_qr_image():
    """Cached 'PENDING APPROVAL' placeholder PNG for not-yet-approved affiliates."""
    from PIL import Image, ImageDraw
    p = os.path.join(QR_DIR, "_pending.png")
    if not os.path.exists(p):
        img = Image.new("RGB", (400, 400), (22, 25, 38))
        dr = ImageDraw.Draw(img)
        dr.rectangle([20, 20, 380, 380], outline=(245, 166, 35), width=6)
        for i, line in enumerate(["PENDING", "APPROVAL"]):
            dr.text((200, 165 + i * 55), line, fill=(245, 166, 35), anchor="mm")
        dr.text((200, 300), "Link activates after review", fill=(136, 146, 164), anchor="mm")
        img.save(p)
    return p

@app.route("/qr/<code>.png")
def qr(code):
    d = db()
    row = d.execute("SELECT status FROM affiliates WHERE ref_code=?", (code,)).fetchone()
    if not row:
        return "Not found", 404
    if row["status"] != "approved":
        return send_file(pending_qr_image(), mimetype="image/png")
    p = os.path.join(QR_DIR, f"{code}.png")
    if not os.path.exists(p):
        img = qrcode.make(f"{base_url()}/r/{code}")
        img.save(p)
    return send_file(p, mimetype="image/png")

@app.route("/api/me")
def api_me():
    u = current_user()
    if not u:
        return jsonify({"ok": False}), 401
    return jsonify({"ok": True, "email": u["email"], "role": u["role"], "name": u["name"]})

@app.route("/health")
def health():
    return jsonify({"ok": True, "service": "armorbearer", "phase": 2, "dev": DEV})



@app.route("/webhooks/stripe", methods=["POST"])
def stripe_webhook():
    import hmac, hashlib
    payload = request.get_data()
    # Stripe signature verification - FAIL CLOSED
    webhook_secret = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
    if not webhook_secret:
        # No secret configured: reject all webhooks rather than process unverified
        return jsonify({"error": "webhook not configured"}), 503
    sig_header = request.headers.get("Stripe-Signature", "")
    # Parse t= timestamp and v1= signature
    try:
        parts = dict(p.split("=", 1) for p in sig_header.split(",") if "=" in p)
        timestamp = parts.get("t", "")
        signature = parts.get("v1", "")
        if not timestamp or not signature:
            return jsonify({"error": "invalid signature"}), 400
        # Reject stale signatures (>5 min) to blunt replay attacks.
        try:
            if abs(_time.time() - int(timestamp)) > 300:
                return jsonify({"error": "invalid signature"}), 400
        except (ValueError, TypeError):
            return jsonify({"error": "invalid signature"}), 400
        signed_payload = f"{timestamp}.{payload.decode('utf-8')}"
        expected = hmac.new(
            webhook_secret.encode(), signed_payload.encode(), hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(expected, signature):
            return jsonify({"error": "invalid signature"}), 400
    except Exception:
        return jsonify({"error": "invalid signature"}), 400
    try:
        event = json.loads(payload)
    except:
        return jsonify({"error": "invalid payload"}), 400
    event_type = event.get("type", "")
    if event_type == "checkout.session.completed":
        d = db()
        session_data = event.get("data", {}).get("object", {})
        metadata = session_data.get("metadata", {}) or {}
        ref_code = metadata.get("ref_code") or session_data.get("client_reference_id", "")
        if not ref_code:
            return jsonify({"received": True, "attributed": False})
        aff = d.execute("SELECT user_id, ref_code FROM affiliates WHERE ref_code=? AND status='approved'", (ref_code,)).fetchone()
        if not aff:
            return jsonify({"received": True, "attributed": False, "reason": "invalid ref_code"})
        affiliate_id = aff["user_id"]
        app_id = int(metadata.get("app_id", 1))
        amount_total = session_data.get("amount_total", 0) / 100.0
        stripe_fee = round(amount_total * 0.029 + 0.30, 2)
        amount_net = round(amount_total - stripe_fee, 2)
        if metadata.get("via_app_store") == "true":
            amount_net = round(amount_net * 0.70, 2)
        sub_id = session_data.get("subscription", "") or session_data.get("id", "")
        click = d.execute("SELECT id FROM clicks WHERE ref_code=? ORDER BY ts DESC LIMIT 1", (ref_code,)).fetchone()
        click_id = click["id"] if click else None
        d.execute("INSERT INTO conversions(click_id, affiliate_id, app_id, sub_id, amount_net, ts) VALUES(?,?,?,?,?,?)", (click_id, affiliate_id, app_id, sub_id, amount_net, now_iso()))
        commission = round(amount_net * 0.10, 2)
        period = datetime.now(timezone.utc).strftime("%Y-%m")
        existing = d.execute("SELECT id, amount, subs_active FROM commissions WHERE affiliate_id=? AND app_id=? AND period=? AND status='pending'", (affiliate_id, app_id, period)).fetchone()
        if existing:
            d.execute("UPDATE commissions SET amount=?, subs_active=? WHERE id=?", (round(existing["amount"] + commission, 2), existing["subs_active"] + 1, existing["id"]))
        else:
            d.execute("INSERT INTO commissions(affiliate_id, app_id, period, subs_active, amount, status) VALUES(?,?,?,?,?,?)", (affiliate_id, app_id, period, 1, commission, "pending"))
        d.commit()
        return jsonify({"received": True, "attributed": True, "affiliate_id": affiliate_id, "amount_net": amount_net, "commission": commission})
    return jsonify({"received": True, "type": event_type})

# ---------------------------------------------------------------- demo seed (dev only)
def seed_demo():
    d = db()
    if d.execute("SELECT 1 FROM users WHERE email='demo@armorbearer.app'").fetchone():
        return
    _demo_pw = secrets.token_urlsafe(16)
    pw_hash = bcrypt.hashpw(_demo_pw.encode(), bcrypt.gensalt(12))
    cur = d.execute(
        "INSERT INTO users(email, pw_hash, role, name, created_at) VALUES(?,?,?,?,?)",
        ("demo@armorbearer.app", pw_hash, "affiliate", "Demo Affiliate", now_iso()))
    uid = cur.lastrowid
    code = ensure_affiliate(uid)
    d.execute("UPDATE affiliates SET status='approved' WHERE user_id=?", (uid,))
    if not d.execute("SELECT 1 FROM users WHERE email='admin@armorbearer.app'").fetchone():
        _admin_pw = secrets.token_urlsafe(16)
        apw = bcrypt.hashpw(_admin_pw.encode(), bcrypt.gensalt(12))
        d.execute(
            "INSERT INTO users(email, pw_hash, role, name, created_at) VALUES(?,?,?,?,?)",
            ("admin@armorbearer.app", apw, "admin", "Admin", now_iso()))
        print(f"seeded admin@armorbearer.app / {_admin_pw}")
    # seed some clicks + conversions + a commission row
    for i in range(37):
        d.execute("INSERT INTO clicks(ref_code, ip_hash, ua_hash, ts) VALUES(?,?,?,?)",
                  (code, f"ip{i:02d}", f"ua{i:02d}", now_iso()))
    for i in range(5):
        cid = d.execute("SELECT id FROM clicks LIMIT 1").fetchone()["id"]
        d.execute("INSERT INTO conversions(click_id, affiliate_id, app_id, amount_net, ts) VALUES(?,?,?,?,?)",
                  (cid, uid, 1, 6.29, now_iso()))
    d.execute("INSERT INTO commissions(affiliate_id, app_id, period, subs_active, amount, status) VALUES(?,?,?,?,?,?)",
              (uid, 1, "2026-10", 5, 3.15, "pending"))
    d.execute("INSERT INTO milestones(affiliate_id, app_id, level, bonus_amount, awarded_at) VALUES(?,?,?,?,?)",
              (uid, 1, 1000, 63.0, now_iso()))
    d.commit()
    print(f"seeded demo@armorbearer.app / {_demo_pw}  ref_code={code}")

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 2 and sys.argv[1] == "--make-admin":
        email = sys.argv[2].strip().lower()
        with app.app_context():
            init_db()
            d = db()
            r = d.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
            if not r:
                print(f"no such user: {email}")
                sys.exit(1)
            d.execute("UPDATE users SET role='admin' WHERE id=?", (r["id"],))
            d.commit()
            print(f"{email} is now an admin")
        sys.exit(0)
    with app.app_context():
        init_db()
        if DEV:
            seed_demo()
    app.run(host="127.0.0.1", port=5060, debug=DEV)
else:
    # Production (WSGI import): make sure tables exist and seed apps are present.
    with app.app_context():
        init_db()
csrf = CSRFProtect(app)
# Stripe webhook must be CSRF-exempt (Stripe can't provide CSRF tokens);
# signature verification in stripe_webhook() provides the security.
csrf.exempt(stripe_webhook)

# Stripe billing integration (subscription checkout, portal, webhook)
from stripe_billing import init_stripe_billing  # noqa: E402
init_stripe_billing(app, db, login_required, now_iso, csrf)
