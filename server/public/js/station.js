/* One station's graphs. Needs a login (the server answers 401 without one). All text that comes
 * from the server or from users is inserted with textContent. */
(async function () {
  'use strict';
  const { el, api, session, loginForm, explain, config, showMessage, ACTIVITY } = CRD;
  const $ = (id) => document.getElementById(id);
  const id = (new URLSearchParams(location.search).get('id') || '').trim().toLowerCase();
  const msg = $('msg');

  if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(id)) {
    showMessage(msg, 'error', '観測局の ID が正しくありません。地図から選んでください。');
    return;
  }
  $('title').textContent = id;
  document.title = id + ' | 観測局 | CosmicRay 観測ネットワーク';
  let days = 7;

  const fmtLocal = (ms) => new Date(ms).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  // One point per hour over the whole window; hours with no data are gaps (null), not zeros.
  function timeline(hourly, key) {
    const byHour = new Map(hourly.map((h) => [h.hour, h]));
    const end = Math.floor(Date.now() / 3600e3) * 3600e3;
    const pts = [];
    for (let t = end - (days * 24 - 1) * 3600e3; t <= end; t += 3600e3) {
      const h = byHour.get(new Date(t).toISOString().slice(0, 13));
      pts.push({ t, y: h && h[key] != null ? h[key] : null });
    }
    return pts;
  }

  function render(d) {
    $('content').classList.remove('hidden');
    $('desc').textContent = d.legacy ? '旧サーバーから引き継いだ観測局です。持ち主の引き継ぎを待っています。' : (d.description || '');
    const [label, cls] = ACTIVITY[d.activity] || ACTIVITY.idle;
    const stats = $('stats');
    stats.textContent = '';
    const stat = (value, name) => el('div', {}, el('b', {}, value), el('div', { class: 'lead' }, name));
    stats.appendChild(el('div', {}, el('span', { class: 'dot ' + cls }), label));
    stats.appendChild(stat(String(d.totals.events), `期間内のイベント数（${d.days} 日）`));
    stats.appendChild(stat(String(d.totals.hours_with_data), 'データのあった時間数'));
    if (d.mine) {
      stats.appendChild(stat(d.last_seen_utc ? fmtLocal(Date.parse(d.last_seen_utc)) : '—', '最後に届いた時刻（あなただけに見えます）'));
      stats.appendChild(stat(d.listed ? '載っている' : '載っていない', '公開地図への掲載'));
    }
    CRD.drawLine($('c-count'), timeline(d.hourly, 'count'), { yLabel: '件 / 時間' });
    CRD.drawLine($('c-rate'), timeline(d.hourly, 'rate_per_min'), { yLabel: '件 / 分' });
    CRD.drawLine($('c-temp'), timeline(d.hourly, 'temp_c'), { yLabel: '℃', yMin: 'auto' });
    CRD.drawBars($('c-adc'), d.adc.bins, { yLabel: '件', labelFor: (i) => String(i * d.adc.bin_width) });

    const rows = d.hourly.slice(-48).reverse();
    const table = el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, ...['時刻', 'イベント数', '件/分', '温度 ℃'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...rows.map((h) => el('tr', {},
        el('td', {}, fmtLocal(Date.parse(h.hour + ':00:00Z'))),
        el('td', {}, String(h.count)),
        el('td', {}, h.rate_per_min == null ? '—' : h.rate_per_min.toFixed(1)),
        el('td', {}, h.temp_c == null ? '—' : h.temp_c.toFixed(1))))));
    $('table').textContent = '';
    $('table').appendChild(table);
  }

  async function load() {
    $('gate').classList.add('hidden');
    showMessage(msg, 'ok', '読み込んでいます…');
    const r = await api('/stations/' + encodeURIComponent(id) + '/summary?days=' + days, { auth: true });
    if (r.status === 401) { showMessage(msg, '', ''); needLogin(); return; }
    if (!r.ok) { showMessage(msg, 'error', r.status === 404 ? 'この観測局は見つかりません（地図に載っていないか、削除されました）。' : explain(r)); return; }
    showMessage(msg, '', '');
    render(r.json);
  }

  async function needLogin() {
    $('content').classList.add('hidden');
    $('gate').classList.remove('hidden');
    loginForm($('loginbox'), () => { CRD.nav(); load(); });
    if ((await config()).registration_open) $('regnote').classList.remove('hidden');
  }

  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => { days = Number(b.dataset.days); load(); }));
  window.addEventListener('resize', () => { if (!$('content').classList.contains('hidden')) load(); });

  if (!session()) needLogin(); else load();
})();
