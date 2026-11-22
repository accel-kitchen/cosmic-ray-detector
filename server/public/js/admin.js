/* The operator page. Plain script, no inline code (CSP: script-src 'self').
 *
 * - Its own session key: an operator login is never mixed with a station login (common.js uses another key).
 * - Everything that came from the server, above all a station's introduction text, goes in with
 *   textContent (CRD.el). Nothing is ever inserted as markup.
 * - The e-mail address appears only in the detail panel; opening the panel is recorded on the server.
 */
(function () {
  'use strict';
  const { el, showMessage } = window.CRD;
  const $ = (id) => document.getElementById(id);

  const KEY = 'crd_admin_session';
  const sess = {
    get() { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (_) { return null; } },
    set(v) { try { sessionStorage.setItem(KEY, JSON.stringify(v)); } catch (_) { /* no storage: the login just does not persist */ } },
    clear() { try { sessionStorage.removeItem(KEY); } catch (_) { /* nothing to do */ } },
  };

  async function api(path, { method = 'GET', body } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const s = sess.get();
    if (s && s.token) headers.Authorization = 'Bearer ' + s.token;
    let res;
    try {
      res = await fetch('/admin-api' + path, { method, headers, credentials: 'omit', cache: 'no-store',
                                               body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (_) { return { ok: false, status: 0, json: null }; }
    let json = null;
    try { json = await res.json(); } catch (_) { /* no body */ }
    if (res.status === 401 && json && json.code === 'token_invalid') { sess.clear(); showGate('ログインの有効期限が切れました。もう一度ログインしてください。'); }
    return { ok: res.ok, status: res.status, json };
  }
  const say = (r) => (r.status === 0 ? 'サーバーにつながりません。'
    : r.status === 429 ? '短い間に試行が重なりました。しばらく待ってからお試しください。'
    : (r.json && r.json.message_ja) || 'うまくいきませんでした。');

  const STATUS = { active: '利用中', pending_email: 'メール未確認', legacy_unclaimed: '旧アカウント', disabled: '停止中' };
  const ACTION = {
    'admin-login': 'ログイン', 'admin-login-failed': 'ログインの失敗', 'view-detail': '詳細を見た（メールアドレスを表示）',
    'list-on': '地図に載せた', 'list-off': '地図から外した（保留）', 'hide-description': '自己紹介を隠した', 'show-description': '自己紹介を表示した',
    'disable': '停止した', 'enable': '停止を解いた', 'delete': '削除した', 'admin-create': '運営アカウントを作った',
    'admin-password': '運営のパスワードを変えた', 'admin-disable': '運営アカウントを止めた', 'admin-enable': '運営アカウントを再開した',
  };
  const when = (iso) => (iso ? iso.replace('T', ' ').slice(0, 16) + ' UTC' : '—');

  // ---- gate / app ------------------------------------------------------------------------
  function showGate(text) {
    $('app').classList.add('hidden');
    $('gate').classList.remove('hidden');
    showMessage($('login-msg'), text ? 'error' : 'ok', text || '');
  }

  async function showApp() {
    const s = sess.get();
    $('gate').classList.add('hidden');
    $('app').classList.remove('hidden');
    $('who').textContent = 'ログイン中: ' + s.name;
    await loadList(true);
  }

  $('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('a-go'); btn.disabled = true;
    showMessage($('login-msg'), 'ok', 'ログインしています…');
    const r = await api('/login', { method: 'POST', body: { name: $('a-name').value.trim(), password: $('a-pw').value } });
    btn.disabled = false;
    if (r.ok && r.json.token) { $('a-pw').value = ''; sess.set({ token: r.json.token, name: r.json.name }); showMessage($('login-msg'), 'ok', ''); showApp(); }
    else showMessage($('login-msg'), 'error', say(r));
  });

  $('logout').addEventListener('click', () => { sess.clear(); $('detail').classList.add('hidden'); showGate(''); });

  // ---- tabs ------------------------------------------------------------------------------
  function tab(which) {
    $('pane-list').classList.toggle('hidden', which !== 'list');
    $('pane-audit').classList.toggle('hidden', which !== 'audit');
    $('tab-list').classList.toggle('secondary', which !== 'list');
    $('tab-audit').classList.toggle('secondary', which !== 'audit');
    if (which === 'audit') loadAudit();
  }
  $('tab-list').addEventListener('click', () => tab('list'));
  $('tab-audit').addEventListener('click', () => tab('audit'));

  // ---- the list --------------------------------------------------------------------------
  let query = ''; let offset = 0; let shown = [];

  function badge(text, cls) { return el('span', { class: 'badge ' + (cls || '') }, text); }

  function row(s) {
    const open = el('a', { href: '#', 'data-id': s.id }, s.id);
    open.addEventListener('click', (e) => { e.preventDefault(); openDetail(s.id); });
    const map = s.admin_hold ? badge('運営が外した', 'warn') : (s.listed ? badge('掲載中', 'ok') : badge('掲載なし'));
    return el('tr', {},
      el('td', {}, open),
      el('td', {}, STATUS[s.status] || s.status),
      el('td', {}, map, s.description_hidden ? badge('紹介文を隠し中', 'warn') : null),
      el('td', {}, s.has_email ? (s.verified ? '確認済み' : '未確認') : '—'),
      el('td', {}, String(s.events)),
      el('td', {}, when(s.last_seen_utc)),
      el('td', {}, when(s.created_at)));
  }

  function renderTable() {
    const t = $('stations');
    t.textContent = '';
    t.appendChild(el('thead', {}, el('tr', {}, ...['局 ID', '状態', '地図', 'メール', 'イベント数', '最終受信', '登録'].map((h) => el('th', {}, h)))));
    t.appendChild(el('tbody', {}, shown.map(row)));
  }

  async function loadList(reset) {
    if (reset) { offset = 0; shown = []; }
    const r = await api(`/stations?q=${encodeURIComponent(query)}&limit=100&offset=${offset}`);
    if (!r.ok) { showMessage($('msg'), 'error', say(r)); return; }
    showMessage($('msg'), 'ok', '');
    shown = shown.concat(r.json.stations);
    offset = shown.length;
    $('count').textContent = `${r.json.total} 件中 ${shown.length} 件を表示`;
    $('more').classList.toggle('hidden', shown.length >= r.json.total);
    renderTable();
  }
  $('more').addEventListener('click', () => loadList(false));
  $('search').addEventListener('submit', (e) => { e.preventDefault(); query = $('q').value.trim().toLowerCase(); loadList(true); });

  // ---- one station -------------------------------------------------------------------------
  async function openDetail(id) {
    const r = await api('/stations/' + encodeURIComponent(id));
    const box = $('detail');
    box.classList.remove('hidden');
    box.textContent = '';
    if (!r.ok) { box.appendChild(el('div', { class: 'msg error' }, say(r))); return; }
    const d = r.json;
    const dl = el('dl', {});
    const add = (k, v) => { dl.appendChild(el('dt', {}, k)); dl.appendChild(el('dd', {}, v == null || v === '' ? '—' : v)); };
    add('局 ID', d.id);
    add('状態', (STATUS[d.status] || d.status) + (d.status === 'disabled' && d.previous_status ? `（停止前: ${STATUS[d.previous_status] || d.previous_status}）` : ''));
    add('メールアドレス', d.email ? d.email + (d.email_verified_at ? '（確認済み）' : '（未確認）') : '（登録なし）');
    add('登録', `${when(d.created_at)} ・ 経路: ${d.via}`);
    add('同意', d.consent_version ? `${d.consent_version}（${when(d.consent_at)}）` : null);
    add('位置（約 10 km の格子の中心）', d.position ? `${d.position.lat}, ${d.position.lon}` : '未送信');
    add('地図', d.admin_hold ? '運営が外している（本人は戻せません）' : (d.listed ? '載っている' : '載っていない'));
    add('自己紹介', d.public_description + (d.description_hidden ? '  ［他の人には隠している］' : ''));
    add('イベント数', String(d.events));
    add('最終受信', when(d.last_seen_utc));
    box.appendChild(el('h2', {}, '局の詳細'));
    box.appendChild(dl);

    const msg = el('div');
    const act = (label, cls, ask, path, body) => {
      const b = el('button', { type: 'button', class: cls || 'secondary' }, label);
      b.addEventListener('click', async () => {
        if (ask && !window.confirm(ask)) return;
        b.disabled = true;
        const res = await api(`/stations/${encodeURIComponent(d.id)}/${path}`, { method: 'POST', body });
        b.disabled = false;
        if (res.ok) { await loadList(true); await openDetail(d.id); }
        else showMessage(msg, 'error', say(res));
      });
      return b;
    };
    const on = d.listed && !d.admin_hold;
    box.appendChild(el('div', { class: 'row' },
      on ? act('地図から外す（本人は戻せません）', 'secondary', `${d.id} を地図から外します。本人は、自分では戻せなくなります。よろしいですか？`, 'list', { listed: false })
         : act('地図に載せる', 'secondary', null, 'list', { listed: true }),
      d.description_hidden ? act('自己紹介を表示する', 'secondary', null, 'description', { hidden: false })
                           : act('自己紹介を隠す', 'secondary', null, 'description', { hidden: true }),
      d.status === 'disabled' ? act('停止を解く', 'secondary', null, 'status', { active: true })
                              : act('停止する', 'danger', `${d.id} のログインとアップロードを止めます。よろしいですか？`, 'status', { active: false })));
    box.appendChild(msg);
    box.scrollIntoView({ block: 'nearest' });
  }

  // ---- the audit log ------------------------------------------------------------------------
  async function loadAudit() {
    const r = await api('/audit?limit=200');
    const t = $('audit');
    t.textContent = '';
    if (!r.ok) { showMessage($('msg'), 'error', say(r)); return; }
    t.appendChild(el('thead', {}, el('tr', {}, ...['時刻', '誰が', '何を', '局', '内容'].map((h) => el('th', {}, h)))));
    t.appendChild(el('tbody', {}, r.json.entries.map((e) => el('tr', {},
      el('td', {}, when(e.at)), el('td', {}, e.actor === 'cli' ? 'サーバーのコマンド' : e.actor), el('td', {}, ACTION[e.action] || e.action), el('td', {}, e.target || '—'), el('td', {}, e.detail || '—')))));
  }

  // ---- start ---------------------------------------------------------------------------------
  if (sess.get()) showApp(); else showGate('');
})();
