'use strict';
/**
 * E2E ONBOARDING-ACTIONS tests — Layer 2 (real Chromium DOM + real shipped JS).
 *
 * Covers the 2026-10-14 reports:
 *  1. "action button cut off at the bottom in EVERY onboarding step" — each
 *     step's action buttons are wrapped in a sticky .step-actions bar so they
 *     stay visible while scrolling long steps.
 *  2. "after installing, show installed templates as clickable links" — the
 *     done state of the templates step lists installed templates as deep
 *     links (/app#tpl-<key>) into the dashboard Templates section, instead
 *     of a bare "Done".
 *
 * fetch() is stubbed (this environment's Chromium blocks loopback I/O);
 * the REAL public/js/onboarding.js runs against the stubs.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { launchBrowser, watchConsole } = require('./helpers');

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const REPO_ROOT = path.join(__dirname, '..', '..');
function readPublic(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, 'public', rel), 'utf8');
}

function statusWith(templatesDone) {
  return {
    ok: true,
    onboarding: {
      progress_pct: templatesDone ? 80 : 40,
      is_complete: false,
      current_step: 'starter_content',
      steps: [
        { id: 'welcome', title: 'Welcome', description: 'd', done: true },
        { id: 'connect_socials', title: 'Connect socials', description: 'd', done: true },
        { id: 'starter_content', title: 'Install starter templates', description: 'd', done: templatesDone },
        { id: 'first_lead_job', title: 'Lead search', description: 'd', done: false },
        { id: 'first_campaign', title: 'First campaign', description: 'd', done: false },
      ],
    },
  };
}

const TEMPLATES_API = {
  ok: true,
  library: {
    email: [
      { key: 'welcome-1', name: 'Welcome Email', subject: 'Welcome!', body_text: 'hi', body_html: '<p>hi</p>' },
    ],
    social: [],
  },
  installed: {
    email: [
      { template_key: 'welcome-1', name: 'Welcome Email', subject: 'Welcome!' },
      { template_key: 'launch', name: 'Launch', subject: 'It is live' },
    ],
    social: [],
  },
};

async function loadOnboardingWithStubs(page, { templatesDone }) {
  const stubs = {
    'GET /api/onboarding/status': statusWith(templatesDone),
    'GET /api/onboarding/templates': TEMPLATES_API,
    'GET /api/onboarding/socials': { ok: true, socials: [] },
    'GET /api/overview': { ok: true, email: {}, counts: {} },
  };
  await page.setContent(readPublic('onboarding.html'), { waitUntil: 'domcontentloaded', timeout: 15000 });
  // NOTE: page.setContent() wipes evaluateOnNewDocument scripts in this
  // environment, so the fetch stub must be installed AFTER setContent.
  await page.evaluate((s) => {
    window.fetch = function (path, opts) {
      var key = ((opts && opts.method) || 'GET') + ' ' + path;
      var body = s[key];
      return Promise.resolve({
        status: body ? 200 : 404,
        json: function () { return Promise.resolve(body || { ok: false }); },
      });
    };
  }, stubs);
  await page.addScriptTag({ content: readPublic('js/onboarding.js') });
  // Load the real shipped stylesheet so computed-style assertions (e.g. the
  // sticky .step-actions bar) test the actual CSS, not just the class name.
  await page.addStyleTag({ content: readPublic('css/onboarding.css') });
  await new Promise((r) => setTimeout(r, 600)); // let render + async template fetch settle
}

test('E2E ACTIONS: installed templates render as deep links, not bare "Done"', async () => {
  const page = await browser.newPage();
  const errors = watchConsole(page);
  try {
    await loadOnboardingWithStubs(page, { templatesDone: true });

    const links = await page.evaluate(() =>
      Array.prototype.map.call(document.querySelectorAll('.tpl-link'), (a) => ({
        text: a.textContent,
        href: a.getAttribute('href'),
      }))
    );
    assert.equal(links.length, 2, `expected 2 installed-template links, got ${links.length}`);
    assert.ok(
      links.every((l) => /^\/app#tpl-[A-Za-z0-9_-]+$/.test(l.href)),
      `links must deep-link to /app#tpl-<key>: ${JSON.stringify(links)}`
    );
    assert.ok(
      links.some((l) => l.href === '/app#tpl-welcome-1'),
      'expected a link to /app#tpl-welcome-1'
    );

    // Sticky action bar present with the "Open Templates section" button.
    const bar = await page.evaluate(() => {
      const el = document.querySelector('.step-actions');
      return el ? el.textContent : null;
    });
    assert.ok(bar && bar.includes('Open Templates section'), 'sticky .step-actions bar with Open button missing');

    assert.deepEqual(errors, [], `console/page errors:\n${errors.join('\n')}`);
  } finally {
    await page.close();
  }
});

test('E2E ACTIONS: template picker action buttons sit in a sticky bar', async () => {
  const page = await browser.newPage();
  const errors = watchConsole(page);
  try {
    await loadOnboardingWithStubs(page, { templatesDone: false });

    const barText = await page.evaluate(() => {
      const el = document.querySelector('#steps .step-actions');
      return el ? el.textContent : null;
    });
    assert.ok(
      barText && barText.includes('Install selected'),
      'expected Install selected inside a sticky .step-actions bar'
    );

    // The sticky bar must actually stick (CSS position: sticky, bottom: 0).
    const pos = await page.evaluate(() => {
      const el = document.querySelector('#steps .step-actions');
      const cs = window.getComputedStyle(el);
      return { position: cs.position, bottom: cs.bottom };
    });
    assert.equal(pos.position, 'sticky', `expected sticky positioning, got ${pos.position}`);
    assert.equal(pos.bottom, '0px', `expected bottom: 0, got ${pos.bottom}`);

    assert.deepEqual(errors, [], `console/page errors:\n${errors.join('\n')}`);
  } finally {
    await page.close();
  }
});

test('E2E ACTIONS: dashboard honors #tpl-<key> deep links', async () => {
  const page = await browser.newPage();
  const errors = watchConsole(page);
  try {
    // The dashboard's JS is one big inline <script>, which would run during
    // setContent — before any fetch stub exists. Strip it, stub fetch, then
    // inject the real script so the templates render against the stub.
    const full = readPublic('dashboard-template.html');
    const m = full.match(/<script>([\s\S]*)<\/script>/);
    assert.ok(m, 'inline dashboard script not found');
    const stripped = full.replace(m[0], '<!-- inline script injected by test -->');
    await page.setContent(stripped, { waitUntil: 'domcontentloaded', timeout: 15000 });
    // NOTE: setContent() wipes evaluateOnNewDocument scripts here, so the
    // fetch stub is installed AFTER setContent instead.
    await page.evaluate(() => {
      window.fetch = function (path) {
        if (String(path).indexOf('/api/email/templates') === 0) {
          return Promise.resolve({
            status: 200,
            json: () => Promise.resolve({
              ok: true,
              templates: [{ template_key: 'welcome-1', name: 'Welcome Email', subject: 'Welcome!', preview: 'hi' }],
            }),
          });
        }
        return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) });
      };
    });
    await page.addScriptTag({ content: m[1] });
    await new Promise((r) => setTimeout(r, 800)); // let templates render

    // Per-template anchor must exist once templates render.
    const cardExists = await page.evaluate(() => !!document.getElementById('tpl-welcome-1'));
    assert.ok(cardExists, 'expected per-template anchor #tpl-welcome-1 in the Templates section');

    // Re-run the REAL shipped deep-link init with a #tpl- hash present and
    // verify the email tab activates and the card is targeted.
    const result = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script'));
      const src = scripts.map((s) => s.textContent).find((t) => t.includes('Deep links:'));
      if (!src) return { found: false };
      window.location.hash = '#tpl-welcome-1';
      // eslint-disable-next-line no-eval
      eval(src);
      return {
        found: true,
        emailVisible: document.getElementById('panel-email').style.display !== 'none',
        cardTargeted: !!document.getElementById('tpl-welcome-1'),
      };
    });
    assert.ok(result.found, 'deep-link init block not found in shipped HTML');
    assert.ok(result.emailVisible, 'email tab did not activate for #tpl-welcome-1');
    assert.ok(result.cardTargeted, 'template card anchor missing for deep link');

    assert.deepEqual(errors, [], `console/page errors:\n${errors.join('\n')}`);
  } finally {
    await page.close();
  }
});
