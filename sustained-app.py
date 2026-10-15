#!/usr/bin/env python3
"""Sustained product backend — auth + Stripe + gated search.

ATTORNEY-READY BUILD (v2):
- No dev bypass. Real signup/login required for all access.
- Card-upfront trial flow: 1 free week, card on file from day 1,
  charge starts after the trial. Easy cancel.
- Stripe integration points are stubbed and clearly marked STRIPE_TODO.
  Nothing charges until Michael adds real Stripe keys (he handles this last).

STRIPE_TODO (Michael):
  1. See STRIPE_SETUP.md for the full checklist.
  2. Set env vars: STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY,
     STRIPE_PRICE_MONTHLY, STRIPE_PRICE_ANNUAL, STRIPE_WEBHOOK_SECRET.
  3. pip install -r requirements.txt (installs the `stripe` package).
  4. Point the Stripe webhook at <your-domain>/webhook.

Local run (no Stripe — checkout will show "not connected", by design):
    python3 app.py
    # then open http://127.0.0.1:5057
"""
import os
import json
import re
import sqlite3
import secrets
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from functools import wraps

import bcrypt
from flask import (
    Flask, request, redirect, url_for, render_template,
    jsonify, session, send_file,
)

# ---------------------------------------------------------------- config
HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "users.db")

# NOTE: there is intentionally NO dev bypass in this build. The old
# development bypass (an env var that auto-activated trials with no card)
# has been removed entirely. Every trial starts through Stripe.


def load_dotenv():
    p = os.path.join(HERE, ".env")
    if os.path.exists(p):
        for line in open(p, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_dotenv()

# STRIPE_TODO: Michael fills these in (see STRIPE_SETUP.md). Until all five
# are set, checkout shows a clear "billing not connected yet" message and
# NO trial is activated, NO card is taken, NOTHING is charged.
STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY", "")
STRIPE_PUBLISHABLE_KEY = os.environ.get("STRIPE_PUBLISHABLE_KEY", "")
STRIPE_PRICE_MONTHLY = os.environ.get("STRIPE_PRICE_MONTHLY", "")
STRIPE_PRICE_ANNUAL = os.environ.get("STRIPE_PRICE_ANNUAL", "")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")

PLANS = {
    "monthly": {"label": "Monthly", "amount": "$199/mo",
                "detail": "$199 per month, cancel anytime"},
    "annual": {"label": "Annual", "amount": "$100/mo",
               "detail": "$1,200 billed once a year — about 2 months of Westlaw"},
}
ACTIVE_STATUSES = ("trialing", "active")
TRIAL_DAYS = 7  # one free week; card on file from day 1, charge starts after

# Admin access: anyone with an @faithshield.ai email address bypasses the
# subscription check entirely. Michael and Leon sign in and use the app
# fully without needing Stripe. No visible admin UI or badge.
# A small set of named external emails (first affiliates) get the same access.
ADMIN_DOMAIN = "@faithshield.ai"
ADMIN_EMAILS = (
    "peterfield6@hotmail.com",
    "isaacpemberton795@gmail.com",
)


def is_admin_email(email):
    try:
        e = str(email or "").strip().lower()
        return e.endswith(ADMIN_DOMAIN) or e in ADMIN_EMAILS
    except Exception:
        return False


def is_admin(u):
    # NOTE: u is a sqlite3.Row — it has NO .get() method. Use u["email"].
    try:
        return bool(u) and is_admin_email(u["email"])
    except Exception:
        return False


def stripe_ready():
    return all([STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY,
                STRIPE_PRICE_MONTHLY, STRIPE_PRICE_ANNUAL])


def get_secret():
    p = os.path.join(HERE, ".flask_secret")
    if os.path.exists(p):
        return open(p, encoding="utf-8").read().strip()
    s = secrets.token_hex(32)
    with open(p, "w", encoding="utf-8") as f:
        f.write(s)
    return s


app = Flask(__name__, template_folder=os.path.join(HERE, "templates"))
app.secret_key = get_secret()

# Security headers on every response.
@app.after_request
def _security_headers(resp):
    resp.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    resp.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    return resp
# Production hardening: lock down the session cookie.
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=True,  # production is HTTPS-only
    PERMANENT_SESSION_LIFETIME=timedelta(days=14),
    # Bound request bodies: signup/waitlist forms are tiny; anything over
    # 1MB is abuse. (Flask answers 413 automatically.)
    MAX_CONTENT_LENGTH=1_000_000,
)

