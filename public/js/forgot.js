'use strict';
(function () {
  var form = document.getElementById('forgot-form');
  var btn = document.getElementById('submit');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    D2RM.clearAlerts();
    btn.disabled = true;
    D2RM.api('POST', '/api/auth/forgot-password', {
      email: document.getElementById('email').value.trim(),
    }).then(function () {
      // Always the same message — the API never reveals whether the email exists.
      D2RM.showSuccess('ok', MannaI18n.t('forgot.js.reset_sent'));
      btn.disabled = false;
    }).catch(function () {
      D2RM.showError('err', MannaI18n.t('dash.js.common.network_error'));
      btn.disabled = false;
    });
  });
})();
