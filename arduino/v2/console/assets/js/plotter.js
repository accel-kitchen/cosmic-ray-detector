// CosmicRay Recorder - plotter (解析)
//
// arduino/plotter.html の解析をこのコンソールの見た目に移したもの。計算（ヒストグラム、
// バックグラウンドの差し引き、cosⁿθ フィット、ガウス近似のピーク補正、最小二乗の校正）は
// 元のまま。変えたのは次の点だけ:
//   - 文言を日本語 / 英語にした（言語の選択は記録のページと同じ localStorage 'uiLang'）。
//   - グラフの色と文字をコンソールに合わせた（themed()）。
//   - 読み込むファイルの列を見出しの行から見つけるようにした（v2 の .dat / .csv、v1 のページの
//     .dat、microSD のログを読める）。
//   - alert() をやめて、その場に出す文言にした。

'use strict';

// ========== Text ==========
const I18N = {
  ja: {
    'app.title': '解析 — CosmicRay Recorder',
    'nav.label': 'ページ',
    'nav.record': '記録',
    'nav.plotter': '解析',
    'nav.manual': 'マニュアル',
    'head.eyebrow': '保存したデータの解析',
    'head.title': '解析',
    'head.lead': '記録のページで保存した .dat / .csv を読み込みます。ファイルはこのパソコンの中だけで読み、どこにも送りません。',
    'tab.hist': 'ADC ヒストグラム',
    'tab.zenith': '天頂角分布',
    'tab.cal': 'エネルギー校正',
    'common.choose': 'ファイルを選ぶ',
    'common.noFile': '未選択',
    'common.optional': '任意',
    'common.auto': '自動',
    'common.end': '最後',
    'common.logY': '縦軸を対数に',
    'common.zoomHint': 'ドラッグで範囲を拡大・ホイールで拡大縮小・ダブルクリックで全体',
    'common.counts': 'イベント数',
    'common.countsLog': 'イベント数（対数）',
    'common.adc': 'ADC 値',
    'common.energy': 'エネルギー [keV]',
    'file.loaded': '{name}（{n} 件）',
    'file.none': '{name} — 読める行がありませんでした',
    'file.v1': 'v1 の形式',
    'file.sessions': '{n} 回の測定を含む（時間は足し合わせ）',
    'file.skipped': '{n} 行は ADC が 0〜{max} の外なので除外',
    'hist.dataTitle': 'データと表示の範囲',
    'hist.file': '測定データ',
    'hist.binWidth': 'ビン幅',
    'hist.adcMin': 'ADC 下限',
    'hist.adcMax': 'ADC 上限',
    'hist.timeFrom': '開始 [s]',
    'hist.timeTo': '終了 [s]',
    'hist.duration': '（0〜{s} s）',
    'hist.bgFile': 'バックグラウンド',
    'hist.noBg': 'なし',
    'hist.bgScale': 'BG の倍率',
    'hist.subtract': 'バックグラウンドを引く',
    'hist.useKeV': '横軸を keV に（校正を使う）',
    'hist.count': 'イベント数',
    'hist.mean': '平均 ADC',
    'hist.median': '中央値 ADC',
    'hist.std': '標準偏差',
    'hist.meanKeV': '平均 [keV]',
    'hist.medianKeV': '中央値 [keV]',
    'hist.stdKeV': '標準偏差 [keV]',
    'hist.plotTitle': 'エネルギー分布',
    'hist.empty': '測定データのファイルを選ぶと、ここにヒストグラムが出ます',
    'hist.trEvents': 'イベント',
    'hist.trSub': '差し引き（S − BG）',
    'hist.trSignal': '測定',
    'hist.trBg': 'バックグラウンド ×{s}',
    'hist.hover': 'イベント数',
    'zen.dataTitle': '角度ごとのカウントレート',
    'zen.dataSub': '検出器を傾けて測ったレートを入れてください。誤差は計数の統計誤差（√N）から計算します。',
    'zen.measTime': '1 角度あたりの測定時間 [s]',
    'zen.rate': 'R(θ) [回/秒]',
    'zen.fit': 'cosⁿθ でフィット',
    'zen.needData': 'R(0°) に 0 より大きい値を入れ、ほかの角度も 1 つ以上入れてください。',
    'zen.empty': 'R(0°) と、ほかの角度を 1 つ以上入れてください',
    'zen.logSub': '傾きが n',
    'zen.trMeasured': '測定',
    'zen.trFit': 'フィット: cos^{n}(θ)',
    'zen.trFitLog': 'フィット: 傾き n = {n}',
    'cal.srcTitle': '校正用の線源',
    'cal.srcSub': '線源を置いて測ったファイルを読み込み、下の表で各ピークを指定します。',
    'cal.file': '線源の測定データ',
    'cal.source': '線源',
    'cal.srcTh': 'Th-232（トリウム系列）',
    'cal.loadLines': '線源のピークを入れる',
    'cal.specTitle': 'スペクトル',
    'cal.specSub': '表で行を選んでからピークをクリックすると、その行の Peak ADC に入ります（ガウス近似でビンより細かく補正）。',
    'cal.autoPeaks': 'ピークを自動で探す',
    'cal.clearPeaks': '候補を消す',
    'cal.peaksHint': '候補（▼）をクリックしても、選んでいる行に入ります。',
    'cal.empty': '校正用のファイルを読み込んでください',
    'cal.noPeaks': 'ピークが見つかりませんでした',
    'cal.needFile': '先に校正用のファイルを読み込んでください。',
    'cal.tableTitle': '校正点（ADC ↔ keV）',
    'cal.tableSub': '「使う」にチェックがあり、keV と Peak ADC が入っている行で最小二乗フィットします（1 次は 2 点、2 次は 3 点以上）。',
    'cal.thArm': '選択',
    'cal.thUse': '使う',
    'cal.thLine': '核種 / ライン',
    'cal.thKev': 'エネルギー [keV]',
    'cal.thResid': '残差 [keV]',
    'cal.thResol': '分解能',
    'cal.addRow': '行を足す',
    'cal.remove': 'この行を消す',
    'cal.model': 'フィットの式',
    'cal.linear': '1 次　E = a·ADC + b',
    'cal.quadratic': '2 次　E = a·ADC² + b·ADC + c',
    'cal.need': 'ピークを {n} 点以上（keV と Peak ADC）入れてください（{kind}のフィット）',
    'cal.kindLinear': '1 次',
    'cal.kindQuad': '2 次',
    'cal.warnMono': '⚠ データの範囲で校正が単調ではありません',
    'cal.warnSlope': '⚠ 傾きが物理的にありえません（点を確かめてください）',
    'cal.fitTitle': '校正の直線（keV vs ADC）',
    'cal.trPeaks': 'ピーク',
    'cal.trFit': 'フィット（{model}）',
    'cal.trSuggest': 'ピークの候補',
    'cal.hoverPick': 'クリックで選んでいる行に入れる',
    'cal.saveTitle': '保存と読み込み',
    'cal.save': '保存',
    'cal.saved': '保存しました',
    'cal.load': '読み込む',
    'cal.noSaved': '保存された校正がありません。',
    'cal.clear': '消去',
    'cal.export': '.json に書き出す',
    'cal.import': '.json から読み込む',
    'cal.badFile': '校正ファイルの形式が正しくありません。',
    'cal.readError': '校正ファイルを読み込めませんでした: {msg}',
    'cal.saveHint': '校正はこのブラウザに自動で保存されます。「ADC ヒストグラム」のタブで横軸を keV にすると、ほかの測定データにも使えます。',
    'cal.placeholderLine': 'ライン',
    'footer.company': '加速キッチン合同会社',
  },
  en: {
    'app.title': 'Analysis — CosmicRay Recorder',
    'nav.label': 'Pages',
    'nav.record': 'Record',
    'nav.plotter': 'Analysis',
    'nav.manual': 'Manual',
    'head.eyebrow': 'Analysing saved data',
    'head.title': 'Analysis',
    'head.lead': 'Open the .dat / .csv files saved on the Record page. Files are read on this computer only and are never sent anywhere.',
    'tab.hist': 'ADC histogram',
    'tab.zenith': 'Zenith angle',
    'tab.cal': 'Energy calibration',
    'common.choose': 'Choose file',
    'common.noFile': 'No file',
    'common.optional': 'optional',
    'common.auto': 'auto',
    'common.end': 'end',
    'common.logY': 'Log y-axis',
    'common.zoomHint': 'Drag to zoom · wheel to scale · double-click to reset',
    'common.counts': 'Counts',
    'common.countsLog': 'Counts (log)',
    'common.adc': 'ADC channel',
    'common.energy': 'Energy [keV]',
    'file.loaded': '{name} ({n} events)',
    'file.none': '{name} — no readable rows',
    'file.v1': 'v1 format',
    'file.sessions': '{n} runs in the file (times are summed)',
    'file.skipped': '{n} rows left out (ADC outside 0–{max})',
    'hist.dataTitle': 'Data and range',
    'hist.file': 'Measurement',
    'hist.binWidth': 'Bin width',
    'hist.adcMin': 'ADC min',
    'hist.adcMax': 'ADC max',
    'hist.timeFrom': 'Start [s]',
    'hist.timeTo': 'End [s]',
    'hist.duration': '(0–{s} s)',
    'hist.bgFile': 'Background',
    'hist.noBg': 'None',
    'hist.bgScale': 'BG scale',
    'hist.subtract': 'Subtract background',
    'hist.useKeV': 'Energy axis [keV] (uses calibration)',
    'hist.count': 'Events',
    'hist.mean': 'Mean ADC',
    'hist.median': 'Median ADC',
    'hist.std': 'Std dev',
    'hist.meanKeV': 'Mean [keV]',
    'hist.medianKeV': 'Median [keV]',
    'hist.stdKeV': 'Std dev [keV]',
    'hist.plotTitle': 'Energy spectrum',
    'hist.empty': 'Choose a measurement file and the histogram appears here',
    'hist.trEvents': 'Events',
    'hist.trSub': 'Subtracted (S − BG)',
    'hist.trSignal': 'Signal',
    'hist.trBg': 'Background ×{s}',
    'hist.hover': 'Counts',
    'zen.dataTitle': 'Count rate per angle',
    'zen.dataSub': 'Enter the rate measured with the detector tilted to each angle. Errors come from counting statistics (√N).',
    'zen.measTime': 'Measurement time per angle [s]',
    'zen.rate': 'R(θ) [counts/s]',
    'zen.fit': 'Fit cosⁿθ',
    'zen.needData': 'Enter R(0°) > 0 and at least one other angle.',
    'zen.empty': 'Enter R(0°) and at least one other angle',
    'zen.logSub': 'slope = n',
    'zen.trMeasured': 'Measured',
    'zen.trFit': 'Fit: cos^{n}(θ)',
    'zen.trFitLog': 'Fit: slope n = {n}',
    'cal.srcTitle': 'Calibration source',
    'cal.srcSub': 'Open a file measured with a source in place, then mark each peak in the table below.',
    'cal.file': 'Source measurement',
    'cal.source': 'Source',
    'cal.srcTh': 'Th-232 (thorium series)',
    'cal.loadLines': 'Load source lines',
    'cal.specTitle': 'Spectrum',
    'cal.specSub': 'Select a row in the table, then click a peak to fill its Peak ADC (refined below one bin with a Gaussian).',
    'cal.autoPeaks': 'Find peaks',
    'cal.clearPeaks': 'Clear suggestions',
    'cal.peaksHint': 'Clicking a suggestion (▼) also fills the selected row.',
    'cal.empty': 'Open a calibration file',
    'cal.noPeaks': 'No peaks found',
    'cal.needFile': 'Open a calibration file first.',
    'cal.tableTitle': 'Calibration points (ADC ↔ keV)',
    'cal.tableSub': 'Rows with “Use” checked and both keV and Peak ADC filled are fitted by least squares (linear needs 2, quadratic 3 or more).',
    'cal.thArm': 'Select',
    'cal.thUse': 'Use',
    'cal.thLine': 'Nuclide / line',
    'cal.thKev': 'Energy [keV]',
    'cal.thResid': 'Residual [keV]',
    'cal.thResol': 'Resolution',
    'cal.addRow': 'Add row',
    'cal.remove': 'Remove this row',
    'cal.model': 'Fit model',
    'cal.linear': 'Linear  E = a·ADC + b',
    'cal.quadratic': 'Quadratic  E = a·ADC² + b·ADC + c',
    'cal.need': 'Enter at least {n} peaks (keV and Peak ADC) for a {kind} fit',
    'cal.kindLinear': 'linear',
    'cal.kindQuad': 'quadratic',
    'cal.warnMono': '⚠ calibration is not monotonic over the data range',
    'cal.warnSlope': '⚠ unphysical slope (check the points)',
    'cal.fitTitle': 'Calibration (keV vs ADC)',
    'cal.trPeaks': 'Peaks',
    'cal.trFit': 'Fit ({model})',
    'cal.trSuggest': 'Suggested peaks',
    'cal.hoverPick': 'Click to fill the selected row',
    'cal.saveTitle': 'Save and load',
    'cal.save': 'Save',
    'cal.saved': 'Saved',
    'cal.load': 'Load',
    'cal.noSaved': 'No saved calibration.',
    'cal.clear': 'Clear',
    'cal.export': 'Export .json',
    'cal.import': 'Import .json',
    'cal.badFile': 'This is not a calibration file.',
    'cal.readError': 'Could not read the calibration file: {msg}',
    'cal.saveHint': 'The calibration is saved in this browser automatically. Turn on the keV axis in the “ADC histogram” tab to use it with other measurements.',
    'cal.placeholderLine': 'line',
    'footer.company': 'Accel Kitchen LLC',
  },
};