# ---------------------------------------------------------------- db
def db():
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    return c


def init_db():
    c = db()
    c.execute("""CREATE TABLE IF NOT EXISTS users(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        firm TEXT,
        password_hash BLOB NOT NULL,
        plan TEXT NOT NULL DEFAULT 'monthly',
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        sub_status TEXT NOT NULL DEFAULT 'none',
        trial_end TEXT,
        created_at TEXT NOT NULL)""")
    cols = [r[1] for r in c.execute("PRAGMA table_info(users)").fetchall()]
    if "cancel_at_period_end" not in cols:
        c.execute("ALTER TABLE users ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0")
    # Password reset tokens: single-use, 1-hour expiry.
    c.execute("""CREATE TABLE IF NOT EXISTS password_reset_tokens(
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL)""")
    c.execute("""CREATE TABLE IF NOT EXISTS waitlist(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        firm TEXT,
        source TEXT NOT NULL DEFAULT 'landing',
        created_at TEXT NOT NULL)""")
    c.commit()
    c.close()


def get_user(uid):
    if not uid:
        return None
    c = db()
    r = c.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    c.close()
    return r


def current_user():
    return get_user(session.get("uid"))


def trial_expired(u):
    """True when a trialing user's free week has run out."""
    if not u or u["sub_status"] != "trialing" or not u["trial_end"]:
        return False
    try:
        te = datetime.fromisoformat(u["trial_end"])
        if te.tzinfo is None:
            te = te.replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) > te
    except Exception:
        return False


def subscription_active(u):
    """A subscription counts as active only while paid or inside the free week.
    Admins (@faithshield.ai domain + whitelisted emails) always count as
    active — no Stripe needed."""
    if is_admin(u):
        return True
    if not u or u["sub_status"] not in ACTIVE_STATUSES:
        return False
    return not trial_expired(u)


def login_required(f):
    @wraps(f)
    def w(*a, **k):
        u = current_user()
        if not u:
            return redirect(url_for("login"))
        return f(u, *a, **k)
    return w


def sub_required(f):
    @wraps(f)
    def w(*a, **k):
        u = current_user()
        if not u:
            return redirect(url_for("login"))
        if not subscription_active(u):
            if trial_expired(u):
                return redirect(url_for("checkout", expired="1"))
            return redirect(url_for("checkout"))
        return f(u, *a, **k)
    return w


# ---------------------------------------------------------------- login rate limiting
# Simple in-memory guard against password brute-forcing: 10 failed logins
# per IP per 10 minutes. (Per-process; good enough for this scale.)
_LOGIN_ATTEMPTS = defaultdict(list)
_LOGIN_WINDOW = 600
_LOGIN_MAX = 10

# Waitlist collector throttle: max 10 submissions per IP per minute.
_WAITLIST_HITS = defaultdict(list)
_WAITLIST_WINDOW = 60
_WAITLIST_MAX = 10

# Signup throttle: max 10 new accounts per IP per minute (spam-account guard).
_SIGNUP_HITS = defaultdict(list)
_SIGNUP_WINDOW = 60
_SIGNUP_MAX = 10


def _hit(bucket, window, maximum):
    """Generic per-IP throttle. Returns True when the caller is over the limit."""
    now = time.time()
    ip = _client_ip()
    bucket[ip] = [t for t in bucket[ip] if now - t < window]
    if len(bucket[ip]) >= maximum:
        return True
    bucket[ip].append(now)
    return False


def signup_blocked():
    return _hit(_SIGNUP_HITS, _SIGNUP_WINDOW, _SIGNUP_MAX)


def waitlist_blocked():
    return _hit(_WAITLIST_HITS, _WAITLIST_WINDOW, _WAITLIST_MAX)


def _client_ip():
    return request.headers.get("X-Forwarded-For", request.remote_addr or "?").split(",")[0].strip()


