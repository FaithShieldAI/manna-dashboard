'use strict';
/* D2RM PR: press connections, releases, pitch log.
   Mounts into #pr-panel (dashboard tab content area) or any container
   passed to PrUI.init(containerId). Private D2RM dashboard only: the
   tab button stays hidden unless /api/pr/summary answers OK, and every
   /api/pr route is admin-gated server-side besides. Reuses the
   dashboard-template CSS (.card, .btn, .table-wrap, .empty) with
   neutral accents. Do not restyle without Michael. */
(function () {
  var API = '/api/pr';
  var TIERS = [
    ['faith_major', 'Faith press majors'],
    ['tech', 'Tech and mainstream'],
    ['niche', 'Faith-tech niche'],
  ];
  var TIER_LABEL = {};
  TIERS.forEach(function (t) { TIER_LABEL[t[0]] = t[1]; });
  var PITCH_STATUSES = ['drafted', 'approved', 'sent', 'replied', 'covered', 'declined', 'no_response'];
  var STATUS_LABEL = {
    drafted: 'Drafted', approved: 'Approved', sent: 'Sent', replied: 'Replied',
    covered: 'Covered', declined: 'Declined', no_response: 'No response',
    draft: 'Draft', active: 'Active', archived: 'Archived',
  };
  var RELEASE_STATUSES = ['draft', 'approved', 'sent', 'archived'];

  var state = { targets: [], releases: [], pitches: [], summary: null, editTarget: null, editRelease: null };

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
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

  function call(method, url, body) {
    return fetch(url, hdr(method, body)).then(function (r) { return r.json(); });
  }
  function get(url) { return call('GET', url); }

  var inputCss = 'background:var(--bg);border:1px solid var(--border2);border-radius:8px;color:var(--text);padding:9px 12px;font-size:13px;font-family:inherit;';
  var labelCss = 'font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;display:block;';

  function field(label, inner) {
    return '<div><label style="' + labelCss + '">' + label + '</label>' + inner + '</div>';
  }
  function textInput(id, val, ph, extra) {
    return '<input id="' + id + '" value="' + esc(val || '') + '" placeholder="' + esc(ph || '') + '" style="' + inputCss + 'width:100%' + (extra || '') + '" />';
  }
  function select(id, options, val) {
    var h = '<select id="' + id + '" style="' + inputCss + 'width:100%">';
    options.forEach(function (o) {
      h += '<option value="' + esc(o[0]) + '"' + (o[0] === val ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
    });
    return h + '</select>';
  }
  function optionsFrom(list, labelFn) {
    return list.map(function (x) { return [String(x.id), labelFn(x)]; });
  }

  function routeChip(t) {
    if (!t.contact_route) return '<span style="color:var(--text3)">no route on file</span>';
    var chip = t.route_verified
      ? '<span style="color:#8fd18a;font-weight:700;font-size:11px">VERIFIED</span>'
      : '<span style="color:#e0b36a;font-weight:700;font-size:11px">UNVERIFIED</span>';
    return '<span style="font-size:12px">' + esc(t.contact_route) + '</span> ' + chip;
  }

  function renderCounts(root) {
    var el = root.querySelector('[data-pr-counts]');
    if (!el) return;
    var s = state.summary || {};
    el.innerHTML =
      '<span><strong style="color:var(--text)">' + (s.targets || 0) + '</strong> connections</span>' +
      '<span><strong style="color:var(--text)">' + (s.targets_unverified || 0) + '</strong> routes unverified</span>' +
      '<span><strong style="color:var(--text)">' + (s.releases || 0) + '</strong> releases</span>' +
      '<span><strong style="color:var(--text)">' + (s.pitches_sent || 0) + '</strong> pitches out</span>' +
      '<span><strong style="color:var(--text)">' + (s.followups_due || 0) + '</strong> follow-ups due</span>';
  }

  function render(root) {
    var html = '';

    html += '<div class="card"><div class="card-header"><div>' +
      '<div class="card-title">&#128240; PR: Press Connections</div>' +
      '<div class="card-sub">The house list of publications and the people who take pitches there, the releases we send them, and where every pitch stands. D2RM private: this tab is not part of MannaAi.</div></div>' +
      '<button class="btn" data-pr-import>&#8681; Import connections list</button></div>' +
      '<div data-pr-counts style="display:flex;gap:18px;flex-wrap:wrap;font-size:13px;color:var(--text2)"></div>' +
      '<div data-pr-import-note style="font-size:12px;color:var(--text3);margin-top:6px"></div></div>';

    /* --- Connections --- */
    html += '<div class="card"><div class="card-header"><div><div class="card-title">Connections</div>' +
      '<div class="card-sub">One row per publication contact. A route marked unverified has not been confirmed from the outlet\'s own pages yet.</div></div></div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">' +
      '<div style="min-width:180px">' + field('Tier', select('pr-filter-tier', [['', 'All tiers']].concat(TIERS), '')) + '</div>' +
      '<div style="min-width:140px">' + field('Status', select('pr-filter-status', [['active', 'Active'], ['archived', 'Archived'], ['', 'All']], 'active')) + '</div>' +
      '<div style="flex:1;min-width:200px">' + field('Search', textInput('pr-filter-q', '', 'Publication, contact, beat')) + '</div>' +
      '</div>' +
      '<div class="table-wrap"><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr>' +
      '<th style="text-align:left;padding:6px">Publication</th><th style="text-align:left;padding:6px">Contact</th>' +
      '<th style="text-align:left;padding:6px">Beat</th><th style="text-align:left;padding:6px">Pitch route</th>' +
      '<th style="text-align:left;padding:6px">Tier</th><th style="text-align:left;padding:6px">Fit</th><th></th></tr></thead>' +
      '<tbody data-pr-targets><tr><td colspan="7"><div class="empty">Loading…</div></td></tr></tbody></table></div>' +
      '<div style="margin-top:14px;border-top:1px solid var(--border2);padding-top:12px">' +
      '<div style="font-weight:700;margin-bottom:8px" data-pr-target-form-title>Add a connection</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px">' +
      field('Publication *', textInput('pr-t-publication', '', 'Christianity Today')) +
      field('Contact name', textInput('pr-t-contact', '', 'Jane Editor')) +
      field('Role', textInput('pr-t-role', '', 'Religion editor')) +
      field('Beat', textInput('pr-t-beat', '', 'Faith and technology')) +
      field('Tier', select('pr-t-tier', TIERS, 'niche')) +
      field('Pitch route', textInput('pr-t-route', '', 'tips@example.org or the contact page URL')) +
      field('Source', textInput('pr-t-source', '', 'Where this contact was verified')) +
      '<div>' + '<label style="' + labelCss + '">Route verified</label>' +
      '<label style="font-size:13px"><input type="checkbox" id="pr-t-verified" /> Confirmed from the outlet\'s own pages</label></div>' +
      '</div>' +
      '<div style="margin-top:10px">' + field('Fit note', textInput('pr-t-fit', '', 'Why this outlet fits the story')) + '</div>' +
      '<div style="display:flex;gap:8px;margin-top:10px"><button class="btn" data-pr-target-save>Save connection</button>' +
      '<button class="btn" data-pr-target-cancel style="display:none">Cancel edit</button></div>' +
      '</div></div>';

    /* --- Releases --- */
    html += '<div class="card"><div class="card-header"><div><div class="card-title">Releases</div>' +
      '<div class="card-sub">The releases themselves, so every pitch points at the exact words that went out.</div></div></div>' +
      '<div data-pr-releases><div class="empty">Loading…</div></div>' +
      '<div style="margin-top:14px;border-top:1px solid var(--border2);padding-top:12px">' +
      '<div style="font-weight:700;margin-bottom:8px" data-pr-release-form-title>New release</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px">' +
      field('Title *', textInput('pr-r-title', '', 'Release title')) +
      field('Subject line', textInput('pr-r-subject', '', 'Email subject when pitched')) +
      field('Status', select('pr-r-status', RELEASE_STATUSES.map(function (x) { return [x, STATUS_LABEL[x]]; }), 'draft')) +
      '</div>' +
      '<div style="margin-top:10px"><label style="' + labelCss + '">Body</label>' +
      '<textarea id="pr-r-body" rows="8" style="' + inputCss + 'width:100%"></textarea></div>' +
      '<div style="display:flex;gap:8px;margin-top:10px"><button class="btn" data-pr-release-save>Save release</button>' +
      '<button class="btn" data-pr-release-cancel style="display:none">Cancel edit</button></div>' +
      '</div></div>';

    /* --- Pitch log --- */
    html += '<div class="card"><div class="card-header"><div><div class="card-title">Pitch log</div>' +
      '<div class="card-sub">Every pitch of a release to a connection, and where it stands. Changing a status here stamps the sent and reply dates automatically.</div></div></div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:12px">' +
      field('Connection', '<select id="pr-p-target" style="' + inputCss + 'width:100%"></select>') +
      field('Release', '<select id="pr-p-release" style="' + inputCss + 'width:100%"></select>') +
      field('Status', select('pr-p-status', PITCH_STATUSES.map(function (x) { return [x, STATUS_LABEL[x]]; }), 'drafted')) +
      field('Follow-up due', '<input id="pr-p-followup" type="date" style="' + inputCss + 'width:100%" />') +
      field('Notes', textInput('pr-p-notes', '', 'What was said, what is owed')) +
      '</div>' +
      '<button class="btn" data-pr-pitch-save>Log pitch</button>' +
      '<div class="table-wrap" style="margin-top:12px"><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr>' +
      '<th style="text-align:left;padding:6px">Connection</th><th style="text-align:left;padding:6px">Release</th>' +
      '<th style="text-align:left;padding:6px">Status</th><th style="text-align:left;padding:6px">Sent</th>' +
      '<th style="text-align:left;padding:6px">Reply</th><th style="text-align:left;padding:6px">Follow-up due</th>' +
      '<th style="text-align:left;padding:6px">Notes</th><th></th></tr></thead>' +
      '<tbody data-pr-pitches><tr><td colspan="8"><div class="empty">Loading…</div></td></tr></tbody></table></div>' +
      '</div>';

    root.innerHTML = html;
    wire(root);
    loadAll(root);
  }

  function loadTargets(root) {
    var tier = root.querySelector('#pr-filter-tier').value;
    var status = root.querySelector('#pr-filter-status').value;
    var q = root.querySelector('#pr-filter-q').value.trim();
    var qs = [];
    if (tier) qs.push('tier=' + encodeURIComponent(tier));
    if (status) qs.push('status=' + encodeURIComponent(status));
    if (q) qs.push('q=' + encodeURIComponent(q));
    var body = root.querySelector('[data-pr-targets]');
    get(API + '/targets' + (qs.length ? '?' + qs.join('&') : '')).then(function (d) {
      if (!d.ok) { body.innerHTML = '<tr><td colspan="7"><div class="empty">Failed to load.</div></td></tr>'; return; }
      state.targets = d.targets || [];
      if (!state.targets.length) {
        body.innerHTML = '<tr><td colspan="7"><div class="empty">No connections yet. Import the researched list or add the first one below.</div></td></tr>';
      } else {
        body.innerHTML = state.targets.map(function (t) {
          return '<tr style="border-top:1px solid var(--border2)">' +
            '<td style="padding:6px"><strong>' + esc(t.publication) + '</strong>' +
            (t.status === 'archived' ? ' <span style="color:var(--text3)">(archived)</span>' : '') + '</td>' +
            '<td style="padding:6px">' + esc(t.contact_name || '') +
            (t.role ? '<div style="color:var(--text3);font-size:12px">' + esc(t.role) + '</div>' : '') + '</td>' +
            '<td style="padding:6px">' + esc(t.beat || '') + '</td>' +
            '<td style="padding:6px">' + routeChip(t) + '</td>' +
            '<td style="padding:6px">' + esc(TIER_LABEL[t.tier] || t.tier) + '</td>' +
            '<td style="padding:6px;font-size:12px">' + esc(t.fit_note || '') + '</td>' +
            '<td style="padding:6px;white-space:nowrap"><button class="btn" data-pr-target-edit="' + t.id + '">Edit</button> ' +
            '<button class="btn" data-pr-target-del="' + t.id + '">Delete</button></td></tr>';
        }).join('');
      }
      fillPitchSelects(root);
      body.querySelectorAll('[data-pr-target-edit]').forEach(function (b) {
        b.addEventListener('click', function () { editTarget(root, Number(b.getAttribute('data-pr-target-edit'))); });
      });
      body.querySelectorAll('[data-pr-target-del]').forEach(function (b) {
        b.addEventListener('click', function () {
          if (!confirm('Delete this connection? Its pitch history goes with it.')) return;
          call('DELETE', API + '/targets/' + b.getAttribute('data-pr-target-del')).then(function () { loadAll(root); });
        });
      });
    });
  }

  function editTarget(root, id) {
    var t = state.targets.find(function (x) { return x.id === id; });
    if (!t) return;
    state.editTarget = id;
    root.querySelector('#pr-t-publication').value = t.publication || '';
    root.querySelector('#pr-t-contact').value = t.contact_name || '';
    root.querySelector('#pr-t-role').value = t.role || '';
    root.querySelector('#pr-t-beat').value = t.beat || '';
    root.querySelector('#pr-t-tier').value = t.tier || 'niche';
    root.querySelector('#pr-t-route').value = t.contact_route || '';
    root.querySelector('#pr-t-source').value = t.source || '';
    root.querySelector('#pr-t-fit').value = t.fit_note || '';
    root.querySelector('#pr-t-verified').checked = !!t.route_verified;
    root.querySelector('[data-pr-target-form-title]').textContent = 'Edit connection';
    root.querySelector('[data-pr-target-cancel]').style.display = '';
  }

  function clearTargetForm(root) {
    state.editTarget = null;
    ['#pr-t-publication', '#pr-t-contact', '#pr-t-role', '#pr-t-beat', '#pr-t-route', '#pr-t-source', '#pr-t-fit']
      .forEach(function (s) { root.querySelector(s).value = ''; });
    root.querySelector('#pr-t-verified').checked = false;
    root.querySelector('[data-pr-target-form-title]').textContent = 'Add a connection';
    root.querySelector('[data-pr-target-cancel]').style.display = 'none';
  }

  function loadReleases(root) {
    var el = root.querySelector('[data-pr-releases]');
    get(API + '/releases').then(function (d) {
      if (!d.ok) { el.innerHTML = '<div class="empty">Failed to load.</div>'; return; }
      state.releases = d.releases || [];
      if (!state.releases.length) {
        el.innerHTML = '<div class="empty">No releases yet. The first one gets written below.</div>';
      } else {
        el.innerHTML = state.releases.map(function (r) {
          return '<div style="border:1px solid var(--border2);border-radius:10px;padding:10px 12px;margin-bottom:8px">' +
            '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><strong>' + esc(r.title) + '</strong>' +
            '<span style="font-size:11px;font-weight:700;color:var(--text2)">' + esc(STATUS_LABEL[r.status] || r.status) + '</span>' +
            (r.subject_line ? '<span style="color:var(--text3);font-size:12px">Subject: ' + esc(r.subject_line) + '</span>' : '') +
            '<span style="margin-left:auto"><button class="btn" data-pr-release-edit="' + r.id + '">Edit</button> ' +
            '<button class="btn" data-pr-release-del="' + r.id + '">Delete</button></div></div>' +
            (r.body ? '<div style="font-size:12px;color:var(--text2);margin-top:6px;white-space:pre-wrap">' + esc(r.body.slice(0, 400)) + (r.body.length > 400 ? '…' : '') + '</div>' : '') +
            '</div>';
        }).join('');
      }
      fillPitchSelects(root);
      el.querySelectorAll('[data-pr-release-edit]').forEach(function (b) {
        b.addEventListener('click', function () { editRelease(root, Number(b.getAttribute('data-pr-release-edit'))); });
      });
      el.querySelectorAll('[data-pr-release-del]').forEach(function (b) {
        b.addEventListener('click', function () {
          if (!confirm('Delete this release? Pitches keep their row but lose the release link.')) return;
          call('DELETE', API + '/releases/' + b.getAttribute('data-pr-release-del')).then(function () { loadAll(root); });
        });
      });
    });
  }

  function editRelease(root, id) {
    var r = state.releases.find(function (x) { return x.id === id; });
    if (!r) return;
    state.editRelease = id;
    root.querySelector('#pr-r-title').value = r.title || '';
    root.querySelector('#pr-r-subject').value = r.subject_line || '';
    root.querySelector('#pr-r-status').value = r.status || 'draft';
    root.querySelector('#pr-r-body').value = r.body || '';
    root.querySelector('[data-pr-release-form-title]').textContent = 'Edit release';
    root.querySelector('[data-pr-release-cancel]').style.display = '';
  }

  function clearReleaseForm(root) {
    state.editRelease = null;
    root.querySelector('#pr-r-title').value = '';
    root.querySelector('#pr-r-subject').value = '';
    root.querySelector('#pr-r-body').value = '';
    root.querySelector('[data-pr-release-form-title]').textContent = 'New release';
    root.querySelector('[data-pr-release-cancel]').style.display = 'none';
  }

  function fillPitchSelects(root) {
    var tSel = root.querySelector('#pr-p-target');
    var rSel = root.querySelector('#pr-p-release');
    if (tSel) {
      tSel.innerHTML = state.targets.filter(function (t) { return t.status === 'active'; })
        .map(function (t) { return '<option value="' + t.id + '">' + esc(t.publication + (t.contact_name ? ' · ' + t.contact_name : '')) + '</option>'; }).join('');
    }
    if (rSel) {
      rSel.innerHTML = '<option value="">No release linked</option>' + state.releases
        .map(function (r) { return '<option value="' + r.id + '">' + esc(r.title) + '</option>'; }).join('');
    }
  }

  function loadPitches(root) {
    var body = root.querySelector('[data-pr-pitches]');
    get(API + '/pitches').then(function (d) {
      if (!d.ok) { body.innerHTML = '<tr><td colspan="8"><div class="empty">Failed to load.</div></td></tr>'; return; }
      state.pitches = d.pitches || [];
      if (!state.pitches.length) {
        body.innerHTML = '<tr><td colspan="8"><div class="empty">No pitches logged yet.</div></td></tr>';
        return;
      }
      body.innerHTML = state.pitches.map(function (p) {
        var statusSel = '<select data-pr-pitch-status="' + p.id + '" style="' + inputCss + '">' +
          PITCH_STATUSES.map(function (s) {
            return '<option value="' + s + '"' + (s === p.status ? ' selected' : '') + '>' + STATUS_LABEL[s] + '</option>';
          }).join('') + '</select>';
        return '<tr style="border-top:1px solid var(--border2)">' +
          '<td style="padding:6px"><strong>' + esc(p.target_publication) + '</strong>' +
          (p.target_contact_name ? '<div style="color:var(--text3);font-size:12px">' + esc(p.target_contact_name) + '</div>' : '') + '</td>' +
          '<td style="padding:6px">' + esc(p.release_title || '') + '</td>' +
          '<td style="padding:6px">' + statusSel + '</td>' +
          '<td style="padding:6px;font-size:12px">' + esc(p.sent_at ? p.sent_at.slice(0, 10) : '') + '</td>' +
          '<td style="padding:6px;font-size:12px">' + esc(p.reply_at ? p.reply_at.slice(0, 10) : '') + '</td>' +
          '<td style="padding:6px"><input type="date" data-pr-pitch-followup="' + p.id + '" value="' + esc(p.follow_up_due ? p.follow_up_due.slice(0, 10) : '') + '" style="' + inputCss + '" /></td>' +
          '<td style="padding:6px;font-size:12px">' + esc(p.notes || '') + '</td>' +
          '<td style="padding:6px"><button class="btn" data-pr-pitch-del="' + p.id + '">Delete</button></td></tr>';
      }).join('');
      body.querySelectorAll('[data-pr-pitch-status]').forEach(function (sel) {
        sel.addEventListener('change', function () {
          call('PATCH', API + '/pitches/' + sel.getAttribute('data-pr-pitch-status'), { status: sel.value })
            .then(function (w) { if (w.ok) loadAll(root); else alert('Status change failed: ' + (w.error || 'unknown')); });
        });
      });
      body.querySelectorAll('[data-pr-pitch-followup]').forEach(function (inp) {
        inp.addEventListener('change', function () {
          call('PATCH', API + '/pitches/' + inp.getAttribute('data-pr-pitch-followup'), { follow_up_due: inp.value || null })
            .then(function (w) { if (!w.ok) alert('Follow-up save failed: ' + (w.error || 'unknown')); });
        });
      });
      body.querySelectorAll('[data-pr-pitch-del]').forEach(function (b) {
        b.addEventListener('click', function () {
          if (!confirm('Delete this pitch row?')) return;
          call('DELETE', API + '/pitches/' + b.getAttribute('data-pr-pitch-del')).then(function () { loadAll(root); });
        });
      });
    });
  }

  function loadSummary(root) {
    return get(API + '/summary').then(function (d) {
      if (d.ok) { state.summary = d.summary; renderCounts(root); }
    });
  }

  function loadAll(root) {
    loadSummary(root);
    loadTargets(root);
    loadReleases(root);
    loadPitches(root);
  }

  function wire(root) {
    root.querySelector('[data-pr-import]').addEventListener('click', function () {
      var note = root.querySelector('[data-pr-import-note]');
      note.textContent = 'Importing…';
      call('POST', API + '/targets/import', {}).then(function (d) {
        if (!d.ok) { note.textContent = 'Import failed: ' + (d.error || 'unknown'); return; }
        var r = d.import || {};
        note.textContent = r.reason === 'file_missing'
          ? 'No connections file found yet. The researched list lands at ' + d.file + ' and imports from here.'
          : r.reason === 'no_house_tenant'
            ? 'No house tenant found to import into.'
            : 'Imported ' + (r.inserted || 0) + ' new connection(s), ' + (r.skipped || 0) + ' already on file, of ' + (r.total || 0) + ' in the list.';
        loadAll(root);
      });
    });
    ['#pr-filter-tier', '#pr-filter-status'].forEach(function (s) {
      root.querySelector(s).addEventListener('change', function () { loadTargets(root); });
    });
    var searchTimer = null;
    root.querySelector('#pr-filter-q').addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { loadTargets(root); }, 250);
    });
    root.querySelector('[data-pr-target-save]').addEventListener('click', function () {
      var payload = {
        publication: root.querySelector('#pr-t-publication').value,
        contact_name: root.querySelector('#pr-t-contact').value,
        role: root.querySelector('#pr-t-role').value,
        beat: root.querySelector('#pr-t-beat').value,
        tier: root.querySelector('#pr-t-tier').value,
        contact_route: root.querySelector('#pr-t-route').value,
        source: root.querySelector('#pr-t-source').value,
        fit_note: root.querySelector('#pr-t-fit').value,
        route_verified: root.querySelector('#pr-t-verified').checked,
      };
      var done = function (w) {
        if (w.ok) { clearTargetForm(root); loadAll(root); }
        else alert('Save failed: ' + (w.error || 'unknown'));
      };
      if (state.editTarget) call('PUT', API + '/targets/' + state.editTarget, payload).then(done);
      else call('POST', API + '/targets', payload).then(done);
    });
    root.querySelector('[data-pr-target-cancel]').addEventListener('click', function () { clearTargetForm(root); });
    root.querySelector('[data-pr-release-save]').addEventListener('click', function () {
      var payload = {
        title: root.querySelector('#pr-r-title').value,
        subject_line: root.querySelector('#pr-r-subject').value,
        status: root.querySelector('#pr-r-status').value,
        body: root.querySelector('#pr-r-body').value,
      };
      var done = function (w) {
        if (w.ok) { clearReleaseForm(root); loadAll(root); }
        else alert('Save failed: ' + (w.error || 'unknown'));
      };
      if (state.editRelease) call('PUT', API + '/releases/' + state.editRelease, payload).then(done);
      else call('POST', API + '/releases', payload).then(done);
    });
    root.querySelector('[data-pr-release-cancel]').addEventListener('click', function () { clearReleaseForm(root); });
    root.querySelector('[data-pr-pitch-save]').addEventListener('click', function () {
      var rel = root.querySelector('#pr-p-release').value;
      var payload = {
        target_id: Number(root.querySelector('#pr-p-target').value),
        release_id: rel ? Number(rel) : null,
        status: root.querySelector('#pr-p-status').value,
        follow_up_due: root.querySelector('#pr-p-followup').value || null,
        notes: root.querySelector('#pr-p-notes').value,
      };
      call('POST', API + '/pitches', payload).then(function (w) {
        if (w.ok) { root.querySelector('#pr-p-notes').value = ''; loadAll(root); }
        else alert('Log failed: ' + (w.error || 'unknown'));
      });
    });
  }

  function init(containerId) {
    var el = document.getElementById(containerId);
    if (!el) return;
    if (el.getAttribute('data-pr-init') === '1') { loadAll(el); return; }
    el.setAttribute('data-pr-init', '1');
    render(el);
  }

  window.PrUI = { init: init };
})();
