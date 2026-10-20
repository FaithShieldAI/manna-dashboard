'use strict';
/* Drip campaigns + scheduled sends — dashboard UI.
 * Dark theme + gold UI. Renders into <div id="drips-app"></div>.
 * Call D2RMDrips.init('drips-app') after /js/auth.js has loaded.
 * All data calls go to /api/drips/* (tenant-scoped server-side). */
(function () {
  var API = '/api/drips';
  var PRODUCTS = ['faithshield', 'armorbearer', 'manna'];
  var productLabel = { faithshield: 'FaithShield AI', armorbearer: 'Armor Bearer', manna: 'Manna AI' };

  var state = {
    root: null,
    view: 'list',        // list | create | detail
    detailId: null,
    templates: null,
    campaigns: null,
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async function call(method, path, body) {
    var r = await D2RM.api(method, API + path, body);
    if (!r.json || r.json.ok !== true) {
      var err = (r.json && r.json.error) || ('http_' + r.status);
      throw new Error(err);
    }
    return r.json;
  }

  function statusBadge(status) {
    var cls = { active: 'b-green', paused: 'b-gold', draft: 'b-blue',
                completed: 'b-green', unsubscribed: 'b-red',
                pending: 'b-gold', sent: 'b-green', cancelled: 'b-red' }[status] || 'b-blue';
    return '<span class="badge ' + cls + '">' + esc(status) + '</span>';
  }

  function style() {
    if (document.getElementById('drips-style')) return;
    var s = document.createElement('style');
    s.id = 'drips-style';
    s.textContent = [
      '#drips-app .drips-tabs{display:flex;gap:8px;margin-bottom:16px}',
      '#drips-app .drips-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}',
      '#drips-app table.drips-t{width:100%;border-collapse:collapse;font-size:14px}',
      '#drips-app table.drips-t th{text-align:left;padding:10px 12px;color:#d9a441;font-weight:600;border-bottom:1px solid rgba(217,164,65,.32)}',
      '#drips-app table.drips-t td{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06)}',
      '#drips-app .drips-form label{display:block;font-size:13px;color:#d9a441;margin:10px 0 4px}',
      '#drips-app .drips-form input,.drips-app2,.drips-form select,.drips-form textarea{width:100%}',
      '#drips-app .step-card{border:1px solid rgba(217,164,65,.32);border-radius:8px;padding:12px;margin:8px 0;background:rgba(217,164,65,.05)}',
      '#drips-app .step-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}',
      '#drips-app .step-fields{display:grid;grid-template-columns:1fr 1fr 2fr 2fr;gap:10px}',
      '#drips-app .row-actions{display:flex;gap:8px;flex-wrap:wrap}',
      '#drips-app .hint{color:#999;font-size:12px}',
      '@media(max-width:900px){#drips-app .drips-grid{grid-template-columns:1fr}#drips-app .step-fields{grid-template-columns:1fr 1fr}}',
    ].join('\n');
    document.head.appendChild(s);
  }

  // -- list view -------------------------------------------------------------
  async function loadCampaigns() {
    state.campaigns = await call('GET', '/');
  }

  function renderList() {
    var rows = (state.campaigns.drips || []).map(function (d) {
      return '<tr><td><strong>' + esc(d.name) + '</strong></td>'
        + '<td>' + esc(productLabel[d.product] || d.product) + '</td>'
        + '<td>' + esc(d.language || '') + '</td>'
        + '<td>' + esc(d.audience || '—') + '</td>'
        + '<td>' + statusBadge(d.status) + '</td>'
        + '<td>' + (d.step_count || 0) + '</td>'
        + '<td>' + (d.active_enrollments || 0) + ' / ' + (d.completed_enrollments || 0) + '</td>'
        + '<td><div class="row-actions">'
        + '<button class="ghost" data-open="' + d.id + '">Open</button>'
        + (d.status === 'active'
            ? '<button class="ghost" data-pause="' + d.id + '">Pause</button>'
            : '<button class="ghost" data-resume="' + d.id + '">Activate</button>')
        + '</div></td></tr>';
    }).join('');
    state.root.innerHTML =
      '<div class="drips-tabs">'
      + '<button class="btn" data-nav="create">+ New drip campaign</button>'
      + '<button class="ghost" data-nav="scheduled">Scheduled sends</button>'
      + '</div>'
      + '<div class="card"><div class="card-title">Drip campaigns</div>'
      + '<div class="card-sub">Multi-step email sequences. Pause a drip any time —'
      + ' due steps stop firing while paused.</div>'
      + (rows
          ? '<table class="drips-t"><thead><tr>'
            + '<th>Name</th><th>Product</th><th>Lang</th><th>Audience</th>'
            + '<th>Status</th><th>Steps</th><th>Active / Done</th><th></th>'
            + '</tr></thead><tbody>' + rows + '</tbody></table>'
          : '<div class="empty-state"><div class="empty-title">No drip campaigns yet</div>'
            + '<div class="empty-text">Build your first multi-step follow-up sequence.</div></div>')
      + '</div>';
    bindList();
  }

  function bindList() {
    state.root.querySelectorAll('[data-nav]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.getAttribute('data-nav') === 'create') showCreate();
        else showScheduled();
      });
    });
    state.root.querySelectorAll('[data-open]').forEach(function (b) {
      b.addEventListener('click', function () { showDetail(Number(b.getAttribute('data-open'))); });
    });
    state.root.querySelectorAll('[data-pause]').forEach(function (b) {
      b.addEventListener('click', function () { setStatus(Number(b.getAttribute('data-pause')), 'paused'); });
    });
    state.root.querySelectorAll('[data-resume]').forEach(function (b) {
      b.addEventListener('click', function () { setStatus(Number(b.getAttribute('data-resume')), 'active'); });
    });
  }

  async function setStatus(id, status) {
    try {
      await call('PUT', '/' + id, { status: status });
      await refresh();
    } catch (e) { alert('Could not update drip: ' + e.message); }
  }

  // -- create view ------------------------------------------------------------
  async function loadTemplates() {
    if (state.templates) return;
    var r = await D2RM.api('GET', '/api/email/templates');
    state.templates = (r.json && r.json.ok && r.json.templates) || [];
  }

  function templateOptions(selected) {
    return (state.templates || []).map(function (t) {
      return '<option value="' + esc(t.template_key) + '"' + (t.template_key === selected ? ' selected' : '') + '>'
        + esc(t.name || t.template_key) + '</option>';
    }).join('');
  }

  var stepSeq = 0;

  function stepCard() {
    stepSeq += 1;
    var i = stepSeq;
    return '<div class="step-card" data-step="' + i + '">'
      + '<div class="step-head"><strong>Step ' + i + '</strong>'
      + '<button type="button" class="ghost" data-rmstep="' + i + '">Remove</button></div>'
      + '<div class="step-fields">'
      + '<div><label>Order</label><input type="number" data-f="order" value="' + (i - 1) + '" min="0"></div>'
      + '<div><label>Delay (hours after prev step)</label><input type="number" data-f="delay" value="24" min="0" max="87600"></div>'
      + '<div><label>Email template</label><select data-f="template">' + templateOptions('') + '</select></div>'
      + '<div><label>Subject (optional)</label><input type="text" data-f="subject" placeholder="Defaults to template subject"></div>'
      + '</div></div>';
  }

  function showCreate() {
    state.view = 'create';
    stepSeq = 0;
    state.root.innerHTML =
      '<div class="drips-tabs"><button class="ghost" data-nav="list">&larr; All drips</button></div>'
      + '<div class="card"><div class="card-title">New drip campaign</div>'
      + '<div class="card-sub">Steps fire in order, each after its delay from the previous step.</div>'
      + '<div class="drips-form">'
      + '<label>Name</label><input id="d-name" type="text" maxlength="120" placeholder="e.g. Influencer welcome sequence">'
      + '<div class="drips-grid">'
      + '<div><label>Product</label><select id="d-product">'
      + PRODUCTS.map(function (p) { return '<option value="' + p + '">' + esc(productLabel[p]) + '</option>'; }).join('')
      + '</select></div>'
      + '<div><label>Language</label><select id="d-lang">'
      + '<option value="en">English</option><option value="es">Español</option>'
      + '<option value="fr">Français</option><option value="de">Deutsch</option>'
      + '<option value="pt">Português</option><option value="tl">Tagalog</option>'
      + '<option value="id">Bahasa Indonesia</option>'
      + '</select></div>'
      + '</div>'
      + '<label>Audience (optional)</label><input id="d-audience" type="text" maxlength="60" placeholder="e.g. pastor, influencer, warm">'
      + '<div id="d-steps">' + stepCard() + '</div>'
      + '<div class="row-actions" style="margin-top:10px"><button class="ghost" id="d-addstep">+ Add step</button></div>'
      + '<div class="row-actions" style="margin-top:16px">'
      + '<button class="btn" id="d-save">Create drip</button>'
      + '<button class="ghost" data-nav="list">Cancel</button></div>'
      + '<p class="hint">The drip is created as a draft. Activate it after review — enrollments only work on active drips.</p>'
      + '</div></div>';
    state.root.querySelectorAll('[data-nav]').forEach(function (b) {
      b.addEventListener('click', refresh);
    });
    document.getElementById('d-addstep').addEventListener('click', function () {
      var box = document.getElementById('d-steps');
      box.insertAdjacentHTML('beforeend', stepCard());
      bindRmSteps();
    });
    bindRmSteps();
    document.getElementById('d-save').addEventListener('click', saveDrip);
  }

  function bindRmSteps() {
    state.root.querySelectorAll('[data-rmstep]').forEach(function (b) {
      b.onclick = function () {
        var el = b.closest('[data-step]');
        if (el) el.remove();
      };
    });
  }

  function collectSteps() {
    var cards = Array.prototype.slice.call(state.root.querySelectorAll('[data-step]'));
    return cards.map(function (c) {
      return {
        step_order: Number(c.querySelector('[data-f="order"]').value) || 0,
        delay_hours: Number(c.querySelector('[data-f="delay"]').value) || 0,
        template_key: c.querySelector('[data-f="template"]').value,
        subject: c.querySelector('[data-f="subject"]').value.trim() || null,
      };
    });
  }

  async function saveDrip() {
    var body = {
      name: document.getElementById('d-name').value.trim(),
      product: document.getElementById('d-product').value,
      language: document.getElementById('d-lang').value,
      audience: document.getElementById('d-audience').value.trim() || null,
      steps: collectSteps(),
    };
    if (!body.name) { alert('Give the drip a name.'); return; }
    if (!body.steps.length) { alert('Add at least one step.'); return; }
    if (body.steps.some(function (s) { return !s.template_key; })) {
      alert('Every step needs an email template.'); return;
    }
    try {
      var r = await call('POST', '/', body);
      showDetail(r.id);
    } catch (e) { alert('Could not create drip: ' + e.message); }
  }

  // -- detail view -------------------------------------------------------------
  async function showDetail(id) {
    state.view = 'detail';
    state.detailId = id;
    try {
      var r = await call('GET', '/' + id);
    } catch (e) { alert('Could not load drip: ' + e.message); return; }
    var d = r.drip;
    var steps = (r.steps || []).map(function (s) {
      return '<div class="step-card"><div class="step-head"><strong>Step ' + s.step_order + '</strong>'
        + statusBadge(s.status) + '</div>'
        + '<div class="hint">Fires ' + s.delay_hours + 'h after the previous step</div>'
        + '<div><strong>' + esc(s.template_key) + '</strong>'
        + (s.subject ? '<br><span class="hint">' + esc(s.subject) + '</span>' : '') + '</div></div>';
    }).join('');
    var counts = (r.enrollment_counts || []).map(function (c) {
      return statusBadge(c.status) + ' ' + c.n;
    }).join(' &nbsp; ');
    state.root.innerHTML =
      '<div class="drips-tabs"><button class="ghost" data-nav="list">&larr; All drips</button></div>'
      + '<div class="card"><div class="card-title">' + esc(d.name) + ' ' + statusBadge(d.status) + '</div>'
      + '<div class="card-sub">' + esc(productLabel[d.product] || d.product) + ' · ' + esc(d.language || '')
      + (d.audience ? ' · ' + esc(d.audience) : '') + '</div>'
      + '<div class="hint">Enrollments: ' + (counts || 'none yet') + '</div>'
      + '<h4 style="color:#d9a441;margin:16px 0 4px">Steps</h4>' + (steps || '<p class="hint">No steps.</p>')
      + '<h4 style="color:#d9a441;margin:16px 0 4px">Enroll contacts</h4>'
      + '<div class="drips-form"><label>Emails (one per line)</label>'
      + '<textarea id="e-emails" rows="5" placeholder="pastor@church.org\ninfluencer@example.com"></textarea>'
      + '<div class="row-actions" style="margin-top:10px">'
      + '<button class="btn" id="e-go">Enroll</button>'
      + (d.status === 'active'
          ? '<button class="ghost" id="e-pause">Pause drip</button>'
          : '<button class="ghost" id="e-resume">Activate drip</button>')
      + '</div><p class="hint">Contacts start at step 0, sent after step 0&rsquo;s delay. Re-enrolling restarts a contact at step 0.</p>'
      + '</div></div>';
    state.root.querySelectorAll('[data-nav]').forEach(function (b) {
      b.addEventListener('click', refresh);
    });
    document.getElementById('e-go').addEventListener('click', async function () {
      var emails = document.getElementById('e-emails').value.split('\n')
        .map(function (s) { return s.trim(); }).filter(Boolean);
      if (!emails.length) { alert('Enter at least one email.'); return; }
      try {
        var rr = await call('POST', '/' + d.id + '/enroll', { emails: emails });
        alert('Enrolled ' + rr.enrolled + ' contact(s).');
        showDetail(d.id);
      } catch (e) { alert('Could not enroll: ' + e.message); }
    });
    var pb = document.getElementById('e-pause');
    if (pb) pb.addEventListener('click', function () { setStatus(d.id, 'paused').then(function () { showDetail(d.id); }); });
    var rb = document.getElementById('e-resume');
    if (rb) rb.addEventListener('click', function () { setStatus(d.id, 'active').then(function () { showDetail(d.id); }); });
  }

  // -- scheduled sends ----------------------------------------------------------
  async function showScheduled() {
    state.view = 'scheduled';
    var sched = await call('GET', '/scheduled');
    var schedRows = (sched.scheduled || []).map(function (s) {
      return '<tr><td>#' + s.id + '</td><td>' + esc(s.campaign_name || ('campaign ' + s.campaign_id)) + '</td>'
        + '<td>' + esc(s.scheduled_at) + '</td><td>' + statusBadge(s.status) + '</td>'
        + '<td>' + (s.status === 'pending'
            ? '<button class="ghost" data-cancel="' + s.id + '">Cancel</button>' : '') + '</td></tr>';
    }).join('');
    // campaign dropdown for scheduling uses email campaigns list
    var ec = await D2RM.api('GET', '/api/email/campaigns?limit=100');
    var ecList = (ec.json && ec.json.ok && ec.json.campaigns) || [];
    state.root.innerHTML =
      '<div class="drips-tabs"><button class="ghost" data-nav="list">&larr; Drip campaigns</button></div>'
      + '<div class="drips-grid">'
      + '<div class="card"><div class="card-title">Schedule a campaign send</div>'
      + '<div class="drips-form">'
      + '<label>Campaign</label><select id="s-campaign">'
      + ecList.map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; }).join('')
      + '</select>'
      + '<label>Send at (your local time)</label><input id="s-at" type="datetime-local">'
      + '<div class="row-actions" style="margin-top:12px"><button class="btn" id="s-go">Schedule send</button></div>'
      + '<p class="hint">The sender cron picks up sends when their time arrives. Cancel any time before then.</p>'
      + '</div></div>'
      + '<div class="card"><div class="card-title">Scheduled sends</div>'
      + (schedRows
          ? '<table class="drips-t"><thead><tr><th>ID</th><th>Campaign</th><th>Scheduled at (UTC)</th><th>Status</th><th></th></tr></thead>'
            + '<tbody>' + schedRows + '</tbody></table>'
          : '<div class="empty-state"><div class="empty-title">Nothing scheduled</div>'
            + '<div class="empty-text">Queue a campaign to go out later.</div></div>')
      + '</div></div>';
    state.root.querySelectorAll('[data-nav]').forEach(function (b) {
      b.addEventListener('click', refresh);
    });
    document.getElementById('s-go').addEventListener('click', async function () {
      var cid = document.getElementById('s-campaign').value;
      var at = document.getElementById('s-at').value;
      if (!cid || !at) { alert('Pick a campaign and a time.'); return; }
      try {
        await call('POST', '/scheduled', { campaign_id: Number(cid), scheduled_at: at });
        alert('Send scheduled.');
        showScheduled();
      } catch (e) { alert('Could not schedule: ' + e.message); }
    });
    state.root.querySelectorAll('[data-cancel]').forEach(function (b) {
      b.addEventListener('click', async function () {
        if (!confirm('Cancel this scheduled send?')) return;
        try {
          await call('DELETE', '/scheduled/' + b.getAttribute('data-cancel'));
          showScheduled();
        } catch (e) { alert('Could not cancel: ' + e.message); }
      });
    });
  }

  // -- entry ---------------------------------------------------------------------
  async function refresh() {
    try {
      await loadTemplates();
      await loadCampaigns();
      if (state.view === 'detail' && state.detailId) { showDetail(state.detailId); return; }
      if (state.view === 'scheduled') { showScheduled(); return; }
      state.view = 'list';
      renderList();
    } catch (e) {
      state.root.innerHTML = '<div class="empty-state"><div class="empty-title">Could not load drips</div>'
        + '<div class="empty-text">' + esc(e.message) + '</div></div>';
    }
  }

  function init(containerId) {
    style();
    state.root = document.getElementById(containerId);
    if (!state.root) return;
    refresh();
  }

  window.D2RMDrips = { init: init, refresh: refresh };
})();