def login_blocked():
    now = time.time()
    ip = _client_ip()
    _LOGIN_ATTEMPTS[ip] = [t for t in _LOGIN_ATTEMPTS[ip] if now - t < _LOGIN_WINDOW]
    return len(_LOGIN_ATTEMPTS[ip]) >= _LOGIN_MAX


def record_failed_login():
    _LOGIN_ATTEMPTS[_client_ip()].append(time.time())


# ---------------------------------------------------------------- pages
@app.get("/")
def index():
    u = current_user()
    if u and subscription_active(u):
        return redirect(url_for("app_home"))
    if u:
        return redirect(url_for("checkout"))
    return redirect(url_for("signup"))


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@app.route("/signup", methods=["GET", "POST"])
def signup():
    if current_user():
        return redirect(url_for("index"))
    err = ""
    if request.method == "POST":
        if signup_blocked():
            err = "Too many signups from this address. Please wait a minute and try again."
            return render_template("signup.html", err=err), 429
        name = request.form.get("name", "").strip()
        email = request.form.get("email", "").strip().lower()
        firm = request.form.get("firm", "").strip()[:120]
        password = request.form.get("password", "")
        plan = request.form.get("plan", "monthly")
        if plan not in PLANS:
            plan = "monthly"
        if not name or not EMAIL_RE.match(email) or len(password) < 8:
            err = "Please enter your name, a valid email, and a password of 8+ characters."
        elif len(password.encode("utf-8", "ignore")) > 72:
            # bcrypt hard-caps passwords at 72 bytes and raises ValueError
            # beyond that — reject cleanly instead of 500ing.
            err = "That password is too long — please use 72 characters or fewer."
        elif len(name) > 120:
            err = "That name is too long."
        else:
            c = db()
            try:
                if c.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone():
                    err = "That email is already registered. Try logging in."
                else:
                    pw = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt())
                    cur = c.execute(
                        "INSERT INTO users(name,email,firm,password_hash,plan,created_at)"
                        " VALUES(?,?,?,?,?,?)",
                        (name, email, firm, pw, plan,
                         datetime.now(timezone.utc).isoformat()))
                    uid = cur.lastrowid
                    c.commit()
                    session["uid"] = uid
                    session.permanent = True
                    # Admins skip checkout entirely — full access, no Stripe.
                    if is_admin_email(email):
                        return redirect(url_for("app_home"))
                    return redirect(url_for("checkout"))
            finally:
                c.close()
    return render_template("signup.html", err=err)


@app.route("/login", methods=["GET", "POST"])
def login():
    if current_user():
        return redirect(url_for("index"))
    err = ""
    if request.method == "POST":
        if login_blocked():
            err = "Too many failed attempts. Please wait a few minutes and try again."
            return render_template("login.html", err=err), 429
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        # bcrypt raises ValueError past 72 bytes — a too-long password can
        # never match, so fail closed as "invalid" instead of 500ing.
        if len(password.encode("utf-8", "ignore")) > 72:
            record_failed_login()
            err = "Invalid email or password."
            return render_template("login.html", err=err)
        c = db()
        r = c.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        c.close()
        if r and bcrypt.checkpw(password.encode("utf-8"), r["password_hash"]):
            session["uid"] = r["id"]
            session.permanent = True
            return redirect(url_for("index"))
        record_failed_login()
        err = "Invalid email or password."
    return render_template("login.html", err=err)


