'use strict';
/**
 * E2E test helpers — two-layer "ultimate check".
 *
 * WHY TWO LAYERS (read before "simplifying" this):
 * The Chromium available in this environment (system meta-chromium build)
 * refuses ALL network I/O to loopback — page.goto, subresource loads and
 * fetch() to http://127.0.0.1 are blocked with
 * net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS, and no flag, CDP
 * permission grant, or proxy setting bypasses it. So a classic
 * goto-and-click browser test cannot run here.
 *
 * Instead each layer uses the REAL artifact it exercises:
 *
 *   Layer 1 — HTTP + real cookie jar (tough-cookie, full RFC 6265):
 *     node fetch() replays the EXACT requests the shipped frontend JS makes
 *     (same URLs, same headers incl. X-Requested-With, same JSON bodies),
 *     and a real cookie jar decides what a browser would store and re-send.
 *     This is what catches session bugs: Secure-on-http cookies, wrong
 *     Path/Domain, SameSite blocking, missing credentials, server-side
 *     session loss — i.e. the 2026-10-14 "signed in, hit refresh, got
 *     unauthorized" bug class.
 *
 *   Layer 2 — real Chromium DOM + real shipped JS:
 *     page.setContent() with the REAL public/*.html plus the REAL
 *     public/js/*.js injected, then real clicks on real buttons.
 *     Catches dead tabs, mismatched panel IDs, JS exceptions — the
 *     2026-10-14 "the buttons don't change anything" bug class.
 *     (setContent is used because goto() to loopback is blocked; no
 *     network I/O happens in this layer by design.)
 *
 * Each test file gets a fresh SQLite DB (tests/helpers.js setupTestEnv) and
 * tests use unique emails, so nothing leaks between tests or files.
 *
 * Env:
 *   CHROME_PATH — Chromium binary. Defaults to /opt/meta-chromium/chrome.
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { CookieJar } = require('tough-cookie');
const { client } = require('../helpers');

const CHROME_PATH = process.env.CHROME_PATH || '/opt/meta-chromium/chrome';
const TEST_PASSWORD = 'e2e-test-password-123'; // >= 12 chars per signup rules
const REPO_ROOT = path.join(__dirname, '..', '..');

/* ------------------------------------------------------------------ */
/* Layer 2: real Chromium (DOM + JS only, no network)                  */
/* ------------------------------------------------------------------ */

async function launchBrowser() {
  return puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
}

function readPublicFile(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, 'public', rel), 'utf8');
}

/**
 * Load REAL page HTML into a real Chromium page and inject REAL shipped JS
 * files (the <script src> tags can't load over the network here, so the test
 * harness inlines exactly what the browser would have fetched).
 */
async function loadRealPage(page, htmlFile, jsFiles = []) {
  const html = readPublicFile(htmlFile);
  await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });
  for (const js of jsFiles) {
    await page.addScriptTag({ content: readPublicFile(js) });
  }
  // Let any inline scripts / injected scripts finish wiring up.
  await new Promise((r) => setTimeout(r, 300));
}

/** Collect console errors + uncaught page errors for later assertion. */
function watchConsole(page) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text().slice(0, 200)}`);
  });
  page.on('pageerror', (err) => {
    errors.push(`pageerror: ${err && err.message ? err.message.slice(0, 200) : String(err)}`);
  });
  return errors;
}

/** True when #panel-<tab> is actually rendered visible (handles both the
 *  .is-hidden class mechanism on /onboarding and inline display:none on /app). */
async function isPanelVisible(page, tab) {
  return page.evaluate((t) => {
    const el = document.getElementById('panel-' + t);
    if (!el) return false;
    if (el.classList.contains('is-hidden')) return false;
    const s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }, tab);
}

async function tabButtonActive(page, tab) {
  return page.$eval(
    `button.main-tab[data-tab="${tab}"]`,
    (el) => el.classList.contains('active')
  );
}

/* ------------------------------------------------------------------ */
/* Layer 1: HTTP with a real RFC-6265 cookie jar (browser fidelity)     */
/* ------------------------------------------------------------------ */

function newJar() {
  return new CookieJar();
}

/** The exact headers the shipped frontend (public/js/auth.js D2RM.api) sends. */
function frontendHeaders() {
  return { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
}

/**
 * fetch() through a real cookie jar: sends what a browser would send,
 * stores what a browser would store (honoring Domain/Path/Secure/
 * HttpOnly/SameSite/Max-Age). Returns { status, headers, json, text }.
 */
async function fetchWithJar(jar, url, { method = 'GET', headers = {}, body } = {}) {
  const cookieString = await jar.getCookieString(url);
  const res = await fetch(url, {
    method,
    headers: { ...headers, ...(cookieString ? { Cookie: cookieString } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const sc of setCookies) {
    try { await jar.setCookie(sc, url); } catch (e) { /* malformed -> browser would ignore */ }
  }
  let text = '';
  try { text = await res.text(); } catch (e) { /* ignore */ }
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* non-JSON */ }
  return { status: res.status, headers: res.headers, json, text };
}

async function jarHasSessionCookie(jar, url) {
  const cookies = await jar.getCookies(url);
  return cookies.some((c) => c.key === 'd2rm_session' && c.value);
}

/** Register via API (fast path; the UI signup form flow is covered in journey.test.js). */
async function registerUser(base, { companyName = 'E2E Co', displayName = 'E2E Tester', email, password = TEST_PASSWORD, plan = 'starter' } = {}) {
  if (!email) throw new Error('registerUser requires an email');
  const c = client(base);
  const r = await c.post('/api/auth/register', { companyName, displayName, email, password, plan });
  if (r.status !== 201) {
    throw new Error(`register failed: HTTP ${r.status} ${JSON.stringify(r.json)}`);
  }
  return { email, password, json: r.json };
}

/**
 * Log in EXACTLY the way public/js/login.js does:
 * POST /api/auth/login { email, password } with the frontend's headers.
 * The session cookie lands in the jar via fetchWithJar.
 */
async function loginLikeFrontend(jar, base, email, password) {
  return fetchWithJar(jar, base + '/api/auth/login', {
    method: 'POST',
    headers: frontendHeaders(),
    body: { email, password },
  });
}

function uniqueEmail(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

const TABS_ONBOARDING = ['overview', 'email', 'warm', 'conversions', 'sites', 'influencers', 'social', 'ipregistry'];
const TABS_APP = ['overview', 'email', 'warm', 'conversions', 'sites', 'influencers', 'vetted', 'social', 'ipregistry', 'billing'];

module.exports = {
  CHROME_PATH,
  TEST_PASSWORD,
  launchBrowser,
  readPublicFile,
  loadRealPage,
  watchConsole,
  isPanelVisible,
  tabButtonActive,
  newJar,
  frontendHeaders,
  fetchWithJar,
  jarHasSessionCookie,
  registerUser,
  loginLikeFrontend,
  uniqueEmail,
  TABS_ONBOARDING,
  TABS_APP,
};
