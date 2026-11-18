'use strict';
/**
 * Regression test for the 2026-11-18 Drips tab failure.
 *
 * What broke: public/js/drips.js routes every API call through
 * D2RM.api(...) (its header documents the contract: "Call
 * D2RMDrips.init('drips-app') after /js/auth.js has loaded").
 * window.D2RM is defined in exactly one place, public/js/auth.js
 * line 60. The dashboard page (public/dashboard-template.html, served
 * at /app) never included /js/auth.js, so clicking the Drips tab ran
 * D2RMDrips.init -> refresh -> D2RM.api and threw
 * "ReferenceError: D2RM is not defined", which drips.js catches and
 * renders as "Could not load drips / D2RM is not defined". The API was
 * fine; the page could not run. API tests cannot see this class of
 * failure, which is how it shipped behind a green suite.
 *
 * This test covers the class, not just the instance:
 *  1. Static resolution: for every served page, every bare global a
 *     script uses as a namespace or call (NAME.x / NAME(...) /
 *     NAME[...]) must be defined somewhere in that page's own script
 *     set (a window.NAME assignment or a top-level declaration), or be
 *     a browser/JS builtin. Pages checked: the /app dashboard (every
 *     tab lives in this one page: Overview, Email, Drips, Warm Leads,
 *     Leads, Conversions, Sites, Influencers, Vetted, Content Library,
 *     Engagement, PR, IP Registry, Billing, Social), the Setup page
 *     (onboarding.html), and the standalone auth/leads pages.
 *  2. Execution: the /app external scripts are loaded in template
 *     order into a vm sandbox with browser stubs, then the exact tab
 *     click path (window.D2RMDrips.init('drips-app')) is invoked and
 *     the rendered result is asserted: the drip list renders, the
 *     "Could not load drips" error state does not.
 *
 * The cross-origin tracker.js script tag on some pages belongs to a
 * different app (the PythonAnywhere tracker) and cannot be resolved
 * from this repo; it is skipped and listed, not silently passed.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');

/* ------------------------------------------------------------------ */
/* Tokenizer: comments, strings, regexes and template text are opaque; */
/* template ${ } expressions are tokenized as code.                    */
/* ------------------------------------------------------------------ */
function tokenize(code) {
  const toks = [];
  const modes = ['code']; // 'code' | 'tpl' | { expr: true, depth }
  let i = 0;
  const n = code.length;
  let lastSig = null; // last significant token, for the regex heuristic

  const push = (t, v) => { const tok = { t, v }; toks.push(tok); lastSig = tok; };
  const regexAllowed = () => {
    if (!lastSig) return true;
    if (lastSig.t === 'id') {
      return ['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'instanceof', 'yield', 'await', 'else', 'do'].includes(lastSig.v);
    }
    if (lastSig.t === 'pun') return ![')', ']', '}'].includes(lastSig.v);
    return false; // after num/str/regex a slash is division
  };

  while (i < n) {
    const mode = modes[modes.length - 1];
    const c = code[i];
    if (mode === 'tpl') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { modes.pop(); i++; continue; }
      if (c === '$' && code[i + 1] === '{') { modes.push({ expr: true, depth: 0 }); push('pun', '${'); i += 2; continue; }
      i++; continue;
    }
    // code mode
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }
    if (c === '/' && code[i + 1] === '/') { while (i < n && code[i] !== '\n') i++; continue; }
    if (c === '/' && code[i + 1] === '*') { i += 2; while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++; i += 2; continue; }
    if (c === "'" || c === '"') {
      const q = c; i++;
      while (i < n && code[i] !== q) { if (code[i] === '\\') i++; i++; }
      i++; push('str', q); continue;
    }
    if (c === '`') { modes.push('tpl'); push('str', '`'); i++; continue; }
    if (c === '/' && regexAllowed()) {
      i++;
      let inClass = false;
      while (i < n) {
        const ch = code[i];
        if (ch === '\\') { i += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        else if (ch === '\n') break;
        i++;
      }
      i++;
      while (i < n && /[a-z]/i.test(code[i])) i++; // flags
      push('re', '/'); continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(code[j])) j++;
      push('id', code.slice(i, j)); i = j; continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(code[j])) j++;
      push('num', code.slice(i, j)); i = j; continue;
    }
    if (c === '{') {
      const top = modes[modes.length - 1];
      if (top && top.expr) top.depth++;
      push('pun', '{'); i++; continue;
    }
    if (c === '}') {
      const top = modes[modes.length - 1];
      if (top && top.expr) {
        if (top.depth === 0) { modes.pop(); push('pun', '}tpl'); i++; continue; }
        top.depth--;
      }
      push('pun', '}'); i++; continue;
    }
    if (c === '=' && code[i + 1] === '>') { push('pun', '=>'); i += 2; continue; }
    if (c === '?' && code[i + 1] === '.') { push('pun', '?.'); i += 2; continue; }
    push('pun', c); i++;
  }
  return toks;
}

