'use strict';
/**
 * Billing tab seats (2026-11-18, red-team walk minor): GET /api/billing
 * already reported the tenant's seat state (src/lib/seats.js, the same
 * tenants row the tenant-plan door writes: plan seats_included plus
 * tenants.extra_seats, against the tenant's user count), but the
 * Billing tab's loadBilling never rendered it, so no seats figure
 * appeared anywhere on the tab.
 *
 * Under test: the API reports the door-written seat state, and the
 * tab's own render functions (billingUsageBar + loadBilling, extracted
 * from the served template and executed with a stubbed fetch) draw
 * the seats bar from that payload, and omit it when the payload
 * carries no seats.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();
process.env.MIGRATION_TOKEN = ['test', 'billing', 'seats'].join('-');

let server, base, db;
before(async () => {
  ({ server, base } = await startServer());
  ({ db } = require('../src/db'));
});
after(async () => { server.close(); });

test('billing API reports the seat state the tenant-plan door writes', async () => {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'Seats Co', email: 'seats@billing.example',
    password: 'billing-seats-secret', plan: 'starter',
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const tenantId = Number(r.json.tenant.id);

  const b1 = await c.get('/api/billing');
  assert.equal(b1.status, 200);
  assert.deepEqual(
    {
      included: b1.json.seats.included, extra: b1.json.seats.extra,
      total: b1.json.seats.total, used: b1.json.seats.used,
    },
    { included: 1, extra: 0, total: 1, used: 1 },
  );

  // The tenant-plan door writes extra_seats on the tenants row; the
  // billing read must move with it (same source, no second copy).
  const door = await c.post(`/api/auth/tenant-plan/${process.env.MIGRATION_TOKEN}`, {
    tenant_id: tenantId, extra_seats: 2,
  });
  assert.equal(door.status, 200, JSON.stringify(door.json));

  const b2 = await c.get('/api/billing');
  assert.equal(b2.json.seats.extra, 2);
  assert.equal(b2.json.seats.total, 3);
  assert.equal(b2.json.seats.used, 1);
});

function renderBilling(payload) {
  const template = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'dashboard-template.html'), 'utf8'
  );
  const start = template.indexOf('function billingUsageBar');
  const end = template.indexOf('/* lazy-load billing on first open of the tab */');
  assert.ok(start > 0 && end > start, 'billing render functions must exist in the template');
  const src = template.slice(start, end);
  const bodyEl = { innerHTML: '', querySelectorAll: () => [] };
  const badgeEl = { style: {}, textContent: '' };
  const sandbox = {
    console,
    API_BASE: '',
    apiH: () => ({}),
    MannaI18n: { t: (k) => k },
    esc: (s) => String(s == null ? '' : s),
    num: (n) => Number(n).toLocaleString('en-US'),
    document: {
      getElementById: (id) => (id === 'billing-body' ? bodyEl : (id === 'billing-status-badge' ? badgeEl : null)),
      querySelectorAll: () => [],
    },
    fetch: () => Promise.resolve({ json: () => Promise.resolve(payload) }),
    _billingLoaded: false,
  };
  vm.createContext(sandbox);
  vm.runInContext(src + '\nloadBilling();', sandbox);
  return new Promise(resolve => setImmediate(() => setImmediate(() => resolve(bodyEl.innerHTML))));
}

const BILLING_PAYLOAD = {
  ok: true,
  plan_name: 'Heavy 30', price_label: '$129.99/mo', tagline: 'tagline',
  subscription_status: 'active',
  usage: { month_key: '2026-11', projects_used: 1, emails_sent_this_month: 10 },
  limits: { projects: 10, emails_per_month: 50000 },
  plans: [],
  checkout: {},
  seats: { included: 1, extra: 2, total: 3, used: 1, remaining: 2, price_label: '$25/mo' },
};

test('billing tab renders the seats bar from the API payload', async () => {
  const html = await renderBilling(BILLING_PAYLOAD);
  assert.ok(
    html.includes('dash.js.billing.usage_seats'),
    'the seats bar label must render when the payload carries seats',
  );
  assert.ok(
    html.includes('dash.js.billing.usage_projects') && html.includes('dash.js.billing.usage_emails'),
    'the existing usage bars still render',
  );
});

test('billing tab omits the seats bar when the payload carries none', async () => {
  const payload = { ...BILLING_PAYLOAD };
  delete payload.seats;
  const html = await renderBilling(payload);
  assert.ok(!html.includes('dash.js.billing.usage_seats'));
  assert.ok(html.includes('dash.js.billing.usage_projects'));
});
