# D2RM Dashboard SaaS — Architecture (Phase 2)

> Status: Phase 2 complete + guided onboarding shipped. Turnkey SaaS: auth UI,
> live dashboard, lead collection, AI co-pilot, ROI, realtime, plan
> enforcement, 5-step guided setup. Billing STUBBED.
> Last updated: 2026-10-12.

## 1. What this is

The D2RM Master Dashboard is a multi-tenant SaaS marketing command center:
**"Big agency data, little guy money."** Pricing: **$50/mo Starter**
(2 projects, 5,000 emails/mo) / **$100/mo Pro** (10 projects, 20,000
emails/mo). **No public enterprise tier** — custom deals by request only
(the takeaway sale: prospects must call and ask).

Turnkey promise: customers don't just get tracking — they get lead
collection and an AI co-pilot built in. The data collection itself is
part of the product, not a separate service.

## 2. Tech stack

| Layer      | Choice | Why |
|------------|--------|-----|
| Runtime    | **Node.js 22+** | Single language with the existing dashboard frontend (already JS/fetch-based). First-class Stripe SDK for Phase 2. |
| Framework  | **Express 4** | Minimal, well-understood, huge middleware ecosystem. No framework magic. |
| Database   | **SQLite via `node:sqlite`** (built into Node 22+) | Zero native dependencies (better-sqlite3's node-gyp build failed in this sandbox — `node:sqlite` removes the entire class of problem). Zero ops for v1: single file, trivial backups. Clean migration path to Postgres (same schema, swap driver). WAL mode + foreign keys + busy timeout enabled. |
| Passwords  | **bcryptjs, cost 12** | OWASP-recommended adaptive hashing. Minimum password length 12. |
| Sessions   | **Server-side, opaque tokens** | 256-bit random token in httpOnly + SameSite=Strict cookie (Secure in production). Only SHA-256(token) stored. Instant revocation via row delete. |
| Security headers | **helmet** | Sensible defaults; CSP off until the frontend is served in Phase 2. |

**Deliberately not used:** JWT (can't revoke without a denylist, which is just
sessions with extra steps), ORMs (raw parameterized SQL is auditable and the
schema is small), TypeScript (v1 speed; can adopt later).

## 3. Multi-tenancy: shared schema, `tenant_id` discriminator

**Decision:** one database, one set of tables, every tenant-scoped row carries
`tenant_id NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`.

**Why not separate schemas/databases per tenant:**
- SQLite has no schemas; separate DB files per tenant complicates backups,
  migrations, and connection handling for zero v1 benefit.
- `tenant_id` filtering is simple, and the security boundary is enforced in
  **one place** (`src/db.js → forTenant()`), not scattered across queries.

**Enforcement (defense in depth):**
1. `forTenant(tenantId)` returns the ONLY query interface route handlers
   receive (`req.tdb`). Every helper injects `WHERE tenant_id = ?`.
   There is intentionally no way to query another tenant's rows through it.
2. `requireAuth` middleware loads the tenant from the **server-side session**
   — the tenant identity never comes from client input (no `?tenant_id=`
   parameter anywhere).
3. All SQL is parameterized; no string interpolation of user input.
4. `tests/tenancy.test.js` proves isolation: a "Beta" tenant's marker rows
   are inserted directly in the DB, then every endpoint is called as "Alpha"
   and asserted to contain zero Beta bytes. **If this suite fails, the build
   is not shippable.**

**Postgres migration path:** the schema uses only portable SQL (no
SQLite-isms except `strftime` defaults, which become `now()`). The
`forTenant` abstraction means route code doesn't change — only `src/db.js`.

## 4. Auth design

- **Signup** (`POST /api/auth/register`): creates tenant + owner user in one
  transaction. Validates company name, email format, password ≥ 12 chars.
  Duplicate email returns generic `email_unavailable` (no enumeration).
  14-day trial, `subscription_status='trialing'`. Plan column ready for
  Stripe in Phase 2.
- **Login** (`POST /api/auth/login`): bcrypt compare; on unknown email a
  **dummy bcrypt compare** runs first so response timing doesn't reveal
  whether the account exists. Same 401 shape either way.
- **Sessions**: 30-day sliding expiry (`last_seen_at` refreshed per request),
  absolute expiry enforced. `POST /logout` revokes one session;
  `POST /logout-everywhere` revokes all.
- **Email verification**: token hashed in DB, single-use, 24h expiry.
  Phase 1 returns the raw token in dev responses only (`NODE_ENV !==
  'production'`); Phase 2 sends it via email provider.
- **Rate limiting**: 20 auth attempts / 15 min / IP; 300 req/min on the API.
- **CSRF**: all mutating endpoints (including login/register) require
  `X-Requested-With: XMLHttpRequest`, layered over SameSite=Strict cookies.
  Safe methods are exempt and never mutate state.

## 5. API surface (all under `/api`, all require auth except `/api/auth/*`)

| Endpoint | Dashboard panel |
|----------|-----------------|
| `GET /api/auth/register|login|logout|logout-everywhere|me|verify-email` | — |
| `GET /api/overview` | Overview tab (goals, email rollup, counts) |
| `GET /api/sites`, `GET /api/sites/:key/stats?days=`, `/realtime`, `/breakdown` | Sites tab — mirrors the existing tracker API shape the dashboard already calls |
| `GET /api/email/windows`, `/api/email/campaigns` | Email tab (EMAIL_WINDOWS equivalent) |
| `GET /api/funnels` | Conversions tab (funnels + stage goals) |
| `GET /api/influencers[?category=][?status=]`, `/influencers/counts` | Influencers tab (`category='podcast'` for podcast hosts) |
| `GET /api/ip-registry[?type=][?status=]` | IP Registry tab |
| `GET /api/social` | Social tab |
| `GET /api/goals` | Goal progress bars |

Response envelope: `{ ok: true, ... }` / `{ ok: false, error: '<code>' }`.
Error codes are stable strings (`unauthorized`, `site_not_found`,
`invalid_credentials`, `too_many_requests`, …), never stack traces.

## 6. Project layout

```
d2rm-dashboard-saas/
├── ARCHITECTURE.md          # this file
├── package.json             # 6 runtime deps, 0 dev deps (node:test built in)
├── .env.example
├── migrations/
│   └── 001_init.sql         # full multi-tenant schema (15 tables)
├── src/
│   ├── server.js            # Express wiring, middleware order, boot
│   ├── db.js                # connection, migrate(), transaction(), forTenant(), unscoped
│   ├── lib/
│   │   ├── password.js      # bcrypt helpers + dummy hash
│   │   └── sessions.js      # create/verify/revoke/purge, cookie options
│   ├── middleware/
│   │   ├── auth.js          # requireAuth, requireRole
│   │   ├── csrf.js          # X-Requested-With check
│   │   └── rateLimit.js     # auth + api limiters
│   └── routes/
│       ├── auth.js          # register/login/logout/me/verify-email
│       ├── overview.js
│       ├── sites.js
│       ├── email.js
│       ├── funnels.js
│       ├── influencers.js
│       ├── ipRegistry.js
│       └── socialGoals.js
├── scripts/
│   ├── migrate.js           # npm run migrate
│   └── seed.js              # demo tenant + isolation-marker tenant
└── tests/
    ├── helpers.js           # fresh DB, ephemeral port, cookie-jar client
    ├── auth.test.js         # 8 tests: register/login/logout/CSRF/verify
    └── tenancy.test.js      # 3 tests: zero cross-tenant leakage
```

## 7. Verification

Phase 1 (2026-10-12):
- `npm test`: **11/11 pass**, including the full tenant-isolation suite.
- `npm run seed`: creates demo tenant with data mirroring the real
  dashboard (1578/11500 email goal, funnels, sites, influencers).
- Live smoke test: login → me → goals → funnels → site stats → 401
  unauthenticated — all correct, no cross-tenant leakage.

Phase 2 (2026-10-12) — full suite run TWICE, green both times:
- `npm test`: **38/38 pass** (11 Phase 1 + 27 new).
- New suites: billing/plan-limits (5), password-reset (4), ROI (3),
  realtime beacon+SSe (3), lead collection (7), assistant (5).
- Migrations 002 + 003 apply cleanly on the existing dev DB.
- Live smoke test (port 3101, seeded DB): login → /app serves with
  injected tenant SITES + assistant widget + tenant chip → beacon →
  realtime active_now → compat /api/stats → /api/billing ($100/mo Pro) →
  assistant chat returns data-grounded next actions. All 200, no leaks.

## 8. Phase 2 — shipped 2026-10-12

1. **Onboarding UI** (`public/`): dark-themed login, signup (plan picker:
   Starter $50 / Pro $100 only — no public enterprise tier), forgot/reset
   password, email verification pages. External CSS/JS only, strict CSP.
   Signup creates tenant + owner, 14-day trial, verification email via SES
   (stub fallback when AWS keys are absent).
2. **Dashboard frontend** (`GET /app`, auth-gated): the existing dashboard
   HTML is served per-tenant with serve-time injection (`src/app-serve.js`):
   `API_BASE`→same-origin, live `SITES` from the tenant's projects, live
   `EMAIL_WINDOWS` mapped to the template shape, goals grid re-rendered
   from `/api/goals`, tenant chip + Leads link in nav. Query-param compat
   shim (`/api/stats`, `/api/realtime`, `/api/breakdown`) preserves the
   tracker's response shape for the Sites tab's existing fetch code.
3. **Email verification/password reset**: forgot-password (enumeration-safe,
   always 200), single-use 1h reset tokens, reset revokes all sessions,
   resend-verification. Delivery via `src/lib/mailer.js` — **Amazon SES**
   when `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` + `SES_FROM_EMAIL`
   are set (`@aws-sdk/client-ses`, `SendEmail`); otherwise falls back to
   the stub (logs + in-memory outbox, zero emails sent). Production refuses
   to boot without SES configured (fail-fast in `src/config.js`), so a
   missing key can never silently break signup. Mail sends are
   fire-and-forget with logged errors — a transient SES failure never
   breaks registration; the user can re-request via resend-verification.
4. **Realtime feed** (stub replaced): public beacon `POST /api/collect/:siteKey`
   (per-site `collect_key`, rate-limited, CSRF-exempt by design) →
   `site_events` → `GET /api/sites/:key/realtime` (distinct sessions, 5-min
   window) + SSE `GET /api/sites/:key/stream` (5s ticks).
5. **ROI tracking**: `cost_cents`/`revenue_cents` on campaigns + funnels
   (migration 002); `roi_pct`/`profit_cents` on campaign, funnel, and
   overview-rollup responses (`src/lib/roi.js`).
6. **Plan enforcement** (`src/lib/plans.js`, Stripe STUBBED per Michael):
   project caps enforced on `POST /api/sites` (starter: 2, pro: 10 → 403
   `project_limit_reached`); monthly email quota enforced on
   `POST /api/email/log-send` (starter: 5k, pro: 20k → 403
   `email_quota_exceeded`); `GET /api/billing` reports plan/limits/usage
   with a stubbed-checkout note. Agency plan exists in the DB enum for
   manual custom deals only — never shown on the signup picker.
7. **Lead collection** (`/api/leads`, `src/lib/collectors/`): turnkey lead
   gen productized from D2RM's internal collector fleet. v1 ships the two
   credential-free sources — `youtube` (keywords → public channel search →
   about pages → business emails) and `weblist` (seed URLs → page fetch →
   contact emails) — reusing the proven ytInitialData-parsing and email
   extraction logic. Jobs are tenant-scoped (`collection_jobs` table,
   migration 003); results dedupe into the tenant's `influencers` table
   (`status='unvetted'`, `source='lead-collect:<source>'`) — directly into
   the dashboard's email list. UI at `GET /leads`. Instagram/podcast/TikTok
   need per-customer credentials — deferred.
8. **AI marketing co-pilot** (`/api/assistant`, `src/lib/assistant.js`):
   chat grounded in the tenant's live data (email, funnels, goals, social,
   sites) via the tenant-scoped layer — never another tenant's rows.
   With `ANTHROPIC_API_KEY` set, Muse synthesizes replies (default
   `claude-haiku-4-5`); otherwise the built-in insight engine answers from
   the data (funnel drop-off, goal pace, next actions). Widget injected
   into `/app` (floating 💬 button + panel). 60 msgs/hour/IP rate limit.
