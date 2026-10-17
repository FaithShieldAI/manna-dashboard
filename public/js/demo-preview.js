/* Manna — signup demo experience: animated counters, canvas charts,
   rotating activity feed, and the exclusive feature carousel.
   No dependencies. All demo data is fictional. */
(function () {
  'use strict';

  /* ---------- animated counters ---------- */
  function animateCount(el, target, dur, fmt) {
    dur = dur || 1400;
    fmt = fmt || function (v) { return Math.round(v).toLocaleString('en-US'); };
    var start = null;
    function frame(t) {
      if (!start) start = t;
      var p = Math.min((t - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(target * eased);
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  document.querySelectorAll('[data-count]').forEach(function (el) {
    var target = parseFloat(el.getAttribute('data-count'));
    var dec = parseInt(el.getAttribute('data-dec') || '0', 10);
    animateCount(el, target, 1600, function (v) {
      return dec ? v.toFixed(dec) + '%' : Math.round(v).toLocaleString('en-US');
    });
  });

  /* ---------- canvas charts ---------- */
  function setupCanvas(id) {
    var c = document.getElementById(id);
    if (!c) return null;
    var dpr = window.devicePixelRatio || 1;
    var w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    var ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    return { ctx: ctx, w: w, h: h };
  }
  var GOLD = '#d9a441', GOLD_BRIGHT = '#f0c876';

  // line chart: 30-day email sends
  (function () {
    var s = setupCanvas('demo-line');
    if (!s) return;
    var pts = [42,55,48,70,66,82,95,88,104,120,112,130,142,138,155,168,160,178,195,188,205,222,215,232,248,240,258,275,268,290];
    var max = Math.max.apply(null, pts), min = Math.min.apply(null, pts);
    var pad = 8, stepX = (s.w - pad * 2) / (pts.length - 1);
    var Y = function (v) { return s.h - pad - ((v - min) / (max - min)) * (s.h - pad * 2); };
    var prog = 0;
    function draw() {
      s.ctx.clearRect(0, 0, s.w, s.h);
      var n = Math.max(2, Math.floor(pts.length * prog));
      var grad = s.ctx.createLinearGradient(0, 0, 0, s.h);
      grad.addColorStop(0, 'rgba(217,164,65,.35)');
      grad.addColorStop(1, 'rgba(217,164,65,0)');
      s.ctx.beginPath();
      s.ctx.moveTo(pad, s.h - pad);
      for (var i = 0; i < n; i++) s.ctx.lineTo(pad + i * stepX, Y(pts[i]));
      s.ctx.lineTo(pad + (n - 1) * stepX, s.h - pad);
      s.ctx.closePath(); s.ctx.fillStyle = grad; s.ctx.fill();
      s.ctx.beginPath();
      for (var j = 0; j < n; j++) {
        var x = pad + j * stepX, y = Y(pts[j]);
        if (j === 0) s.ctx.moveTo(x, y); else s.ctx.lineTo(x, y);
      }
      s.ctx.strokeStyle = GOLD_BRIGHT; s.ctx.lineWidth = 2; s.ctx.stroke();
      var lx = pad + (n - 1) * stepX, ly = Y(pts[n - 1]);
      s.ctx.beginPath(); s.ctx.arc(lx, ly, 3.5, 0, 7);
      s.ctx.fillStyle = GOLD_BRIGHT;
      s.ctx.shadowColor = GOLD; s.ctx.shadowBlur = 10; s.ctx.fill(); s.ctx.shadowBlur = 0;
      if (prog < 1) { prog += 0.025; requestAnimationFrame(draw); }
    }
    draw();
  })();

  // bar chart: leads collected per week
  (function () {
    var s = setupCanvas('demo-bars');
    if (!s) return;
    var vals = [18, 34, 27, 46, 58, 51, 72, 88];
    var max = Math.max.apply(null, vals);
    var bw = (s.w / vals.length);
    var prog = 0;
    function draw() {
      s.ctx.clearRect(0, 0, s.w, s.h);
      for (var i = 0; i < vals.length; i++) {
        var bh = (vals[i] / max) * (s.h - 14) * prog;
        var x = i * bw + bw * 0.22, w = bw * 0.56, y = s.h - bh;
        var g = s.ctx.createLinearGradient(0, y, 0, s.h);
        var last = i === vals.length - 1;
        g.addColorStop(0, last ? GOLD_BRIGHT : '#8a6a2e');
        g.addColorStop(1, last ? GOLD : '#4a3a1c');
        s.ctx.fillStyle = g;
        s.ctx.beginPath();
        if (s.ctx.roundRect) s.ctx.roundRect(x, y, w, Math.max(bh, 2), 3); else s.ctx.rect(x, y, w, Math.max(bh, 2));
        s.ctx.fill();
      }
      if (prog < 1) { prog += 0.04; requestAnimationFrame(draw); }
    }
    draw();
  })();

  /* ---------- rotating activity feed ---------- */
  /* i18n keys + params; text resolved at render time so the dictionary is loaded. */
  var feedItems = [
    { icon: '📧', key: 'demo.js.feed_emails_sent', params: { n: '2,480' }, time: '2m' },
    { icon: '🎯', key: 'demo.js.feed_leads_collected', params: { n: '312' }, time: '9m' },
    { icon: '📈', key: 'demo.js.feed_open_rate', params: { pct: '26.4%' }, time: '18m' },
    { icon: '🤖', key: 'demo.js.feed_warm_flagged', params: { n: '3' }, time: '26m' },
    { icon: '🔥', key: 'demo.js.feed_influencer_clicks', params: { handle: '@creator', n: '48' }, time: '41m' },
    { icon: '💰', key: 'demo.js.feed_roi', params: { pct: '312%' }, time: '1h' }
  ];
  var feedEl = document.getElementById('demo-feed-list');
  var fi = 0;
  function seedFeed() {
    if (!feedEl) return;
    for (var i = 0; i < 3; i++) addFeed(feedItems[i % feedItems.length]);
    fi = 3;
  }
  function addFeed(item) {
    var div = document.createElement('div');
    div.className = 'demo-feed-item';
    div.innerHTML = '<span class="fi">' + item.icon + '</span><span>' + MannaI18n.t(item.key, item.params) + '</span><time>' + MannaI18n.t('demo.js.feed_ago', { time: item.time }) + '</time>';
    feedEl.insertBefore(div, feedEl.firstChild);
    while (feedEl.children.length > 4) feedEl.removeChild(feedEl.lastChild);
  }
  seedFeed();
  setInterval(function () {
    if (!feedEl || !feedEl.offsetParent) return;
    addFeed(feedItems[fi % feedItems.length]); fi++;
  }, 6000);

  /* ---------- feature carousel ---------- */
  /* i18n keys; text resolved at render time so the dictionary is loaded. */
  var features = [
    { icon: '🤖', nameKey: 'demo.js.feature_copilot_name', descKey: 'demo.js.feature_copilot_desc', onlyKey: 'demo.js.feature_only_manna' },
    { icon: '🎯', nameKey: 'demo.js.feature_leads_name', descKey: 'demo.js.feature_leads_desc', onlyKey: 'demo.js.feature_only_elsewhere' },
    { icon: '📊', nameKey: 'demo.js.feature_analytics_name', descKey: 'demo.js.feature_analytics_desc', onlyKey: 'demo.js.feature_only_elsewhere' },
    { icon: '🔥', nameKey: 'demo.js.feature_influencer_name', descKey: 'demo.js.feature_influencer_desc', onlyKey: 'demo.js.feature_only_manna' },
    { icon: '📜', nameKey: 'demo.js.feature_ip_name', descKey: 'demo.js.feature_ip_desc', onlyKey: 'demo.js.feature_only_manna' },
    { icon: '💰', nameKey: 'demo.js.feature_roi_name', descKey: 'demo.js.feature_roi_desc', onlyKey: 'demo.js.feature_only_elsewhere' }
  ];
  var stage = document.getElementById('feat-stage');
  var dotsWrap = document.getElementById('feat-dots');
  var countEl = document.getElementById('feat-count');
  if (stage && dotsWrap) {
    features.forEach(function (f, i) {
      var card = document.createElement('div');
      card.className = 'feat-card' + (i === 0 ? ' active' : '');
      card.innerHTML = '<div class="feat-icon">' + f.icon + '</div>' +
        '<h3 class="feat-name">' + MannaI18n.t(f.nameKey) + '</h3>' +
        '<p class="feat-desc">' + MannaI18n.t(f.descKey) + '</p>' +
        '<span class="feat-only">' + MannaI18n.t(f.onlyKey) + '</span>';
      stage.appendChild(card);
      var dot = document.createElement('button');
      dot.className = 'feat-dot' + (i === 0 ? ' active' : '');
      dot.setAttribute('aria-label', MannaI18n.t(f.nameKey));
      dot.addEventListener('click', function () { go(i); restart(); });
      dotsWrap.appendChild(dot);
    });
    var cards = stage.querySelectorAll('.feat-card');
    var dots = dotsWrap.querySelectorAll('.feat-dot');
    var cur = 0, timer = null;
    function render() {
      cards.forEach(function (c, i) { c.classList.toggle('active', i === cur); });
      dots.forEach(function (d, i) { d.classList.toggle('active', i === cur); });
      if (countEl) countEl.textContent = MannaI18n.t('demo.js.carousel_count', { n: cur + 1, total: features.length });
    }
    function go(i) { cur = (i + features.length) % features.length; render(); }
    function restart() { if (timer) clearInterval(timer); timer = setInterval(function () { go(cur + 1); }, 6000); }
    document.getElementById('feat-prev').addEventListener('click', function () { go(cur - 1); restart(); });
    document.getElementById('feat-next').addEventListener('click', function () { go(cur + 1); restart(); });
    stage.addEventListener('mouseenter', function () { if (timer) clearInterval(timer); timer = null; });
    stage.addEventListener('mouseleave', restart);
    render(); restart();
  }
})();
