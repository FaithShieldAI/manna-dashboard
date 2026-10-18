'use strict';
/* Manna Content Library — video repository browser.
   Loads from /api/content, organized by product and language. */
(function () {
  var LANG_NAMES = {
    en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch',
    pt: 'Português', tl: 'Tagalog', id: 'Bahasa Indonesia', ro: 'Română'
  };
  var PRODUCT_NAMES = {
    faithshield: 'FaithShield AI', armorbearer: 'Armor Bearer', manna: 'Manna AI',
    kpkunk: 'K-Punk', sustained: 'Sustained AI'
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

  var currentProduct = null;
  // Sustained is excluded from video repositories by design.
  var EXCLUDED_PRODUCTS = ['sustained'];

  function loadProductTabs() {
    var tabs = document.getElementById('content-product-tabs');
    fetch('/api/content/products', { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) {
          tabs.innerHTML = '<div class="empty">Failed to load.</div>';
          return;
        }
        var products = Object.keys(data.tree).filter(function (p) {
          return EXCLUDED_PRODUCTS.indexOf(p) === -1;
        }).sort();
        if (!products.length) {
          tabs.innerHTML = '<div class="empty">No repositories yet.</div>';
          return;
        }
        tabs.innerHTML = products.map(function (p) {
          var count = Object.values(data.tree[p]).reduce(function (a, langs) {
            return a + Object.values(langs).reduce(function (x, n) { return x + n; }, 0);
          }, 0);
          return '<button data-cp="' + p + '" style="padding:0.75rem 1.5rem;cursor:pointer;font-weight:600">' +
            esc(PRODUCT_NAMES[p] || p) + ' (' + count + ')</button>';
        }).join('');
        tabs.querySelectorAll('[data-cp]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            tabs.querySelectorAll('[data-cp]').forEach(function (b) {
              b.style.background = '';
            });
            btn.style.background = 'var(--gold)';
            currentProduct = btn.getAttribute('data-cp');
            loadContent();
          });
        });
        // Auto-open the first repository.
        tabs.querySelector('[data-cp]').click();
      })
      .catch(function () {
        tabs.innerHTML = '<div class="empty">Failed to load.</div>';
      });
  }

  function loadContent() {
    var grid = document.getElementById('content-grid');
    if (!currentProduct) {
      grid.innerHTML = '<div class="empty">Select a product above.</div>';
      return;
    }
    grid.innerHTML = '<div class="empty">Loading videos…</div>';

    fetch('/api/content?product=' + encodeURIComponent(currentProduct),
      { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        renderProduct(currentProduct, data.items || []);
      })
      .catch(function () {
        grid.innerHTML = '<div class="empty">Failed to load videos.</div>';
      });
  }

  function renderProduct(product, items) {
    var grid = document.getElementById('content-grid');
    // Group by language subcategory.
    var byLang = {};
    items.forEach(function (item) {
      byLang[item.language] = byLang[item.language] || [];
      byLang[item.language].push(item);
    });

    var html = '<div style="grid-column:1/-1">' +
      '<h3 style="margin:0 0 0.5rem">' + esc(PRODUCT_NAMES[product] || product) + ' Video Repository</h3></div>';

    Object.keys(byLang).sort().forEach(function (lang) {
      html += '<div style="grid-column:1/-1">' +
        '<h4 style="margin:0.75rem 0 0.25rem;opacity:0.85">&#127760; ' +
        esc(LANG_NAMES[lang] || lang) + ' (' + byLang[lang].length + ')</h4></div>';
      byLang[lang].forEach(function (item) {
        var score = item.performance_score != null
          ? '<span style="color:var(--gold)">★ ' + item.performance_score.toFixed(0) + '</span>'
          : '<span style="opacity:0.5">not scored</span>';
        html += '<div class="card" style="margin:0">' +
          '<div style="font-weight:600;margin-bottom:0.25rem">' + esc(item.title) + '</div>' +
          '<div style="font-size:0.85rem;opacity:0.7;margin-bottom:0.5rem">' + esc(item.category) + '</div>' +
          '<div style="font-size:0.85rem;margin-bottom:0.75rem">' +
            fmtSize(item.file_size_bytes) + ' · ' + item.view_count + ' views · ' + score +
          '</div>' +
          '<button data-content-play="' + item.id + '" style="padding:0.5rem 1rem;cursor:pointer">▶ Play</button> ' +
          '<a href="/api/content/' + item.id + '/file" download style="padding:0.5rem 1rem">⬇ Download</a>' +
        '</div>';
      });
    });
    grid.innerHTML = html || '<div class="empty">No videos in this repository yet.</div>';

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
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (!document.getElementById('content-product-tabs')) return;
    document.getElementById('content-close').addEventListener('click', function () {
      var modal = document.getElementById('content-modal');
      var player = document.getElementById('content-player');
      player.pause();
      player.src = '';
      modal.style.display = 'none';
    });
    // Load repositories when the tab is first opened.
    document.querySelectorAll('.main-tab').forEach(function (b) {
      if (b.getAttribute('data-tab') === 'content') {
        b.addEventListener('click', function () {
          var tabs = document.getElementById('content-product-tabs');
          if (!tabs.dataset.loaded) {
            tabs.dataset.loaded = '1';
            loadProductTabs();
          }
        });
      }
    });
  });
})();
