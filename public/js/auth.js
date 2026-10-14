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

  const FRIENDLY = {
    invalid_credentials: 'Wrong email or password.',
    email_unavailable: 'That email is already registered. Try logging in.',
    invalid_email: 'Enter a valid email address.',
    password_too_short: 'Password must be at least 12 characters.',
    invalid_company_name: 'Enter your company or project name.',
    invalid_token: 'That link is invalid or expired. Request a new one.',
    too_many_requests: 'Too many attempts — wait a few minutes and try again.',
    csrf_check_failed: 'Security check failed. Reload the page and try again.',
    job_not_found: 'Job not found — refresh the page.',
    job_not_cancelable: 'That job can no longer be canceled.',
    invalid_job_id: 'Invalid job.',
  };

  function friendly(err) {
    return FRIENDLY[err] || 'Something went wrong. Please try again.';
  }

  window.D2RM = { api, showError, showSuccess, clearAlerts, friendly };
})();
