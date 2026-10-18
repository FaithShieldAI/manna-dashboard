'use strict';
/* Manna Content Library — video repository browser.
   Loads from /api/content, organized by product and language. */
(function () {
  var LANG_NAMES = {
    en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch',
    pt: 'Português', tl: 'Tagalog', id: 'Bahasa Indonesia', ro: 'Română'
  };
  var PRODUCT_NAMES = {
    faithshield: 'FaithShield AI', armorbearer: 'Armor Bearer', manna: 'Manna AI'
  };

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtSize(bytes) {
    if (!bytes) return '—';
    var mb = bytes / 1048576;
    return mb >= 1 ? mb.toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB';
  }

  function loadContent() {
    var product = document.getElementById('content-product').value;
    var language = document.getElementById('content-language').value;
    var grid = document.getElementById('content-grid');
    grid.innerHTML = '<div class="empty">Loading videos…</div>';

    var url = '/api/content?';
    if (product) url += 'product=' + encodeURIComponent(product) + '&';
    if (language) url += 'language=' + encodeURIComponent(language);

    fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok || !data.items.length) {
          grid.innerHTML = '<div class="empty">No videos found.</div>';
          return;
        }
        grid.innerHTML = data.items.map(function (item) {
          var score = item.performance_score != null
            ? '<span style="color:var(--gold)">★ ' + item.performance_score.toFixed(0) + '</span>'
            : '<span style="opacity:0.5">not scored</span>';
          return '<div class="card" style="margin:0">' +
            '<div style="font-weight:600;margin-bottom:0.25rem">' + esc(item.title) + '</div>' +
            '<div style="font-size:0.85rem;opacity:0.7;margin-bottom:0.5rem">' +
              esc(PRODUCT_NAMES[item.product] || item.product) + ' · ' +
              esc(LANG_NAMES[item.language] || item.language) + ' · ' +
              esc(item.category) +
            '</div>' +
            '<div style="font-size:0.85rem;margin-bottom:0.75rem">' +
              fmtSize(item.file_size_bytes) + ' · ' + item.view_count + ' views · ' + score +
            '</div>' +
            '<button data-content-play="' + item.id + '" style="padding:0.5rem 1rem;cursor:pointer">▶ Play</button> ' +
            '<a href="/api/content/' + item.id + '/file" download style="padding:0.5rem 1rem">⬇ Download</a>' +
          '</div>';
        }).join('');

        grid.querySelectorAll('[data-content-play]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-content-play');
            var modal = document.getElementById('content-modal');
            var player = document.getElementById('content-player');
            player.src = '/api/content/' + id + '/file';
            modal.style.display = 'flex';
            player.play().catch(function () {});
          });
        });
      })
      .catch(function () {
        grid.innerHTML = '<div class="empty">Failed to load videos.</div>';
      });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var prodSel = document.getElementById('content-product');
    var langSel = document.getElementById('content-language');
    if (!prodSel) return;
    prodSel.addEventListener('change', loadContent);
    langSel.addEventListener('change', loadContent);
    document.getElementById('content-close').addEventListener('click', function () {
      var modal = document.getElementById('content-modal');
      var player = document.getElementById('content-player');
      player.pause();
      player.src = '';
      modal.style.display = 'none';
    });
    // Load when the tab is first opened.
    document.querySelectorAll('.main-tab').forEach(function (b) {
      if (b.getAttribute('data-tab') === 'content') {
        b.addEventListener('click', function () {
          if (!document.getElementById('content-grid').dataset.loaded) {
            document.getElementById('content-grid').dataset.loaded = '1';
            loadContent();
          }
        });
      }
    });
  });
})();
