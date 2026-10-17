'use strict';
(function () {
  document.querySelectorAll('.plan').forEach(function (el) {
    el.addEventListener('click', function () {
      document.querySelectorAll('.plan').forEach(function (p) { p.classList.remove('selected'); });
      el.classList.add('selected');
    });
  });

  var form = document.getElementById('signup-form');
  var btn = document.getElementById('submit');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    D2RM.clearAlerts();
    var plan = (form.querySelector('input[name=plan]:checked') || {}).value || 'starter';
    btn.disabled = true;
    D2RM.api('POST', '/api/auth/register', {
      companyName: document.getElementById('company').value.trim(),
      displayName: document.getElementById('name').value.trim(),
      email: document.getElementById('email').value.trim(),
      password: document.getElementById('password').value,
      plan: plan,
    }).then(function (r) {
      if (r.json && r.json.ok) {
        window.location.href = '/onboarding';
        return;
      }
      var extra = '';
      if (r.json && r.json.error === 'password_too_short') extra = MannaI18n.t('signup.js.err_password_min_suffix', { min: r.json.minLength });
      D2RM.showError('err', D2RM.friendly(r.json && r.json.error) + extra);
      btn.disabled = false;
    }).catch(function () {
      D2RM.showError('err', MannaI18n.t('dash.js.common.network_error'));
      btn.disabled = false;
    });
  });
})();