let currentLang = 'en';
function t(key, params) {
  let s = (I18N[currentLang] && I18N[currentLang][key]) ?? I18N.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(v);
  return s;
}
function detectLanguage() {
  try {
    const saved = localStorage.getItem('uiLang');
    if (saved === 'ja' || saved === 'en') return saved;
  } catch (_) {}
  return (navigator.language || '').toLowerCase().startsWith('ja') ? 'ja' : 'en';
}
function setLanguage(lang) {
  currentLang = lang === 'ja' ? 'ja' : 'en';
  try { localStorage.setItem('uiLang', currentLang); } catch (_) {}
  applyLanguage();
}
function applyLanguage() {
  document.documentElement.lang = currentLang;
  document.title = t('app.title');
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  document.querySelectorAll('.lang button').forEach(b => {
    b.classList.toggle('active', b.dataset.lang === currentLang);
    b.setAttribute('aria-pressed', b.dataset.lang === currentLang ? 'true' : 'false');
  });
  document.querySelectorAll('.cal-label').forEach(el => { el.placeholder = t('cal.placeholderLine'); });
  document.querySelectorAll('.cal-remove').forEach(el => { el.title = t('cal.remove'); el.setAttribute('aria-label', t('cal.remove')); });
  renderFileNames();
  updateTimeHints();
  // Redraw everything that carries text.
  if (signal.adc.length) renderAll();
  updateRatios();
  if (lastFit) doFit();
  renderCalHistogram();
  recomputeFit();
}

const $ = id => document.getElementById(id);

// ========== Plot look (same palette as the Record page) ==========
const C = {
  ink: '#2A2730', ink2: '#4F4956', ink3: '#6E6776', ink4: '#A39CA8',
  grid: 'rgba(42,39,48,0.09)', axis: 'rgba(42,39,48,0.40)',
  bar: 'rgba(42,39,48,0.78)', barLine: 'rgba(42,39,48,0.95)',
  signal: '#5CD6EA', signal2: '#2E8BA0', coral: '#C8654E',
};
const PLOT_CONFIG = {
  responsive: true,
  scrollZoom: true,
  displaylogo: false,
  modeBarButtonsToRemove: ['lasso2d', 'select2d'],
  toImageButtonOptions: { format: 'png', filename: 'cosmicray_plot', scale: 2 },
};
function themed(layout) {
  const axis = a => Object.assign({
    gridcolor: C.grid, linecolor: C.axis, zeroline: false, ticks: 'outside', tickcolor: C.axis,
    tickfont: { family: '"IBM Plex Mono", Consolas, monospace', size: 11, color: C.ink3 },
    title: {},
  }, a, { title: Object.assign({ font: { size: 12, color: C.ink3 } }, a && a.title) });
  return Object.assign({}, layout, {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: '"Noto Sans JP", "Yu Gothic UI", Meiryo, sans-serif', size: 12, color: C.ink2 },
    hoverlabel: { bgcolor: '#2A2730', bordercolor: '#2A2730', font: { color: '#FAF6EB', family: '"Noto Sans JP", sans-serif', size: 12 } },
    legend: Object.assign({ orientation: 'h', y: 1.12, x: 0, font: { size: 12, color: C.ink2 } }, layout.legend),
    xaxis: axis(layout.xaxis),
    yaxis: axis(layout.yaxis),
  });
}
function plotEmpty(id, empty) {
  const el = $(id);
  if (el) el.hidden = !empty;
}

// ========== Tabs ==========
function resizePlot(divId) {
  const d = $(divId);
  if (d && d.data) Plotly.Plots.resize(d);
}
function switchTab(id) {
  document.querySelectorAll('.tabs [role="tab"]').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === id ? 'true' : 'false'));
  document.querySelectorAll('.tab-content').forEach(el => { el.hidden = el.id !== id; });
  try { localStorage.setItem('plotterTab', id); } catch (_) {}
  // Plotly cannot measure a hidden container; resize once the tab is laid out.
  setTimeout(() => {
    if (id === 'tab1') resizePlot('histDiv');
    else if (id === 'tab2') { resizePlot('linearDiv'); resizePlot('logDiv'); }
    else if (id === 'tab3') { resizePlot('calHistDiv'); resizePlot('calFitDiv'); }
  }, 0);
}

// ========== Reading files ==========
// Columns are found from the column-name row when there is one:
//   v2 .dat / .csv (this console):  # Event PC_Timestamp Time[us] ADC[0-4095] Deadtime[us] ...
//   firmware / microSD log:         ### Event Time[us] ADC[0-4095] Deadtime[us] ...
//   v1 page .dat:                   # Event PC_Timestamp Time[ms] ADC[0-1023] SiPM[mV] Deadtime[ms] ...
// Times end up in microseconds. Without a column row the v2 .dat layout is assumed
// (Time col 2, ADC col 3, Deadtime col 4, µs), as the original plotter did.
const DEFAULT_COLS = { time: 2, adc: 3, dead: 4, event: 0, scale: 1, v1: false };

// Rows whose ADC value is outside the converter's range are damaged (a line cut short, two lines
// glued together) or were read from the wrong column. They are left out and counted, so one such
// row can no longer stretch the histogram to billions of bins (P-2).
const ADC_LIMIT = 4095;
const MAX_BINS = 20000;   // upper bound on the number of histogram bars