const KEYWORDS = new Set((
  'var let const function return if else for while do switch case break continue new delete typeof ' +
  'instanceof in of try catch finally throw class extends super this void yield async await static ' +
  'get set null true false'
).split(/\s+/));

const BUILTINS = new Set((
  'window document fetch console JSON Math Object Array String Number Boolean Date RegExp Error ' +
  'TypeError RangeError SyntaxError Promise Map Set WeakMap WeakSet Symbol Reflect Proxy parseInt ' +
  'parseFloat isNaN isFinite setTimeout setInterval clearTimeout clearInterval requestAnimationFrame ' +
  'cancelAnimationFrame localStorage sessionStorage location navigator history alert confirm prompt ' +
  'URL URLSearchParams FormData Blob File FileReader Image Event CustomEvent KeyboardEvent MouseEvent ' +
  'Intl encodeURIComponent decodeURIComponent encodeURI decodeURI btoa atob globalThis NaN Infinity ' +
  'undefined queueMicrotask getComputedStyle matchMedia ResizeObserver IntersectionObserver ' +
  'MutationObserver AbortController TextEncoder TextDecoder crypto performance addEventListener ' +
  'removeEventListener dispatchEvent DOMParser XMLSerializer HTMLElement Element Node XMLHttpRequest ' +
  'WebSocket EventSource Worker Audio Option Notification MessageChannel BroadcastChannel indexedDB'
).split(/\s+/));

/* Names a single file declares for itself (over-approximate on purpose:
   a name the file declares anywhere is treated as local to that file). */
function localsOf(toks) {
  const names = new Set();
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t !== 'id') continue;
    if (['var', 'let', 'const'].includes(t.v)) {
      // collect declarator names until ';' at the same nesting level
      let depth = 0;
      let expectName = true;
      for (let j = k + 1; j < toks.length; j++) {
        const u = toks[j];
        if (u.t === 'pun') {
          if (['(', '[', '{', '${'].includes(u.v)) depth++;
          if ([')', ']', '}', '}tpl'].includes(u.v)) { if (depth === 0) break; depth--; }
          if (u.v === ';' && depth === 0) break;
          if (u.v === ',' && depth === 0) expectName = true;
          continue;
        }
        if (u.t === 'id' && expectName) { names.add(u.v); expectName = false; }
      }
      continue;
    }
    if (t.v === 'function') {
      let j = k + 1;
      if (toks[j] && toks[j].t === 'id') { names.add(toks[j].v); j++; }
      if (toks[j] && toks[j].v === '(') {
        for (j++; j < toks.length && toks[j].v !== ')'; j++) {
          if (toks[j].t === 'id' && !KEYWORDS.has(toks[j].v)) names.add(toks[j].v);
        }
      }
      continue;
    }
    if (t.v === 'catch') {
      if (toks[k + 1] && toks[k + 1].v === '(' && toks[k + 2] && toks[k + 2].t === 'id') names.add(toks[k + 2].v);
      continue;
    }
    // arrow params: (a, b) => or a =>
    if (toks[k + 1] && toks[k + 1].v === '=>') { names.add(t.v); continue; }
    if (t.v === '(') {
      const ids = [];
      let j = k + 1;
      for (; j < toks.length && toks[j].v !== ')'; j++) {
        if (toks[j].t === 'id' && !KEYWORDS.has(toks[j].v)) ids.push(toks[j].v);
      }
      if (toks[j] && toks[j].v === ')' && toks[j + 1] && toks[j + 1].v === '=>') ids.forEach(x => names.add(x));
    }
  }
  return names;
}

