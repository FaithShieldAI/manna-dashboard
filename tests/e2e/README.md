# Manna E2E Tests — the "ultimate check"

Two layers that together simulate a real user, built after unit tests
(78 passing) and the security red-team (42/42) both missed real user-facing
bugs on 2026-10-14:

- **Session loss on refresh** — signed in, hit F5, got
  `{"ok":false,"error":"unauthorized"}` → `session.test.js`
- **Dead tab buttons** — "the buttons don't change anything" →
  `tabs.test.js` (all 8 onboarding tabs + all 10 /app tabs incl. Vetted)
- **Blank dashboard** — Key Numbers not rendering → `tabs.test.js`

## Why two layers (read before "simplifying")

The Chromium available in this environment refuses ALL network I/O to
loopback — `page.goto()`, subresource loads and `fetch()` to
`http://127.0.0.1` are blocked with
`net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`, and no launch flag, CDP
permission grant, or proxy setting bypasses it (verified empirically).
A classic goto-and-click browser test cannot run here.

So each layer uses the REAL artifact it exercises:

- **Layer 1 — HTTP + real cookie jar** (`session.test.js`, `journey.test.js`):
  node `fetch()` replays EXACTLY what the shipped frontend JS sends (same
  URLs, same headers incl. `X-Requested-With`, same JSON bodies), and
  tough-cookie (full RFC 6265) decides what a browser would store and
  re-send. "Refresh" is a fresh GET with the jar's cookies — precisely what
  F5 does. Catches: cookies a browser would reject (Secure on http, wrong
  Path/Domain, bad SameSite), sessions not persisted server-side, logout
  not ending sessions.

- **Layer 2 — real Chromium DOM + real shipped JS** (`tabs.test.js`):
  `page.setContent()` loads the REAL `public/*.html`; the REAL
  `public/js/*.js` is injected (what `<script src>` would have fetched);
  then REAL clicks on REAL buttons assert REAL panel switching, with
  console/page errors collected. Catches dead tabs, mismatched panel IDs,
  JS exceptions. (No network happens in this layer by design.)

## Run

```bash
npm run test:e2e
```

Each file gets a **fresh SQLite DB** and tests use **unique emails**, so
nothing leaks between tests. The Chromium layer uses a fresh page per test.

## Requirements

- Node >= 22
- A Chromium/Chrome binary. Defaults to `/opt/meta-chromium/chrome`.
  Override with `CHROME_PATH`:
  ```bash
  CHROME_PATH=/usr/bin/chromium npm run test:e2e
  ```
- `puppeteer-core`, `tough-cookie` (devDependencies — installed)

## What each file covers

| File | Layer | What it proves |
|---|---|---|
| `session.test.js` | HTTP+jar | Login sets a storable session cookie; session survives refresh (the 2026-10-14 bug); session works across /app and /onboarding; anonymous /app → /login; logout ends the session; wrong password sets no cookie |
| `tabs.test.js` | Chromium | Every tab button shows exactly its panel (8 on onboarding, 10 on /app incl. Vetted + Billing); buttons get active state; Key Numbers render; `[data-goto-tab]` shortcuts work; zero console/page errors |
| `journey.test.js` | HTTP+jar | Full first-time flow: signup → /onboarding → /app with Vetted tab; returning-user login; short password rejected with clear error; duplicate email rejected without confirming it exists |

## Pre-deploy gate

Per Michael's standard — **"100% is 100%"** — run before every
staging/production deploy:

```bash
npm test && npm run test:e2e
```

If any e2e test fails, a real user flow is broken. **Do not ship.**