function splitRow(line) {
  return line.trim().split(/\t|,|\s+/).filter(s => s !== '');
}
function columnsFromHeader(line) {
  const names = splitRow(line.replace(/^#+/, '')).map(s => s.toLowerCase());
  const find = re => names.findIndex(n => re.test(n));
  const time = find(/^time/), adc = find(/^adc/), dead = find(/^dead/), event = find(/^event/);
  if (time < 0 || adc < 0) return null;
  const ms = /ms/.test(names[time]);
  return { time, adc, dead, event, scale: ms ? 1000 : 1, v1: ms };
}

// A file can hold several measurements one after another: the recorder appends to one file
// per day, so stopping and restarting (or a RESET / reboot) puts a second run in the same
// file. The board's counters start over at each run, so one run ends where the event number
// or the time or the cumulative deadtime goes backwards. Spans and dead time are summed per
// run; measured over the whole file the duration, the live time and the background scale
// would all be wrong (P-1).
function parseDataFile(text) {
  const lines = text.split(/\r?\n/);
  const adc = [];
  const times = [];   // per-event time [µs] (NaN when unparseable)
  const deads = [];   // per-event cumulative deadtime [µs] (NaN when unparseable)
  const segs = [];    // per-event run number (0, 1, ...)
  const cums = [];    // per-event time since the first event, runs laid end to end [µs] (NaN without a time)
  let cols = DEFAULT_COLS;
  let seg = 0, prevT = NaN, prevD = NaN, prevN = NaN;
  let segStartT = NaN, segMaxT = NaN, cumBefore = 0;   // cumBefore = span of the finished runs
  let sawEvent = false;
  let skipped = 0;   // rows left out because their ADC value is out of range
  for (const line of lines) {
    if (!line) continue;
    if (line.charAt(0) === '#' || /^[A-Za-z]/.test(line.trim())) {
      const c = columnsFromHeader(line);   // column-name row (or CSV header without #)
      if (c) cols = c;
      continue;
    }
    const f = splitRow(line);
    if (f.length <= cols.adc) continue;
    const v = parseInt(f[cols.adc], 10);
    if (isNaN(v)) continue;
    if (v < 0 || v > ADC_LIMIT) { skipped++; continue; }
    const t = parseFloat(f[cols.time]) * cols.scale;
    const d = cols.dead >= 0 ? parseFloat(f[cols.dead]) * cols.scale : NaN;
    const n = (cols.event >= 0 && cols.event < f.length) ? parseInt(f[cols.event], 10) : NaN;
    if (sawEvent && ((!isNaN(t) && !isNaN(prevT) && t < prevT) ||
                     (!isNaN(d) && !isNaN(prevD) && d < prevD) ||
                     (!isNaN(n) && !isNaN(prevN) && n <= prevN))) {
      // a new run starts: the finished one contributes its own span
      if (!isNaN(segMaxT) && !isNaN(segStartT)) cumBefore += segMaxT - segStartT;
      seg++;
      segStartT = NaN; segMaxT = NaN;
    }
    sawEvent = true;
    if (!isNaN(t)) {
      if (isNaN(segStartT)) segStartT = t;
      if (isNaN(segMaxT) || t > segMaxT) segMaxT = t;
    }
    adc.push(v);
    times.push(t);
    deads.push(d);
    segs.push(seg);
    cums.push(isNaN(t) || isNaN(segStartT) ? NaN : cumBefore + (t - segStartT));
    if (!isNaN(t)) prevT = t;
    if (!isNaN(d)) prevD = d;
    if (!isNaN(n)) prevN = n;
  }
  if (!isNaN(segMaxT) && !isNaN(segStartT)) cumBefore += segMaxT - segStartT;   // the last run
  const firstT = times.find(x => !isNaN(x));
  const t0 = firstT === undefined ? 0 : firstT;      // first event time [µs]
  const duration = cumBefore / 1e6;                  // sum of the runs' spans [s]
  const liveTime = computeLiveTime(times, deads, segs);
  return { adc, times, deads, segs, cums, t0, duration, liveTime, sessions: sawEvent ? seg + 1 : 0, skipped, v1: cols.v1 };
}

// Live time [µs] = elapsed span - accumulated deadtime over the given events.
// deads is the firmware's cumulative deadtime counter, so its span = dead time
// spent between the first and last event in the set. Computed per run (segs) and summed.
function computeLiveTime(times, deads, segs) {
  const runs = new Map();   // run number -> { minT, maxT, minD, maxD }
  for (let i = 0; i < times.length; i++) {
    const key = segs ? segs[i] : 0;
    let r = runs.get(key);
    if (!r) { r = { minT: Infinity, maxT: -Infinity, minD: Infinity, maxD: -Infinity }; runs.set(key, r); }
    const tt = times[i], d = deads[i];
    if (!isNaN(tt)) { if (tt < r.minT) r.minT = tt; if (tt > r.maxT) r.maxT = tt; }
    if (!isNaN(d)) { if (d < r.minD) r.minD = d; if (d > r.maxD) r.maxD = d; }
  }
  let live = 0;
  for (const r of runs.values()) {
    if (r.maxT <= r.minT) continue;
    const dead = (r.maxD >= r.minD && r.maxD !== -Infinity) ? (r.maxD - r.minD) : 0;
    live += Math.max(0, (r.maxT - r.minT) - dead);
  }
  return live;
}

function readFile(input, onText) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => onText(file.name, ev.target.result);
  reader.readAsText(file);
}

// File names shown under the pickers (kept as state so a language switch can redraw them).
const fileLabels = { fileName: null, bgFileName: null, calFileName: null };
function setFileLabel(id, name, data) {
  fileLabels[id] = { name, n: data.adc.length, v1: data.v1, sessions: data.sessions, skipped: data.skipped };
  renderFileNames();
}
function renderFileNames() {
  for (const id of Object.keys(fileLabels)) {
    const el = $(id), f = fileLabels[id];
    if (!el || !f) continue;
    el.removeAttribute('data-i18n');
    el.classList.add('has');
    let s = f.n ? t('file.loaded', { name: f.name, n: f.n.toLocaleString() }) : t('file.none', { name: f.name });
    if (f.n && f.v1) s += ' · ' + t('file.v1');
    if (f.n && f.sessions > 1) s += ' · ' + t('file.sessions', { n: f.sessions });
    if (f.skipped) s += ' · ' + t('file.skipped', { n: f.skipped.toLocaleString(), max: ADC_LIMIT });
    el.textContent = s;
    el.title = s;
  }
}

// ========== ADC histogram ==========
let signal = { adc: [], times: [], deads: [], segs: [], cums: [], t0: 0, duration: 0, liveTime: 0, sessions: 0, skipped: 0 };
let background = null;

// Auto BG scale = signal live time / background live time (units cancel in the ratio).
// Falls back to 1.0 when either live time cannot be derived. Uses the time-windowed
// signal live time so the scale stays correct when a plot time range is selected.
function autoBgScale(sigLiveTime) {
  const sigLive = (sigLiveTime === undefined) ? windowedSignal().liveTime : sigLiveTime;
  if (background && sigLive > 0 && background.liveTime > 0) return sigLive / background.liveTime;
  return 1;
}

// Plot time window [s from start]. Empty/invalid inputs mean "from the very start" / "to the end".
function getTimeWindow() {
  const fromV = parseFloat($('timeFrom').value);
  const toV = parseFloat($('timeTo').value);
  const from = (!isNaN(fromV) && fromV > 0) ? fromV : 0;
  const to = (!isNaN(toV) && toV > from) ? toV : Infinity;
  return { from, to };
}

// Signal restricted to the selected plot time window, with its own live time
// recomputed for that window. Returns the full signal when no window is set.
function windowedSignal() {
  const { from, to } = getTimeWindow();
  if (from <= 0 && to === Infinity) return { adc: signal.adc, liveTime: signal.liveTime };
  const adc = [], times = [], deads = [], segs = [];
  for (let i = 0; i < signal.adc.length; i++) {
    const tt = signal.times[i];
    if (isNaN(tt)) continue;   // events without a timestamp can't be windowed
    const rel = signal.cums[i] / 1e6;   // seconds from the start, with the runs laid end to end
    if (rel >= from && rel <= to) { adc.push(signal.adc[i]); times.push(tt); deads.push(signal.deads[i]); segs.push(signal.segs[i]); }
  }
  return { adc, liveTime: computeLiveTime(times, deads, segs) };
}

function updateTimeHints() {
  const dur = signal.duration || 0;
  $('timeTo').placeholder = dur > 0 ? dur.toFixed(1) : t('common.end');
  $('durationHint').textContent = dur > 0 ? t('hist.duration', { s: dur.toFixed(1) }) : '';
}

function computeStats(vals) {
  const n = vals.length;
  if (n === 0) return { count: 0, mean: 0, median: 0, std: 0 };
  let sum = 0;
  for (const v of vals) sum += v;
  const mean = sum / n;
  const sorted = Float64Array.from(vals).sort();
  const median = n % 2 === 1 ? sorted[Math.floor(n / 2)] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  let ss = 0;
  for (const v of vals) ss += (v - mean) ** 2;
  return { count: n, mean, median, std: Math.sqrt(ss / n) };
}

// Combined min/max across one or more value arrays (loop avoids spread-on-huge-array limits).
function rangeOf(...arrays) {
  let mn = Infinity, mx = -Infinity;
  for (const arr of arrays) for (const v of arr) { if (v < mn) mn = v; if (v > mx) mx = v; }
  return { mn, mx };
}

function computeHistogram(vals, binWidth, forceMin, forceMax) {
  if (vals.length === 0) return { labels: [], counts: [] };
  let minV = forceMin, maxV = forceMax;
  if (minV === null || maxV === null) {
    const r = rangeOf(vals);
    if (minV === null) minV = Math.floor(r.mn / binWidth) * binWidth;
    if (maxV === null) maxV = Math.ceil((r.mx + 1) / binWidth) * binWidth;
  }
  let nBins = Math.round((maxV - minV) / binWidth);
  if (!isFinite(nBins) || nBins < 1) nBins = 1;
  if (nBins > MAX_BINS) {   // a forced range or a stray value: widen the bins rather than run out of memory (P-2)
    binWidth = Math.ceil((maxV - minV) / MAX_BINS);
    nBins = Math.max(1, Math.round((maxV - minV) / binWidth));
  }
  const counts = new Array(nBins).fill(0);
  const labels = [];
  for (let i = 0; i < nBins; i++) labels.push(minV + i * binWidth + binWidth / 2);
  for (const v of vals) {
    const idx = Math.floor((v - minV) / binWidth);
    if (idx >= 0 && idx < nBins) counts[idx]++;
  }
  return { labels, counts, binWidth };   // the bin width actually used
}

function renderAll() {
  plotEmpty('histEmpty', signal.adc.length === 0);
  if (signal.adc.length === 0) return;
  const sig = windowedSignal();
  const stats = computeStats(sig.adc);

  // Energy-calibration display transform (identity when the keV axis is off).
  const kev = useKeVActive();
  const toE = kev ? (x => calEnergy(x)) : (x => x);
  const slopeAt = x => kev ? calSlope(x) : 1;   // local dE/dADC for std-dev / bar-width scaling

  $('statsRow').hidden = false;
  $('statCount').textContent = stats.count.toLocaleString();
  $('statMean').textContent = toE(stats.mean).toFixed(1);
  $('statMedian').textContent = toE(stats.median).toFixed(1);
  $('statStd').textContent = (Math.abs(slopeAt(stats.mean)) * stats.std).toFixed(1);
  $('statMeanLabel').textContent = t(kev ? 'hist.meanKeV' : 'hist.mean');
  $('statMedianLabel').textContent = t(kev ? 'hist.medianKeV' : 'hist.median');
  $('statStdLabel').textContent = t(kev ? 'hist.stdKeV' : 'hist.std');

  const subtract = !!(background && $('subtractBg').checked);
  const logY = $('logY').checked;
  const binWidthWanted = Math.max(1, parseInt($('binWidth').value, 10) || 10);
  const forceMin = $('adcMin').value !== '' ? parseFloat($('adcMin').value) : null;
  const forceMax = $('adcMax').value !== '' ? parseFloat($('adcMax').value) : null;

  $('bgScale').placeholder = autoBgScale(sig.liveTime).toFixed(4);

  // Shared bin edges across signal (and background when subtracting).
  const { mn, mx } = rangeOf(sig.adc, subtract ? background.adc : []);
  const minV = forceMin !== null ? forceMin : Math.floor(mn / binWidthWanted) * binWidthWanted;
  const maxV = forceMax !== null ? forceMax : Math.ceil((mx + 1) / binWidthWanted) * binWidthWanted;
  const hist = computeHistogram(sig.adc, binWidthWanted, minV, maxV);
  const { labels, counts: signalCounts } = hist;
  const binWidth = hist.binWidth;   // wider than asked for only when the range needed more than MAX_BINS bars

  const forLog = arr => logY ? arr.map(v => (v > 0 ? v : null)) : arr;
  const xDisp = labels.map(toE);
  const barW = kev ? labels.map(c => Math.abs(toE(c + binWidth / 2) - toE(c - binWidth / 2))) : binWidth;
  const binText = labels.map(c => {
    if (!kev) return `ADC ${c - binWidth / 2} – ${c + binWidth / 2}`;
    const e1 = toE(c - binWidth / 2), e2 = toE(c + binWidth / 2);
    return `${Math.min(e1, e2).toFixed(1)} – ${Math.max(e1, e2).toFixed(1)} keV`;
  });

  const traces = [];
  if (subtract) {
    let scale = parseFloat($('bgScale').value);
    if (isNaN(scale)) scale = autoBgScale(sig.liveTime);
    const bgCounts = computeHistogram(background.adc, binWidth, minV, maxV).counts;
    const bgScaled = bgCounts.map(c => c * scale);
    const subtracted = signalCounts.map((c, i) => c - bgScaled[i]);
    traces.push({
      type: 'bar', name: t('hist.trSub'), x: xDisp, y: forLog(subtracted), width: barW,
      marker: { color: C.bar, line: { color: C.barLine, width: 0.5 } },
      text: binText, textposition: 'none', hovertemplate: `%{text}<br>${t('hist.hover')}: %{y:.1f}<extra></extra>`,
    });
    traces.push({
      type: 'scatter', mode: 'lines', name: t('hist.trSignal'), x: xDisp, y: forLog(signalCounts),
      line: { color: C.signal2, width: 1.5, shape: 'hvh' },
    });
    traces.push({
      type: 'scatter', mode: 'lines', name: t('hist.trBg', { s: scale.toFixed(3) }), x: xDisp, y: forLog(bgScaled),
      line: { color: C.coral, width: 1.5, dash: 'dash', shape: 'hvh' },
    });
  } else {
    traces.push({
      type: 'bar', name: t('hist.trEvents'), x: xDisp, y: forLog(signalCounts), width: barW,
      marker: { color: C.bar, line: { color: C.barLine, width: 0.5 } },
      text: binText, textposition: 'none', hovertemplate: `%{text}<br>${t('hist.hover')}: %{y}<extra></extra>`,
    });
  }

  const showLegend = traces.length > 1;
  Plotly.react('histDiv', traces, themed({
    margin: { l: 64, r: 16, t: showLegend ? 36 : 12, b: 50 },
    bargap: 0,
    showlegend: showLegend,
    hovermode: 'closest',
    dragmode: 'zoom',
    xaxis: { title: { text: kev ? t('common.energy') : t('common.adc') } },
    yaxis: { title: { text: logY ? t('common.countsLog') : t('common.counts') }, type: logY ? 'log' : 'linear', rangemode: logY ? 'normal' : 'tozero' },
  }), PLOT_CONFIG);
}

// ========== Zenith angle ==========
const angles = [0, 15, 30, 45, 60, 75];
let lastFit = false;

function getMeasTime() {
  return Math.max(1, parseFloat($('measTime').value) || 300);
}

function initZenithTable() {
  const tbody = $('zenithBody');
  for (const a of angles) {
    const cosV = Math.cos(a * Math.PI / 180);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${a}&deg;</td>
      <td class="auto">${cosV.toFixed(3)}</td>
      <td><input type="number" step="any" min="0" data-angle="${a}" class="rate-input" placeholder="0.000" aria-label="R(${a}°)"></td>
      <td class="auto sigma-cell" data-angle="${a}">-</td>
      <td class="auto ratio-cell" data-angle="${a}">-</td>
      <td class="auto sigma-ratio-cell" data-angle="${a}">-</td>`;
    tbody.appendChild(tr);
  }
  tbody.addEventListener('input', () => { lastFit = false; $('fitResult').hidden = true; updateRatios(); saveZenith(); });
  $('measTime').addEventListener('input', () => { updateRatios(); if (lastFit) doFit(); saveZenith(); });
  $('fitBtn').addEventListener('click', doFit);
  loadZenith();
}

// The typed rates are kept in this browser so a reload does not lose them.
function saveZenith() {
  const rates = {};
  document.querySelectorAll('.rate-input').forEach(inp => { if (inp.value !== '') rates[inp.dataset.angle] = inp.value; });
  try { localStorage.setItem('crd_zenith_v1', JSON.stringify({ T: $('measTime').value, rates })); } catch (_) {}
}
function loadZenith() {
  let obj = null;
  try { obj = JSON.parse(localStorage.getItem('crd_zenith_v1') || 'null'); } catch (_) {}
  if (!obj) return;
  if (obj.T) $('measTime').value = obj.T;
  document.querySelectorAll('.rate-input').forEach(inp => { if (obj.rates && obj.rates[inp.dataset.angle] != null) inp.value = obj.rates[inp.dataset.angle]; });
}

function updateRatios() {
  const inputs = document.querySelectorAll('.rate-input');
  const T = getMeasTime();
  let r0 = 0, N0 = 0;
  inputs.forEach(inp => {
    if (parseInt(inp.dataset.angle) === 0) { r0 = parseFloat(inp.value) || 0; N0 = r0 * T; }
  });
  inputs.forEach(inp => {
    const a = parseInt(inp.dataset.angle);
    const sigmaCell = document.querySelector(`.sigma-cell[data-angle="${a}"]`);
    const ratioCell = document.querySelector(`.ratio-cell[data-angle="${a}"]`);
    const sigmaRatioCell = document.querySelector(`.sigma-ratio-cell[data-angle="${a}"]`);
    const r = parseFloat(inp.value) || 0;
    const N = r * T;
    // sigma_R = sqrt(N) / T
    sigmaCell.textContent = r > 0 ? (Math.sqrt(N) / T).toFixed(4) : '-';
    if (a === 0 && r0 > 0) {
      ratioCell.textContent = '1.0000';
      sigmaRatioCell.textContent = Math.sqrt(2 / N0).toFixed(4);   // sqrt(1/N0 + 1/N0)
    } else if (r0 > 0 && r > 0) {
      const ratio = r / r0;
      ratioCell.textContent = ratio.toFixed(4);
      sigmaRatioCell.textContent = (ratio * Math.sqrt(1 / N + 1 / N0)).toFixed(4);
    } else {
      ratioCell.textContent = '-';
      sigmaRatioCell.textContent = '-';
    }
  });
  if (!lastFit) updateZenithPlots(null);
}

function getTableData() {
  const T = getMeasTime();
  const data = [];
  document.querySelectorAll('.rate-input').forEach(inp => {
    const theta = parseInt(inp.dataset.angle);
    const rate = parseFloat(inp.value);
    if (!isNaN(rate) && rate > 0) data.push({ theta, rate, cosTheta: Math.cos(theta * Math.PI / 180), N: rate * T });
  });
  return data;
}

// Least squares through the origin of ln(R/R0) = n · ln(cos θ).
function performFit(data) {
  const r0Entry = data.find(d => d.theta === 0);
  if (!r0Entry) return null;
  const r0 = r0Entry.rate;
  const points = data.filter(d => d.theta > 0 && d.rate > 0)
    .map(d => ({ x: Math.log(d.cosTheta), y: Math.log(d.rate / r0) }));
  if (points.length < 1) return null;
  let sumXY = 0, sumXX = 0;
  for (const p of points) { sumXY += p.x * p.y; sumXX += p.x * p.x; }
  const n = sumXY / sumXX;
  const yMean = points.reduce((s, p) => s + p.y, 0) / points.length;
  const ssTot = points.reduce((s, p) => s + (p.y - yMean) ** 2, 0);
  const ssRes = points.reduce((s, p) => s + (p.y - n * p.x) ** 2, 0);
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 1;
  return { n, rSquared };
}

function doFit() {
  const result = performFit(getTableData());
  const msg = $('fitMsg');
  if (!result) {
    lastFit = false;
    $('fitResult').hidden = true;
    msg.textContent = t('zen.needData');
    msg.hidden = false;
    return;
  }
  msg.hidden = true;
  lastFit = true;
  $('fitResult').hidden = false;
  $('nValue').textContent = result.n.toFixed(3);
  $('r2Value').textContent = result.rSquared.toFixed(4);
  updateZenithPlots(result);
}

function updateZenithPlots(fitResult) {
  const data = getTableData();
  const r0Entry = data.find(d => d.theta === 0);
  const ready = !!r0Entry && data.length >= 2;
  plotEmpty('linearEmpty', !ready);
  plotEmpty('logEmpty', !ready);
  if (!ready) { Plotly.purge('linearDiv'); Plotly.purge('logDiv'); return; }
  const r0 = r0Entry.rate;
  const N0 = r0Entry.N;

  const linearX = data.map(d => d.cosTheta);
  const linearY = data.map(d => d.rate / r0);
  const linearErr = data.map(d => (d.rate / r0) * Math.sqrt(1 / d.N + 1 / N0));

  const logFiltered = data.filter(d => d.theta > 0 && d.rate > 0);
  const logX = logFiltered.map(d => Math.log(d.cosTheta));
  const logYv = logFiltered.map(d => Math.log(d.rate / r0));
  const logErr = logFiltered.map(d => Math.sqrt(1 / d.N + 1 / N0));
  logX.push(0); logYv.push(0); logErr.push(Math.sqrt(2 / N0));   // θ = 0 at the origin

  const pts = (x, y, err, hover) => ({
    type: 'scatter', mode: 'markers', name: t('zen.trMeasured'), x, y,
    error_y: { type: 'data', array: err, visible: true, color: C.ink2, thickness: 1.2, width: 4 },
    marker: { color: C.ink, size: 8 },
    hovertemplate: hover,
  });
  const traces1 = [pts(linearX, linearY, linearErr, 'cos θ = %{x:.3f}<br>R/R₀ = %{y:.4f}<extra></extra>')];
  const traces2 = [pts(logX, logYv, logErr, 'ln(cos θ) = %{x:.3f}<br>ln(R/R₀) = %{y:.3f}<extra></extra>')];

  if (fitResult) {
    const fitX = [], fitY = [];
    for (let c = 0.01; c <= 1.005; c += 0.02) { fitX.push(c); fitY.push(Math.pow(c, fitResult.n)); }
    traces1.push({
      type: 'scatter', mode: 'lines', name: t('zen.trFit', { n: fitResult.n.toFixed(2) }), x: fitX, y: fitY,
      line: { color: C.coral, width: 2, shape: 'spline' }, hoverinfo: 'skip',
    });
    const xMin = Math.min(...logX, -1.5);
    traces2.push({
      type: 'scatter', mode: 'lines', name: t('zen.trFitLog', { n: fitResult.n.toFixed(3) }),
      x: [xMin, 0], y: [fitResult.n * xMin, 0],
      line: { color: C.coral, width: 2 }, hoverinfo: 'skip',
    });
  }

  const showLegend = !!fitResult;
  const base = { margin: { l: 64, r: 16, t: showLegend ? 36 : 12, b: 50 }, showlegend: showLegend, hovermode: 'closest', dragmode: 'zoom' };
  Plotly.react('linearDiv', traces1, themed(Object.assign({}, base, {
    xaxis: { title: { text: 'cos θ' }, range: [0, 1.05] },
    yaxis: { title: { text: 'R(θ) / R(0°)' }, rangemode: 'tozero' },
  })), PLOT_CONFIG);
  Plotly.react('logDiv', traces2, themed(Object.assign({}, base, {
    xaxis: { title: { text: 'ln(cos θ)' } },
    yaxis: { title: { text: 'ln(R(θ) / R(0°))' } },
  })), PLOT_CONFIG);
}

// ========== Energy calibration ==========
const CAL_KEY = 'crd_energy_cal_v1';   // same key as the original plotter, so saved calibrations carry over

let calSignal = { adc: [], times: [], deads: [], segs: [], cums: [], t0: 0, duration: 0, liveTime: 0, sessions: 0, skipped: 0 };
// calibration: null when not calibrated, else one of
//   { model:'linear',    a, b,       r2, n, seA, seB,        valid } → E = a·ADC + b
//   { model:'quadratic', c2, c1, c0, r2, n, seC2, seC1, seC0, valid } → E = c2·ADC² + c1·ADC + c0
let calibration = null;
let armedRow = null;      // <tr> that click-to-pick fills
let calClickBound = false;
let calHist = null;       // { labels, counts, binWidth, minV } of the loaded cal spectrum
let calSuggestions = [];  // auto-detected peak candidates [{ center, fwhm, resolution, refined }]

// Reference gamma lines per calibration source (literature energies).
const CAL_SOURCE_PRESETS = {
  'Th-232': [
    { label: 'Pb-212', kev: 238.6,  adc: '', include: true },
    { label: 'Ac-228', kev: 338.3,  adc: '', include: true },
    { label: 'Tl-208', kev: 583.2,  adc: '', include: true },
    { label: 'Bi-212', kev: 727.3,  adc: '', include: true },
    { label: 'Ac-228', kev: 911.2,  adc: '', include: true },
    { label: 'Ac-228', kev: 968.9,  adc: '', include: true },
    { label: 'Tl-208', kev: 2614.5, adc: '', include: true },
  ],
  'Cs-137': [{ label: 'Cs-137', kev: 661.66, adc: '', include: true }],
  'Co-60': [
    { label: 'Co-60', kev: 1173.23, adc: '', include: true },
    { label: 'Co-60', kev: 1332.49, adc: '', include: true },
  ],
  'K-40': [{ label: 'K-40', kev: 1460.82, adc: '', include: true }],
};
const CAL_PRESETS = CAL_SOURCE_PRESETS['Th-232'];

function calMsg(text) {
  const m = $('calMsg');
  m.textContent = text || '';
  m.hidden = !text;
}

function loadPreset(name) {
  const rows = CAL_SOURCE_PRESETS[name];
  if (!rows) return;
  rebuildCalTable(rows.map(r => ({ label: r.label, kev: r.kev, adc: '', include: true })));
  onCalTableChange();
}

// Clickable ADC spectrum of the loaded calibration source. Peaks are read off here.
function renderCalHistogram() {
  if (!calSignal.adc.length) {
    plotEmpty('calHistEmpty', true);
    calClickBound = false;          // handler is dropped by purge; rebind on next render
    calHist = null;
    Plotly.purge('calHistDiv');
    return;
  }
  plotEmpty('calHistEmpty', false);

  const binWidth = Math.max(1, parseInt($('calBinWidth').value, 10) || 10);
  const logY = $('calLogY').checked;
  const { mn, mx } = rangeOf(calSignal.adc);
  const minV = Math.floor(mn / binWidth) * binWidth;
  const maxV = Math.ceil((mx + 1) / binWidth) * binWidth;
  const { labels, counts, binWidth: usedWidth } = computeHistogram(calSignal.adc, binWidth, minV, maxV);
  calHist = { labels, counts, binWidth: usedWidth, minV };   // the width actually used (same as renderAll)
  const y = logY ? counts.map(v => (v > 0 ? v : null)) : counts;
  const binText = labels.map(c => `ADC ${c - binWidth / 2} – ${c + binWidth / 2}`);

  const traces = [{
    type: 'bar', name: t('common.counts'), x: labels, y, width: binWidth,
    marker: { color: C.bar, line: { color: C.barLine, width: 0.5 } },
    text: binText, textposition: 'none',
    hovertemplate: `%{text}<br>${t('hist.hover')}: %{y}<br>${t('cal.hoverPick')}<extra></extra>`,
  }];

  // Auto-detected peak suggestions (▼). Each carries its refined center + FWHM/resolution.
  if (calSuggestions.length) {
    const sx = [], sy = [], scd = [];
    for (const s of calSuggestions) {
      const bi = Math.floor((s.center - minV) / binWidth);
      const yy = (bi >= 0 && bi < counts.length) ? counts[bi] : 0;
      sx.push(s.center); sy.push(logY ? (yy > 0 ? yy : null) : yy); scd.push(s);
    }
    traces.push({
      type: 'scatter', mode: 'markers', name: t('cal.trSuggest'), meta: 'suggest',
      x: sx, y: sy, customdata: scd,
      marker: { symbol: 'triangle-down', size: 13, color: C.signal, line: { color: C.signal2, width: 1.2 } },
      hovertemplate: `${t('cal.trSuggest')}<br>ADC %{x:.1f}<br>${t('cal.hoverPick')}<extra></extra>`,
    });
  }
  const showLegend = traces.length > 1;
  Plotly.react('calHistDiv', traces, themed({
    margin: { l: 64, r: 16, t: showLegend ? 36 : 12, b: 50 },
    bargap: 0,
    showlegend: showLegend,
    hovermode: 'closest',
    dragmode: 'zoom',
    xaxis: { title: { text: t('common.adc') } },
    yaxis: { title: { text: logY ? t('common.countsLog') : t('common.counts') }, type: logY ? 'log' : 'linear', rangemode: logY ? 'normal' : 'tozero' },
  }), PLOT_CONFIG);
  bindCalHistClick();
}

// Bind the click-to-pick handler exactly once (Plotly.react keeps .on handlers,
// so re-binding every render would stack duplicate fills).
function bindCalHistClick() {
  if (calClickBound) return;
  const gd = $('calHistDiv');
  if (!gd || !gd.on) return;
  gd.on('plotly_click', ev => {
    if (!ev || !ev.points || !ev.points.length) return;
    const tr = getArmedRow();
    if (!tr) return;
    const p = ev.points[0];
    if (p.data && p.data.meta === 'suggest') {
      const s = p.customdata || {};
      applyPeakToRow(tr, (s.center != null ? s.center : p.x), s);
    } else {
      const res = refinePeak(p.pointNumber);
      applyPeakToRow(tr, res.center, res);
    }
    onCalTableChange();
  });
  calClickBound = true;
}

function applyPeakToRow(tr, centerAdc, res) {
  tr.querySelector('.cal-adc').value = Math.round(centerAdc * 100) / 100;   // programmatic set → no 'input' event
  if (res && res.refined) setRowRefinement(tr, res);
  else clearRowRefinement(tr);
}

function setRowRefinement(tr, res) {
  tr.dataset.fwhm = isFinite(res.fwhm) ? res.fwhm : '';
  tr.dataset.resol = isFinite(res.resolution) ? res.resolution : '';
  const fc = tr.querySelector('.cal-fwhm'), rc = tr.querySelector('.cal-resol');
  if (fc) fc.textContent = isFinite(res.fwhm) ? res.fwhm.toFixed(1) : '-';
  if (rc) rc.textContent = isFinite(res.resolution) ? res.resolution.toFixed(1) + '%' : '-';
}

function clearRowRefinement(tr) {
  delete tr.dataset.fwhm; delete tr.dataset.resol;
  const fc = tr.querySelector('.cal-fwhm'), rc = tr.querySelector('.cal-resol');
  if (fc) fc.textContent = '-';
  if (rc) rc.textContent = '-';
}

// Closed-form Gaussian peak refinement by a log-parabola fit around bin `idx`.
// Window = ±6 bins; a linear background from the window edges is subtracted; on
// the positive residuals we fit ln(y)=A+B·x+C·x² and read center = −B/(2C),
// sigma = sqrt(−1/(2C)) (needs C<0), FWHM = 2.3548·sigma. Falls back to the bin
// center (no resolution) when degenerate.
function refinePeak(idx) {
  if (!calHist || idx == null || idx < 0 || idx >= calHist.counts.length) {
    const c = (calHist && calHist.labels[idx] != null) ? calHist.labels[idx] : NaN;
    return { center: c, refined: false };
  }
  const labels = calHist.labels, counts = calHist.counts, binWidth = calHist.binWidth;
  const clicked = labels[idx];
  const half = 6;
  const lo = Math.max(0, idx - half), hi = Math.min(counts.length - 1, idx + half);
  const xs = [], ys = [];
  for (let i = lo; i <= hi; i++) { xs.push(i - idx); ys.push(counts[i]); }
  const xe0 = xs[0], xe1 = xs[xs.length - 1], ye0 = ys[0], ye1 = ys[ys.length - 1];
  const slope = (xe1 !== xe0) ? (ye1 - ye0) / (xe1 - xe0) : 0;
  const bgAt = x => ye0 + slope * (x - xe0);
  const fx = [], fy = [];
  for (let k = 0; k < xs.length; k++) {
    const s = ys[k] - bgAt(xs[k]);
    if (s > 0) { fx.push(xs[k]); fy.push(Math.log(s)); }
  }
  if (fx.length < 3) return { center: clicked, refined: false };
  const sol = quadNormalSolve(fx, fy);
  if (!sol) return { center: clicked, refined: false };
  const Cq = sol.coef[0], B = sol.coef[1];
  if (!(Cq < 0)) return { center: clicked, refined: false };
  const centerBin = -B / (2 * Cq);
  const sigmaBin = Math.sqrt(-1 / (2 * Cq));
  if (Math.abs(centerBin) > half) return { center: clicked, refined: false };
  const centerAdc = clicked + centerBin * binWidth;
  const sigmaAdc = sigmaBin * binWidth;
  const fwhm = 2.3548 * sigmaAdc;
  if (!isFinite(centerAdc) || !isFinite(fwhm)) return { center: clicked, refined: false };
  const resolution = centerAdc !== 0 ? (fwhm / centerAdc) * 100 : NaN;
  return { center: centerAdc, sigma: sigmaAdc, fwhm, resolution, refined: true };
}

function movingAverage(arr, win) {
  const half = Math.floor(win / 2);
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let s = 0, c = 0;
    for (let j = i - half; j <= i + half; j++) if (j >= 0 && j < arr.length) { s += arr[j]; c++; }
    out[i] = s / c;
  }
  return out;
}

// Smooth, find local maxima whose prominence over the local background exceeds a
// threshold, refine each to sub-bin, and mark them as suggestions.
function autoDetectPeaks() {
  if (!calHist || !calHist.counts || calHist.counts.length < 5) { calMsg(t('cal.needFile')); return; }
  calMsg('');
  const sm = movingAverage(calHist.counts, 5);
  const maxV = Math.max.apply(null, sm);
  if (!(maxV > 0)) return;
  const win = 6;
  const minProm = Math.max(3, 0.02 * maxV);
  const raw = [];
  for (let i = 1; i < sm.length - 1; i++) {
    if (sm[i] < sm[i - 1] || sm[i] < sm[i + 1]) continue;
    if (sm[i] === sm[i - 1] && sm[i] === sm[i + 1]) continue;
    let loMin = Infinity, hiMin = Infinity;
    for (let j = Math.max(0, i - win); j < i; j++) loMin = Math.min(loMin, sm[j]);
    for (let j = i + 1; j <= Math.min(sm.length - 1, i + win); j++) hiMin = Math.min(hiMin, sm[j]);
    const base = Math.max(loMin, hiMin);
    if (!isFinite(base)) continue;
    if (sm[i] - base < minProm) continue;
    raw.push(i);
  }
  const merged = [];
  for (const i of raw) {
    const last = merged.length ? merged[merged.length - 1] : null;
    if (last != null && (i - last) < 3) { if (sm[i] > sm[last]) merged[merged.length - 1] = i; }
    else merged.push(i);
  }
  calSuggestions = merged.map(i => refinePeak(i));
  renderCalHistogram();
  if (!calSuggestions.length) flashBtn('autoPeaksBtn', t('cal.noPeaks'));
}

function clearPeakSuggestions() {
  calSuggestions = [];
  renderCalHistogram();
}

// The row a click fills. Driven by an explicit armed state (not :focus — clicking
// the Plotly canvas blurs the input, which would clear a focus-based highlight).
function getArmedRow() {
  if (armedRow && document.body.contains(armedRow)) return armedRow;
  const checked = document.querySelector('#calTableBody input.cal-arm:checked');
  if (checked) return checked.closest('tr');
  return document.querySelector('#calTableBody tr');
}

function setArmed(tr) {
  armedRow = tr;
  document.querySelectorAll('#calTableBody tr').forEach(r => r.classList.toggle('cal-row-armed', r === tr));
  if (tr) {
    const radio = tr.querySelector('input.cal-arm');
    if (radio) radio.checked = true;
  }
}

function buildCalRow(point) {
  const tr = document.createElement('tr');
  tr.innerHTML =
    '<td><input type="radio" name="armRow" class="cal-arm"></td>' +
    '<td><input type="checkbox" class="cal-include"></td>' +
    '<td><input type="text" class="cal-label"></td>' +
    '<td><input type="number" step="any" class="cal-kev" placeholder="keV"></td>' +
    '<td><input type="number" step="any" class="cal-adc" placeholder="ADC"></td>' +
    '<td class="auto cal-resid">-</td>' +
    '<td class="auto cal-fwhm">-</td>' +
    '<td class="auto cal-resol">-</td>' +
    '<td><button type="button" class="icon-btn cal-remove"><svg class="i"><use href="#i-close"/></svg></button></td>';
  const p = point || {};
  tr.querySelector('.cal-include').checked = (p.include !== false);
  tr.querySelector('.cal-label').value = (p.label != null ? p.label : '');
  tr.querySelector('.cal-label').placeholder = t('cal.placeholderLine');
  tr.querySelector('.cal-kev').value = (p.kev != null ? p.kev : '');
  tr.querySelector('.cal-adc').value = (p.adc != null ? p.adc : '');
  const rm = tr.querySelector('.cal-remove');
  rm.title = t('cal.remove');
  rm.setAttribute('aria-label', t('cal.remove'));
  if (p.fwhm != null && p.fwhm !== '' && isFinite(+p.fwhm)) {
    tr.dataset.fwhm = p.fwhm; tr.querySelector('.cal-fwhm').textContent = (+p.fwhm).toFixed(1);
  }
  if (p.resol != null && p.resol !== '' && isFinite(+p.resol)) {
    tr.dataset.resol = p.resol; tr.querySelector('.cal-resol').textContent = (+p.resol).toFixed(1) + '%';
  }
  tr.querySelector('.cal-arm').addEventListener('change', () => setArmed(tr));
  tr.addEventListener('focusin', () => setArmed(tr));
  tr.querySelector('.cal-include').addEventListener('change', onCalTableChange);
  tr.querySelector('.cal-label').addEventListener('input', onCalTableChange);
  tr.querySelector('.cal-kev').addEventListener('input', onCalTableChange);
  // Manual ADC edits invalidate any Gaussian-refined FWHM/resolution for the row.
  tr.querySelector('.cal-adc').addEventListener('input', () => { clearRowRefinement(tr); onCalTableChange(); });
  rm.addEventListener('click', () => removeCalRow(tr));
  return tr;
}

function addCalRow() {
  const tr = buildCalRow({ label: '', kev: '', adc: '', include: true });
  $('calTableBody').appendChild(tr);
  setArmed(tr);
  onCalTableChange();
}

function removeCalRow(tr) {
  const body = $('calTableBody');
  if (armedRow === tr) armedRow = null;
  tr.remove();
  if (!body.querySelector('tr')) body.appendChild(buildCalRow({ label: '', kev: '', adc: '', include: true }));
  const first = body.querySelector('tr');
  if (!armedRow && first) setArmed(first);
  onCalTableChange();
}

function collectCalPoints() {
  const pts = [];
  document.querySelectorAll('#calTableBody tr').forEach(tr => {
    const inc = tr.querySelector('.cal-include').checked;
    const kev = parseFloat(tr.querySelector('.cal-kev').value);
    const adc = parseFloat(tr.querySelector('.cal-adc').value);
    if (inc && isFinite(kev) && isFinite(adc)) pts.push({ adc, kev, tr });
  });
  return pts;
}

// Invert a 3x3 matrix via adjugate / determinant. Null when singular.
function invert3(m) {
  const a = m[0][0], b = m[0][1], c = m[0][2];
  const d = m[1][0], e = m[1][1], f = m[1][2];
  const g = m[2][0], h = m[2][1], i = m[2][2];
  const A = e * i - f * h, B = -(d * i - f * g), Cc = d * h - e * g;
  const det = a * A + b * B + c * Cc;
  if (!isFinite(det) || Math.abs(det) < 1e-12) return null;
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
  const inv = 1 / det;
  return [
    [A * inv, D * inv, G * inv],
    [B * inv, E * inv, H * inv],
    [Cc * inv, F * inv, I * inv],
  ];
}

// Quadratic normal equations for basis [x², x, 1]. Returns { coef:[c2,c1,c0], inv, n } or null.
function quadNormalSolve(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  let s0 = n, s1 = 0, s2 = 0, s3 = 0, s4 = 0, ty0 = 0, ty1 = 0, ty2 = 0;
  for (let k = 0; k < n; k++) {
    const x = xs[k], y = ys[k], x2 = x * x;
    s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2;
    ty0 += y; ty1 += x * y; ty2 += x2 * y;
  }
  const inv = invert3([[s4, s3, s2], [s3, s2, s1], [s2, s1, s0]]);
  if (!inv) return null;
  const rhs = [ty2, ty1, ty0];
  const c2 = inv[0][0] * rhs[0] + inv[0][1] * rhs[1] + inv[0][2] * rhs[2];
  const c1 = inv[1][0] * rhs[0] + inv[1][1] * rhs[1] + inv[1][2] * rhs[2];
  const c0 = inv[2][0] * rhs[0] + inv[2][1] * rhs[1] + inv[2][2] * rhs[2];
  return { coef: [c2, c1, c0], inv, n };
}

// E = a·ADC + b with coefficient standard errors from Cov = σ²·(XᵀX)⁻¹, σ² = RSS/(n−2).
function linearLeastSquares(pts) {
  const n = pts.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) { sx += p.adc; sy += p.kev; sxx += p.adc * p.adc; sxy += p.adc * p.kev; }
  const den = n * sxx - sx * sx;
  if (den === 0) return null;
  const a = (n * sxy - sx * sy) / den;
  const b = (sy - a * sx) / n;
  const yMean = sy / n;
  let ssTot = 0, ssRes = 0;
  for (const p of pts) { const yh = a * p.adc + b; ssTot += (p.kev - yMean) ** 2; ssRes += (p.kev - yh) ** 2; }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1;
  const dof = n - 2;
  const sigma2 = dof > 0 ? ssRes / dof : NaN;
  const seA = dof > 0 ? Math.sqrt(Math.max(0, sigma2 * n / den)) : NaN;
  const seB = dof > 0 ? Math.sqrt(Math.max(0, sigma2 * sxx / den)) : NaN;
  return { model: 'linear', a, b, r2, n, seA, seB, valid: isFinite(a) && isFinite(b) };
}

// E = c2·ADC² + c1·ADC + c0 with standard errors, σ² = RSS/(n−3).
function quadraticLeastSquares(pts) {
  const xs = pts.map(p => p.adc), ys = pts.map(p => p.kev);
  const sol = quadNormalSolve(xs, ys);
  if (!sol) return null;
  const c2 = sol.coef[0], c1 = sol.coef[1], c0 = sol.coef[2], n = sol.n;
  const yMean = ys.reduce((s, v) => s + v, 0) / n;
  let ssTot = 0, ssRes = 0;
  for (let k = 0; k < n; k++) {
    const yh = c2 * xs[k] * xs[k] + c1 * xs[k] + c0;
    ssTot += (ys[k] - yMean) ** 2; ssRes += (ys[k] - yh) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1;
  const dof = n - 3;
  const sigma2 = dof > 0 ? ssRes / dof : NaN;
  const seC2 = dof > 0 ? Math.sqrt(Math.max(0, sigma2 * sol.inv[0][0])) : NaN;
  const seC1 = dof > 0 ? Math.sqrt(Math.max(0, sigma2 * sol.inv[1][1])) : NaN;
  const seC0 = dof > 0 ? Math.sqrt(Math.max(0, sigma2 * sol.inv[2][2])) : NaN;
  return { model: 'quadratic', c2, c1, c0, r2, n, seC2, seC1, seC0, valid: isFinite(c2) && isFinite(c1) && isFinite(c0) };
}

function getCalModel() {
  const sel = $('calModel');
  return (sel && sel.value === 'quadratic') ? 'quadratic' : 'linear';
}

function calEnergy(x) {
  if (!calibration) return x;
  if (calibration.model === 'quadratic') return calibration.c2 * x * x + calibration.c1 * x + calibration.c0;
  return calibration.a * x + calibration.b;
}

function calSlope(x) {
  if (!calibration) return 1;
  if (calibration.model === 'quadratic') return 2 * calibration.c2 * x + calibration.c1;
  return calibration.a;
}

function calMonotonic(lo, hi) {
  if (!calibration) return true;
  if (calibration.model === 'quadratic') {
    if (calibration.c2 === 0) return calibration.c1 !== 0;
    const vertex = -calibration.c1 / (2 * calibration.c2);
    return !(vertex > lo && vertex < hi);
  }
  return calibration.a !== 0;
}

function coefStr(v) {
  if (!isFinite(v)) return 'NaN';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(3);
  if (a < 1) return v.toFixed(5);
  if (a < 100) return v.toFixed(4);
  return v.toFixed(2);
}
function addStr(v) { return (v >= 0 ? '+ ' : '− ') + coefStr(Math.abs(v)); }
function seStr(v) { return isFinite(v) ? coefStr(v) : '—'; }

function updateCalReport(fit, pts) {
  const eqn = $('calEqn');
  const r2 = $('calR2');
  const model = getCalModel();
  if (!fit) {
    eqn.textContent = t('cal.need', { n: model === 'quadratic' ? 3 : 2, kind: t(model === 'quadratic' ? 'cal.kindQuad' : 'cal.kindLinear') });
    eqn.classList.add('fit-small');
    r2.textContent = '';
    return;
  }
  eqn.classList.remove('fit-small');
  let se;
  if (fit.model === 'quadratic') {
    eqn.textContent = 'E = ' + coefStr(fit.c2) + '·ADC² ' + addStr(fit.c1) + '·ADC ' + addStr(fit.c0) + ' keV';
    se = 'SE: a=' + seStr(fit.seC2) + ', b=' + seStr(fit.seC1) + ', c=' + seStr(fit.seC0);
  } else {
    const bsign = fit.b >= 0 ? '+' : '−';
    eqn.textContent = 'E = ' + fit.a.toFixed(4) + '·ADC ' + bsign + ' ' + Math.abs(fit.b).toFixed(2) + ' keV';
    se = 'SE: a=' + seStr(fit.seA) + ', b=' + seStr(fit.seB);
  }
  const warns = [];
  if (pts.length) {
    let lo = Math.min.apply(null, pts.map(p => p.adc));
    let hi = Math.max.apply(null, pts.map(p => p.adc));
    if (calSignal.adc.length) { const r = rangeOf(calSignal.adc); lo = Math.min(lo, r.mn); hi = Math.max(hi, r.mx); }
    if (!calMonotonic(lo, hi)) warns.push(t('cal.warnMono'));
  }
  if (fit.model === 'linear' && fit.a <= 0) warns.push(t('cal.warnSlope'));
  r2.innerHTML = '';
  r2.append('R² = ' + fit.r2.toFixed(4) + '  (n=' + fit.n + ')   ' + se);
  if (warns.length) {
    const w = document.createElement('span');
    w.className = 'fit-warn';
    w.textContent = '   ' + warns.join('  ');
    r2.append(w);
  }
}

function recomputeFit() {
  const pts = collectCalPoints();
  const model = getCalModel();
  const simple = pts.map(p => ({ adc: p.adc, kev: p.kev }));
  calibration = (model === 'quadratic') ? quadraticLeastSquares(simple) : linearLeastSquares(simple);
  const fit = calibration;
  document.querySelectorAll('#calTableBody tr').forEach(tr => {
    const cell = tr.querySelector('.cal-resid');
    const kev = parseFloat(tr.querySelector('.cal-kev').value);
    const adc = parseFloat(tr.querySelector('.cal-adc').value);
    cell.textContent = (fit && isFinite(kev) && isFinite(adc)) ? (calEnergy(adc) - kev).toFixed(1) : '-';
  });
  updateCalReport(fit, pts);
  setUseKeVEnabled(!!(fit && fit.valid));
  renderCalFit();
  if (signal.adc.length) renderAll();   // keep the histogram tab in sync with the new calibration
}

function renderCalFit() {
  const pts = collectCalPoints();
  const traces = [{
    type: 'scatter', mode: 'markers', name: t('cal.trPeaks'),
    x: pts.map(p => p.adc), y: pts.map(p => p.kev),
    text: pts.map(p => p.tr.querySelector('.cal-label').value || ''),
    marker: { color: C.ink, size: 9 },
    hovertemplate: '%{text}<br>ADC %{x}<br>%{y} keV<extra></extra>',
  }];
  if (calibration) {
    let lo = 0, hi = 4095;
    if (pts.length) {
      lo = Math.min.apply(null, pts.map(p => p.adc));
      hi = Math.max.apply(null, pts.map(p => p.adc));
      const pad = (hi - lo) * 0.1 || 100;
      lo = Math.max(0, lo - pad); hi = hi + pad;
    }
    const fx = [], fy = [], steps = 60;
    for (let k = 0; k <= steps; k++) { const x = lo + (hi - lo) * k / steps; fx.push(x); fy.push(calEnergy(x)); }
    traces.push({
      type: 'scatter', mode: 'lines', name: t('cal.trFit', { model: t(calibration.model === 'quadratic' ? 'cal.kindQuad' : 'cal.kindLinear') }),
      x: fx, y: fy, line: { color: C.coral, width: 2 }, hoverinfo: 'skip',
    });
  }
  const showLegend = !!calibration;
  Plotly.react('calFitDiv', traces, themed({
    margin: { l: 64, r: 16, t: showLegend ? 36 : 12, b: 50 },
    showlegend: showLegend,
    hovermode: 'closest',
    dragmode: 'zoom',
    xaxis: { title: { text: t('common.adc') } },
    yaxis: { title: { text: t('common.energy') }, rangemode: 'tozero' },
  }), PLOT_CONFIG);
}

function onCalTableChange() {
  recomputeFit();
  saveCalibration();
}

function useKeVActive() {
  const c = $('useKeV');
  return !!(c && c.checked && !c.disabled && calibration && calibration.valid);
}

function setUseKeVEnabled(enabled) {
  const c = $('useKeV');
  if (!c) return;
  c.disabled = !enabled;
  if (!enabled) c.checked = false;   // never display a stale/invalid calibration
}

// --- Persistence (localStorage auto + explicit save/load + JSON export/import) ---
function serializeCalState() {
  const points = [];
  document.querySelectorAll('#calTableBody tr').forEach(tr => {
    points.push({
      label: tr.querySelector('.cal-label').value,
      kev: tr.querySelector('.cal-kev').value,
      adc: tr.querySelector('.cal-adc').value,
      include: tr.querySelector('.cal-include').checked,
      fwhm: tr.dataset.fwhm || '',
      resol: tr.dataset.resol || '',
    });
  });
  return { version: 1, model: getCalModel(), points, fit: calibration, useKeV: $('useKeV').checked };
}

function saveCalibration() {
  try { localStorage.setItem(CAL_KEY, JSON.stringify(serializeCalState())); } catch (e) { /* storage unavailable */ }
}

function rebuildCalTable(points) {
  const body = $('calTableBody');
  body.innerHTML = '';
  armedRow = null;
  const rows = (points && points.length) ? points : CAL_PRESETS;
  rows.forEach(p => body.appendChild(buildCalRow(p)));
  const first = body.querySelector('tr');
  if (first) setArmed(first);
}

function applyCalState(obj) {
  if (!obj || !Array.isArray(obj.points)) return false;
  $('calModel').value = (obj.model === 'quadratic') ? 'quadratic' : 'linear';
  rebuildCalTable(obj.points);
  recomputeFit();
  const c = $('useKeV');
  if (obj.useKeV && c && !c.disabled) c.checked = true;
  if (signal.adc.length) renderAll();
  return true;
}

function loadCalibration() {
  let raw = null;
  try { raw = localStorage.getItem(CAL_KEY); } catch (e) { return false; }
  if (!raw) return false;
  try { return applyCalState(JSON.parse(raw)); } catch (e) { return false; }
}

function clearCalibration() {
  try { localStorage.removeItem(CAL_KEY); } catch (e) {}
  calibration = null;
  rebuildCalTable(CAL_PRESETS);
  setUseKeVEnabled(false);
  recomputeFit();
  if (signal.adc.length) renderAll();
}

function downloadJSON(obj, name) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// Briefly replace a button's label (the label span keeps its data-i18n, so restore from it).
function flashBtn(id, msg) {
  const b = $(id);
  if (!b) return;
  const span = b.querySelector('[data-i18n]') || b;
  span.textContent = msg;
  setTimeout(() => { span.textContent = t(span.dataset.i18n); }, 1400);
}

function initCalTab() {
  $('calFileInput').addEventListener('change', e => readFile(e.target, (name, text) => {
    calSignal = parseDataFile(text);
    setFileLabel('calFileName', name, calSignal);
    calSuggestions = [];
    calMsg('');
    renderCalHistogram();
  }));
  $('calBinWidth').addEventListener('input', renderCalHistogram);
  $('calLogY').addEventListener('change', renderCalHistogram);
  $('calModel').addEventListener('change', () => { recomputeFit(); saveCalibration(); });
  $('loadPresetBtn').addEventListener('click', () => loadPreset($('calSource').value));
  $('autoPeaksBtn').addEventListener('click', autoDetectPeaks);
  $('clearPeaksBtn').addEventListener('click', clearPeakSuggestions);
  $('addCalRowBtn').addEventListener('click', addCalRow);
  $('saveCalBtn').addEventListener('click', () => { saveCalibration(); calMsg(''); flashBtn('saveCalBtn', t('cal.saved')); });
  $('loadCalBtn').addEventListener('click', () => { calMsg(loadCalibration() ? '' : t('cal.noSaved')); });
  $('clearCalBtn').addEventListener('click', () => { clearCalibration(); calMsg(''); });
  $('exportCalBtn').addEventListener('click', () => downloadJSON(serializeCalState(), 'energy_calibration.json'));
  $('calImportInput').addEventListener('change', e => {
    readFile(e.target, (name, text) => {
      try {
        if (!applyCalState(JSON.parse(text))) { calMsg(t('cal.badFile')); return; }
        calMsg('');
        saveCalibration();
      } catch (err) { calMsg(t('cal.readError', { msg: err.message })); }
    });
    e.target.value = '';   // allow re-importing the same file name
  });
  $('useKeV').addEventListener('change', () => { renderAll(); saveCalibration(); });

  rebuildCalTable(CAL_PRESETS);   // default preset rows
  loadCalibration();              // override from storage if a saved calibration exists
  recomputeFit();                 // equation/plot + useKeV enabled state
}

// ========== Start ==========
function initHistTab() {
  $('fileInput').addEventListener('change', e => readFile(e.target, (name, text) => {
    signal = parseDataFile(text);
    setFileLabel('fileName', name, signal);
    updateTimeHints();
    if (!signal.adc.length) { $('statsRow').hidden = true; Plotly.purge('histDiv'); plotEmpty('histEmpty', true); return; }
    renderAll();
  }));
  $('bgFileInput').addEventListener('change', e => readFile(e.target, (name, text) => {
    background = parseDataFile(text);
    setFileLabel('bgFileName', name, background);
    const sub = $('subtractBg');
    sub.disabled = !background.adc.length;
    sub.checked = !!background.adc.length;
    renderAll();
  }));
  ['binWidth', 'adcMin', 'adcMax', 'timeFrom', 'timeTo', 'bgScale'].forEach(id => $(id).addEventListener('input', renderAll));
  ['subtractBg', 'logY'].forEach(id => $(id).addEventListener('change', renderAll));
}

document.addEventListener('DOMContentLoaded', () => {
  currentLang = detectLanguage();
  document.querySelectorAll('.lang button').forEach(b => b.addEventListener('click', () => setLanguage(b.dataset.lang)));
  document.querySelectorAll('.tabs [role="tab"]').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  const bar = $('topbar');
  const syncHead = () => document.documentElement.style.setProperty('--head-h', bar.offsetHeight + 'px');
  syncHead();
  window.addEventListener('resize', syncHead);

  if (typeof Plotly === 'undefined') {
    // The CDN did not load (offline). The page still shows; the plots say why.
    window.Plotly = { react() {}, purge() {}, Plots: { resize() {} } };
    document.querySelectorAll('.plot-empty').forEach(el => { el.textContent = 'Plotly を読み込めませんでした（インターネットにつないで開き直してください） / Could not load Plotly (needs an internet connection).'; el.removeAttribute('data-i18n'); });
  }

  // Plotly's own "responsive" only follows the window; panels also change width with the layout.
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(entries => { for (const en of entries) resizePlot(en.target.id); });
    ['histDiv', 'linearDiv', 'logDiv', 'calHistDiv', 'calFitDiv'].forEach(id => ro.observe($(id)));
  }

  initHistTab();
  initZenithTable();
  initCalTab();
  applyLanguage();

  let tab = 'tab1';
  try { tab = localStorage.getItem('plotterTab') || 'tab1'; } catch (_) {}
  switchTab(['tab1', 'tab2', 'tab3'].includes(tab) ? tab : 'tab1');
});