9. **Production hardening**: `src/config.js` env validation (fails fast on
   bad production config — including missing SES credentials); strict CSP
   on auth pages, documented looser policy on `/app` (inline-script
   template); `.env.example`; `scripts/backup.js`
   (WAL-checkpointed timestamped copies); request logging stays minimal
   (no bodies/cookies/tokens); Secure cookies already gated on NODE_ENV.
10. **Guided onboarding** (migration 004): the turnkey promise made real.
    New signups land on `GET /onboarding` (auth-gated page, strict CSP) —
    a 5-step checklist with a progress bar and an embedded setup co-pilot
    chat panel. Steps: (1) welcome tour, (2) connect socials
    (Instagram/TikTok/YouTube/X/Facebook — handle plus optional API token),
    (3) install starter templates (8 email + 6 social, from
    `src/lib/starterTemplates.js`), (4) first lead-collection job (inline
    quick-run or the full `/leads` page), (5) first email campaign
    (`POST /api/email/campaigns`). Step completion is DERIVED from the
    tenant's real data (never a manual flag the UI could forget), so the
    checklist can't desync. Social tokens are AES-256-GCM encrypted
    (`src/lib/socialTokens.js`, key from `SOCIAL_TOKEN_KEY` — required in
    production, ephemeral dev fallback) and never leave the server in
    plaintext; API lists return only a `has_token` flag. The assistant is
    onboarding-aware: `buildContext` carries the checklist, the system
    prompt puts setup guidance first while incomplete, and the insight
    engine greets new users with their next step plus a 🛠 nudge on
    next-actions/briefing replies. `POST /api/onboarding/dismiss` skips
    setup; `POST /api/onboarding/restart` starts over. Real per-platform
    OAuth is a later milestone — v1's handle/token entry unblocks setup
    with zero app-registration overhead.

