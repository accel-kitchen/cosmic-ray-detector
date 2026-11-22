/* Sign-up. The form is shown only while registration is open (/config.json). The hidden field
 * "website" is for bots: people never see it, and the server treats anything in it as spam. */
(async function () {
  'use strict';
  const { api, config, explain, showMessage } = CRD;
  const $ = (id) => document.getElementById(id);
  const cfg = await config();

  if (!cfg.registration_open) { $('closed').classList.remove('hidden'); return; }
  $('form').classList.remove('hidden');

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('msg');
    if ($('password').value !== $('password2').value) { showMessage(msg, 'error', '2 回入力したパスワードが違います。'); return; }
    if (!$('consent').checked) { showMessage(msg, 'error', '同意にチェックを入れてください。'); return; }
    $('submit').disabled = true;
    showMessage(msg, 'ok', '送信しています…');
    const r = await api('/auth/register', { method: 'POST', body: {
      id: $('id').value.trim().toLowerCase(),
      email: $('email').value.trim(),
      password: $('password').value,
      consent: true,
      consent_version: cfg.consent_version,
      website: $('website').value,
    } });
    $('submit').disabled = false;
    if (r.ok) {
      $('password').value = ''; $('password2').value = '';
      $('form').classList.add('hidden');
      $('done').classList.remove('hidden');
      showMessage(msg, '', '');
    } else {
      showMessage(msg, 'error', explain(r));
    }
  });
})();
