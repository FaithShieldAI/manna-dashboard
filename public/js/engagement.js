'use strict';
/* Manna Engagement — Star of the Day, A/B testing, social posting tracking.
   Mounts into #engagement-panel (dashboard tab content area) or any
   container passed to EngagementUI.init(containerId).
   Dark theme + gold UI reuse the dashboard-template CSS variables
   (--gold, --gold-bg, .card, .btn, .btn.gold, .table-wrap, .empty).
   Built by worker D (2026-10-20) — do not restyle without Michael. */
(function () {
  var API = '/api/engagement';
  var PLATFORMS = ['instagram', 'facebook', 'x', 'linkedin', 'tiktok', 'telegram', 'rumble', 'truthsocial'];

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function hdr(method, body) {
    var h = { 'X-Requested-With': 'XMLHttpRequest' };
    var o = { method: method, headers: h };
    if (body !== undefined) {
      h['Content-Type'] = 'application/json';
      o.body = JSON.stringify(body);
    }
    return o;
  }

  function get(url) {
    return fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } }).then(function (r) { return r.json(); });
  }

  var goldInput = 'background:var(--bg);border:1px solid var(--border2);border-radius:8px;color:var(--text);padding:9px 12px;font-size:13px;font-family:inherit;';
  var goldLabel = 'font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;display:block;';

  /* --- Next Move: Scribe follow-ups (the loop) ---------------------------
     Every recorded move fires Scribe automatically; this card is where
     the operator hears what happened, answers Scribe's questions, and
     presses the one button that matters: OK. */

  function renderFollowups(el) {
    el.innerHTML = '<div class="card"><div class="card-header"><div><div class="card-title">&#129517; Next Move — Scribe</div>' +
      '<div class="card-sub">Every move is followed up automatically. Scribe dictates the next move and prepares it — your part is the answers and the OK.</div></div></div>' +
      '<div data-fu-list><div class="empty">Loading…</div></div></div>';
    var listEl = el.querySelector('[data-fu-list]');

    function dirChip(d) {
      if (d === 'up') return '<span style="color:#8fd18a;font-weight:700;font-size:11px">REACTION: UP</span>';
      if (d === 'down') return '<span style="color:#e08a8a;font-weight:700;font-size:11px">REACTION: DOWN</span>';
      if (d === 'flat') return '<span style="color:var(--text3);font-weight:700;font-size:11px">REACTION: FLAT</span>';
      return '';
    }

    function load() {
      get('/api/scribe/followups?limit=50').then(function (d) {
        if (!d.ok) { listEl.innerHTML = '<div class="empty">Failed to load.</div>'; return; }
        var pending = (d.followups || []).filter(function (f) { return f.status === 'pending'; });
        var decided = (d.followups || []).filter(function (f) { return f.status !== 'pending'; }).slice(0, 3);
        if (!pending.length && !decided.length) {
          listEl.innerHTML = '<div class="empty">No moves waiting on you. When a move is recorded, Scribe\'s next move and its ask land here.</div>';
          return;
        }
        var html = pending.map(function (f) {
          var qs = (f.questions || []).map(function (q, i) {
            var saved = (f.answers || {})[String(i)] || '';
            return '<div style="margin-top:8px"><label style="' + goldLabel + '">Scribe asks</label>' +
              '<div style="font-size:13px;margin-bottom:4px">' + esc(q.question) + (q.why ? '<div style="color:var(--text3);font-size:11px">' + esc(q.why) + '</div>' : '') + '</div>' +
              '<input data-fu-answer="' + f.id + '|' + i + '" value="' + esc(saved) + '" placeholder="Your answer, one sentence" style="' + goldInput + 'width:100%" /></div>';
          }).join('');
          return '<div style="border:1px solid var(--border2);border-radius:10px;padding:12px;margin-bottom:10px">' +
            '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><strong>' + esc(f.summary) + '</strong>' + dirChip(f.direction) + '</div>' +
            (f.next_move ? '<div style="margin-top:6px;font-size:13px">Scribe\'s next move: <strong style="color:var(--gold)">' + esc(f.next_move) + '</strong>' +
              (f.drafts_count ? ' <span style="color:var(--text3)">(' + f.drafts_count + ' draft' + (f.drafts_count === 1 ? '' : 's') + ' prepared)</span>' : '') + '</div>' : '') +
            qs +
            '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">' +
            (qs ? '<button class="btn" data-fu-save="' + f.id + '">Save answers</button>' : '') +
            '<button class="btn gold" data-fu-decide="' + f.id + '|approved">OK — go this direction</button>' +
            '<button class="btn" data-fu-decide="' + f.id + '|dismissed">Not now</button></div></div>';
        }).join('');
        if (decided.length) {
          html += '<div style="color:var(--text3);font-size:12px;margin-top:4px">' + decided.map(function (f) {
            return esc(f.status === 'approved' ? 'You said OK: ' : 'Shelved: ') + esc(f.summary);
          }).join('<br>') + '</div>';
        }
        listEl.innerHTML = html;
        listEl.querySelectorAll('[data-fu-save]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-fu-save');
            var answers = {};
            listEl.querySelectorAll('[data-fu-answer]').forEach(function (inp) {
              var parts = inp.getAttribute('data-fu-answer').split('|');
              if (parts[0] === id && inp.value.trim()) answers[parts[1]] = inp.value.trim();
            });
            fetch('/api/scribe/followups/' + id + '/answers', hdr('POST', { answers: answers }))
              .then(function (r) { return r.json(); })
              .then(function (w) { if (w.ok) load(); else alert('Save failed: ' + (w.error || 'unknown')); });
          });
        });
        listEl.querySelectorAll('[data-fu-decide]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var parts = btn.getAttribute('data-fu-decide').split('|');
            fetch('/api/scribe/followups/' + parts[0] + '/decide', hdr('POST', { decision: parts[1] }))
              .then(function (r) { return r.json(); })
              .then(function (w) { if (w.ok) load(); else alert('Failed: ' + (w.error || 'unknown')); });
          });
        });
      }).catch(function () { listEl.innerHTML = '<div class="empty">Failed to load.</div>'; });
    }
    load();
  }

  /* --- Star of the Day -------------------------------------------------- */

  function renderStar(el) {
    el.innerHTML = '<div class="card"><div class="card-header"><div><div class="card-title">&#11088; Star of the Day</div>' +
      '<div class="card-sub">Best campaign by engagement (score = clicks&times;3 + opens)</div></div>' +
      '<button class="btn" data-refresh-star>&#8635; Refresh</button></div>' +
      '<div data-star-body><div class="empty">Loading…</div></div></div>';
    var body = el.querySelector('[data-star-body]');
    function load() {
      body.innerHTML = '<div class="empty">Loading…</div>';
      get(API + '/star').then(function (d) {
        if (!d.ok) { body.innerHTML = '<div class="empty">Failed to load.</div>'; return; }
        if (!d.star) {
          body.innerHTML = '<div class="empty">No star yet — send a campaign (sent &gt; 0) and the daily winner appears here.</div>';
          return;
        }
        var c = d.star.campaign || {};
        var openRate = c.sent > 0 ? (100 * (c.opens || 0) / c.sent).toFixed(1) : '0.0';
        var clickRate = c.sent > 0 ? (100 * (c.clicks || 0) / c.sent).toFixed(1) : '0.0';
        body.innerHTML =
          '<div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding:1rem;border:1px solid rgba(217,164,65,.35);border-radius:var(--radius);background:var(--gold-bg)">' +
          '<div style="font-size:34px">&#11088;</div>' +
          '<div style="flex:1;min-width:220px">' +
          '<div style="font-size:16px;font-weight:700;color:var(--gold)">' + esc(c.name || 'Untitled') + '</div>' +
          '<div style="font-size:12px;color:var(--text2);margin-top:2px">score ' + esc(String(d.star.score)) +
          ' &middot; ' + esc(String(c.sent || 0)) + ' sent &middot; ' + esc(String(c.opens || 0)) + ' opens (' + openRate + '%)' +
          ' &middot; ' + esc(String(c.clicks || 0)) + ' clicks (' + clickRate + '%)' + '</div>' +
          '</div>' +
          '<div style="display:flex;gap:8px;align-items:center">' +
          '<input data-adapt-name placeholder="Adapted name (optional)" style="' + goldInput + 'width:220px" />' +
          '<button class="btn gold" data-adapt="' + d.star.id + '">Duplicate &amp; Adapt</button>' +
          '</div></div>' +
          '<div style="font-size:11px;color:var(--text3);margin-top:8px">Duplicating creates a NEW draft (zeroed counters) — you edit it before sending.</div>';
        var adaptBtn = body.querySelector('[data-adapt]');
        adaptBtn.addEventListener('click', function () {
          var nameInput = body.querySelector('[data-adapt-name]');
          var name = nameInput ? nameInput.value.trim() : '';
          adaptBtn.disabled = true;
          fetch(API + '/star/' + d.star.id + '/adapt', hdr('POST', { name: name }))
            .then(function (r) { return r.json(); })
            .then(function (ad) {
              if (!ad.ok) { alert('Adapt failed: ' + (ad.error || 'unknown')); adaptBtn.disabled = false; return; }
              alert('Draft created: "' + (ad.campaign && ad.campaign.name) + '" — edit it under Email campaigns before sending.');
              adaptBtn.disabled = false;
              if (nameInput) nameInput.value = '';
            })
            .catch(function () { alert('Adapt failed (network).'); adaptBtn.disabled = false; });
        });
      }).catch(function () { body.innerHTML = '<div class="empty">Failed to load.</div>'; });
    }
    el.querySelector('[data-refresh-star]').addEventListener('click', load);
    load();
  }

  /* --- A/B testing ------------------------------------------------------- */

  function renderAB(el) {
    el.innerHTML = '<div class="card"><div class="card-header"><div><div class="card-title">&#129518; A/B Tests</div>' +
      '<div class="card-sub">Split tests for email templates and video posts — declare a winner when the data is in</div></div></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:1rem;align-items:flex-end">' +
      '<input data-ab-name placeholder="Test name" style="' + goldInput + 'flex:2;min-width:180px" />' +
      '<select data-ab-kind style="' + goldInput + '"><option value="email">Email templates</option><option value="video">Video posts</option></select>' +
      '<span data-ab-email-fields style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<input data-ab-a placeholder="Variant A template key" style="' + goldInput + 'flex:1;min-width:150px" />' +
      '<input data-ab-b placeholder="Variant B template key" style="' + goldInput + 'flex:1;min-width:150px" />' +
      '<input data-ab-split type="number" min="1" max="99" value="50" title="% of audience for variant A" style="' + goldInput + 'width:70px" /></span>' +
      '<span data-ab-video-fields style="display:none;gap:8px;flex-wrap:wrap">' +
      '<select data-ab-pa style="' + goldInput + 'flex:1;min-width:200px"></select>' +
      '<select data-ab-pb style="' + goldInput + 'flex:1;min-width:200px"></select></span>' +
      '<button class="btn gold" data-ab-create>Create test</button></div>' +
      '<div data-ab-list><div class="empty">Loading…</div></div></div>';
    var listEl = el.querySelector('[data-ab-list]');
    var kindSel = el.querySelector('[data-ab-kind]');
    var emailFields = el.querySelector('[data-ab-email-fields]');
    var videoFields = el.querySelector('[data-ab-video-fields]');

    function postLabel(p) {
      var d = (p.posted_at || '').slice(0, 10);
      var u = p.post_url || '';
      if (u.length > 42) u = u.slice(0, 42) + '…';
      return p.platform + (d ? ' · ' + d : '') + ' · ' + u;
    }

    function fillPostPickers() {
      get(API + '/social').then(function (d) {
        var posts = (d && d.postings) || [];
        var html = posts.length
          ? posts.map(function (p) { return '<option value="' + p.id + '">' + esc(postLabel(p)) + '</option>'; }).join('')
          : '<option value="">No posts logged yet — log both posts below first</option>';
        el.querySelector('[data-ab-pa]').innerHTML = html;
        el.querySelector('[data-ab-pb]').innerHTML = html;
      }).catch(function () { /* pickers stay empty; create will complain */ });
    }

    kindSel.addEventListener('change', function () {
      var video = kindSel.value === 'video';
      emailFields.style.display = video ? 'none' : 'flex';
      videoFields.style.display = video ? 'flex' : 'none';
      if (video) fillPostPickers();
    });

    function postCell(post, fallback) {
      if (!post) return esc(fallback || '—');
      var u = post.post_url || '';
      var short = u.length > 34 ? u.slice(0, 34) + '…' : u;
      return esc(post.platform) + '<br><a href="' + esc(u) + '" target="_blank" rel="noopener" style="color:var(--gold);font-size:11px">' + esc(short) + '</a>';
    }

    function scoreLine(t, s) {
      return '<span style="font-size:11px;color:var(--text2)">' + (s === 'a' ? 'A' : 'B') + ': ' +
        t['clicks_' + s] + ' clicks · ' + t['likes_' + s] + ' likes · ' + t['shares_' + s] + ' shares · ' +
        t['comments_' + s] + ' comments · <strong>score ' + (t.scores ? t.scores[s] : 0) + '</strong></span>';
    }

    function load() {
      listEl.innerHTML = '<div class="empty">Loading…</div>';
      get(API + '/ab').then(function (d) {
        if (!d.ok || !d.tests || !d.tests.length) {
          listEl.innerHTML = '<div class="empty">No A/B tests yet.</div>';
          return;
        }
        var rows = d.tests.map(function (t) {
          var winnerCell = t.winner
            ? '<span class="btn-ok" style="cursor:default">Winner: ' + (t.winner === 'a' ? 'A' : 'B') + '</span>'
            : '<button class="btn-ok" data-winner="' + t.id + '|a">A wins</button> ' +
              '<button class="btn-ok" data-winner="' + t.id + '|b">B wins</button>';
          var kindTag = t.kind === 'video' ? ' · video' : ' · email';
          if (t.kind === 'video') {
            var syncCell = t.winner ? '' : ' <button class="btn" data-sync="' + t.id + '">Sync numbers</button>';
            return '<tr><td><strong>' + esc(t.name) + '</strong><br><span style="color:var(--text3);font-size:11px">' + esc(t.status) + kindTag + '</span></td>' +
              '<td>' + postCell(t.variant_a_post, t.variant_a_template) + '</td><td>' + postCell(t.variant_b_post, t.variant_b_template) + '</td>' +
              '<td>' + scoreLine(t, 'a') + '<br>' + scoreLine(t, 'b') + '</td>' +
              '<td>' + winnerCell + syncCell + '</td></tr>';
          }
          return '<tr><td><strong>' + esc(t.name) + '</strong><br><span style="color:var(--text3);font-size:11px">' + esc(t.status) + kindTag + '</span></td>' +
            '<td>' + esc(t.variant_a_template || '—') + '</td><td>' + esc(t.variant_b_template || '—') + '</td>' +
            '<td class="n">' + esc(String(t.split_pct)) + ' / ' + esc(String(100 - t.split_pct)) + '</td>' +
            '<td>' + winnerCell + '</td></tr>';
        }).join('');
        listEl.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Test</th><th>Variant A</th><th>Variant B</th><th>Split / Score</th><th>Winner</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
        listEl.querySelectorAll('[data-winner]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var parts = btn.getAttribute('data-winner').split('|');
            fetch(API + '/ab/' + parts[0] + '/winner', hdr('POST', { variant: parts[1] }))
              .then(function (r) { return r.json(); })
              .then(function (w) { if (w.ok) load(); else alert('Failed: ' + (w.error || 'unknown')); });
          });
        });
        listEl.querySelectorAll('[data-sync]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            fetch(API + '/ab/' + btn.getAttribute('data-sync') + '/sync', hdr('POST', {}))
              .then(function (r) { return r.json(); })
              .then(function (w) {
                if (!w.ok) { alert('Sync failed: ' + (w.error || 'unknown')); return; }
                if (w.auto_winner) alert('Auto winner declared: ' + w.auto_winner.toUpperCase());
                load();
              });
          });
        });
      }).catch(function () { listEl.innerHTML = '<div class="empty">Failed to load.</div>'; });
    }

    el.querySelector('[data-ab-create]').addEventListener('click', function () {
      var name = el.querySelector('[data-ab-name]').value.trim();
      if (!name) { alert('Give the test a name.'); return; }
      var payload;
      if (kindSel.value === 'video') {
        var pa = el.querySelector('[data-ab-pa]').value;
        var pb = el.querySelector('[data-ab-pb]').value;
        if (!pa || !pb) { alert('Log both posts in Social Posting Tracking first, then pick them.'); return; }
        if (pa === pb) { alert('Pick two different posts for A and B.'); return; }
        payload = { name: name, kind: 'video', variant_a_post_id: pa, variant_b_post_id: pb };
      } else {
        payload = {
          name: name,
          variant_a_template: el.querySelector('[data-ab-a]').value.trim(),
          variant_b_template: el.querySelector('[data-ab-b]').value.trim(),
          split_pct: el.querySelector('[data-ab-split]').value
        };
      }
      fetch(API + '/ab', hdr('POST', payload))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d.ok) { alert('Create failed: ' + (d.error || 'unknown')); return; }
          el.querySelector('[data-ab-name]').value = '';
          el.querySelector('[data-ab-a]').value = '';
          el.querySelector('[data-ab-b]').value = '';
          load();
        });
    });
    load();
  }

  /* --- Social tracking ----------------------------------------------------- */

  function renderSocial(el) {
    var platformOpts = PLATFORMS.map(function (p) { return '<option value="' + p + '">' + esc(p.charAt(0).toUpperCase() + p.slice(1)) + '</option>'; }).join('');
    el.innerHTML = '<div class="card"><div class="card-header"><div><div class="card-title">&#128241; Social Posting Tracking</div>' +
      '<div class="card-sub">Log posts (pasted link or auto-posted) and keep metrics in one place</div></div></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:1rem;align-items:flex-end">' +
      '<div><label style="' + goldLabel + '">Platform</label><select data-so-platform style="' + goldInput + '">' + platformOpts + '</select></div>' +
      '<div style="flex:2;min-width:200px"><label style="' + goldLabel + '">Post URL</label><input data-so-url placeholder="https://…" style="' + goldInput + 'width:100%" /></div>' +
      '<div><label style="' + goldLabel + '">Content item ID (optional)</label><input data-so-cid placeholder="—" style="' + goldInput + 'width:110px" /></div>' +
      '<div><label style="' + goldLabel + '">Likes</label><input data-so-likes type="number" min="0" value="0" style="' + goldInput + 'width:80px" /></div>' +
      '<div><label style="' + goldLabel + '">Shares</label><input data-so-shares type="number" min="0" value="0" style="' + goldInput + 'width:80px" /></div>' +
      '<div><label style="' + goldLabel + '">Comments</label><input data-so-comments type="number" min="0" value="0" style="' + goldInput + 'width:80px" /></div>' +
      '<div><label style="' + goldLabel + '">Clicks</label><input data-so-clicks type="number" min="0" value="0" style="' + goldInput + 'width:80px" /></div>' +
      '<button class="btn gold" data-so-log>Log post</button></div>' +
      '<div data-so-list><div class="empty">Loading…</div></div></div>';
    var listEl = el.querySelector('[data-so-list]');

    function load() {
      listEl.innerHTML = '<div class="empty">Loading…</div>';
      get(API + '/social').then(function (d) {
        if (!d.ok || !d.postings || !d.postings.length) {
          listEl.innerHTML = '<div class="empty">No posts logged yet.</div>';
          return;
        }
        var rows = d.postings.map(function (p) {
          return '<tr><td>' + esc(p.platform) + '</td>' +
            '<td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><a href="' + esc(p.post_url) + '" target="_blank" rel="noopener" style="color:var(--gold)">' + esc(p.post_url) + '</a>' +
            (p.content_title ? '<br><span style="color:var(--text3);font-size:11px">📼 ' + esc(p.content_title) + '</span>' : '') + '</td>' +
            '<td class="n">' + esc(String(p.likes)) + '</td><td class="n">' + esc(String(p.shares)) + '</td>' +
            '<td class="n">' + esc(String(p.comments)) + '</td><td class="n">' + esc(String(p.clicks)) + '</td>' +
            '<td><button class="btn" data-so-edit="' + p.id + '" data-l="' + p.likes + '" data-s="' + p.shares + '" data-c="' + p.comments + '" data-k="' + p.clicks + '">Update metrics</button></td></tr>';
        }).join('');
        listEl.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Platform</th><th>Post</th><th class="n">Likes</th><th class="n">Shares</th><th class="n">Comments</th><th class="n">Clicks</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
        listEl.querySelectorAll('[data-so-edit]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-so-edit');
            var likes = prompt('Likes:', btn.getAttribute('data-l'));
            if (likes === null) return;
            var shares = prompt('Shares:', btn.getAttribute('data-s'));
            if (shares === null) return;
            var comments = prompt('Comments:', btn.getAttribute('data-c'));
            if (comments === null) return;
            var clicks = prompt('Clicks:', btn.getAttribute('data-k'));
            if (clicks === null) return;
            fetch(API + '/social/' + id + '/metrics', hdr('PUT', { likes: likes, shares: shares, comments: comments, clicks: clicks }))
              .then(function (r) { return r.json(); })
              .then(function (u) { if (u.ok) load(); else alert('Update failed: ' + (u.error || 'unknown')); });
          });
        });
      }).catch(function () { listEl.innerHTML = '<div class="empty">Failed to load.</div>'; });
    }

    el.querySelector('[data-so-log]').addEventListener('click', function () {
      var payload = {
        platform: el.querySelector('[data-so-platform]').value,
        post_url: el.querySelector('[data-so-url]').value.trim(),
        content_item_id: el.querySelector('[data-so-cid]').value.trim() || null,
        likes: el.querySelector('[data-so-likes]').value,
        shares: el.querySelector('[data-so-shares]').value,
        comments: el.querySelector('[data-so-comments]').value,
        clicks: el.querySelector('[data-so-clicks]').value,
      };
      if (!payload.post_url) { alert('Paste the post URL.'); return; }
      fetch(API + '/social', hdr('POST', payload))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d.ok) { alert('Log failed: ' + (d.error || 'unknown')); return; }
          el.querySelector('[data-so-url]').value = '';
          el.querySelector('[data-so-cid]').value = '';
          load();
        });
    });
    load();
  }

  /* --- init ---------------------------------------------------------------- */

  function init(containerId) {
    var root = document.getElementById(containerId || 'engagement-panel');
    if (!root) return;
    root.innerHTML =
      '<div class="page-header"><h1>&#9881; Engagement</h1>' +
      '<p>Star of the Day &middot; A/B tests &middot; social posting tracking</p></div>' +
      '<div data-eng-next style="margin-bottom:1rem"></div>' +
      '<div data-eng-star style="margin-bottom:1rem"></div>' +
      '<div data-eng-ab style="margin-bottom:1rem"></div>' +
      '<div data-eng-social></div>';
    renderFollowups(root.querySelector('[data-eng-next]'));
    renderStar(root.querySelector('[data-eng-star]'));
    renderAB(root.querySelector('[data-eng-ab]'));
    renderSocial(root.querySelector('[data-eng-social]'));
  }

  window.EngagementUI = { init: init };
  document.addEventListener('DOMContentLoaded', function () {
    if (document.getElementById('engagement-panel')) init('engagement-panel');
  });
})();
