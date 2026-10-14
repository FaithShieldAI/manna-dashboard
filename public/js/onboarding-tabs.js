'use strict';
/* Manna onboarding — main tab navigation. Extracted from inline <script>
   for strict Content-Security-Policy (script-src 'self', no unsafe-inline). */
(function () {
  function setMainTab(tab, opts) {
    document.querySelectorAll('.main-tab').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
    var target = null;
    document.querySelectorAll('.main-tab-panel').forEach(function (p) {
      var show = (p.id === 'panel-' + tab);
      p.classList.toggle('is-hidden', !show);
      if (show) target = p;
    });
    try { localStorage.setItem('manna_main_tab', tab); } catch (e) {}
    /* On user clicks (not initial load), scroll the newly shown panel into
       view so the tab switch is visible — panels sit below Key Numbers. */
    if (target && opts && opts.scroll && typeof target.scrollIntoView === 'function') {
      try { target.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {}
    }
  }
  document.querySelectorAll('.main-tab').forEach(function (b) {
    b.addEventListener('click', function () { setMainTab(b.getAttribute('data-tab'), { scroll: true }); });
  });
  document.querySelectorAll('[data-goto-tab]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.preventDefault();
      setMainTab(el.getAttribute('data-goto-tab'), { scroll: true });
    });
  });
  (function () {
    var saved = 'overview';
    try { saved = localStorage.getItem('manna_main_tab') || 'overview'; } catch (e) {}
    if (!document.getElementById('panel-' + saved)) saved = 'overview';
    setMainTab(saved);
  })();
  /* Range tabs (visual only) */
  document.querySelectorAll('.range-tab').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.range-tab').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
    });
  });
})();
