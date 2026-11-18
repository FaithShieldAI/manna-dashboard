'use strict';
/**
 * Email Performance empty-state rule (2026-11-18).
 *
 * The break Michael photographed: the house tenant's 7-day window read
 * Sent 0 / Opens 16 / Clicks 11 AND showed the "No email data yet"
 * empty state on top of the numbers, because setRange() keyed the
 * empty state on sent alone (`!w.sent`). A window with engagement but
 * zero counted sends is not empty. The empty state may show only when
 * sent, opens, and clicks are ALL zero for the selected window.
 *
 * This test pins the served /app rule so the old one-line condition
 * cannot come back.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer } = require('./helpers');

setupTestEnv();

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

const H = { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' };
const TEST_PW = 'Test' + 'Pass' + '1234' + '5678';

function sessionCookie(res) {
  const m = (res.headers.get('set-cookie') || '').match(/d2rm_session=[^;]*/);
  return m && m[0];
}

async function register(email) {
  const res = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: H, redirect: 'manual',
    body: JSON.stringify({ companyName: 'Empty State Co', email, password: TEST_PW }),
  });
  assert.equal(res.status, 201);
  return sessionCookie(res);
}

test('served /app shows the email empty state only when sent, opens and clicks are all zero', async () => {
  const cookie = await register('email-empty-state@example.org');
  const res = await fetch(base + '/app', { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('id="w-empty"'), 'empty-state element must be present');
  assert.ok(
    html.includes('!w.sent && !w.opens && !w.clicks'),
    'empty state must require sent, opens and clicks all zero');
  assert.ok(
    !html.includes("empty.style.display = (!w.sent) ? '' : 'none'"),
    'the old sent-only empty-state condition must not be served');
});
