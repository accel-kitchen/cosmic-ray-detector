/* Email confirmation. The mailed link carries the token in the #fragment (so it never reaches an
 * access log). The page takes it out of the address bar and history at once, and sends it only
 * when the person presses the button: some mail programs open every link in a message on their own,
 * and that must not be able to confirm anything. */
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
  $('ask').classList.remove('hidden');

  $('go').addEventListener('click', async () => {
    $('go').disabled = true;
    showMessage($('msg'), 'ok', '確認しています…');
    const r = await api('/auth/verify-email', { method: 'POST', body: { token } });
    if (r.ok) {
      $('ask').classList.add('hidden');
      showMessage($('msg'), 'ok', 'メールアドレスを確認しました。登録が完了しました。');
      $('after').classList.remove('hidden');
    } else {
      $('go').disabled = false;
      showMessage($('msg'), 'error', explain(r));
      $('bad').classList.remove('hidden');
    }
  });
})();
