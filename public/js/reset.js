'use strict';
(function () {
  var token = new URLSearchParams(window.location.search).get('token') || '';
  var form = document.getElementById('reset-form');
  var btn = document.getElementById('submit');
  if (!token) {
    D2RM.showError('err', MannaI18n.t('reset.js.missing_token'));
    btn.disabled = true;
    return;
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    D2RM.clearAlerts();
    var p1 = document.getElementById('password').value;
    var p2 = document.getElementById('password2').value;
    if (p1 !== p2) {
      D2RM.showError('err', MannaI18n.t('reset.js.passwords_mismatch'));
      return;
    }
    btn.disabled = true;
    D2RM.api('POST', '/api/auth/reset-password', { token: token, password: p1 })
      .then(function (r) {
        if (r.json && r.json.ok) {
          D2RM.showSuccess('ok', MannaI18n.t('reset.js.password_updated'));
          form.style.display = 'none';
          return;
        }
        D2RM.showError('err', D2RM.friendly(r.json && r.json.error));
        btn.disabled = false;
      }).catch(function () {
        D2RM.showError('err', MannaI18n.t('dash.js.common.network_error'));
        btn.disabled = false;
      });
  });
})();
