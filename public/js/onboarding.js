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
      if (j && j.ok) document.getElementById('chat-prov').textContent = j.provider === 'Muse' ? MannaI18n.t('dash.js.scribe.powered_claude') : MannaI18n.t('dash.js.scribe.insights_engine');
    }).catch(function () {});

  function greet() {
    if (greeted) return;
    greeted = true;
    addMsg(MannaI18n.t('dash.js.scribe.greeting'), 'bot');
  }

  formEl.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    addMsg(text, 'user');
    var typing = addMsg(MannaI18n.t('dash.js.common.thinking'), 'bot typing');
    api('POST', '/api/assistant/chat', { message: text, history: history.slice(-10) })
      .then(function (r) {
        typing.remove();
        if (r.json && r.json.ok) {
          addMsg(r.json.reply, 'bot');
          history.push({ role: 'user', content: text });
          history.push({ role: 'assistant', content: r.json.reply });
        } else {
          addMsg(MannaI18n.t('dash.js.common.assistant_error'), 'bot');
        }
      })
      .catch(function () { typing.remove(); addMsg(MannaI18n.t('dash.js.onboarding.network_error_short'), 'bot'); });
  });

  // ------------------------------------------------------------------ steps
  var PLATFORMS = ['instagram', 'tiktok', 'youtube', 'x', 'facebook'];
  /* i18n keys for the platform option labels (replaces code-side capitalization). */
  var PLATFORM_LABELS = {
    instagram: 'dash.js.onboarding.platform_instagram',
    tiktok: 'dash.js.onboarding.platform_tiktok',
    youtube: 'dash.js.onboarding.platform_youtube',
    x: 'dash.js.onboarding.platform_x',
    facebook: 'dash.js.onboarding.platform_facebook',
  };

  function render(status) {
    var ob = status.onboarding;
    barEl.value = ob.progress_pct;
    labelEl.textContent = MannaI18n.t('dash.js.onboarding.progress', { pct: ob.progress_pct });
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
      /* Sticky action bar: wrap the step's trailing action buttons/rows so
         they stay visible (stuck to the viewport bottom) while scrolling
         through long steps. Rebuilt on every render; alerts insert at the
         top of the body and never land inside the bar. */
      (function () {
        var kids = Array.prototype.slice.call(body.children);
        var take = [];
        for (var i = kids.length - 1; i >= 0; i--) {
          var el = kids[i];
          var isAction = el.tagName === 'BUTTON' ||
            (el.classList && (el.classList.contains('row') || el.classList.contains('ob-linkline')));
          if (!isAction) break;
          take.unshift(el);
        }
        if (!take.length) return;
        var bar = document.createElement('div');
        bar.className = 'step-actions';
        body.insertBefore(bar, take[0]);
        take.forEach(function (el) { bar.appendChild(el); });
      })();
      card.appendChild(body);
      stepsEl.appendChild(card);
    });
    greet();
  }

  function renderStepBody(step, body, status) {
    if (step.done) {
      /* Templates step: don't just say "Done" — show where they went, as
         clickable links straight into the dashboard Templates section. */
      if (step.id === 'starter_content') { renderInstalledTemplates(body); return; }
      var p = document.createElement('p');
      p.className = 'ob-done';
      p.textContent = MannaI18n.t('dash.js.onboarding.step_done');
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
    p.textContent = MannaI18n.t('dash.js.onboarding.welcome_text');
    var btn = document.createElement('button');
    btn.textContent = MannaI18n.t('dash.js.onboarding.start_setup');
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
      o.value = pl; o.textContent = MannaI18n.t(PLATFORM_LABELS[pl]);
      sel.appendChild(o);
    });
    var handle = document.createElement('input');
    handle.type = 'text'; handle.placeholder = MannaI18n.t('dash.js.onboarding.social_handle_ph'); handle.maxLength = 80;
    var token = document.createElement('input');
    token.type = 'text'; token.placeholder = MannaI18n.t('dash.js.onboarding.social_token_ph'); handle.maxLength = 80;
    token.maxLength = 4000;
    var add = document.createElement('button');
    add.textContent = MannaI18n.t('dash.js.onboarding.social_connect');
    row.appendChild(sel); row.appendChild(handle); row.appendChild(token); row.appendChild(add);
    body.appendChild(row);
    var hint = document.createElement('p');
    hint.className = 'ob-hint';
    hint.textContent = MannaI18n.t('dash.js.onboarding.social_hint');
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
          x.title = MannaI18n.t('dash.js.onboarding.social_disconnect');
          x.addEventListener('click', function () {
            api('DELETE', '/api/onboarding/socials/' + encodeURIComponent(s.platform)).then(function () { load(); refresh(false); });
          });
          pill.appendChild(x);
          list.appendChild(pill);
        });
      });
    }
    add.addEventListener('click', function () {
      if (!handle.value.trim()) { alertBox(body, 'err', MannaI18n.t('dash.js.onboarding.err_handle')); return; }
      add.disabled = true;
      api('POST', '/api/onboarding/socials', {
        platform: sel.value, handle: handle.value.trim(),
        access_token: token.value.trim() || undefined,
      }).then(function (r) {
        add.disabled = false;
        if (r.json && r.json.ok) {
          handle.value = ''; token.value = '';
          alertBox(body, 'ok', MannaI18n.t('dash.js.onboarding.social_connected'));
          load(); refresh(false);
        } else {
          alertBox(body, 'err', MannaI18n.t('dash.js.onboarding.err_connect', { error: (r.json && r.json.error) || 'error' }));
        }
      }).catch(function () { add.disabled = false; alertBox(body, 'err', MannaI18n.t('dash.js.onboarding.network_error_bare')); });
    });
    load();
  }

  function renderTemplates(body) {
    var box = document.createElement('div');
    body.appendChild(box);
    var installBtn = document.createElement('button');
    installBtn.textContent = MannaI18n.t('dash.js.onboarding.tpl_install_selected');
    installBtn.className = 'ob-btn-gap';
    var allBtn = document.createElement('button');
    allBtn.textContent = MannaI18n.t('dash.js.onboarding.tpl_install_all');
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
      h.textContent = MannaI18n.t('dash.js.onboarding.tpl_email_title');
      box.appendChild(h);
      lib.email.forEach(function (t) { box.appendChild(tplRow('e:' + t.key, t.name, t.subject, installed)); });
      var h2 = document.createElement('h4');
      h2.className = 'ob-h';
      h2.textContent = MannaI18n.t('dash.js.onboarding.tpl_social_title');
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
        if (!s.email.length && !s.social.length) { alertBox(body, 'err', MannaI18n.t('dash.js.onboarding.tpl_err_none')); return; }
        installBtn.disabled = true;
        api('POST', '/api/onboarding/templates/install', s).then(function (rr) {
          installBtn.disabled = false;
          if (rr.json && rr.json.ok) {
            /* Re-render: the step flips to done and shows installed templates
               as clickable links into the Templates section. */
            refresh(false);
          } else alertBox(body, 'err', MannaI18n.t('dash.js.onboarding.tpl_err_install'));
        }).catch(function () { installBtn.disabled = false; });
      });
      allBtn.addEventListener('click', function () {
        allBtn.disabled = true;
        api('POST', '/api/onboarding/templates/install-all', {}).then(function (rr) {
          allBtn.disabled = false;
          if (rr.json && rr.json.ok) {
            /* Re-render: the step flips to done and shows installed templates
               as clickable links into the Templates section. */
            refresh(false);
          } else alertBox(body, 'err', MannaI18n.t('dash.js.onboarding.tpl_err_install'));
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
      txt.innerHTML = '<span class="tname">' + esc(name) + '</span><br><span class="tsub">' + esc(sub) + (installed[value] ? ' ' + MannaI18n.t('dash.js.onboarding.tpl_installed_suffix') : '') + '</span>';
      lab.appendChild(cb); lab.appendChild(txt);
      d.appendChild(lab);
      return d;
    }
  }

  /* Installed templates as clickable deep links into the dashboard
     Templates section (/app#tpl-<key>). Used for the done state of the
     "Install starter templates" step — shows where they went. */
  function renderInstalledTemplates(body) {
    api('GET', '/api/onboarding/templates').then(function (r) {
      if (!r.json || !r.json.ok) return;
      var installed = r.json.installed.email || [];
      var ok = document.createElement('div');
      ok.className = 'alert ok';
      ok.textContent = installed.length
        ? (installed.length === 1
          ? MannaI18n.t('dash.js.onboarding.tpl_installed_one', { n: installed.length })
          : MannaI18n.t('dash.js.onboarding.tpl_installed_many', { n: installed.length }))
        : MannaI18n.t('dash.js.onboarding.tpl_installed_generic');
      body.appendChild(ok);
      var list = document.createElement('div');
      list.className = 'tpl-installed';
      installed.forEach(function (t) {
        var a = document.createElement('a');
        a.className = 'tpl-link';
        a.href = '/app#tpl-' + t.template_key;
        a.textContent = t.name + ' \u2192';
        list.appendChild(a);
      });
      body.appendChild(list);
      var bar = document.createElement('div');
      bar.className = 'step-actions';
      var open = document.createElement('button');
      open.textContent = MannaI18n.t('dash.js.onboarding.tpl_open');
      open.addEventListener('click', function () { window.location.href = '/app#templates'; });
      bar.appendChild(open);
      var more = document.createElement('button');
      more.className = 'ghost';
      more.textContent = MannaI18n.t('dash.js.onboarding.tpl_install_more');
      more.addEventListener('click', function () { body.innerHTML = ''; renderTemplates(body); });
      bar.appendChild(more);
      body.appendChild(bar);
    });
  }

  function renderLeadJob(body) {
    var p = document.createElement('p');
    p.className = 'ob-p';
    p.textContent = MannaI18n.t('dash.js.onboarding.lead_text');
    var row = document.createElement('div');
    row.className = 'row';
    var kw = document.createElement('input');
    kw.type = 'text'; kw.placeholder = MannaI18n.t('dash.js.onboarding.lead_kw_ph');
    var go = document.createElement('button');
    go.textContent = MannaI18n.t('dash.js.onboarding.lead_run');
    row.appendChild(kw); row.appendChild(go);
    var link = document.createElement('p');
    link.className = 'ob-linkline';
    link.innerHTML = MannaI18n.t('dash.js.onboarding.lead_linkline', { leads_tab: '<a href="/app#leads" class="ob-goldlink">' + MannaI18n.t('dash.js.onboarding.lead_link_text') + '</a>' });
    body.appendChild(p); body.appendChild(row); body.appendChild(link);
    go.addEventListener('click', function () {
      var keywords = kw.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      if (!keywords.length) { alertBox(body, 'err', MannaI18n.t('dash.js.leads.err_keyword')); return; }
      go.disabled = true;
      go.textContent = MannaI18n.t('dash.js.onboarding.lead_searching');
      api('POST', '/api/leads/jobs', { source: 'youtube', keywords: keywords.slice(0, 5), auto_run: true })
        .then(function (r) {
          go.disabled = false; go.textContent = MannaI18n.t('dash.js.onboarding.lead_run');
          if (r.json && r.json.ok) {
            var n = (r.json.result && r.json.result.new) || 0;
            alertBox(body, 'ok', MannaI18n.t('dash.js.onboarding.lead_done', { n: n }));
            refresh(false);
          } else {
            alertBox(body, 'err', MannaI18n.t('dash.js.onboarding.lead_failed', { error: (r.json && r.json.error) || 'error' }));
          }
        })
        .catch(function () { go.disabled = false; go.textContent = MannaI18n.t('dash.js.onboarding.lead_run'); alertBox(body, 'err', MannaI18n.t('dash.js.onboarding.network_error_bare')); });
    });
  }

  function renderCampaign(body) {
    var p = document.createElement('p');
    p.className = 'ob-p';
    p.textContent = MannaI18n.t('dash.js.onboarding.campaign_text');
    var row = document.createElement('div');
    row.className = 'row';
    var name = document.createElement('input');
    name.type = 'text'; name.placeholder = MannaI18n.t('dash.js.onboarding.campaign_name_ph'); name.maxLength = 120;
    var prov = document.createElement('select');
    /* i18n keys for the provider option labels (replaces code-side uppercasing). */
    var PROVIDER_LABELS = {
      ses: 'dash.js.onboarding.provider_ses',
      brevo: 'dash.js.onboarding.provider_brevo',
      kit: 'dash.js.onboarding.provider_kit',
      mailerlite: 'dash.js.onboarding.provider_mailerlite',
      other: 'dash.js.onboarding.provider_other',
    };
    ['ses', 'brevo', 'kit', 'mailerlite', 'other'].forEach(function (v) {
      var o = document.createElement('option');
      o.value = v; o.textContent = MannaI18n.t(PROVIDER_LABELS[v]);
      prov.appendChild(o);
    });
    var go = document.createElement('button');
    go.textContent = MannaI18n.t('dash.js.onboarding.campaign_create');
    row.appendChild(name); row.appendChild(prov); row.appendChild(go);
    body.appendChild(p); body.appendChild(row);
    go.addEventListener('click', function () {
      if (!name.value.trim()) { alertBox(body, 'err', MannaI18n.t('dash.js.onboarding.campaign_err_name')); return; }
      go.disabled = true;
      api('POST', '/api/email/campaigns', { name: name.value.trim(), provider: prov.value })
        .then(function (r) {
          go.disabled = false;
          if (r.json && r.json.ok) {
            alertBox(body, 'ok', MannaI18n.t('dash.js.onboarding.campaign_created'));
            refresh(false);
          } else alertBox(body, 'err', MannaI18n.t('dash.js.onboarding.campaign_err_create'));
        })
        .catch(function () { go.disabled = false; alertBox(body, 'err', MannaI18n.t('dash.js.onboarding.network_error_bare')); });
    });
  }

  // ------------------------------------------------------------------ key numbers
  /* Populate the Key Numbers 4-col grid from /api/overview so the cards show
     live values + D2RM-style color graph bars instead of static dashes. */
  function fmt(n) {
    return Number(n || 0).toLocaleString('en-US');
  }
  function loadKeyNumbers() {
    api('GET', '/api/overview').then(function (r) {
      if (!r.json || !r.json.ok) return;
      var j = r.json;
      var vals = {
        sent:        j.email.sent,
        opens:       j.email.opens,
        clicks:      j.email.clicks,
        warm:        j.email.warmTotal,
        influencers: j.counts.influencers,
        sites:       j.counts.sites,
        ip:          j.counts.ipAssets,
        social:      j.counts.socialAccounts,
      };
      var subs = {
        sent:        vals.sent ? MannaI18n.t('dash.js.onboarding.sub_sent', { n: fmt(vals.sent) }) : MannaI18n.t('dash.js.common.no_sends_yet'),
        opens:       vals.sent ? MannaI18n.t('dash.js.common.open_rate_pct', { rate: j.email.openRate }) : MannaI18n.t('dash.js.common.open_rate'),
        clicks:      vals.sent ? MannaI18n.t('dash.js.common.click_rate_pct', { rate: j.email.clickRate }) : MannaI18n.t('dash.js.common.click_rate'),
        warm:        vals.warm ? MannaI18n.t('dash.js.onboarding.sub_warm', { n: fmt(vals.warm) }) : MannaI18n.t('dash.js.onboarding.sub_warm_empty'),
        influencers: MannaI18n.t('dash.js.onboarding.sub_influencers'),
        sites:       vals.sites ? MannaI18n.t('dash.js.onboarding.sub_sites', { n: fmt(vals.sites) }) : MannaI18n.t('dash.js.onboarding.sub_sites_empty'),
        ip:          vals.ip ? MannaI18n.t('dash.js.onboarding.sub_ip', { n: fmt(vals.ip) }) : MannaI18n.t('dash.js.onboarding.sub_ip_empty'),
        social:      vals.social ? MannaI18n.t('dash.js.onboarding.sub_social', { n: fmt(vals.social) }) : MannaI18n.t('dash.js.onboarding.sub_social_empty'),
      };
      /* Color graph bars: each bar shows the metric relative to the largest
         Key Number, so the grid reads as a visual graph like D2RM's. */
      var max = 1;
      Object.keys(vals).forEach(function (k) { if (vals[k] > max) max = vals[k]; });
      Object.keys(vals).forEach(function (k) {
        var vEl = document.querySelector('[data-kn="' + k + '"]');
        if (vEl) vEl.textContent = fmt(vals[k]);
        var sEl = document.querySelector('[data-kn-sub="' + k + '"]');
        if (sEl) sEl.textContent = subs[k];
        var bEl = document.querySelector('[data-kn-bar="' + k + '"]');
        if (bEl) {
          var pct = max > 0 ? (100 * vals[k] / max) : 0;
          bEl.style.width = (Math.round(pct * 10) / 10) + '%';
          bEl.title = fmt(vals[k]);
        }
      });
    }).catch(function () {});
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
    if (!confirm(MannaI18n.t('dash.js.onboarding.confirm_skip'))) return;
    api('POST', '/api/onboarding/dismiss', {}).then(refresh);
  });
  document.getElementById('restart-link').addEventListener('click', function (e) {
    e.preventDefault();
    api('POST', '/api/onboarding/restart', {}).then(refresh);
  });

  refresh(true);
  loadKeyNumbers();
})();
