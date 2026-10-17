'use strict';
(function () {
  var form = document.getElementById('login-form');
  var btn = document.getElementById('submit');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    D2RM.clearAlerts();
    btn.disabled = true;
    D2RM.api('POST', '/api/auth/login', {
      email: document.getElementById('email').value.trim(),
      password: document.getElementById('password').value,
    }).then(function (r) {
      if (r.json && r.json.ok) {
        window.location.href = '/app';
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
