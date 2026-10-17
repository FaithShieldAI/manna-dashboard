'use strict';
(function () {
  var token = new URLSearchParams(window.location.search).get('token') || '';
  var status = document.getElementById('status');
  if (!token) {
    status.textContent = MannaI18n.t('verify.js.no_token');
    D2RM.showError('err', MannaI18n.t('verify.js.request_new'));
    return;
  }
  D2RM.api('POST', '/api/auth/verify-email', { token: token })
    .then(function (r) {
      if (r.json && r.json.ok) {
        status.textContent = MannaI18n.t('verify.js.done');
        D2RM.showSuccess('ok', MannaI18n.t('verify.js.verified'));
      } else {
        status.textContent = MannaI18n.t('verify.js.failed');
        D2RM.showError('err', D2RM.friendly(r.json && r.json.error));
      }
    }).catch(function () {
      status.textContent = MannaI18n.t('verify.js.failed');
      D2RM.showError('err', MannaI18n.t('dash.js.common.network_error'));
    });
})();
