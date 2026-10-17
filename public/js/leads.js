'use strict';
(function () {
  document.getElementById('back-dash').addEventListener('click', function () { location.href = '/app'; });
  var sourceSel = document.getElementById('source');
  var kwBlock = document.getElementById('kw-block');
  var seedBlock = document.getElementById('seed-block');
  var aiBlock = document.getElementById('ai-block');

  sourceSel.addEventListener('change', function () {
    var v = sourceSel.value;
    kwBlock.classList.toggle('is-hidden', v !== 'youtube');
    seedBlock.classList.toggle('is-hidden', v !== 'weblist');
    aiBlock.classList.toggle('is-hidden', v !== 'aisearch');
  });

  document.getElementById('logout').addEventListener('click', function () {
    D2RM.api('POST', '/api/auth/logout', {}).then(function () { location.href = '/login'; });
  });

  function lines(id) {
    return document.getElementById(id).value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function badge(status) {
    var cls = { queued: 'b-blue', running: 'b-gold', done: 'b-green', failed: 'b-red', canceled: 'b-red' }[status] || 'b-blue';
    return '<span class="badge ' + cls + '">' + status + '</span>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderJobs(jobs) {
    var box = document.getElementById('jobs');
    if (!jobs.length) {
      box.innerHTML = '<p class="small">' + MannaI18n.t('dash.js.leadfinder.no_jobs') + '</p>';
      return;
    }
    box.innerHTML = jobs.map(function (j) {
      var input = j.source === 'youtube'
        ? esc(j.keywords.join(', '))
        : j.source === 'aisearch'
          ? '🤖 ' + esc(j.query || MannaI18n.t('dash.js.leads.ai_search_fallback'))
          : esc(j.seeds.slice(0, 3).join(', ') + (j.seeds.length > 3 ? MannaI18n.t('dash.js.leads.more_seeds', { n: j.seeds.length - 3 }) : ''));
      var stats = (j.status === 'done')
        ? '<span class="small"> ' + MannaI18n.t('dash.js.leads.job_stats_done', { found: j.found_count, new: '<strong class="j-new">' + j.new_count + '</strong>' }) + '</span>'
        : '';
      var err = (j.status === 'failed' && j.error) ? '<div class="small j-err">' + esc(j.error) + '</div>' : '';
      var runBtn = (j.status === 'queued' || j.status === 'failed' || j.status === 'canceled')
        ? '<button class="ghost" data-run="' + j.id + '">' + MannaI18n.t('dash.js.common.btn_run') + '</button>' : '';
      var cancelBtn = (j.status === 'queued')
        ? '<button class="ghost" data-cancel="' + j.id + '">' + MannaI18n.t('dash.js.common.btn_cancel') + '</button>' : '';
      return '<div class="job"><div class="jh"><div><span class="jt">' + esc(j.source) + '</span> ' + badge(j.status) + stats + '</div>'
        + '<div class="row">' + runBtn + cancelBtn + '</div></div>'
        + '<div class="jm">' + MannaI18n.t('dash.js.leads.job_meta', { input: input, max: j.max_results, created: esc(j.created_at || '') }) + '</div>' + err + '</div>';
    }).join('');
    box.querySelectorAll('[data-run]').forEach(function (b) {
      b.addEventListener('click', function () { runJob(b.getAttribute('data-run')); });
    });
    box.querySelectorAll('[data-cancel]').forEach(function (b) {
      b.addEventListener('click', function () { cancelJob(b.getAttribute('data-cancel')); });
    });
  }

  function cancelJob(id) {
    if (!window.confirm(MannaI18n.t('dash.js.leads.confirm_cancel'))) return;
    D2RM.clearAlerts();
    D2RM.api('POST', '/api/leads/jobs/' + id + '/cancel', {}).then(function (r) {
      D2RM.clearAlerts();
      if (r.json && r.json.ok) {
        D2RM.showSuccess('ok', MannaI18n.t('dash.js.leads.job_canceled'));
      } else {
        D2RM.showError('err', D2RM.friendly(r.json && r.json.error));
      }
      loadJobs();
    }).catch(function () {
      D2RM.showError('err', MannaI18n.t('dash.js.leads.network_error_status'));
      loadJobs();
    });
  }

  function loadJobs() {
    D2RM.api('GET', '/api/leads/jobs').then(function (r) {
      if (r.status === 401) { location.href = '/login'; return; }
      renderJobs((r.json && r.json.jobs) || []);
    });
  }

  function runJob(id) {
    D2RM.clearAlerts();
    D2RM.showSuccess('ok', MannaI18n.t('dash.js.leads.job_running'));
    D2RM.api('POST', '/api/leads/jobs/' + id + '/run', {}).then(function (r) {
      D2RM.clearAlerts();
      if (r.json && r.json.ok) {
        D2RM.showSuccess('ok', MannaI18n.t('dash.js.leads.job_done', { found: r.json.found, new: r.json.new }));
      } else {
        D2RM.showError('err', D2RM.friendly(r.json && r.json.error));
      }
      loadJobs();
    }).catch(function () {
      D2RM.showError('err', MannaI18n.t('dash.js.leads.network_error_running'));
      loadJobs();
    });
  }

  function finishRun(btn, r) {
    btn.disabled = false;
    document.getElementById('run-hint').classList.add('is-hidden');
    D2RM.clearAlerts();
    if (r.json && r.json.ok) {
      var res = r.json.result || r.json;
      var msg = MannaI18n.t('dash.js.leads.job_done', { found: res.found || 0, new: res.new || 0 });
      if (res.parsed && res.parsed.business_type) {
        var where = res.parsed.location ? MannaI18n.t('dash.js.leads.searched_in', { location: res.parsed.location }) : '';
        msg = MannaI18n.t('dash.js.leads.searched_for', { query: res.parsed.business_type + where }) + '. ' + msg;
      }
      D2RM.showSuccess('ok', msg);
    } else {
      D2RM.showError('err', D2RM.friendly(r.json && r.json.error));
    }
    loadJobs();
  }

  function failRun(btn) {
    btn.disabled = false;
    document.getElementById('run-hint').classList.add('is-hidden');
    D2RM.showError('err', MannaI18n.t('dash.js.leads.network_error_running'));
    loadJobs();
  }

  document.getElementById('run-job').addEventListener('click', function () {
    D2RM.clearAlerts();
    var btn = this;
    var source = sourceSel.value;
    var maxr = parseInt(document.getElementById('maxr').value, 10);

    // AI search goes straight to its own endpoint (creates + runs the job inline).
    if (source === 'aisearch') {
      var q = document.getElementById('ai-query').value.trim();
      if (!q) {
        D2RM.showError('err', MannaI18n.t('dash.js.leads.err_ai_query'));
        return;
      }
      btn.disabled = true;
      document.getElementById('run-hint').classList.remove('is-hidden');
      D2RM.api('POST', '/api/leads/ai-search', { query: q, max_results: maxr })
        .then(function (r) { finishRun(btn, r); })
        .catch(function () { failRun(btn); });
      return;
    }

    var payload = {
      source: source,
      max_results: maxr,
      auto_run: true,
    };
    if (source === 'youtube') payload.keywords = lines('keywords');
    else payload.seeds = lines('seeds');
    if (source === 'youtube' && !payload.keywords.length) {
      D2RM.showError('err', MannaI18n.t('dash.js.leads.err_keyword'));
      return;
    }
    if (source === 'weblist' && !payload.seeds.length) {
      D2RM.showError('err', MannaI18n.t('dash.js.leads.err_url'));
      return;
    }
    btn.disabled = true;
    document.getElementById('run-hint').classList.remove('is-hidden');
    D2RM.api('POST', '/api/leads/jobs', payload)
      .then(function (r) { finishRun(btn, r); })
      .catch(function () { failRun(btn); });
  });

  loadJobs();
})();
