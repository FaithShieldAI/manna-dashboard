'use strict';
/**
 * FaithShield Stripe webhook tests (POST /api/billing/webhook/faithshield).
 *
 * Fully offline: events are fabricated JSON payloads signed locally with a
 * throwaway secret (Stripe SDK's generateTestHeaderString + constructEvent
 * are pure HMAC — no network). The checkout.session.completed payloads
 * carry an EXPANDED subscription object, which the handler accepts in place
 * of an API retrieve.
 *
 * Proves:
 *  - migration 021 created faithshield_subscriptions
 *  - FS-price checkout upserts a row and moves the 'faithshield' goal to 1
 *  - a Manna-price checkout is acknowledged but ignored
 *  - a bad signature gets a 400 and writes nothing
 *  - subscription.updated (trialing) counts; subscription.deleted cancels
 *    the row and drops the counter
 *  - missing STRIPE_FS_WEBHOOK_SECRET fails closed (503)
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();

const FS_SECRET = 'whsec_fs_test_throwaway';
const FS_PRICE = 'price_1UQtKcHKZQIpdYgs'; // the module default under test
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy_fs';
process.env.STRIPE_FS_WEBHOOK_SECRET = FS_SECRET;
delete process.env.STRIPE_FS_PRICE_ID; // exercise the built-in default

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

let server, base, db, tenantId;
before(async () => {
  ({ server, base } = await startServer());
  db = require('../src/db').db;
  // A tenant to hold the 'faithshield' goal row (seeded the way syncD2rm
  // would seed it into the D2RM owner tenant).
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'FS Goal Co',
    email: 'fs-goal@example.org',
    password: 'Sup3rSecret!',
    plan: 'starter',
  });
  assert.equal(r.status, 201);
  tenantId = db.prepare('SELECT tenant_id FROM users WHERE email = ?')
    .get('fs-goal@example.org').tenant_id;
  db.prepare(`
    INSERT INTO goals (tenant_id, goal_key, label, current_value, goal_value, unit)
    VALUES (?, 'faithshield', 'FaithShield paying users', 0, 100, 'users')
  `).run(tenantId);
});
after(async () => { server.close(); });

function goalValue() {
  return db.prepare(
    `SELECT current_value FROM goals WHERE tenant_id = ? AND goal_key = 'faithshield'`
  ).get(tenantId).current_value;
}
function subRow(subId) {
  return db.prepare(
    'SELECT * FROM faithshield_subscriptions WHERE stripe_subscription_id = ?'
  ).get(subId);
}

async function postEvent(payloadObj, signature) {
  const payload = JSON.stringify(payloadObj);
  const sig = signature !== undefined
    ? signature
    : stripe.webhooks.generateTestHeaderString({ payload, secret: FS_SECRET });
  const res = await fetch(base + '/api/billing/webhook/faithshield', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig },
    body: payload,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON */ }
  return { status: res.status, json };
}

function fsSubscription(id, customer, status) {
  return {
    id, object: 'subscription', customer, status,
    current_period_end: 1800000000,
    items: {
      object: 'list',
      data: [{
        id: 'si_' + id, object: 'subscription_item',
        price: { id: FS_PRICE, object: 'price' },
        current_period_end: 1800000000,
      }],
    },
  };
}

test('migration 021 created faithshield_subscriptions', () => {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'faithshield_subscriptions'`
  ).get();
  assert.ok(row, 'table exists');
});

test('FS checkout.session.completed upserts the sub and moves the goal to 1', async () => {
  const sub = fsSubscription('sub_fs_1', 'cus_fs_1', 'active');
  const r = await postEvent({
    id: 'evt_fs_1', object: 'event', type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_fs_1', object: 'checkout.session',
        customer: 'cus_fs_1', subscription: sub,
      },
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.tracked, true);
  const row = subRow('sub_fs_1');
  assert.ok(row, 'row upserted');
  assert.equal(row.stripe_customer_id, 'cus_fs_1');
  assert.equal(row.status, 'active');
  assert.ok(row.current_period_end, 'period end stored');
  assert.equal(goalValue(), 1);
});

test('a Manna-price checkout is acknowledged but ignored', async () => {
  const mannaSub = fsSubscription('sub_manna_1', 'cus_manna_1', 'active');
  mannaSub.items.data[0].price.id = 'price_manna_starter_not_fs';
  const r = await postEvent({
    id: 'evt_manna_1', object: 'event', type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_manna_1', object: 'checkout.session',
        customer: 'cus_manna_1', subscription: mannaSub,
      },
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.tracked, false);
  assert.equal(subRow('sub_manna_1'), undefined);
  assert.equal(goalValue(), 1, 'counter unchanged');
});

test('bad signature gets a 400 and writes nothing', async () => {
  const sub = fsSubscription('sub_fs_evil', 'cus_evil', 'active');
  const r = await postEvent({
    id: 'evt_evil', object: 'event', type: 'customer.subscription.updated',
    data: { object: sub },
  }, 't=1,v1=0000deadbeef');
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'invalid_signature');
  assert.equal(subRow('sub_fs_evil'), undefined);
  assert.equal(goalValue(), 1);
});

test('subscription.updated (trialing) for a second FS sub raises the goal to 2', async () => {
  const sub = fsSubscription('sub_fs_2', 'cus_fs_2', 'trialing');
  const r = await postEvent({
    id: 'evt_fs_2', object: 'event', type: 'customer.subscription.updated',
    data: { object: sub },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.tracked, true);
  assert.equal(subRow('sub_fs_2').status, 'trialing');
  assert.equal(goalValue(), 2);
});

test('subscription.deleted cancels the row and drops the goal back to 1', async () => {
  const sub = fsSubscription('sub_fs_1', 'cus_fs_1', 'canceled');
  const r = await postEvent({
    id: 'evt_fs_3', object: 'event', type: 'customer.subscription.deleted',
    data: { object: sub },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.tracked, true);
  assert.equal(subRow('sub_fs_1').status, 'canceled');
  assert.equal(goalValue(), 1);
});

test('missing STRIPE_FS_WEBHOOK_SECRET fails closed with a 503', async () => {
  delete process.env.STRIPE_FS_WEBHOOK_SECRET;
  try {
    const sub = fsSubscription('sub_fs_3', 'cus_fs_3', 'active');
    const r = await postEvent({
      id: 'evt_fs_4', object: 'event', type: 'customer.subscription.updated',
      data: { object: sub },
    });
    assert.equal(r.status, 503);
    assert.equal(subRow('sub_fs_3'), undefined);
  } finally {
    process.env.STRIPE_FS_WEBHOOK_SECRET = FS_SECRET;
  }
});

test('exported manual resync recomputes the counter from the table', () => {
  const handler = require('../src/routes/faithshieldWebhook');
  assert.equal(typeof handler.resyncFaithshieldGoal, 'function');
  // Corrupt the counter by hand, then resync: table has one paying sub
  // (sub_fs_2 trialing; sub_fs_1 canceled).
  db.prepare(`UPDATE goals SET current_value = 99 WHERE goal_key = 'faithshield'`).run();
  const out = handler.resyncFaithshieldGoal();
  assert.equal(out.count, 1);
  assert.equal(goalValue(), 1);
});