@app.get("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


# ---------------------------------------------------------------- password reset
@app.route("/forgot-password", methods=["GET", "POST"])
def forgot_password():
    """Request a password reset. Always shows the same message (no email enumeration)."""
    msg = ""
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        c = db()
        r = c.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
        if r:
            token = secrets.token_urlsafe(32)
            expires = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
            c.execute(
                "INSERT INTO password_reset_tokens(token,user_id,expires_at,created_at) VALUES(?,?,?,?)",
                (token, r["id"], expires, datetime.now(timezone.utc).isoformat()))
            c.commit()
            # TODO: send reset email when SMTP is configured. For now the
            # token is shown on-screen so the flow is testable.
            msg = f"Reset link (email not configured yet): /reset-password/{token}"
        else:
            # Same message either way — no email enumeration.
            msg = "If that email is registered, a reset link has been sent."
        c.close()
        if r:
            return render_template("forgot-password.html", msg=msg, show_link=True)
    return render_template("forgot-password.html", msg=msg or "Enter your email to reset your password.", show_link=False)


@app.route("/reset-password/<token>", methods=["GET", "POST"])
def reset_password(token):
    """Set a new password using a reset token. Single-use, 1-hour expiry."""
    c = db()
    r = c.execute(
        "SELECT * FROM password_reset_tokens WHERE token=? AND used=0", (token,)).fetchone()
    err = ""
    if not r:
        c.close()
        return render_template("reset-password.html", err="Invalid or expired reset link.", valid=False)
    try:
        expires = datetime.fromisoformat(r["expires_at"])
    except (ValueError, TypeError):
        expires = datetime.now(timezone.utc) - timedelta(hours=1)
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if datetime.now(timezone.utc) > expires:
        c.close()
        return render_template("reset-password.html", err="This reset link has expired.", valid=False)
    if request.method == "POST":
        password = request.form.get("password", "")
        confirm = request.form.get("confirm", "")
        if len(password) < 8:
            err = "Password must be at least 8 characters."
        elif password != confirm:
            err = "Passwords do not match."
        elif len(password.encode("utf-8", "ignore")) > 72:
            err = "Password is too long."
        else:
            pw_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt())
            c.execute("UPDATE users SET password_hash=? WHERE id=?", (pw_hash, r["user_id"]))
            c.execute("UPDATE password_reset_tokens SET used=1 WHERE token=?", (token,))
            c.commit()
            c.close()
            return render_template("reset-password.html", valid=False, success=True)
    c.close()
    return render_template("reset-password.html", err=err, valid=True)


@app.route("/checkout", methods=["GET", "POST"])
@login_required
def checkout(u):
    if subscription_active(u):
        return redirect(url_for("app_home"))
    err = ""
    expired = bool(request.args.get("expired"))
    if expired:
        err = "Your free week has ended. Add a card to keep using Sustained."
    if request.method == "POST":
        plan = request.form.get("plan", u["plan"])
        if plan not in PLANS:
            plan = "monthly"
        if plan != u["plan"]:
            c = db()
            c.execute("UPDATE users SET plan=? WHERE id=?", (plan, u["id"]))
            c.commit()
            c.close()
            u = get_user(u["id"])
        # STRIPE_TODO: this branch is the whole reason Stripe keys matter.
        # Until Michael configures Stripe, we REFUSE to start a trial —
        # no silent free access, no card taken, nothing charged.
        if not stripe_ready():
            err = ("Online billing isn't connected yet. Your account is created — "
                   "you'll be able to start your free week as soon as billing is live. "
                   "Questions? Reply to any Sustained email.")
        else:
            # Real path: Stripe Checkout with a 7-day trial. The card is
            # collected on Stripe's hosted page (PCI-safe; card details never
            # touch our servers). The trial is activated by the
            # checkout.session.completed webhook below — never here.
            import stripe  # STRIPE_TODO: `pip install -r requirements.txt`
            stripe.api_key = STRIPE_SECRET_KEY
            price = STRIPE_PRICE_MONTHLY if plan == "monthly" else STRIPE_PRICE_ANNUAL
            customer_id = u["stripe_customer_id"]
            if not customer_id:
                cust = stripe.Customer.create(
                    email=u["email"], name=u["name"],
                    metadata={"user_id": str(u["id"])})
                customer_id = cust.id
                c = db()
                c.execute("UPDATE users SET stripe_customer_id=? WHERE id=?",
                          (customer_id, u["id"]))
                c.commit()
                c.close()
            try:
                sess = stripe.checkout.Session.create(
                    customer=customer_id,
                    mode="subscription",
                    payment_method_types=["card", "us_bank_account"],
                    line_items=[{"price": price, "quantity": 1}],
                    subscription_data={"trial_period_days": TRIAL_DAYS,
                                       "metadata": {"user_id": str(u["id"])}},
                    metadata={"user_id": str(u["id"])},
                    success_url=request.host_url.rstrip("/") + "/app?checkout=success",
                    cancel_url=request.host_url.rstrip("/") + "/checkout?canceled=1",
                )
            except Exception as e:  # surface Stripe config errors plainly
                err = f"Payment setup failed: {e}. Please try again or contact us."
            else:
                return redirect(sess.url, code=303)
    u = get_user(u["id"])
    return render_template(
        "checkout.html", user=u,
        stripe_configured=stripe_ready(),
        # STRIPE_TODO: when keys are set, the publishable key enables the
        # card form below. Until then the card form stays stubbed.
        publishable_key=STRIPE_PUBLISHABLE_KEY if stripe_ready() else "",
        canceled=bool(request.args.get("canceled")),
        err=err)


