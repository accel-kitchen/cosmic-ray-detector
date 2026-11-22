/* The owner's account page. Everything from the server goes in with textContent. The login token is
 * the one in sessionStorage (this tab only). */
(function () {
  'use strict';
  const { el, api, session, loginForm, explain, showMessage } = CRD;
  const $ = (id) => document.getElementById(id);
  let me = null;

  function fmt(iso) { return iso ? new Date(iso).toLocaleString('ja-JP') : '—'; }
  const STATUS = { active: '有効', pending_email: 'メールの確認待ち', disabled: '停止中', legacy_unclaimed: '旧アカウント' };

  function row(dl, term, value) { dl.appendChild(el('dt', {}, term)); dl.appendChild(el('dd', {}, value)); }

  function render() {
    const dl = $('basic');
    dl.textContent = '';
    row(dl, '局 ID', me.id);
    row(dl, 'メールアドレス（あなただけに見えます）', me.email ? me.email + (me.email_verified ? '（確認済み）' : '（未確認）') : '未登録');
    row(dl, '状態', STATUS[me.status] || me.status);
    row(dl, '登録した日', fmt(me.created_at));
    row(dl, '同意した文面', me.consent_version ? `${me.consent_version}（${fmt(me.consent_at)}）` : '—');

    $('desc').value = me.public_description || '';

    $('listing').textContent = me.listed
      ? '地図に載っています。'
      : (me.listing_needs_approval ? '地図には載っていません。載せるには、運営の確認が必要です（運営にご連絡ください）。' : '地図には載っていません。');
    const lb = $('listbtn');
    if (me.listed) { lb.textContent = '地図から外す'; lb.classList.remove('hidden'); lb.dataset.to = 'off'; }
    else if (!me.listing_needs_approval) { lb.textContent = '地図に載せる'; lb.classList.remove('hidden'); lb.dataset.to = 'on'; }
    else lb.classList.add('hidden');

    const s = me.station;
    $('where').textContent = s.lat == null
      ? '位置: まだ届いていません。Console の「緯度・経度」を入れてログインすると、約 10 km 四方の中心に丸めて保存されます（正確な位置は保存しません）。'
      : `位置: 約 10 km 四方の中心  北緯 ${s.lat}°  東経 ${s.lon}°（丸めた値です）`;
    $('data').textContent = `届いたイベント: ${s.event_count} 件 ／ 最後に届いた時刻: ${fmt(s.last_seen_utc)}`;
  }

  async function loadFiles() {
    const r = await api('/me/events', { auth: true });
    const ul = $('files');
    ul.textContent = '';
    const files = (r.json && r.json.files) || [];
    if (files.length === 0) { ul.appendChild(el('li', {}, 'まだデータがありません。')); return; }
    for (const f of files) {
      const b = el('button', { type: 'button', class: 'secondary' }, 'ダウンロード');
      b.addEventListener('click', () => download(f.name));
      ul.appendChild(el('li', {}, `${f.name}（${Math.max(1, Math.round(f.bytes / 1024))} KB） `, b));
    }
  }

  async function download(name) {
    const s = session();
    const res = await fetch('/me/events/' + encodeURIComponent(name), { headers: { Authorization: 'Bearer ' + s.token }, credentials: 'omit' });
    if (!res.ok) { showMessage($('msg'), 'error', 'ダウンロードできませんでした。'); return; }
    const url = URL.createObjectURL(await res.blob());
    const a = el('a', { href: url, download: s.id + '-' + name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function load() {
    $('gate').classList.add('hidden');
    const r = await api('/me', { auth: true });
    if (r.status === 401) { needLogin(); return; }
    if (!r.ok) { showMessage($('msg'), 'error', explain(r)); return; }
    me = r.json;
    $('acct').classList.remove('hidden');
    render();
    loadFiles();
  }

  function needLogin() {
    $('acct').classList.add('hidden');
    $('gate').classList.remove('hidden');
    loginForm($('loginbox'), () => { CRD.nav(); load(); });
  }

  $('profile').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await api('/me/profile', { method: 'PUT', auth: true, body: { description: $('desc').value } });
    showMessage($('profile-msg'), r.ok ? 'ok' : 'error', r.ok ? '保存しました。' : explain(r));
    if (r.ok) { me.public_description = r.json.public_description; $('desc').value = me.public_description || ''; }
  });

  $('listbtn').addEventListener('click', async () => {
    const on = $('listbtn').dataset.to === 'on';
    const r = await api('/me/profile', { method: 'PUT', auth: true, body: { listed: on } });
    if (r.ok) { me.listed = on; render(); showMessage($('listing-msg'), 'ok', on ? '地図に載せました。' : '地図から外しました。'); }
    else showMessage($('listing-msg'), 'error', explain(r));
  });

  $('pw').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('pw-msg');
    if ($('pw-new').value !== $('pw-new2').value) { showMessage(msg, 'error', '新しいパスワードが 2 回で違います。'); return; }
    $('pw-go').disabled = true;
    const r = await api('/me/password', { method: 'POST', auth: true, body: { password: $('pw-old').value, new_password: $('pw-new').value } });
    $('pw-go').disabled = false;
    if (r.ok) {
      CRD.store.set({ token: r.json.token, id: session().id });      // this session carries on with the new token
      ['pw-old', 'pw-new', 'pw-new2'].forEach((i) => { $(i).value = ''; });
      showMessage(msg, 'ok', 'パスワードを変えました。');
    } else showMessage(msg, 'error', explain(r));
  });

  $('del').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('del-msg');
    if (!$('del-ok').checked) { showMessage(msg, 'error', '確認のチェックを入れてください。'); return; }
    $('del-go').disabled = true;
    const r = await api('/me/delete', { method: 'POST', auth: true, body: { password: $('del-pw').value } });
    $('del-go').disabled = false;
    if (r.ok) { CRD.logout(); $('acct').classList.add('hidden'); showMessage($('msg'), 'ok', 'アカウントを削除しました。ご利用ありがとうございました。'); CRD.nav(); }
    else showMessage(msg, 'error', explain(r));
  });

  if (!session()) needLogin(); else load();
})();
