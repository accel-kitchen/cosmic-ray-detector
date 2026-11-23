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
  let range = null;                       // { from, to } when the person picked dates; otherwise the last `days` days

  // The bar of days with data. Dragging on it picks a period (the same as the date boxes).
  const bar = CRD.rangeBar($('overview'), {
    onSelect: (from, to) => { range = { from, to }; load(); },
    onInfo: (text) => { $('ovinfo').textContent = text || INFO_HINT; },
  });
  const INFO_HINT = '色の付いた日にデータがあります。ドラッグして、表示する期間を選べます。';
  let overviewDone = false;
  async function loadOverview() {
    if (overviewDone) return;
    overviewDone = true;
    const r = await api('/stations/' + encodeURIComponent(id) + '/overview', { auth: true });
    if (!r.ok || !r.json) { overviewDone = false; return; }
    if (bar.load(r.json)) { $('rangebox').classList.remove('hidden'); $('ovinfo').textContent = INFO_HINT; bar.setWindow(onShow.from, onShow.to); }
  }
  let onShow = { from: null, to: null };
  let last = null;                        // the last answer, so a new scale or a resized window redraws without asking again
  let adcBin = 64;                        // the width of one bar of the ADC histogram, in counts
  let yscale = 'auto';                    // 'auto' | 'linear' | 'log'

  const fmtLocal = (ms) => new Date(ms).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  const DAYMS = 86400e3;
  const fmtDay = (ms) => new Date(ms).toLocaleDateString('ja-JP', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' });

  // One point per hour (short windows) or per UTC day (long ones) over the whole window; buckets with no
  // data are gaps (null), not zeros. A long window starts at the first day that has data, so a station
  // that began last spring does not show years of empty axis.
  function timeline(d, key) {
    const pts = [];
    if (d.bucket === 'day') {
      const byDay = new Map(d.daily.map((h) => [h.day, h]));
      if (!d.daily.length) return pts;
      const from = Math.max(Date.parse(d.from), Date.parse(d.daily[0].day));
      for (let t = from; t <= Date.parse(d.to); t += DAYMS) {
        const h = byDay.get(new Date(t).toISOString().slice(0, 10));
        pts.push({ t, y: h && h[key] != null ? h[key] : null });
      }
      return pts;
    }
    const byHour = new Map(d.hourly.map((h) => [h.hour, h]));
    const end = range ? Date.parse(d.to + 'T23:00:00Z') : Math.floor(Date.now() / 3600e3) * 3600e3;
    const start = range ? Date.parse(d.from + 'T00:00:00Z') : end - (d.days * 24 - 1) * 3600e3;
    for (let t = start; t <= end; t += 3600e3) {
      const h = byHour.get(new Date(t).toISOString().slice(0, 13));
      pts.push({ t, y: h && h[key] != null ? h[key] : null });
    }
    return pts;
  }

  function render(d) {
    last = d;
    $('content').classList.remove('hidden');
    $('desc').textContent = d.legacy ? '旧サーバーから引き継いだ観測局です。持ち主の引き継ぎを待っています。' : (d.description || '');
    const [label, cls] = ACTIVITY[d.activity] || ACTIVITY.idle;
    const daily = d.bucket === 'day';
    const stats = $('stats');
    stats.textContent = '';
    const stat = (value, name) => el('div', {}, el('b', {}, value), el('div', { class: 'lead' }, name));
    stats.appendChild(el('div', {}, el('span', { class: 'dot ' + cls }), label));
    stats.appendChild(stat(d.totals.events.toLocaleString('ja-JP'), `期間内のイベント数（${d.from} 〜 ${d.to}）`));
    stats.appendChild(daily ? stat(String(d.totals.days_with_data), 'データのあった日数')
                            : stat(String(d.totals.hours_with_data), 'データのあった時間数'));
    if (d.mine) {
      stats.appendChild(stat(d.last_seen_utc ? fmtLocal(Date.parse(d.last_seen_utc)) : '—', '最後に届いた時刻（あなただけに見えます）'));
      stats.appendChild(stat(d.listed ? '載っている' : '載っていない', '公開地図への掲載'));
    }

    onShow = { from: d.from, to: d.to };
    bar.setWindow(d.from, d.to);
    loadOverview();
    // Buttons and date boxes show what is on the screen now.
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-pressed', String(!range && Number(b.dataset.days) === days)));
    $('from').value = d.from; $('to').value = d.to;
    const note = $('bucketnote');
    note.textContent = daily ? '長い期間なので、1 日（UTC）ごとにまとめて表示しています。1 時間ごとに見るには、31 日以内の期間を選んでください。' : '';
    note.classList.toggle('hidden', !daily);
    $('h-count').textContent = daily ? '1 日あたりのイベント数（UTC の日）' : '1 時間あたりのイベント数';

    const rows = daily ? d.daily : d.hourly;
    const xFormat = daily ? fmtDay : undefined;
    CRD.drawLine($('c-count'), timeline(d, 'count'), { yLabel: daily ? '件 / 日' : '件 / 時間', xFormat, scale: yscale });
    CRD.drawLine($('c-rate'), timeline(d, 'rate_per_min'), { yLabel: '件 / 分', xFormat, scale: yscale });
    CRD.drawLine($('c-temp'), timeline(d, 'temp_c'), { yLabel: '℃', yMin: 'auto', xFormat, scale: yscale === 'log' ? 'linear' : yscale });
    // The bar widths on offer, and the one the answer used (the server falls back to 64 until the narrow
  // bars have been prepared).
  const sel = $('adcbin');
  sel.textContent = '';
  for (const w of d.adc.widths) sel.appendChild(el('option', { value: String(w) }, String(w)));
  sel.value = String(d.adc.bin_width);
  adcBin = d.adc.bin_width;
  $('adcnote').textContent = d.adc.fine_ready ? ' カウントごと' : ' カウントごと（64 より細かい幅は、準備中です）';
  // the horizontal axis ends at the highest bar that holds anything
  let top = d.adc.bins.length - 1;
  while (top > 0 && !d.adc.bins[top]) top--;
  const shownBins = d.adc.bins.slice(0, Math.min(d.adc.bins.length, Math.max(top + 2, 8)));
  CRD.drawBars($('c-adc'), shownBins, { yLabel: '件', labelFor: (i) => String(i * d.adc.bin_width), scale: yscale });

    $('tablesum').textContent = daily ? '数値を表で見る（直近 60 日分）' : '数値を表で見る（直近 48 時間分）';
    const shown = rows.slice(daily ? -60 : -48).reverse();
    const table = el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, ...[daily ? '日（UTC）' : '時刻', 'イベント数', '件/分', '温度 ℃'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...shown.map((h) => el('tr', {},
        el('td', {}, daily ? h.day : fmtLocal(Date.parse(h.hour + ':00:00Z'))),
        el('td', {}, String(h.count)),
        el('td', {}, h.rate_per_min == null ? '—' : h.rate_per_min.toFixed(1)),
        el('td', {}, h.temp_c == null ? '—' : h.temp_c.toFixed(1))))));
    $('table').textContent = '';
    $('table').appendChild(table);
  }

  async function load() {
    $('gate').classList.add('hidden');
    showMessage(msg, 'ok', '読み込んでいます…');
    const q = range ? 'from=' + encodeURIComponent(range.from) + '&to=' + encodeURIComponent(range.to) : 'days=' + days;
    const qs = q + '&adc_bin=' + adcBin;
    const r = await api('/stations/' + encodeURIComponent(id) + '/summary?' + qs, { auth: true });
    if (r.status === 401) { showMessage(msg, '', ''); needLogin(); return; }
    if (!r.ok) {
      showMessage(msg, 'error', r.status === 404 ? 'この観測局は見つかりません（地図に載っていないか、削除されました）。'
        : r.status === 400 ? '期間の指定が正しくありません（開始日が終了日より後、または 10 年を超えています）。' : explain(r));
      return;
    }
    showMessage(msg, '', '');
    render(r.json);
  }

  async function needLogin() {
    $('content').classList.add('hidden');
    $('gate').classList.remove('hidden');
    loginForm($('loginbox'), () => { CRD.nav(); load(); });
    if ((await config()).registration_open) $('regnote').classList.remove('hidden');
  }

  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => { days = Number(b.dataset.days); range = null; load(); }));
  $('range').addEventListener('submit', (e) => {
    e.preventDefault();
    range = { from: $('from').value, to: $('to').value };
    load();
  });
  $('adcbin').addEventListener('change', () => { adcBin = Number($('adcbin').value); load(); });
  $('yscale').addEventListener('change', () => { yscale = $('yscale').value; if (last) render(last); });
  // A resized window only redraws what was already fetched (and waits until the resizing stops).
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (last && !$('content').classList.contains('hidden')) { bar.redraw(); render(last); } }, 150);
  });

  if (!session()) needLogin(); else load();
})();
