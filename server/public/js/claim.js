/* Taking over a station that came from the old server, with the link an operator mailed. As on the reset page,
 * the token comes from the #fragment and is taken out of the address bar and history straight away. Opening
 * /claim without a link (the Console's "register an email address first" message points here) only explains. */
(async function () {
  'use strict';
  const { api, config, explain, showMessage } = CRD;
  const $ = (id) => document.getElementById(id);

  const token = new URLSearchParams(location.hash.replace(/^#/, '')).get('token') || '';
  history.replaceState(null, '', location.pathname);

  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) {
    showMessage($('msg'), 'error', 'このページは、運営から届いたメールのリンクから開きます。');
    $('bad').classList.remove('hidden');
    return;
  }
  const cfg = await config();
  $('form').classList.remove('hidden');

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('password').value !== $('password2').value) { showMessage($('msg'), 'error', '2 回入力したパスワードが違います。'); return; }
    if (!$('consent').checked) { showMessage($('msg'), 'error', '同意にチェックを入れてください。'); return; }
    $('go').disabled = true;
    showMessage($('msg'), 'ok', '送信しています…');
    const r = await api('/auth/claim', { method: 'POST', body: {
      token, password: $('password').value, consent: true, consent_version: cfg.consent_version,
    } });
    $('go').disabled = false;
    if (r.ok) {
      $('password').value = ''; $('password2').value = '';
      $('form').classList.add('hidden');
      showMessage($('msg'), 'ok', `局「${r.json.id}」を引き継ぎました。`);
      $('after').classList.remove('hidden');
    } else {
      showMessage($('msg'), 'error', explain(r));
      if (r.json && r.json.code === 'bad_token') { $('form').classList.add('hidden'); $('bad').classList.remove('hidden'); }
    }
  });
})();
