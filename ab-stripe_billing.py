"""
Armor Bearer — Stripe billing integration (subscriptions).

Separate module so it can be merged into app-production-REAL.py without
touching the staged file. Registers:

  POST /api/billing/checkout  (auth)  - create a Stripe Checkout Session
  POST /api/billing/portal    (auth)  - create a Stripe Customer Portal session
  GET  /api/billing/status    (auth)  - current subscription status for the user
  POST /api/billing/webhook   (public, signature-verified) - subscription events

Security:
  - Webhook signatures verified with stripe.Webhook.construct_event()
    (includes timestamp tolerance against replay). Invalid -> 400.
  - Prices come ONLY from the server-side STRIPE_PRICE_ID env var;
    the client can never choose or supply a price.
  - Checkout and portal endpoints require a logged-in user.

Env vars (never in code or memory):
  STRIPE_SECRET_KEY        - Stripe secret API key (sk_live_... / sk_test_...)
  STRIPE_PRICE_ID          - Price ID for the subscription (price_...)
  STRIPE_WEBHOOK_SECRET    - Signing secret for the /api/billing/webhook endpoint
                             (whsec_...). NOTE: this is a SEPARATE endpoint from
                             the affiliate-payout webhook at /webhooks/stripe,
                             so it needs its own webhook secret from Stripe.
  ARMORBEARER_PUBLIC_BASE  - public base URL for success/cancel redirects
                             (already used by the main app).

Usage (in app-production-REAL.py, near the bottom before `csrf = ...`):

    from stripe_billing import init_stripe_billing
    init_stripe_billing(app, db, login_required, now_iso, csrf)

The module is a no-op if STRIPE_SECRET_KEY is not set (endpoints return
503), so staging/dev without Stripe keeps working.
"""

import os

BILLING_TABLE_SQL = """
-- Stripe billing columns on users. Idempotent: safe to run on every boot.
"""

BILLING_COLUMNS = [
    ("stripe_customer_id",     "TEXT DEFAULT ''"),
    ("stripe_subscription_id", "TEXT DEFAULT ''"),
    ("subscription_status",    "TEXT DEFAULT 'none'"),
    ("plan",                   "TEXT DEFAULT ''"),
]

VALID_STATUSES = {"none", "trialing", "active", "past_due",
                  "incomplete", "incomplete_expired", "canceled", "unpaid"}


def ensure_billing_columns(app, db_fn):
    """Add billing columns to users if missing (idempotent)."""
    with app.app_context():
        d = db_fn()
        existing = {r["name"] for r in
                    d.execute("PRAGMA table_info(users)").fetchall()}
        for col, ddl in BILLING_COLUMNS:
            if col not in existing:
                d.execute(f"ALTER TABLE users ADD COLUMN {col} {ddl}")
        d.commit()


def _stripe():
    """Import stripe lazily and configure the API key. Returns None if unavailable."""
    secret = os.environ.get("STRIPE_SECRET_KEY", "")
    if not secret:
        return None
    try:
        import stripe
    except ImportError:
        return None
    stripe.api_key = secret
    return stripe


def _public_base():
    return os.environ.get("ARMORBEARER_PUBLIC_BASE", "").rstrip("/")


def _get_or_create_customer(stripe, d, user, now_iso):
    """Return the Stripe customer id for this user, creating one if needed."""
    cid = (user["stripe_customer_id"] or "").strip()
    if cid:
        return cid
    customer = stripe.Customer.create(
        email=user["email"],
        name=user["name"] or "",
        metadata={"armorbearer_user_id": str(user["id"])},
    )
    d.execute("UPDATE users SET stripe_customer_id=? WHERE id=?",
              (customer.id, user["id"]))
    d.commit()
    return customer.id


