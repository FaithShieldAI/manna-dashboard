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
      D2RM.showSuccess('ok', 'If that email is registered, a reset link is on its way. Check your inbox (and spam).');
      btn.disabled = false;
    }).catch(function () {
      D2RM.showError('err', 'Network error. Check your connection and try again.');
      btn.disabled = false;
    });
  });
})();