@app.get("/billing")
@login_required
def billing(u):
    # has_stripe_sub drives the cancel-button copy: with a real Stripe
    # subscription the user keeps access until period end; in local mode
    # (no Stripe) canceling ends access immediately — the confirm dialog
    # must say so honestly.
    return render_template("billing.html", user=u, plans=PLANS,
                           trial_expired=trial_expired(u),
                           has_stripe_sub=bool(u["stripe_subscription_id"]
                                               and stripe_ready()))


@app.post("/api/cancel")
@login_required
def api_cancel(u):
    """Easy cancel: with Stripe, ends the subscription at the current
    period's close (user keeps access until then). Without a Stripe
    subscription on file, cancels locally."""
    if u["stripe_subscription_id"] and stripe_ready():
        import stripe  # STRIPE_TODO: `pip install -r requirements.txt`
        stripe.api_key = STRIPE_SECRET_KEY
        try:
            stripe.Subscription.modify(u["stripe_subscription_id"],
                                       cancel_at_period_end=True)
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 400
        c = db()
        c.execute("UPDATE users SET cancel_at_period_end=1 WHERE id=?", (u["id"],))
        c.commit()
        c.close()
        return jsonify({"ok": True, "mode": "stripe", "cancel_at_period_end": True})
    c = db()
    c.execute("UPDATE users SET sub_status='canceled', cancel_at_period_end=0 WHERE id=?",
              (u["id"],))
    c.commit()
    c.close()
    return jsonify({"ok": True, "mode": "local", "sub_status": "canceled"})


@app.post("/api/billing-portal")
@login_required
def api_billing_portal(u):
    """Stripe Customer Portal: lets the user update their card, view invoices,
    and manage their subscription on Stripe's hosted page. Requires a real
    Stripe customer; otherwise returns 400."""
    if not (u["stripe_customer_id"] and stripe_ready()):
        return jsonify({"ok": False, "error": "billing_not_connected"}), 400
    import stripe  # STRIPE_TODO: `pip install -r requirements.txt`
    stripe.api_key = STRIPE_SECRET_KEY
    try:
        portal = stripe.billing_portal.Session.create(
            customer=u["stripe_customer_id"],
            return_url=request.host_url.rstrip("/") + "/billing")
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    return jsonify({"ok": True, "url": portal.url})


# ---------------------------------------------------------------- search index stats
_INDEX_STATS = None


def index_stats():
    """Counts per category for the app header (computed once)."""
    global _INDEX_STATS
    if _INDEX_STATS is None:
        p = os.path.join(HERE, "search-index-full.json")
        try:
            with open(p, encoding="utf-8") as f:
                docs = json.load(f)
            from collections import Counter
            cats = Counter(d.get("cat") for d in docs)
            _INDEX_STATS = {
                "total": len(docs),
                "definitions": cats.get("def", 0),
                "ucc": cats.get("ucc", 0),
                "constitution": cats.get("con", 0),
            }
        except Exception:
            _INDEX_STATS = {"total": 0, "definitions": 0, "ucc": 0, "constitution": 0}
    return _INDEX_STATS


# ---------------------------------------------------------------- gated product
@app.get("/app")
@sub_required
def app_home(u):
    return render_template("app.html",
                           user_email=u["email"],
                           plan_label=PLANS.get(u["plan"], PLANS["monthly"])["label"],
                           stats=index_stats())


