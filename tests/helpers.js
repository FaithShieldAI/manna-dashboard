'use strict';
/**
 * Test helpers: fresh SQLite DB per test file, app on an ephemeral port,
 * tiny fetch-based HTTP client that manages cookies + CSRF header.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

function freshDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd2rm-test-'));
  return path.join(dir, 'test.db');
}

/**
 * Must be called before requiring the app. Each test file gets its own DB
 * because node --test runs files in separate processes.
 */
function setupTestEnv() {
  process.env.DATABASE_PATH = freshDbPath();
  process.env.NODE_ENV = 'test';
  // Signup demo-seeding is skipped in the test harness (it's a 9k-row insert
  // per registration). The real path is covered by tests/signup-seed.test.js,
  // which deliberately does NOT set this var.
  process.env.MANNA_SKIP_SIGNUP_SEED = '1';
}

async function startServer() {
  const app = require('../src/server');
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}

/** Minimal cookie jar + JSON client. */
function client(base) {
  let cookie = '';
  async function req(method, p, body) {
    const headers = { 'X-Requested-With': 'XMLHttpRequest' };
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + p, { method, headers, body: payload, redirect: 'manual' });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      // keep the session cookie (first segment before ';')
      const m = setCookie.match(/d2rm_session=[^;]*/);
      if (m) cookie = m[0];
      if (/d2rm_session=;/.test(setCookie)) cookie = '';
    }
    let json = null;
    try { json = await res.json(); } catch (e) { /* non-JSON */ }
    return { status: res.status, json };
  }
  return {
    get: (p) => req('GET', p),
    post: (p, body) => req('POST', p, body),
    put: (p, body) => req('PUT', p, body),
    patch: (p, body) => req('PATCH', p, body),
    del: (p) => req('DELETE', p),
    clearCookie() { cookie = ''; },
  };
}

module.exports = { setupTestEnv, startServer, client };
