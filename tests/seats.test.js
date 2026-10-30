'use strict';
/**
 * Seat purchase flow tests (2026-10-29):
 *  - every plan includes ONE seat (the owner's login); extra seats are
 *    $25/mo, sold as a quantity-bearing item on the tenant's subscription
 *  - POST /api/billing/seats/checkout: Checkout Session when the tenant
 *    has no subscription; in-place subscription-item update when it does
 *  - POST /api/billing/seats: sets the TOTAL extra-seat quantity (0
 *    removes the item) — the Manna-side quantity-management path
 *  - webhook: checkout.session.completed / customer.subscription.updated
 *    reconcile tenants.extra_seats from the seat item; subscription
 *    .deleted resets seats to 0; a seat item never moves the plan
 *  - POST /api/team refuses to add a login past the seat total with the
 *    purchase-prompt contract, and succeeds once seats are available
 *  - 'pro' is retired from self-serve registration (400 invalid_plan)
 *
 * Stripe is FAKED: stripeLib.getStripe is replaced with an in-memory fake
 * before the server starts (this file runs in its own process, like every
 * test file). No network, no live keys.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestEnv, startServer, client } = require('./helpers');

setupTestEnv();

process.env.STRIPE_PRICE_SEAT = 'price_seat_test_25';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_seat_test';

const { db } = require('../src/db');
const password = require('../src/lib/password');
const stripeLib = require('../src/lib/stripe');

// --- fake Stripe -----------------------------------------------------------
const calls = { checkoutSessions: [], itemsCreate: [], itemsUpdate: [], itemsDel: [] };
let fakeSub = null; // the subscription object subscriptions.retrieve returns

const fakeStripe = {
  checkout: {
    sessions: {
      create: async (params) => {
        calls.checkoutSessions.push(params);
        return { id: 'cs_seat_test', url: 'https://checkout.stripe.test/cs_seat_test' };
      },
    },
  },
  subscriptions: {
    retrieve: async () => fakeSub,
  },
  subscriptionItems: {
    create: async (params) => {
      calls.itemsCreate.push(params);
      const item = { id: 'si_seat_new', price: { id: params.price }, quantity: params.quantity };
      fakeSub.items.data.push(item);
      return item;
    },
    update: async (id, params) => {
      calls.itemsUpdate.push({ id, params });
      const item = fakeSub.items.data.find(i => i.id === id);
      if (item) item.quantity = params.quantity;
      return item || { id };
    },
    del: async (id) => {
      calls.itemsDel.push(id);
      fakeSub.items.data = fakeSub.items.data.filter(i => i.id !== id);
      return { id, deleted: true };
    },
  },
  webhooks: {
    // The handler's real gate is (stripe configured + secret set); the
    // fake accepts the JSON body the test posted as the verified event.
    constructEvent: (body) => JSON.parse(body.toString()),
  },
};
stripeLib.getStripe = () => fakeStripe;

let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

async function registerOwner(email) {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'Seat Co ' + email,
    email,
    password: 'seat-secret-pw-123',
    plan: 'starter',
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const tenantId = db.prepare('SELECT tenant_id FROM users WHERE email = ?').get(email).tenant_id;
  return { c, tenantId };
}

function tenantRow(tenantId) {
  return db.prepare(
    'SELECT plan, subscription_status, stripe_customer_id, stripe_subscription_id, extra_seats, stripe_seat_item_id FROM tenants WHERE id = ?'
  ).get(tenantId);
}

async function postWebhook(event) {
  const res = await fetch(base + '/api/billing/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 'test-sig' },
    body: JSON.stringify(event),
  });
  const json = await res.json();
  return { status: res.status, json };
}

// --- checkout creation -----------------------------------------------------

test('seat checkout without a subscription creates a Checkout session for the seat price', async () => {
  const { c, tenantId } = await registerOwner('seat-buy@example.org');
  const before = calls.checkoutSessions.length;
  const r = await c.post('/api/billing/seats/checkout', { quantity: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.url, 'https://checkout.stripe.test/cs_seat_test');
  assert.equal(calls.checkoutSessions.length, before + 1);
  const params = calls.checkoutSessions[calls.checkoutSessions.length - 1];
  assert.equal(params.mode, 'subscription');
  assert.deepEqual(params.line_items, [{ price: 'price_seat_test_25', quantity: 2 }]);
  assert.equal(params.metadata.tenant_id, String(tenantId));
  assert.equal(params.metadata.purchase, 'seats');
  assert.equal(params.subscription_data.metadata.purchase, 'seats');
});

test('seat checkout validates quantity', async () => {
  const { c } = await registerOwner('seat-qty@example.org');
  for (const q of [0, -1, 2.5, 'two', undefined]) {
    const r = await c.post('/api/billing/seats/checkout', { quantity: q });
    assert.equal(r.status, 400, `quantity=${q}`);
    assert.equal(r.json.error, 'invalid_quantity');
  }
});

// --- webhook seat sync -----------------------------------------------------

test('webhook checkout.session.completed syncs purchased seats onto the tenant', async () => {
  const { c, tenantId } = await registerOwner('seat-hook@example.org');
  fakeSub = {
    id: 'sub_seat_1', customer: 'cus_seat_1', status: 'active',
    metadata: { tenant_id: String(tenantId), purchase: 'seats' },
    items: { data: [{ id: 'si_seat_1', price: { id: 'price_seat_test_25' }, quantity: 2 }] },
  };
  const r = await postWebhook({
    type: 'checkout.session.completed',
    data: {
      object: {
        customer: 'cus_seat_1',
        subscription: 'sub_seat_1',
        metadata: { tenant_id: String(tenantId), purchase: 'seats' },
      },
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const row = tenantRow(tenantId);
  assert.equal(row.extra_seats, 2);
  assert.equal(row.stripe_seat_item_id, 'si_seat_1');
  assert.equal(row.stripe_subscription_id, 'sub_seat_1');
  // A seat item is not a plan: the tenant's plan never moves.
  assert.equal(row.plan, 'starter');

  const billing = await c.get('/api/billing');
  assert.equal(billing.status, 200);
  assert.equal(billing.json.seats.included, 1);
  assert.equal(billing.json.seats.extra, 2);
  assert.equal(billing.json.seats.total, 3);
  assert.equal(billing.json.seats.used, 1);
  assert.equal(billing.json.seats.remaining, 2);
  assert.equal(billing.json.seats.price_label, '$25/mo');
});

// --- in-place purchase + quantity management -------------------------------

test('seat checkout with an existing subscription grows the seat item in place', async () => {
  const { c, tenantId } = await registerOwner('seat-grow@example.org');
  db.prepare("UPDATE tenants SET stripe_customer_id = 'cus_grow', stripe_subscription_id = 'sub_grow' WHERE id = ?")
    .run(tenantId);
  fakeSub = {
    id: 'sub_grow', customer: 'cus_grow', status: 'active',
    metadata: { tenant_id: String(tenantId) },
    items: { data: [
      { id: 'si_plan_1', price: { id: 'price_plan_x' }, quantity: 1 },
      { id: 'si_seat_1', price: { id: 'price_seat_test_25' }, quantity: 2 },
    ] },
  };
  const updatesBefore = calls.itemsUpdate.length;
  const sessionsBefore = calls.checkoutSessions.length;
  const r = await c.post('/api/billing/seats/checkout', { quantity: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.mode, 'subscription_update');
  assert.equal(r.json.seats.extra, 3);
  // No new checkout session, no new item — the existing item grew 2 -> 3.
  assert.equal(calls.checkoutSessions.length, sessionsBefore);
  assert.equal(calls.itemsUpdate.length, updatesBefore + 1);
  assert.deepEqual(calls.itemsUpdate[calls.itemsUpdate.length - 1],
    { id: 'si_seat_1', params: { quantity: 3, proration_behavior: 'create_prorations' } });
  assert.equal(tenantRow(tenantId).extra_seats, 3);
});

test('POST /api/billing/seats sets the total quantity; 0 removes the item', async () => {
  const { c, tenantId } = await registerOwner('seat-set@example.org');
  db.prepare("UPDATE tenants SET stripe_customer_id = 'cus_set', stripe_subscription_id = 'sub_set', extra_seats = 3, stripe_seat_item_id = 'si_seat_1' WHERE id = ?")
    .run(tenantId);
  fakeSub = {
    id: 'sub_set', customer: 'cus_set', status: 'active',
    metadata: { tenant_id: String(tenantId) },
    items: { data: [{ id: 'si_seat_1', price: { id: 'price_seat_test_25' }, quantity: 3 }] },
  };
  const down = await c.post('/api/billing/seats', { quantity: 1 });
  assert.equal(down.status, 200, JSON.stringify(down.json));
  assert.equal(down.json.seats.extra, 1);
  assert.equal(tenantRow(tenantId).extra_seats, 1);

  const zero = await c.post('/api/billing/seats', { quantity: 0 });
  assert.equal(zero.status, 200, JSON.stringify(zero.json));
  assert.equal(zero.json.seats.extra, 0);
  assert.ok(calls.itemsDel.includes('si_seat_1'));
  const row = tenantRow(tenantId);
  assert.equal(row.extra_seats, 0);
  assert.equal(row.stripe_seat_item_id, null);

  const bad = await c.post('/api/billing/seats', { quantity: -2 });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'invalid_quantity');
});

test('POST /api/billing/seats without a subscription is a 404', async () => {
  const { c } = await registerOwner('seat-nosub@example.org');
  const r = await c.post('/api/billing/seats', { quantity: 1 });
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'no_subscription');
});

test('webhook subscription.updated reconciles seat quantity; deleted resets it', async () => {
  const { tenantId } = await registerOwner('seat-sync@example.org');
  db.prepare("UPDATE tenants SET stripe_customer_id = 'cus_sync', stripe_subscription_id = 'sub_sync' WHERE id = ?")
    .run(tenantId);
  const updated = await postWebhook({
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_sync', customer: 'cus_sync', status: 'active',
        metadata: { tenant_id: String(tenantId) },
        items: { data: [{ id: 'si_seat_9', price: { id: 'price_seat_test_25' }, quantity: 4 }] },
      },
    },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.json));
  assert.equal(tenantRow(tenantId).extra_seats, 4);
  assert.equal(tenantRow(tenantId).stripe_seat_item_id, 'si_seat_9');

  const deleted = await postWebhook({
    type: 'customer.subscription.deleted',
    data: {
      object: {
        id: 'sub_sync', customer: 'cus_sync', status: 'canceled',
        metadata: { tenant_id: String(tenantId) },
        items: { data: [{ id: 'si_seat_9', price: { id: 'price_seat_test_25' }, quantity: 4 }] },
      },
    },
  });
  assert.equal(deleted.status, 200);
  const row = tenantRow(tenantId);
  assert.equal(row.subscription_status, 'canceled');
  assert.equal(row.extra_seats, 0);
  assert.equal(row.stripe_seat_item_id, null);
});

// --- enforcement -----------------------------------------------------------

test('team add is refused at the seat limit, then allowed once a seat is purchased', async () => {
  const { c, tenantId } = await registerOwner('seat-team@example.org');

  const team0 = await c.get('/api/team');
  assert.equal(team0.status, 200);
  assert.equal(team0.json.members.length, 1);
  assert.equal(team0.json.seats.total, 1);
  assert.equal(team0.json.seats.used, 1);

  const refused = await c.post('/api/team', { email: 'member1@example.org', displayName: 'Member One' });
  assert.equal(refused.status, 403, JSON.stringify(refused.json));
  assert.equal(refused.json.error, 'seat_limit_reached');
  assert.equal(refused.json.upgrade_required, true);
  assert.equal(refused.json.limit_name, 'seats');
  assert.equal(refused.json.limit, 1);
  assert.equal(refused.json.used, 1);
  assert.equal(refused.json.remaining, 0);
  assert.match(refused.json.message, /\$25\/mo/);
  assert.match(refused.json.message, /add seats from Billing/i);
  // The refusal created nobody.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE tenant_id = ?').get(tenantId).n, 1);

  // One purchased seat (as the webhook would record it) opens exactly one slot.
  db.prepare('UPDATE tenants SET extra_seats = 1 WHERE id = ?').run(tenantId);
  const added = await c.post('/api/team', { email: 'member1@example.org', displayName: 'Member One' });
  assert.equal(added.status, 201, JSON.stringify(added.json));
  assert.equal(added.json.user.email, 'member1@example.org');
  assert.equal(added.json.user.role, 'viewer');
  assert.equal(added.json.seats.used, 2);
  assert.equal(added.json.seats.remaining, 0);

  const refused2 = await c.post('/api/team', { email: 'member2@example.org' });
  assert.equal(refused2.status, 403);
  assert.equal(refused2.json.error, 'seat_limit_reached');
  assert.equal(refused2.json.limit, 2);
});

test('team add validates input and never grants the owner role', async () => {
  const { c, tenantId } = await registerOwner('seat-valid@example.org');
  db.prepare('UPDATE tenants SET extra_seats = 5 WHERE id = ?').run(tenantId);
  const badEmail = await c.post('/api/team', { email: 'not-an-email' });
  assert.equal(badEmail.status, 400);
  assert.equal(badEmail.json.error, 'invalid_email');
  const ownerRole = await c.post('/api/team', { email: 'sneaky@example.org', role: 'owner' });
  assert.equal(ownerRole.status, 400);
  assert.equal(ownerRole.json.error, 'invalid_role');
  const dupe = await c.post('/api/team', { email: 'seat-valid@example.org' });
  assert.equal(dupe.status, 409);
  assert.equal(dupe.json.error, 'email_unavailable');
});

test('a team viewer cannot buy or manage seats', async () => {
  const { c, tenantId } = await registerOwner('seat-roles@example.org');
  db.prepare('UPDATE tenants SET extra_seats = 1 WHERE id = ?').run(tenantId);
  const added = await c.post('/api/team', { email: 'viewer1@example.org', role: 'viewer' });
  assert.equal(added.status, 201);
  // Give the viewer a known password (as if they accepted the invite) and
  // sign in as them.
  const hash = await password.hash('viewer-secret-pw-12');
  db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, 'viewer1@example.org');
  const vc = client(base);
  const login = await vc.post('/api/auth/login', { email: 'viewer1@example.org', password: 'viewer-secret-pw-12' });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  const buy = await vc.post('/api/billing/seats/checkout', { quantity: 1 });
  assert.equal(buy.status, 403);
  assert.equal(buy.json.error, 'forbidden');
  const set = await vc.post('/api/billing/seats', { quantity: 1 });
  assert.equal(set.status, 403);
  const add = await vc.post('/api/team', { email: 'viewer2@example.org' });
  assert.equal(add.status, 403);
});

// --- the 'pro' retirement ---------------------------------------------------

test("registering with plan 'pro' is refused — retired from self-serve", async () => {
  const c = client(base);
  const r = await c.post('/api/auth/register', {
    companyName: 'Pro Grab Co', email: 'pro-grab@example.org',
    password: 'pro-grab-secret-12', plan: 'pro',
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'invalid_plan');
});