@app.get("/api/me")
@login_required
def api_me(u):
    return jsonify({"email": u["email"], "name": u["name"], "firm": u["firm"],
                    "plan": u["plan"], "sub_status": u["sub_status"],
                    "trial_end": u["trial_end"], "trial_expired": trial_expired(u),
                    "cancel_at_period_end": bool(u["cancel_at_period_end"])})


@app.get("/api/search-index")
@sub_required
def api_search_index(u):
    p = os.path.join(HERE, "search-index-full.json")
    if not os.path.exists(p):
        return jsonify({"error": "search index not built yet"}), 503
    return send_file(p, mimetype="application/json",
                     download_name="search-index.json")


@app.get("/api/search-updates")
@sub_required
def api_search_updates(u):
    p = os.path.join(HERE, "court-updates.json")
    if not os.path.exists(p):
        return jsonify([])
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
        return jsonify(data if isinstance(data, list) else [])
    except Exception:
        return jsonify([])


@app.get("/api/case-law")
@sub_required
def api_case_law(u):
    """Live case-law fallback (CourtListener). Retrieval-only.

    Confinement (Michael's rule): this endpoint answers ONLY case-law /
    precedent queries. Definitions, statutes, and UCC lookups belong to
    the built-in RAG index and are rejected here (400), so the API can
    never be spent on what the RAG already covers. The frontend only
    offers this lookup when local results are thin and the query passes
    the client-side case-law check, and the server re-verifies with the
    same heuristic — the live=1 flag alone is NOT enough to bypass it.

    Returns facts only: case name, court, date, citation, verbatim
    excerpt, link. No opinions, no interpretations, no legal advice.
    """
    import courtlistener
    q = (request.args.get("q") or "").strip()
    if not q or len(q) > 200:
        return jsonify({"error": "missing or invalid query"}), 400
    if not courtlistener.is_case_law_query(q):
        return jsonify({"error": "not a case-law query; use the built-in index"}), 400
    if not courtlistener.configured():
        return jsonify({"error": "live case-law lookup isn't connected yet"}), 503
    try:
        results = courtlistener.search_live_case_law(q)
    except courtlistener.NotConfiguredError:
        return jsonify({"error": "live case-law lookup isn't connected yet"}), 503
    except Exception:
        return jsonify({"error": "live case-law lookup failed"}), 502
    return jsonify({"query": q, "source": "courtlistener", "results": results})


# ---------------------------------------------------------------- waitlist collector
# Public lead-capture endpoint for the static Sustained landing page
# (audit C5). CORS-enabled so the Netlify page can POST cross-origin.
# Success is returned ONLY after the lead is validated and stored.
@app.route("/waitlist", methods=["POST", "OPTIONS"])
def waitlist():
    cors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }
    if request.method == "OPTIONS":
        return ("", 204, cors)
    if waitlist_blocked():
        r = jsonify({"ok": False, "error": "Too many requests. Please try again in a minute."})
        for k, v in cors.items():
            r.headers[k] = v
        return r, 429

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        # NOTE: `request.form or {}` is a bug — an empty ImmutableMultiDict
        # is falsy, so `{}` (a plain dict, no .to_dict()) was used and
        # crashed with AttributeError -> 500 on garbage bodies. Fixed 2026-10-14.
        try:
            data = request.form.to_dict()
        except Exception:
            data = {}
    name = str(data.get("name") or "").strip()[:120]
    email = str(data.get("email") or "").strip().lower()[:160]
    firm = str(data.get("firm") or "").strip()[:160]
    source = str(data.get("source") or "landing").strip()[:32]
    if not name or not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        r = jsonify({"ok": False, "error": "Please provide your name and a valid work email."})
        for k, v in cors.items():
            r.headers[k] = v
        return r, 400
    c = db()
    try:
        c.execute(
            "INSERT OR IGNORE INTO waitlist(name, email, firm, source, created_at)"
            " VALUES(?, ?, ?, ?, ?)",
            (name, email, firm, source, datetime.now(timezone.utc).isoformat()),
        )
        c.commit()
    finally:
        c.close()
    r = jsonify({"ok": True})
    for k, v in cors.items():
        r.headers[k] = v
    return r


