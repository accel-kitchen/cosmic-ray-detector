/* Choosing a new password from the mailed link. As on the confirmation page, the token comes from
 * the #fragment and is taken out of the address bar and history straight away. */
(function () {
  'use strict';
  const { api, explain, showMessage } = CRD;
  const $ = (id) => document.getElementById(id);

  const token = new URLSearchParams(location.hash.replace(/^#/, '')).get('token') || '';
  history.replaceState(null, '', location.pathname);

  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) {
    showMessage($('msg'), 'error', 'このリンクは正しくありません。メールのリンクを、そのまま開いてください。');
    $('bad').classList.remove('hidden');
    return;
  }
  $('form').classList.remove('hidden');

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('password').value !== $('password2').value) { showMessage($('msg'), 'error', '2 回入力したパスワードが違います。'); return; }
    $('go').disabled = true;
    showMessage($('msg'), 'ok', '送信しています…');
    const r = await api('/auth/reset', { method: 'POST', body: { token, password: $('password').value } });
    $('go').disabled = false;
    if (r.ok) {
      $('password').value = ''; $('password2').value = '';
      $('form').classList.add('hidden');
      showMessage($('msg'), 'ok', 'パスワードを変えました。');
      $('after').classList.remove('hidden');
      CRD.logout();
    } else {
      showMessage($('msg'), 'error', explain(r));
      if (r.json && r.json.code === 'bad_token') { $('form').classList.add('hidden'); $('bad').classList.remove('hidden'); }
    }
  });
})();
