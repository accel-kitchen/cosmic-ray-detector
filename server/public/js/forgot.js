/* Two small forms: ask for a password-reset mail, or ask for the confirmation mail again.
 * The server answers the same whether or not the address is registered, and so does this page. */
(function () {
  'use strict';
  const { api, explain, showMessage } = CRD;
  const $ = (id) => document.getElementById(id);

  function wire(formId, emailId, buttonId, msgId, path) {
    $(formId).addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $(msgId);
      const email = $(emailId).value.trim();
      if (!email) { showMessage(msg, 'error', 'メールアドレスを入れてください。'); return; }
      $(buttonId).disabled = true;
      showMessage(msg, 'ok', '送信しています…');
      const r = await api(path, { method: 'POST', body: { email } });
      $(buttonId).disabled = false;
      if (r.ok) showMessage(msg, 'ok', (r.json && r.json.message_ja) || '送信しました。');
      else showMessage(msg, 'error', explain(r));
    });
  }

  wire('forgot', 'forgot-email', 'forgot-go', 'forgot-msg', '/auth/forgot');
  wire('resend', 'resend-email', 'resend-go', 'resend-msg', '/auth/resend-verify');
})();
