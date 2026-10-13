'use strict';
/* D2RM Dashboard — guided onboarding page. */
(function () {
  var stepsEl = document.getElementById('steps');
  var barEl = document.getElementById('progress-bar');
  var labelEl = document.getElementById('progress-label');
  var bannerEl = document.getElementById('done-banner');
  var history = [];

  function H() {
    return { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
  }
  function Hget() {
    return { 'X-Requested-With': 'XMLHttpRequest' };
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function api(method, path, body) {
    var opts = { method: method, headers: body !== undefined ? H() : Hget() };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch(path, opts).then(function (r) { return r.json().then(function (j) { return { status: r.status, json: j }; }); });
  }

  function alertBox(parent, kind, text) {
    var d = document.createElement('div');
    d.className = 'alert ' + kind;
    d.textContent = text;
    parent.insertBefore(d, parent.firstChild);
    setTimeout(function () { d.remove(); }, 5000);
  }

  // ------------------------------------------------------------------ chat
  var msgsEl = document.getElementById('chat-msgs');
  var formEl = document.getElementById('chat-form');
  var inputEl = document.getElementById('chat-input');
  var greeted = false;

  function addMsg(text, cls) {
    var d = document.createElement('div');
    d.className = 'd2rm-msg ' + cls;
    d.textContent = text;
    msgsEl.appendChild(d);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return d;
  }

  fetch('/api/assistant/status', { headers: Hget() })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j && j.ok) document.getElementById('chat-prov').textContent = j.provider === 'Muse' ? 'powered by Muse' : 'insights engine';
    }).catch(function () {});

  function greet() {
    if (greeted) return;
    greeted = true;
    addMsg('What do you want to do first, or do you want me to suggest?', 'bot');
  }

  formEl.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    addMsg(text, 'user');
    var typing = addMsg('thinking\u2026', 'bot typing');
    api('POST', '/api/assistant/chat', { message: text, history: history.slice(-10) })
      .then(function (r) {
        typing.remove();
        if (r.json && r.json.ok) {
          addMsg(r.json.reply, 'bot');
          history.push({ role: 'user', content: text });
          history.push({ role: 'assistant', content: r.json.reply });
        } else {
          addMsg('Sorry \u2014 I hit an error. Try again in a moment.', 'bot');
        }
      })
      .catch(function () { typing.remove(); addMsg('Network error. Check your connection.', 'bot'); });
  });

  // ------------------------------------------------------------------ steps
  var PLATFORMS = ['instagram', 'tiktok', 'youtube', 'x', 'facebook'];

  function render(status) {
    var ob = status.onboarding;
    barEl.value = ob.progress_pct;
    labelEl.textContent = ob.progress_pct + '% complete';
    bannerEl.classList.toggle('is-hidden', !ob.is_complete);
    stepsEl.innerHTML = '';
    ob.steps.forEach(function (s, i) {
      var card = document.createElement('div');
      card.className = 'step-card' + (s.done ? ' done' : '') + (ob.current_step === s.id ? ' current' : '');
      var head = document.createElement('div');
      head.className = 'step-head';
      head.innerHTML = '<div class="step-num">' + (s.done ? '✓' : (i + 1)) + '</div><h2>' + esc(s.title) + '</h2>';
      card.appendChild(head);
      var desc = document.createElement('p');
      desc.className = 'step-desc';
      desc.textContent = s.description;
      card.appendChild(desc);
      var body = document.createElement('div');
      body.className = 'step-body';
      renderStepBody(s, body, status);
      card.appendChild(body);
      stepsEl.appendChild(card);
    });
    greet();
  }

  function renderStepBody(step, body, status) {
    if (step.done) {
      var p = document.createElement('p');
      p.className = 'ob-done';
      p.textContent = '✓ Done';
      body.appendChild(p);
      return;
    }
    if (step.id === 'welcome') return renderWelcome(body);
    if (step.id === 'connect_socials') return renderSocials(body);
    if (step.id === 'starter_content') return renderTemplates(body);
    if (step.id === 'first_lead_job') return renderLeadJob(body);
    if (step.id === 'first_campaign') return renderCampaign(body);
  }

  function renderWelcome(body) {
    var p = document.createElement('p');
    p.className = 'ob-p';
    p.textContent = 'This dashboard is your marketing command center: it tracks your sites, email, socials, and goals — plus it collects leads and includes an AI co-pilot. Setup takes about 10 minutes. Let\u2019s go.';
    var btn = document.createElement('button');
    btn.textContent = 'Start setup →';
    btn.addEventListener('click', function () {
      btn.disabled = true;
      api('POST', '/api/onboarding/welcome', {}).then(refresh).catch(function () { btn.disabled = false; });
    });
    body.appendChild(p);
    body.appendChild(btn);
  }

  function renderSocials(body) {
    var list = document.createElement('div');
    list.className = 'pill-list';
    body.appendChild(list);

    var row = document.createElement('div');
    row.className = 'row';
    var sel = document.createElement('select');
    PLATFORMS.forEach(function (pl) {
      var o = document.createElement('option');
      o.value = pl; o.textContent = pl.charAt(0).toUpperCase() + pl.slice(1);
      sel.appendChild(o);
    });
    var handle = document.createElement('input');
    handle.type = 'text'; handle.placeholder = 'handle (without @)'; handle.maxLength = 80;
    var token = document.createElement('input');
    token.type = 'text'; token.placeholder = 'API token (optional)'; handle.maxLength = 80;
    token.maxLength = 4000;
    var add = document.createElement('button');
    add.textContent = 'Connect';
    row.appendChild(sel); row.appendChild(handle); row.appendChild(token); row.appendChild(add);
    body.appendChild(row);
    var hint = document.createElement('p');
    hint.className = 'ob-hint';
    hint.textContent = 'Just the handle is enough to start — a token unlocks live stats later.';
    body.appendChild(hint);

    function load() {
      api('GET', '/api/onboarding/socials').then(function (r) {
        list.innerHTML = '';
        (r.json.socials || []).forEach(function (s) {
          var pill = document.createElement('span');
          pill.className = 'pill';
          pill.innerHTML = esc(s.platform) + ' / @' + esc(s.handle) + (s.has_token ? ' 🔑' : '');
          var x = document.createElement('button');
          x.textContent = '✕';
          x.title = 'Disconnect';
          x.addEventListener('click', function () {
            api('DELETE', '/api/onboarding/socials/' + encodeURIComponent(s.platform)).then(function () { load(); refresh(false); });
          });
          pill.appendChild(x);
          list.appendChild(pill);
        });
      });
    }
    add.addEventListener('click', function () {
      if (!handle.value.trim()) { alertBox(body, 'err', 'Enter a handle first.'); return; }
      add.disabled = true;
      api('POST', '/api/onboarding/socials', {
        platform: sel.value, handle: handle.value.trim(),
        access_token: token.value.trim() || undefined,
      }).then(function (r) {
        add.disabled = false;
        if (r.json && r.json.ok) {
          handle.value = ''; token.value = '';
          alertBox(body, 'ok', 'Connected! 🎉');
          load(); refresh(false);
        } else {
          alertBox(body, 'err', 'Could not connect: ' + ((r.json && r.json.error) || 'error'));
        }
      }).catch(function () { add.disabled = false; alertBox(body, 'err', 'Network error.'); });
    });
    load();
  }

  function renderTemplates(body) {
    var box = document.createElement('div');
    body.appendChild(box);
    var installBtn = document.createElement('button');
    installBtn.textContent = 'Install selected';
    installBtn.className = 'ob-btn-gap';
    var allBtn = document.createElement('button');
    allBtn.textContent = 'Install all';
    allBtn.className = 'ghost';
    body.appendChild(installBtn);
    body.appendChild(allBtn);

    api('GET', '/api/onboarding/templates').then(function (r) {
      if (!r.json || !r.json.ok) return;
      var lib = r.json.library;
      var installed = {};
      (r.json.installed.email || []).forEach(function (t) { installed['e:' + t.template_key] = 1; });
      (r.json.installed.social || []).forEach(function (t) { installed['s:' + t.template_key] = 1; });

      var h = document.createElement('h4');
      h.className = 'ob-h';
      h.textContent = 'Email templates';
      box.appendChild(h);
      lib.email.forEach(function (t) { box.appendChild(tplRow('e:' + t.key, t.name, t.subject, installed)); });
      var h2 = document.createElement('h4');
      h2.className = 'ob-h';
      h2.textContent = 'Social templates';
      box.appendChild(h2);
      lib.social.forEach(function (t) { box.appendChild(tplRow('s:' + t.key, t.name, t.platform, installed)); });

      function selected() {
        var email = [], social = [];
        box.querySelectorAll('input[type=checkbox]:checked').forEach(function (cb) {
          var v = cb.value;
          if (v.indexOf('e:') === 0) email.push(v.slice(2));
          else social.push(v.slice(2));
        });
        return { email: email, social: social };
      }
      installBtn.addEventListener('click', function () {
        var s = selected();
        if (!s.email.length && !s.social.length) { alertBox(body, 'err', 'Pick at least one template.'); return; }
        installBtn.disabled = true;
        api('POST', '/api/onboarding/templates/install', s).then(function (rr) {
          installBtn.disabled = false;
          if (rr.json && rr.json.ok) {
            alertBox(body, 'ok', 'Installed ' + rr.json.installed.email + ' email + ' + rr.json.installed.social + ' social templates.');
            refresh(false);
          } else alertBox(body, 'err', 'Install failed.');
        }).catch(function () { installBtn.disabled = false; });
      });
      allBtn.addEventListener('click', function () {
        allBtn.disabled = true;
        api('POST', '/api/onboarding/templates/install-all', {}).then(function (rr) {
          allBtn.disabled = false;
          if (rr.json && rr.json.ok) {
            alertBox(body, 'ok', 'All starter templates installed.');
            refresh(false);
          } else alertBox(body, 'err', 'Install failed.');
        }).catch(function () { allBtn.disabled = false; });
      });
    });

    function tplRow(value, name, sub, installed) {
      var d = document.createElement('div');
      d.className = 'tpl';
      var lab = document.createElement('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.value = value;
      if (installed[value]) { cb.checked = true; cb.disabled = true; }
      var txt = document.createElement('span');
      txt.innerHTML = '<span class="tname">' + esc(name) + '</span><br><span class="tsub">' + esc(sub) + (installed[value] ? ' — installed ✓' : '') + '</span>';
      lab.appendChild(cb); lab.appendChild(txt);
      d.appendChild(lab);
      return d;
    }
  }

  function renderLeadJob(body) {
    var p = document.createElement('p');
    p.className = 'ob-p';
    p.textContent = 'Enter 2–3 keywords for your niche — the collector finds public channels and pulls contact emails straight into your dashboard.';
    var row = document.createElement('div');
    row.className = 'row';
    var kw = document.createElement('input');
    kw.type = 'text'; kw.placeholder = 'keywords, comma separated (e.g. fitness coach, meal prep)';
    var go = document.createElement('button');
    go.textContent = 'Run lead search';
    row.appendChild(kw); row.appendChild(go);
    var link = document.createElement('p');
    link.className = 'ob-linkline';
    link.innerHTML = 'Or use the full <a href="/leads" class="ob-goldlink">Leads page</a> for seed URLs and job history.';
    body.appendChild(p); body.appendChild(row); body.appendChild(link);
    go.addEventListener('click', function () {
      var keywords = kw.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      if (!keywords.length) { alertBox(body, 'err', 'Enter at least one keyword.'); return; }
      go.disabled = true;
      go.textContent = 'Searching…';
      api('POST', '/api/leads/jobs', { source: 'youtube', keywords: keywords.slice(0, 5), auto_run: true })
        .then(function (r) {
          go.disabled = false; go.textContent = 'Run lead search';
          if (r.json && r.json.ok) {
            var n = (r.json.result && r.json.result.new) || 0;
            alertBox(body, 'ok', 'Search complete — ' + n + ' new leads added to your dashboard!');
            refresh(false);
          } else {
            alertBox(body, 'err', 'Search failed: ' + ((r.json && r.json.error) || 'error'));
          }
        })
        .catch(function () { go.disabled = false; go.textContent = 'Run lead search'; alertBox(body, 'err', 'Network error.'); });
    });
  }

  function renderCampaign(body) {
    var p = document.createElement('p');
    p.className = 'ob-p';
    p.textContent = 'Name your first campaign so every send is tracked from day one.';
    var row = document.createElement('div');
    row.className = 'row';
    var name = document.createElement('input');
    name.type = 'text'; name.placeholder = 'Campaign name (e.g. November launch)'; name.maxLength = 120;
    var prov = document.createElement('select');
    ['ses', 'brevo', 'kit', 'mailerlite', 'other'].forEach(function (v) {
      var o = document.createElement('option');
      o.value = v; o.textContent = v.toUpperCase();
      prov.appendChild(o);
    });
    var go = document.createElement('button');
    go.textContent = 'Create campaign';
    row.appendChild(name); row.appendChild(prov); row.appendChild(go);
    body.appendChild(p); body.appendChild(row);
    go.addEventListener('click', function () {
      if (!name.value.trim()) { alertBox(body, 'err', 'Give the campaign a name.'); return; }
      go.disabled = true;
      api('POST', '/api/email/campaigns', { name: name.value.trim(), provider: prov.value })
        .then(function (r) {
          go.disabled = false;
          if (r.json && r.json.ok) {
            alertBox(body, 'ok', 'Campaign created. Log sends against it from the Email tab.');
            refresh(false);
          } else alertBox(body, 'err', 'Could not create campaign.');
        })
        .catch(function () { go.disabled = false; alertBox(body, 'err', 'Network error.'); });
    });
  }

  // ------------------------------------------------------------------ boot
  function refresh(full) {
    return api('GET', '/api/onboarding/status').then(function (r) {
      if (r.json && r.json.ok) render(r.json);
      else if (r.status === 401) window.location.href = '/login';
    });
  }

  document.getElementById('dismiss-link').addEventListener('click', function (e) {
    e.preventDefault();
    if (!confirm('Skip the guided setup? You can restart it anytime.')) return;
    api('POST', '/api/onboarding/dismiss', {}).then(refresh);
  });
  document.getElementById('restart-link').addEventListener('click', function (e) {
    e.preventDefault();
    api('POST', '/api/onboarding/restart', {}).then(refresh);
  });

  refresh(true);
})();
