'use strict';
/* Shared frontend helpers for D2RM Dashboard auth pages. */
(function () {
  function headers() {
    return { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (e) { /* non-JSON */ }
    return { status: res.status, json };
  }

  function showError(id, msg) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
  }

  function showSuccess(id, msg) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
  }

  function clearAlerts() {
    document.querySelectorAll('.error.show,.success.show').forEach(function (el) {
      el.classList.remove('show');
    });
  }

  /* i18n key map — resolved at call time so the dictionary is loaded. */
  const FRIENDLY = {
    invalid_credentials: 'auth.js.err_invalid_credentials',
    email_unavailable: 'auth.js.err_email_unavailable',
    invalid_email: 'auth.js.err_invalid_email',
    password_too_short: 'auth.js.err_password_too_short',
    invalid_company_name: 'auth.js.err_invalid_company_name',
    invalid_token: 'auth.js.err_invalid_token',
    too_many_requests: 'dash.js.common.too_many_requests',
    csrf_check_failed: 'dash.js.common.csrf_check_failed',
    job_not_found: 'dash.js.common.job_not_found',
    job_not_cancelable: 'dash.js.common.job_not_cancelable',
    invalid_job_id: 'dash.js.common.job_invalid',
  };

  function friendly(err) {
    var key = FRIENDLY[err];
    return key ? MannaI18n.t(key) : MannaI18n.t('dash.js.common.error_generic');
  }

  window.D2RM = { api, showError, showSuccess, clearAlerts, friendly };
})();
