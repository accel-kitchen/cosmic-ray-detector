/* Shared helpers for every page. Plain script (no modules, no inline code: the CSP is script-src 'self').
 *
 * Rules this file keeps:
 *  - Text from the server or from other people goes in with textContent / createTextNode, never
 *    innerHTML. A station's introduction is written by its owner: treat it as hostile.
 *  - The login token lives in sessionStorage (this tab only) and is sent as a Bearer header.
 *    There are no cookies, so no request is ever authenticated by the browser on its own.
 */
(function () {
  'use strict';

  const KEY = 'crd_session';
  const store = {
    get() { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (_) { return null; } },
    set(v) { try { sessionStorage.setItem(KEY, JSON.stringify(v)); } catch (_) { /* private mode: the session simply does not persist */ } },
    clear() { try { sessionStorage.removeItem(KEY); } catch (_) { /* nothing to do */ } },
  };

  // el('a', { href: '/x', class: 'btn' }, 'text', otherNode): builds DOM, text only.
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      n.appendChild(typeof kid === 'string' || typeof kid === 'number' ? document.createTextNode(String(kid)) : kid);
    }
    return n;
  }

  async function api(path, { method = 'GET', body, auth = false } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const s = store.get();
    if (auth && s && s.token) headers.Authorization = 'Bearer ' + s.token;
    let res;
    try {
      res = await fetch(path, {
        method, headers, credentials: 'omit', cache: 'no-store',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (_) {
      return { ok: false, status: 0, json: null };
    }
    let json = null;
    try { json = await res.json(); } catch (_) { /* no body */ }
    // Only a refused TOKEN ends the session. A 401 for a wrong password (change password, delete account)
    // must not log the person out: they would lose the session they are in the middle of using.
    if (res.status === 401 && auth && json && json.code === 'token_invalid') store.clear();
    return { ok: res.ok, status: res.status, json };
  }

  // Japanese messages for what the server reports.
  function explain(r) {
    if (r.status === 0) return 'サーバーにつながりません。ネットワークを確かめて、もう一度お試しください。';
    const code = r.json && r.json.code;
    if (r.json && r.json.message_ja && r.status !== 429) return r.json.message_ja;   // the server's own wording for this case
    if (r.status === 429 || code === 'rate_limited') return '短い間に試行が重なりました。しばらく待ってから、もう一度お試しください。';
    if (code === 'email_not_verified') return 'メールアドレスの確認がまだです。届いたメールのリンクから確認してください。';
    if (code === 'email_required') return 'この旧アカウントは、メールアドレスの登録が必要です（運営にご連絡ください）。';
    if (code === 'disabled') return 'このアカウントは停止されています。';
    if (code === 'closed') return '現在、新しい登録は受け付けていません。';
    if (r.status === 401) return 'ID またはパスワードが違います。';
    if (r.status === 404) return '見つかりません。';
    return (r.json && r.json.message_ja) || 'うまくいきませんでした。入力を確かめて、もう一度お試しください。';
  }

  async function login(id, password) {
    const r = await api('/auth/login', { method: 'POST', body: { id, password } });
    if (r.ok && r.json && r.json.token) store.set({ token: r.json.token, id: r.json.user.id });
    return r;
  }

  function logout() { store.clear(); }

  function showMessage(container, kind, text) {
    container.textContent = '';
    if (!text) return;
    container.appendChild(el('div', { class: 'msg ' + kind, role: kind === 'error' ? 'alert' : 'status' }, text));
  }

  // A login form inside `container`. onDone() runs after a successful login.
  function loginForm(container, onDone) {
    const msg = el('div');
    const id = el('input', { type: 'text', autocomplete: 'username', required: true, maxlength: 32, 'aria-label': '局 ID' });
    const pw = el('input', { type: 'password', autocomplete: 'current-password', required: true, maxlength: 256, 'aria-label': 'パスワード' });
    const btn = el('button', { type: 'submit' }, 'ログイン');
    const form = el('form', { class: 'stack' },
      el('label', {}, '局 ID', id),
      el('label', {}, 'パスワード', pw),
      el('div', { class: 'row' }, btn, el('a', { href: '/forgot' }, 'パスワードを忘れたとき')),
      msg);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      showMessage(msg, 'ok', 'ログインしています…');
      const r = await login(id.value.trim(), pw.value);
      btn.disabled = false;
      if (r.ok) { pw.value = ''; showMessage(msg, 'ok', ''); onDone(); }
      else showMessage(msg, 'error', explain(r));
    });
    container.textContent = '';
    container.appendChild(form);
  }

  // The top navigation. Shows who is logged in.
  async function nav() {
    const holder = document.getElementById('nav');
    if (!holder) return;
    const s = store.get();
    const links = [el('a', { href: '/' }, '地図')];
    if (s) {
      links.push(el('a', { href: '/account' }, 'アカウント'));
      links.push(el('span', { class: 'who' }, s.id));
      const out = el('a', { href: '#', 'data-act': 'logout' }, 'ログアウト');
      out.addEventListener('click', (e) => { e.preventDefault(); logout(); location.href = '/'; });
      links.push(out);
    } else {
      links.push(el('a', { href: '/account' }, 'ログイン'));
      links.push(el('a', { href: '/register' }, '新規登録'));
    }
    holder.textContent = '';
    links.forEach((l) => holder.appendChild(l));
  }

  let configPromise = null;
  function config() {
    if (!configPromise) configPromise = fetch('/config.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({}));
    return configPromise;
  }

  const ACTIVITY = { today: ['今日データあり', 'today'], week: ['今週データあり', 'week'], idle: ['休止中', 'idle'] };

  // Object.assign: charts.js adds to the same object whichever script runs first.
  window.CRD = Object.assign(window.CRD || {}, { store, el, api, explain, login, logout, loginForm, nav, config,
                                                   showMessage, ACTIVITY, session: () => store.get() });

  document.addEventListener('DOMContentLoaded', nav);
})();
