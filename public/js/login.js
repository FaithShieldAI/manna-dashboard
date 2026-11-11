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

/* Show/hide password eye. Lives here, not inline in login.html: the
   Content-Security-Policy (script-src 'self') blocks inline scripts,
   which is why the original in-page toggle never ran. */
(function () {
  var toggle = document.getElementById('toggle-password');
  var pwField = document.getElementById('password');
  if (toggle && pwField) {
    toggle.addEventListener('click', function () {
      var show = pwField.type === 'password';
      pwField.type = show ? 'text' : 'password';
      toggle.textContent = show ? '🙈' : '👁';
      toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
  }
})();
