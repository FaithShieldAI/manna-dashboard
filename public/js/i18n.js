/* Manna AI — client-side internationalization.
 * Loads /i18n/<lang>.json (or uses window.__MANNA_I18N__ when the server
 * injects it), then applies translations to the DOM.
 *
 * Usage in HTML:
 *   <h1 data-i18n="auth.signup.title">Create your account</h1>
 *   <input data-i18n-ph="auth.signup.email_ph" placeholder="Email">
 *   <button data-i18n-aria="dash.nav.menu" aria-label="Menu">…</button>
 *   <span data-i18n-html="leads.note_html">…</span>   (innerHTML, trusted strings only)
 *
 * Usage in JS:
 *   t('dash.js.email.paused_n', { n: 3 })
 *
 * Language resolution: ?lang= > localStorage > cookie > navigator.language > 'en'
 */
(function () {
  'use strict';

  var SUPPORTED = ['en', 'es', 'fr', 'de', 'pt', 'tl', 'ro', 'id'];
  var NAMES = {
    en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch',
    pt: 'Português', tl: 'Tagalog', ro: 'Română', id: 'Bahasa Indonesia'
  };

  function resolveLang() {
    try {
      var m = /[?&]lang=([a-z]{2})/i.exec(location.search);
      if (m && SUPPORTED.indexOf(m[1].toLowerCase()) !== -1) return m[1].toLowerCase();
      var ls = localStorage.getItem('manna_lang');
      if (ls && SUPPORTED.indexOf(ls) !== -1) return ls;
      var ck = /(?:^|;\s*)manna_lang=([a-z]{2})/i.exec(document.cookie || '');
      if (ck && SUPPORTED.indexOf(ck[1].toLowerCase()) !== -1) return ck[1].toLowerCase();
      var nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
      if (SUPPORTED.indexOf(nav) !== -1) return nav;
    } catch (e) { /* storage may be unavailable */ }
    return 'en';
  }

  var lang = resolveLang();
  var dict = {};      // active language
  var fallback = {};  // English fallback
  var readyResolve;
  var ready = new Promise(function (res) { readyResolve = res; });

  // Synchronous fast path: when the server injects window.__MANNA_I18N__
  // (the /app dashboard does this), t() works immediately for any script
  // running after this file in document order — no async race.
  var syncReady = false;
  try {
    if (window.__MANNA_I18N__ && window.__MANNA_I18N__.dict) {
      var inj = window.__MANNA_I18N__;
      if (SUPPORTED.indexOf(inj.lang) !== -1) lang = inj.lang;
      dict = inj.dict || {};
      fallback = inj.fallback || {};
      syncReady = true;
    }
  } catch (e) {}

  function interpolate(s, params) {
    if (!params) return s;
    return String(s).replace(/\{(\w+)\}/g, function (_, k) {
      return params[k] != null ? params[k] : '{' + k + '}';
    });
  }

  function t(key, params) {
    var s = dict[key] != null ? dict[key] : fallback[key];
    if (s == null) return key;
    return interpolate(s, params);
  }

  function applyTo(root) {
    root = root || document;
    var els, i, el, key;
    els = root.querySelectorAll('[data-i18n]');
    for (i = 0; i < els.length; i++) {
      el = els[i]; key = el.getAttribute('data-i18n');
      var v = t(key);
      if (v !== key) el.textContent = v;
    }
    els = root.querySelectorAll('[data-i18n-html]');
    for (i = 0; i < els.length; i++) {
      el = els[i]; key = el.getAttribute('data-i18n-html');
      var h = t(key);
      if (h !== key) el.innerHTML = h;
    }
    els = root.querySelectorAll('[data-i18n-ph]');
    for (i = 0; i < els.length; i++) {
      el = els[i]; key = el.getAttribute('data-i18n-ph');
      var p = t(key);
      if (p !== key) el.setAttribute('placeholder', p);
    }
    els = root.querySelectorAll('[data-i18n-aria]');
    for (i = 0; i < els.length; i++) {
      el = els[i]; key = el.getAttribute('data-i18n-aria');
      var a = t(key);
      if (a !== key) el.setAttribute('aria-label', a);
    }
    els = root.querySelectorAll('[data-i18n-title]');
    for (i = 0; i < els.length; i++) {
      el = els[i]; key = el.getAttribute('data-i18n-title');
      var ti = t(key);
      if (ti !== key) el.setAttribute('title', ti);
    }
    try { document.documentElement.setAttribute('lang', lang); } catch (e) {}
  }

  function buildPickers() {
    var pickers = document.querySelectorAll('[data-lang-picker]');
    for (var i = 0; i < pickers.length; i++) {
      (function (sel) {
        if (sel.tagName !== 'SELECT') return;
        if (sel.options.length > 0) return; // already built
        SUPPORTED.forEach(function (code) {
          var opt = document.createElement('option');
          opt.value = code;
          opt.textContent = NAMES[code];
          if (code === lang) opt.selected = true;
          sel.appendChild(opt);
        });
        sel.addEventListener('change', function () { setLang(sel.value); });
      })(pickers[i]);
    }
  }

  function setLang(newLang) {
    if (SUPPORTED.indexOf(newLang) === -1) return;
    try {
      localStorage.setItem('manna_lang', newLang);
      document.cookie = 'manna_lang=' + newLang + '; path=/; max-age=31536000; SameSite=Lax';
    } catch (e) {}
    // Reload so the server can inject the right dictionary for /app,
    // and static pages re-resolve cleanly.
    var url = new URL(location.href);
    url.searchParams.set('lang', newLang);
    location.href = url.toString();
  }

  function fetchJson(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('i18n ' + r.status);
      return r.json();
    });
  }

  // Synchronous load used when no server-injected dictionary exists.
  // Guarantees t() works from the very first call — no async race for
  // page scripts that render on load. (Sync XHR is deprecated but remains
  // the only bulletproof option under a strict CSP with no inline scripts.)
  function loadSync(url) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      xhr.send(null);
      if (xhr.status === 200) return JSON.parse(xhr.responseText);
    } catch (e) {}
    return null;
  }

  function init() {
    // Fast path: synchronous load — t() is correct from the first call.
    // (Sync XHR is deprecated but remains the only bulletproof option
    // under a strict CSP with no inline scripts.)
    var d = loadSync('/i18n/' + lang + '.json');
    if (d) {
      dict = d;
    } else if (lang !== 'en') {
      lang = 'en';
      dict = loadSync('/i18n/en.json') || {};
    }
    if (lang !== 'en') {
      fallback = loadSync('/i18n/en.json') || {};
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        applyTo(document); buildPickers(); readyResolve();
      });
    } else {
      applyTo(document); buildPickers(); readyResolve();
    }
  }

  window.MannaI18n = {
    t: t,
    applyTo: applyTo,
    setLang: setLang,
    getLang: function () { return lang; },
    supported: SUPPORTED,
    names: NAMES,
    ready: ready
  };

  if (syncReady) {
    // Dictionary already available: apply as soon as DOM is ready.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        applyTo(document); buildPickers(); readyResolve();
      });
    } else {
      applyTo(document); buildPickers(); readyResolve();
    }
    return;
  }

  init();
})();
