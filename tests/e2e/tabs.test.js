'use strict';
/**
 * E2E TAB tests — Layer 2 (real Chromium DOM + real shipped JS).
 *
 * Loads the REAL public/onboarding.html and public/dashboard-template.html
 * into a real Chromium page, injects the REAL shipped tab scripts
 * (public/js/onboarding-tabs.js; the /app template's tab code is inline),
 * then really clicks every tab button. Catches the 2026-10-14 report
 * "the buttons don't change anything": unwired handlers, mismatched
 * panel IDs, JS exceptions, panels that never become visible.
 *
 * (page.setContent is used because this environment's Chromium blocks all
 * loopback network I/O; no network happens in this layer by design —
 * session/cookie behavior is covered by session.test.js.)
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  launchBrowser, loadRealPage, watchConsole,
  isPanelVisible, tabButtonActive,
  TABS_ONBOARDING, TABS_APP,
} = require('./helpers');

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

async function assertAllTabsWork(page, label, tabs) {
  // Structural check first: every tab has a button AND a matching panel.
  for (const tab of tabs) {
    assert.ok(await page.$(`button.main-tab[data-tab="${tab}"]`), `FAIL [${label}]: no tab button for "${tab}"`);
    assert.ok(await page.$(`#panel-${tab}`), `FAIL [${label}]: no #panel-${tab} element for tab "${tab}"`);
  }

  for (const tab of tabs) {
    // Dispatch the click directly on the element rather than by screen
    // coordinates: this exercises the REAL listener/handler while avoiding
    // flakes from the smooth scrollIntoView animation moving buttons mid-click.
    await page.$eval(`button.main-tab[data-tab="${tab}"]`, (el) => el.click());
    await new Promise((r) => setTimeout(r, 150)); // let toggle + scroll settle

    assert.ok(
      await isPanelVisible(page, tab),
      `FAIL [${label}]: panel-${tab} NOT visible after clicking its tab ("buttons don't change anything")`
    );
    for (const other of tabs) {
      if (other === tab) continue;
      assert.ok(
        !(await isPanelVisible(page, other)),
        `FAIL [${label}]: panel-${other} still visible after switching to "${tab}"`
      );
    }
    assert.ok(
      await tabButtonActive(page, tab),
      `FAIL [${label}]: tab button "${tab}" not marked active after click`
    );
  }
}

test('E2E TABS: all 8 tabs switch panels on onboarding.html (real JS)', async () => {
  const page = await browser.newPage();
  const errors = watchConsole(page);
  try {
    await loadRealPage(page, 'onboarding.html', ['js/onboarding-tabs.js']);
    await assertAllTabsWork(page, 'onboarding', TABS_ONBOARDING);
    assert.deepEqual(errors, [], `console/page errors on onboarding:\n${errors.join('\n')}`);
  } finally {
    await page.close();
  }
});

test('E2E TABS: all 10 tabs switch panels on dashboard-template.html incl. Vetted', async () => {
  const page = await browser.newPage();
  const errors = watchConsole(page);
  try {
    // /app's tab script is inline in the template — setContent runs it.
    await loadRealPage(page, 'dashboard-template.html', []);
    await assertAllTabsWork(page, 'app', TABS_APP);
    assert.deepEqual(errors, [], `console/page errors on app template:\n${errors.join('\n')}`);
  } finally {
    await page.close();
  }
});

test('E2E TABS: Key Numbers section renders on onboarding (no blank dashboard)', async () => {
  const page = await browser.newPage();
  try {
    await loadRealPage(page, 'onboarding.html', ['js/onboarding-tabs.js']);
    // Key Numbers is its own card above the tab panels (not inside #panel-overview).
    const statCount = await page.evaluate(
      () => document.querySelectorAll('.stat-card').length
    );
    const titlePresent = await page.evaluate(
      () => document.body.innerText.includes('Key Numbers')
    );
    assert.ok(titlePresent, 'FAIL: "Key Numbers" heading missing from onboarding');
    assert.ok(statCount >= 8, `FAIL: expected >= 8 Key Number stat cards, found ${statCount}`);
  } finally {
    await page.close();
  }
});

test('E2E TABS: [data-goto-tab] shortcuts switch tabs too', async () => {
  const page = await browser.newPage();
  try {
    await loadRealPage(page, 'onboarding.html', ['js/onboarding-tabs.js']);
    const goto = await page.$('[data-goto-tab]');
    if (!goto) {
      // Not a failure — the shortcut links are optional UI.
      return;
    }
    const target = await page.evaluate((el) => el.getAttribute('data-goto-tab'), goto);
    await page.evaluate((el) => el.click(), goto);
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(
      await isPanelVisible(page, target),
      `FAIL: [data-goto-tab="${target}"] did not switch to its panel`
    );
  } finally {
    await page.close();
  }
});

test('E2E TABS: Leads tab panel contains the collection job form', async () => {
  const page = await browser.newPage();
  const errors = watchConsole(page);
  try {
    await loadRealPage(page, 'dashboard-template.html', []);
    // Switch to the leads tab via a real click.
    await page.$eval('button.main-tab[data-tab="leads"]', (el) => el.click());
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(await isPanelVisible(page, 'leads'), 'FAIL: panel-leads not visible after clicking Leads tab');
    for (const id of ['lead-source', 'lead-maxr', 'lead-keywords', 'lead-run', 'lead-jobs']) {
      assert.ok(await page.$('#' + id), `FAIL: #${id} missing from Leads panel`);
    }
    // Source switching toggles the right input block (static, no network).
    await page.select('#lead-source', 'weblist');
    await new Promise((r) => setTimeout(r, 100));
    const seedVisible = await page.evaluate(() => !document.getElementById('lead-seed-block').classList.contains('is-hidden'));
    const kwHidden = await page.evaluate(() => document.getElementById('lead-kw-block').classList.contains('is-hidden'));
    assert.ok(seedVisible && kwHidden, 'FAIL: source select did not toggle seed/keyword blocks');
    assert.deepEqual(errors, [], `console/page errors:\n${errors.join('\n')}`);
  } finally {
    await page.close();
  }
});