def init_stripe_billing(app, db_fn, login_required, now_iso, csrf=None):
    """
    Register Stripe billing routes on the Flask app.

    app            - the Flask application
    db_fn          - the app's db() connection helper
    login_required - the app's login_required(role=None) decorator factory
    now_iso        - the app's now_iso() helper
    csrf           - the CSRFProtect instance (webhook is exempted)
    """
    from flask import request, jsonify

    ensure_billing_columns(app, db_fn)

    # ------------------------------------------------------------------ checkout
    @app.route("/api/billing/checkout", methods=["POST"])
    @login_required()
    def billing_checkout(user):
        stripe = _stripe()
        if stripe is None:
            return jsonify({"ok": False, "error": "billing_not_configured"}), 503
        price_id = os.environ.get("STRIPE_PRICE_ID", "").strip()
        if not price_id:
            return jsonify({"ok": False, "error": "billing_not_configured"}), 503
        base = _public_base()
        if not base:
            return jsonify({"ok": False, "error": "billing_not_configured"}), 503

        d = db_fn()
        customer_id = _get_or_create_customer(stripe, d, user, now_iso)

        # Server-side price only: the client never chooses a price.
        checkout = stripe.checkout.Session.create(
            customer=customer_id,
            mode="subscription",
            payment_method_types=["card", "us_bank_account"],
            line_items=[{"price": price_id, "quantity": 1}],
            metadata={"armorbearer_user_id": str(user["id"])},
            subscription_data={"metadata": {"armorbearer_user_id": str(user["id"])}},
            success_url=base + "/dashboard?billing=success",
            cancel_url=base + "/dashboard?billing=cancelled",
        )
        return jsonify({"ok": True, "url": checkout.url})

    # ------------------------------------------------------------------ portal
    @app.route("/api/billing/portal", methods=["POST"])
    @login_required()
    def billing_portal(user):
        stripe = _stripe()
        if stripe is None:
            return jsonify({"ok": False, "error": "billing_not_configured"}), 503
        base = _public_base()
        if not base:
            return jsonify({"ok": False, "error": "billing_not_configured"}), 503
        customer_id = (user["stripe_customer_id"] or "").strip()
        if not customer_id:
            return jsonify({"ok": False, "error": "no_subscription"}), 404
        portal = stripe.billing_portal.Session.create(
            customer=customer_id,
            return_url=base + "/dashboard",
        )
        return jsonify({"ok": True, "url": portal.url})

    # ------------------------------------------------------------------ status
    @app.route("/api/billing/status", methods=["GET"])
    @login_required()
    def billing_status(user):
        status = (user["subscription_status"] or "none").strip() or "none"
        if status not in VALID_STATUSES:
            status = "none"
        return jsonify({
            "ok": True,
            "subscription_status": status,
            "plan": user["plan"] or "",
            "has_customer": bool((user["stripe_customer_id"] or "").strip()),
        })

    # ------------------------------------------------------------------ webhook
    @app.route("/api/billing/webhook", methods=["POST"])
    def billing_webhook():
        stripe = _stripe()
        if stripe is None:
            return jsonify({"error": "webhook not configured"}), 503
        webhook_secret = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
        if not webhook_secret:
            # Fail closed: never process unverified webhooks.
            return jsonify({"error": "webhook not configured"}), 503

        payload = request.get_data()
        sig_header = request.headers.get("Stripe-Signature", "")
        try:
            # Verifies HMAC signature AND timestamp tolerance (anti-replay).
            event = stripe.Webhook.construct_event(payload, sig_header, webhook_secret)
            # Newer stripe-python returns an Event object; normalize to dict.
            if hasattr(event, "to_dict"):
                event = event.to_dict()
        except ValueError:
            return jsonify({"error": "invalid payload"}), 400
        except Exception:
            return jsonify({"error": "invalid signature"}), 400

        d = db_fn()
        etype = event.get("type", "")

        if etype == "checkout.session.completed":
            sess = (event.get("data") or {}).get("object") or {}
            meta = sess.get("metadata") or {}
            uid = meta.get("armorbearer_user_id")
            customer_id = sess.get("customer", "") or ""
            sub_id = sess.get("subscription", "") or ""
            # Validate uid is a plain integer string before using it —
            # metadata comes from Stripe and must never crash the handler.
            if uid and customer_id and str(uid).isdigit():
                d.execute(
                    "UPDATE users SET stripe_customer_id=?, stripe_subscription_id=?, "
                    "subscription_status='active' WHERE id=?",
                    (customer_id, sub_id, int(uid)),
                )
                d.commit()

        elif etype in ("customer.subscription.updated", "customer.subscription.deleted"):
            sub = (event.get("data") or {}).get("object") or {}
            sub_id = sub.get("id", "")
            customer_id = sub.get("customer", "") or ""
            raw_status = (sub.get("status", "") or "").strip()
            status = raw_status if raw_status in VALID_STATUSES else "none"
            if etype == "customer.subscription.deleted":
                status = "canceled"
            if sub_id:
                d.execute(
                    "UPDATE users SET subscription_status=?, stripe_subscription_id=? "
                    "WHERE stripe_subscription_id=?",
                    (status, sub_id, sub_id),
                )
                if d.total_changes == 0 and customer_id:
                    # Fallback: match on customer if subscription id isn't stored yet.
                    d.execute(
                        "UPDATE users SET subscription_status=?, stripe_subscription_id=? "
                        "WHERE stripe_customer_id=?",
                        (status, sub_id, customer_id),
                    )
                d.commit()

        return jsonify({"received": True})

    if csrf is not None:
        csrf.exempt(billing_webhook)

    return {
        "checkout": billing_checkout,
        "portal": billing_portal,
        "status": billing_status,
        "webhook": billing_webhook,
    }