# ---------------------------------------------------------------- stripe webhook
def handle_stripe_event(event):
    """Apply a verified Stripe event to our users table. Pure function of
    the event dict — unit-tested in tests/test_sustained.py."""
    t = event.get("type", "")
    data = event.get("data", {}).get("object", {})

    if t == "checkout.session.completed":
        uid = data.get("metadata", {}).get("user_id")
        sub_id = data.get("subscription")
        cust_id = data.get("customer")
        status, trial_end = "trialing", None
        if STRIPE_SECRET_KEY and sub_id:
            try:
                import stripe  # STRIPE_TODO: `pip install -r requirements.txt`
                stripe.api_key = STRIPE_SECRET_KEY
                sub = stripe.Subscription.retrieve(sub_id)
                status = sub.status
                if sub.trial_end:
                    trial_end = datetime.fromtimestamp(
                        sub.trial_end, tz=timezone.utc).isoformat()
                else:
                    # Subscription has no trial (e.g. paid immediately):
                    # nothing expires, so trial_end stays None and the
                    # status alone gates access.
                    trial_end = None
            except Exception:
                # Stripe lookup failed (transient). Fall back to a 7-day
                # trial from now — NEVER leave trialing with trial_end=None,
                # which would grant indefinite access. Fixed 2026-10-14.
                trial_end = (datetime.now(timezone.utc) + timedelta(days=TRIAL_DAYS)).isoformat()
        else:
            # No live Stripe lookup (keys not set or test path): trust the
            # checkout session itself and start the 7-day trial now.
            trial_end = (datetime.now(timezone.utc) + timedelta(days=TRIAL_DAYS)).isoformat()
        if uid:
            c = db()
            c.execute("""UPDATE users SET stripe_customer_id=?, stripe_subscription_id=?,
                         sub_status=?, trial_end=? WHERE id=?""",
                      (cust_id, sub_id, status, trial_end, int(uid)))
            c.commit()
            c.close()
    elif t == "customer.subscription.updated":
        status = data.get("status", "")
        te = data.get("trial_end")
        trial_end = (datetime.fromtimestamp(te, tz=timezone.utc).isoformat()
                     if te else None)
        c = db()
        c.execute("UPDATE users SET sub_status=?, trial_end=?, cancel_at_period_end=? "
                  "WHERE stripe_subscription_id=?",
                  (status, trial_end,
                   1 if data.get("cancel_at_period_end") else 0, data.get("id")))
        c.commit()
        c.close()
    elif t == "customer.subscription.deleted":
        c = db()
        c.execute("UPDATE users SET sub_status='canceled' WHERE stripe_subscription_id=?",
                  (data.get("id"),))
        c.commit()
        c.close()
    return "ok"


@app.post("/webhook")
def webhook():
    # Security: webhooks MUST be signature-verified. With no webhook secret
    # configured we refuse everything (the old unsigned-JSON fallback that
    # accepted forged events has been removed).
    # STRIPE_TODO: set STRIPE_WEBHOOK_SECRET and point Stripe at this URL.
    if not STRIPE_WEBHOOK_SECRET:
        return "webhook not configured", 400
    payload = request.data
    sig = request.headers.get("Stripe-Signature", "")
    try:
        import stripe  # STRIPE_TODO: `pip install -r requirements.txt`
        stripe.api_key = STRIPE_SECRET_KEY
        event = stripe.Webhook.construct_event(payload, sig, STRIPE_WEBHOOK_SECRET)
    except Exception as e:
        return f"webhook error: {e}", 400
    ev = event.to_dict() if hasattr(event, "to_dict") else event
    return handle_stripe_event(ev), 200


# ---------------------------------------------------------------- errors + health
@app.errorhandler(404)
def not_found(e):
    return render_template("error.html", code=404,
                           message="That page doesn't exist."), 404


@app.errorhandler(500)
def server_error(e):
    return render_template("error.html", code=500,
                           message="Something went wrong on our end. Please try again."), 500


@app.get("/health")
def health():
    return jsonify({"ok": True,
                    "stripe_configured": stripe_ready(),
                    "version": "2"})


if __name__ == "__main__":
    init_db()
    port = int(os.environ.get("PORT", "5057"))
    app.run(host="127.0.0.1", port=port, debug=False)
