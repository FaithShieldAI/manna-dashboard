'use strict';
/* Manna onboarding — main tab navigation. Extracted from inline <script>
   for strict Content-Security-Policy (script-src 'self', no unsafe-inline). */
(function () {
  function setMainTab(tab) {
    document.querySelectorAll('.main-tab').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
    document.querySelectorAll('.main-tab-panel').forEach(function (p) {
      p.classList.toggle('is-hidden', p.id !== 'panel-' + tab);
    });
    try { localStorage.setItem('manna_main_tab', tab); } catch (e) {}
  }
  document.querySelectorAll('.main-tab').forEach(function (b) {
    b.addEventListener('click', function () { setMainTab(b.getAttribute('data-tab')); });
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