## 9. Decisions log (Phase 2 additions)

- 2026-10-12: Pricing corrected to Michael's decision: $50 (2 projects/5k
  emails) / $100 (10 projects/20k emails); no public enterprise tier.
  Earlier $79/$199/$499 figures were superseded.
- 2026-10-12: Stripe DEFERRAL — per Michael, wire payments later once
  everything works. Limits enforced in code now; checkout stubbed.
- 2026-10-12: Serve-time HTML injection for /app instead of rewriting the
  949-line dashboard — the file stays the generator's artifact; the SaaS
  transforms a copy per request (API_BASE, SITES, EMAIL_WINDOWS, goals,
  nav, assistant widget).
- 2026-10-12: SSE over WebSockets for the realtime feed — no new
  dependencies, works over plain HTTP, sufficient for 5s ticks.
- 2026-10-12: Lead collection v1 = credential-free sources only (YouTube
  public search, seed-URL fetch). Instagram/podcast/TikTok need customer
  credentials — deferred to keep v1 turnkey with zero setup.
- 2026-10-12: Assistant = Muse when ANTHROPIC_API_KEY is set, built-in
  insight engine otherwise. Both grounded exclusively in req.tdb data.

- 2026-10-12: Amazon SES integrated for transactional email
  (`@aws-sdk/client-ses`). SES when AWS keys + SES_FROM_EMAIL are set,
  stub fallback otherwise; production fail-fast without SES. SES pricing:
  $0.10/1k emails (Michael's resale plan: $0.20/1k). NOTE: new SES
  accounts start in the SANDBOX (verified identities only) — request
  production access and verify SES_FROM_EMAIL before launch.
- 2026-10-12: CSRF header required on auth mutations too (uniform posture;
  we control the frontend).
- 2026-10-12: Server-side sessions over JWT (instant revocation).
- 2026-10-12: Shared-schema tenancy over per-tenant DBs (v1 simplicity;
  single enforcement point in `forTenant()`).
- 2026-10-12: Guided onboarding shipped. Step completion derived from real
  tenant data (not manual flags); social tokens AES-256-GCM encrypted with
  SOCIAL_TOKEN_KEY (production-required); 8 email + 6 social starter
  templates bundled; assistant is onboarding-aware (proactive setup
  guidance in both Muse and insight-engine modes). Signup now redirects
  to /onboarding; /app nav gained a 🚀 Setup link. Full per-platform
  OAuth deferred — handle/token entry is the v1 unblocker.
- 2026-10-12: `engines.node >= 22` (required for `node:sqlite`).
