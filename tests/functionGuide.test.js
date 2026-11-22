'use strict';
/**
 * The Function Guide (2026-11-22, Michael's order: "Scribe guides
 * every function"). Three pins:
 *   1. Grounding: every tab the guide names exists in the dashboard,
 *      and every control it names appears verbatim in the real UI
 *      files, so the guidance cannot drift from the screens.
 *   2. Matching: plain how/what/where questions route to the right
 *      function; stats questions do not get captured by the guide.
 *   3. End to end: a brand-new user asking the chat gets the guide.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setupTestEnv, startServer, client } = require('./helpers');
const guide = require('../src/lib/functionGuide');

setupTestEnv();

const ROOT = path.join(__dirname, '..');
const uiText = [
  'public/dashboard-template.html',
  'public/js/drips.js',
  'public/js/engagement.js',
  'public/js/leads.js',
  'public/js/content.js',
  'public/js/pr.js',
  'translations/en.json',
].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
const template = fs.readFileSync(path.join(ROOT, 'public/dashboard-template.html'), 'utf8');

test('every guided tab exists and every named control is on a real screen', () => {
  assert.ok(guide.FUNCTIONS.length >= 16, 'the guide covers the whole app');
  for (const f of guide.FUNCTIONS) {
    if (f.tab) {
      assert.ok(template.includes(`data-tab="${f.tab}"`), `${f.name}: tab ${f.tab} exists in the dashboard`);
      assert.ok(template.includes(`id="panel-${f.tab}"`), `${f.name}: panel ${f.tab} exists`);
    }
    for (const c of f.controls) {
      assert.ok(uiText.includes(c), `${f.name}: control "${c}" appears in the real UI`);
    }
    assert.ok(f.purpose.length > 20 && f.steps.length >= 2, `${f.name}: has a purpose and steps`);
  }
});

test('questions route to the right function', () => {
  const cases = [
    ['how do drips work', 'drips'],
    ['how do drip campaigns work', 'drips'],
    ['what is the IP registry', 'ipregistry'],
    ['how do I add my site', 'sites'],
    ['what is a funnel', 'conversions'],
    ['take me through setup', 'setup'],
    ['how do I collect leads', 'leads'],
    ['how does the vetting work', 'vetted'],
    ['explain the warm leads tab', 'warm'],
    ['how do I make a video', 'content'],
    ['what is the engagement tab for', 'engagement'],
    ['how do email campaigns work', 'email'],
  ];
  for (const [q, id] of cases) {
    const hit = guide.findGuide(q);
    assert.ok(hit, `matched: ${q}`);
    assert.equal(hit.id, id, `${q} -> ${id}`);
  }
});

test('stats questions are not captured by the guide', () => {
  assert.equal(guide.findGuide('how many followers do I have'), null);
  assert.equal(guide.findGuide('show me the money'), null);
  assert.equal(guide.findGuide('send the campaign tomorrow'), null);
});

const PW = 'guide-' + 'pw-1234';
let server, base;
before(async () => { ({ server, base } = await startServer()); });
after(async () => { server.close(); });

test('a new user asking the chat gets the guide, and the tour lists everything', async () => {
  const c = client(base);
  const reg = await c.post('/api/auth/register', {
    companyName: 'Guide Co', email: 'guide@example.org', password: PW,
  });
  assert.equal(reg.status, 201);

  const drips = await c.post('/api/assistant/chat', { message: 'how do drips work' });
  assert.equal(drips.status, 200);
  assert.ok(drips.json.reply.includes('Drips tab'), 'names the tab');
  assert.ok(drips.json.reply.includes('New drip campaign'), 'names a real control');

  const ip = await c.post('/api/assistant/chat', { message: 'what is the IP registry' });
  assert.ok(ip.json.reply.includes('IP Registry tab'), 'ip answer names its tab');

  const tour = await c.post('/api/assistant/chat', { message: 'take me through every function' });
  for (const f of guide.FUNCTIONS) {
    assert.ok(tour.json.reply.includes(f.name), `tour names ${f.name}`);
  }
});