/* Globals a page's script set defines: window.NAME assignments and
   declarations at brace depth 0 of any script in the set. */
function definedGlobalsOf(scriptToks) {
  const defs = new Set();
  for (const toks of scriptToks) {
    let depth = 0;
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      if (t.t === 'pun') {
        if (t.v === '{' || t.v === '${') depth++;
        if (t.v === '}' || t.v === '}tpl') depth--;
      }
      if (t.t === 'id' && t.v === 'window' && toks[k + 1] && toks[k + 1].v === '.' &&
          toks[k + 2] && toks[k + 2].t === 'id' && toks[k + 3] && toks[k + 3].v === '=') {
        defs.add(toks[k + 2].v);
      }
      if (depth === 0 && t.t === 'id' && ['var', 'let', 'const'].includes(t.v) &&
          toks[k + 1] && toks[k + 1].t === 'id') {
        defs.add(toks[k + 1].v);
      }
      if (depth === 0 && t.t === 'id' && t.v === 'function' &&
          toks[k + 1] && toks[k + 1].t === 'id') {
        defs.add(toks[k + 1].v);
      }
    }
  }
  return defs;
}

/* Bare identifiers used as NAME.x / NAME(...) / NAME[...] that the file
   does not declare itself. */
function referencesOf(toks, locals) {
  const refs = new Map();
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t !== 'id') continue;
    if (KEYWORDS.has(t.v) || BUILTINS.has(t.v) || locals.has(t.v)) continue;
    const prev = toks[k - 1];
    if (prev && prev.t === 'pun' && (prev.v === '.' || prev.v === '?.')) continue;
    if (prev && prev.t === 'id' && ['var', 'let', 'const', 'function'].includes(prev.v)) continue;
    const next = toks[k + 1];
    if (next && next.t === 'pun' && ['.', '?.', '(', '['].includes(next.v)) {
      refs.set(t.v, (refs.get(t.v) || 0) + 1);
    }
  }
  return refs;
}

/* Ordered script set for a page: local external files + inline bodies.
   Cross-origin scripts are returned separately (not resolvable here). */
