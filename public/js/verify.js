'use strict';
(function () {
  var token = new URLSearchParams(window.location.search).get('token') || '';
  var status = document.getElementById('status');
  if (!token) {
    status.textContent = 'No verification token found in this link.';
    D2RM.showError('err', 'Request a new verification email from your account.');
    return;
  }
  D2RM.api('POST', '/api/auth/verify-email', { token: token })
    .then(function (r) {
      if (r.json && r.json.ok) {
        status.textContent = 'Done.';
        D2RM.showSuccess('ok', 'Your email is verified. Welcome aboard.');
      } else {
        status.textContent = 'Verification failed.';
        D2RM.showError('err', D2RM.friendly(r.json && r.json.error));
      }
    }).catch(function () {
      status.textContent = 'Verification failed.';
      D2RM.showError('err', 'Network error. Check your connection and try again.');
    });
})();
