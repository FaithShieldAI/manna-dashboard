'use strict';
/* In-product marketing co-pilot widget (injected into /app). */
(function () {
  var fab = document.getElementById('d2rm-assistant-fab');
  var panel = document.getElementById('d2rm-assistant-panel');
  var msgs = document.getElementById('d2rm-assistant-msgs');
  var form = document.getElementById('d2rm-assistant-form');
  var input = document.getElementById('d2rm-assistant-input');
  var prov = document.getElementById('d2rm-assistant-prov');
  var history = [];
  var greeted = false;

  function H() {
    return { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
  }

  function addMsg(text, cls) {
    var d = document.createElement('div');
    d.className = 'd2rm-msg ' + cls;
    d.textContent = text;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    return d;
  }

  fetch('/api/assistant/status', { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j && j.ok) prov.textContent = j.provider === 'Muse' ? MannaI18n.t('dash.js.scribe.powered_claude') : MannaI18n.t('dash.js.scribe.insights_engine');
    }).catch(function () {});

  fab.addEventListener('click', function () {
    panel.classList.toggle('open');
    if (panel.classList.contains('open') && !greeted) {
      greeted = true;
      addMsg(MannaI18n.t('dash.js.scribe.greeting_widget'), 'bot');
    }
    if (panel.classList.contains('open')) input.focus();
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    addMsg(text, 'user');
    var typing = addMsg(MannaI18n.t('dash.js.common.thinking'), 'bot typing');
    fetch('/api/assistant/chat', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ message: text, history: history.slice(-10) }),
    }).then(function (r) { return r.json(); }).then(function (j) {
      typing.remove();
      if (j && j.ok) {
        addMsg(j.reply, 'bot');
        history.push({ role: 'user', content: text });
        history.push({ role: 'assistant', content: j.reply });
      } else {
        addMsg(MannaI18n.t('dash.js.common.assistant_error'), 'bot');
      }
    }).catch(function () {
      typing.remove();
      addMsg(MannaI18n.t('dash.js.common.network_error'), 'bot');
    });
  });
})();