function pageScripts(htmlFile, extra) {
  const html = fs.readFileSync(path.join(PUB, htmlFile), 'utf8');
  const scripts = [];
  const external = [];
  const tagRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const srcM = /src="([^"]+)"/.exec(m[1]);
    if (srcM) {
      const src = srcM[1];
      if (/^https?:\/\//.test(src)) { external.push(src); continue; }
      const file = path.join(PUB, src.split('?')[0].replace(/^\//, ''));
      scripts.push({ name: src.split('?')[0], code: fs.readFileSync(file, 'utf8') });
    } else if (m[2].trim()) {
      scripts.push({ name: htmlFile + ' inline script', code: m[2] });
    }
  }
  if (extra && extra.prepend) scripts.unshift(...extra.prepend);
  if (extra && extra.append) scripts.push(...extra.append);
  return { scripts, external };
}

function unresolvedForPage(htmlFile, extra) {
  const { scripts } = pageScripts(htmlFile, extra);
  const toksByScript = scripts.map(s => ({ name: s.name, toks: tokenize(s.code) }));
  const defs = definedGlobalsOf(toksByScript.map(s => s.toks));
  const problems = [];
  for (const s of toksByScript) {
    const refs = referencesOf(s.toks, localsOf(s.toks));
    for (const [name, count] of refs) {
      if (!defs.has(name)) problems.push(s.name + ': ' + name + ' (x' + count + ') is referenced but never defined in this page\'s script set');
    }
  }
  return problems;
}

/* /app serve-time additions (src/app-serve.js): the i18n dictionary
   injection before /js/i18n.js, and the boot script appended before
   </body>. Modelled here so the check covers what is actually served,
   not only what is on disk. */
function dashboardExtra() {
  const appServe = fs.readFileSync(path.join(ROOT, 'src', 'app-serve.js'), 'utf8');
  const bootM = /const boot = `([\s\S]*?)`;\n/.exec(appServe);
  assert.ok(bootM, 'could not extract the serve-time boot script from src/app-serve.js');
  return {
    prepend: [{ name: 'serve-time i18n injection (app-serve.js)', code: 'window.__MANNA_I18N__ = {};' }],
    append: [{ name: 'serve-time boot script (app-serve.js)', code: bootM[1] }],
  };
}

const PAGES = [
  ['dashboard-template.html', () => unresolvedForPage('dashboard-template.html', dashboardExtra()), '/app dashboard (all tabs)'],
  ['onboarding.html', () => unresolvedForPage('onboarding.html'), 'Setup page'],
  ['leads.html', () => unresolvedForPage('leads.html'), 'Leads page'],
  ['login.html', () => unresolvedForPage('login.html'), 'Login page'],
  ['signup.html', () => unresolvedForPage('signup.html'), 'Signup page'],
  ['forgot.html', () => unresolvedForPage('forgot.html'), 'Forgot password page'],
  ['reset.html', () => unresolvedForPage('reset.html'), 'Reset password page'],
  ['verify.html', () => unresolvedForPage('verify.html'), 'Verify page'],
];

for (const [, run, label] of PAGES) {
  test('client globals resolve: ' + label, () => {
    const problems = run();
    assert.deepEqual(problems, [], problems.join('\n'));
  });
}

/* ------------------------------------------------------------------ */
/* Execution: load the /app external scripts in template order and    */
/* click the Drips tab, the exact path from the photograph.           */
/* ------------------------------------------------------------------ */
test('drips tab load path executes: init renders the list, not the error state', async () => {
  const { scripts } = pageScripts('dashboard-template.html');
  const externalScripts = scripts.filter(s => !s.name.includes('inline'));

  function makeEl() {
    return {
      innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      addEventListener() {}, removeEventListener() {}, appendChild() {},
      querySelectorAll() { return []; }, querySelector() { return null; },
      getAttribute() { return null; }, setAttribute() {}, remove() {},
    };
  }
  const rootEl = makeEl();
  const sandbox = {
    console,
    setTimeout, setInterval, clearTimeout, clearInterval, queueMicrotask,
    URL, URLSearchParams, AbortController,
    alert() {},
    navigator: { language: 'en' },
    location: { href: 'https://mannaforinfluencers.com/app', search: '', reload() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch: async () => ({
      status: 200, ok: true,
      json: async () => ({ ok: true, templates: [], drips: [], scheduled: [], campaigns: [] }),
    }),
    document: {
      getElementById(id) { return id === 'drips-app' ? rootEl : makeEl(); },
      createElement() { return makeEl(); },
      querySelectorAll() { return []; },
      querySelector() { return null; },
      addEventListener() {},
      head: makeEl(), body: makeEl(), documentElement: makeEl(),
      cookie: '',
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // What src/app-serve.js injects ahead of /js/i18n.js on every /app serve.
  sandbox.__MANNA_I18N__ = { lang: 'en', dict: {}, fallback: {} };
  vm.createContext(sandbox);

  for (const s of externalScripts) {
    vm.runInContext(s.code, sandbox, { filename: s.name });
  }

  assert.equal(typeof sandbox.D2RMDrips, 'object', 'D2RMDrips module did not load');

  // The tab click handler in the template does exactly this.
  sandbox.D2RMDrips.init('drips-app');
  await new Promise(r => setTimeout(r, 50));

  assert.ok(!rootEl.innerHTML.includes('Could not load drips'),
    'drips tab rendered its error state: ' + rootEl.innerHTML.slice(0, 200));
  assert.ok(!rootEl.innerHTML.includes('is not defined'),
    'drips tab rendered an undefined-global error: ' + rootEl.innerHTML.slice(0, 200) +
    ' (window.D2RM is ' + typeof sandbox.D2RM + ' in the /app script set; drips.js calls ' +
    'D2RM.api on every request, and D2RM is defined only in /js/auth.js)');
  assert.ok(rootEl.innerHTML.includes('Drip campaigns'),
    'drips tab did not render the campaigns list: ' + rootEl.innerHTML.slice(0, 200));
});
