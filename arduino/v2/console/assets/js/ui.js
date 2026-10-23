// CosmicRay Recorder v2 console - screen
//
// 画面の組み立てと操作。core.js の状態を読み、Bus の通知で描き直す。
// 画面は 3 つ: 未接続（つなぐだけ）／計測中（数値とグラフ＋保存の欄）／オシロスコープ。
// 詳細設定は右から引き出すパネル、確認は <dialog>、用語の説明は「?」のポップオーバー。
//
// Web Serial / Web Bluetooth / フォルダ選択はユーザー操作の中でしか呼べないので、
// それらはクリックのハンドラから await を挟まずに直接 core の関数を呼ぶ。

'use strict';

const $ = id => document.getElementById(id);
const qsa = sel => document.querySelectorAll(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svgIcon = name => `<svg class="i"><use href="#i-${name}"/></svg>`;
const reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

function lsGet(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
function lsSet(key, value) { try { localStorage.setItem(key, value); } catch (_) {} }

// Buttons that wait for the board (re-enabled by its reply or a timeout).
const busy = { autoThresh: false, autoThreshM: 0, testVib: false, modeSwitch: null, rename: null };
let uiAlert = null;   // { key, params } raised by core (folder API missing, demo upload)

// ========== Detector model ==========
// v1 / v2 / v2.1 は見た目（ケース）で選んでもらう。v2 はこのページ、v1 は v1.html。
// 選んだ機種は覚えておき、次回からは選ぶ画面を飛ばす（v1 は index.html の head で v1.html へ送る）。
// ?choose を付けて開くと、覚えた機種に関係なく選ぶ画面を出す。
const MODEL_KEY = 'detectorModel';
let modelChosen = false;

function chooseModel(model) {
  lsSet(MODEL_KEY, model);
  if (model === 'v1') { location.href = 'v1.html'; return; }
  modelChosen = true;
  // ?choose を外しておく（付いたままだと再読み込みでまた選ぶ画面になる）
  if (new URLSearchParams(location.search).has('choose')) history.replaceState(null, '', location.pathname + location.hash);
  renderView();
  window.scrollTo(0, 0);
}

function showModelChooser() {
  modelChosen = false;
  renderModelChooser();
  renderView();
  window.scrollTo(0, 0);
}

function renderModelChooser() {
  const last = lsGet(MODEL_KEY);
  qsa('.model[data-model]').forEach(card => {
    card.querySelector('.model-last').hidden = card.dataset.model !== last;
  });
}

// ========== Views ==========
function currentView() {
  if (scope.active) return 'scope';
  if (state.isConnected || state.reconnecting) return 'measure';
  if (state.stats.n > 0 || state.events.length > 0) return 'measure';
  return modelChosen ? 'connect' : 'model';
}

let lastView = null;
function renderView() {
  const v = currentView();
  document.body.dataset.view = v;
  $('viewModel').hidden = v !== 'model';
  $('viewConnect').hidden = v !== 'connect';
  $('viewMeasure').hidden = v !== 'measure';
  $('viewScope').hidden = v !== 'scope';
  if (v !== lastView) {
    lastView = v;
    if (v !== 'measure') document.body.classList.remove('rail-open');
    requestAnimationFrame(() => {
      syncHeights();
      redrawCharts();
      if (v === 'scope') drawScope($('scopeCanvas'));
    });
  }
  renderTopActions();
  renderScopeState();
}

// Header and message strip heights feed the layout (first screen = one viewport).
function syncHeights() {
  if (!$('topbar')) return;
  const root = document.documentElement.style;
  root.setProperty('--head-h', $('topbar').offsetHeight + 'px');
  root.setProperty('--msgs-h', $('msgs').offsetHeight + 'px');
}

// ========== Top bar ==========
function renderStatus() {
  const text = $('statusText'), dot = $('liveDot'), dev = $('statusDevice'), box = $('status');
  if (state.reconnecting) {
    const sec = Math.max(0, Math.ceil((state.reconnectAtMs - Date.now()) / 1000));
    text.textContent = state.reconnectAtMs
      ? t('conn.reconnectWait', { n: state.reconnectAttempt, sec })
      : t('conn.reconnecting', { n: state.reconnectAttempt });
    dot.className = 'live retry';
    dev.textContent = state.conn.bleName || '';
    box.title = '';
    return;
  }
  if (!state.isConnected) {
    text.textContent = t('common.notConnected');
    dot.className = 'live off';
    dev.textContent = '';
    box.title = '';
    return;
  }
  const label = state.connectionType === 'demo' ? t('demo.connected')
              : state.connectionType === 'ble'  ? t('conn.connectedBle')
              : t('conn.connectedUsb');
  text.textContent = state.paused ? label + t('conn.pausedSuffix') : label;
  dot.className = 'live ' + (state.paused ? 'paused' : 'on');
  dev.textContent = state.connectionType === 'demo' ? demo.dev.bleName
                  : (state.bleNameKnown && state.bleName) ? state.bleName
                  : (state.conn.bleName || '');
  // The top bar is narrow, so the details (VID:PID / address) go in the tooltip.
  box.title = connDetailLines().join(' / ');
}

function renderTopActions() {
  const v = document.body.dataset.view;
  const conn = state.isConnected, retry = state.reconnecting;
  $('btnPauseLog').hidden = !conn;
  $('btnDisconnect').hidden = !(conn || retry);
  $('quickConnect').hidden = !(v === 'measure' && !conn && !retry);
  $('btnOpenScope').hidden = v === 'connect' || v === 'model';
  $('btnOpenScope').disabled = !conn;
  const paused = state.paused;
  $('btnPauseLog').querySelector('use').setAttribute('href', paused ? '#i-play' : '#i-pause');
  $('pauseLabel').textContent = t(paused ? 'conn.resumeLogging' : 'conn.stopLogging');
  $('logPausedInfo').hidden = !paused;
}

// Pulse the live dot when events arrive (at most a few times a second).
let lastPingMs = 0;
function pingLiveDot() {
  if (reducedMotion) return;
  const now = performance.now();
  if (now - lastPingMs < 180) return;
  lastPingMs = now;
  const d = $('liveDot');
  d.classList.remove('ping');
  void d.offsetWidth;   // restart the animation
  d.classList.add('ping');
}

// ========== Messages (one strip under the top bar) ==========
function renderMessages() {
  const box = $('msgs');
  box.textContent = '';
  const add = (cls, iconName, text, onClose) => {
    const div = document.createElement('div');
    div.className = 'msg msg-' + cls;
    div.innerHTML = svgIcon(iconName);
    const span = document.createElement('span');
    span.className = 'msg-text';
    span.textContent = text;
    div.appendChild(span);
    if (onClose) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'icon-btn';
      b.title = t('common.close');
      b.setAttribute('aria-label', t('common.close'));
      b.innerHTML = svgIcon('close');
      b.addEventListener('click', onClose);
      div.appendChild(b);
    }
    box.appendChild(div);
  };
  if (connErrorMsg) add('error', 'alert', t(connErrorMsg.key, connErrorMsg.params), clearConnError);
  if (uiAlert) add('error', 'alert', t(uiAlert.key, uiAlert.params), () => { uiAlert = null; renderMessages(); });
  if (state.reconnecting) add('notice', 'info', t('conn.reconnectInfo'));
  if (pageNoticeMsg) add('notice', 'info', t(pageNoticeMsg.key, pageNoticeMsg.params), clearNotice);
  syncHeights();
}

// ========== Connect view ==========
function renderConnectAvailability() {
  const noSerial = !('serial' in navigator);
  const noBle = !('bluetooth' in navigator);
  $('btnConnectUSB').disabled = noSerial;
  $('btnQuickUSB').disabled = noSerial;
  $('btnConnectBLE').disabled = noBle;
  $('btnQuickBLE').disabled = noBle;
  $('usbNA').hidden = !noSerial;
  $('usbNA').textContent = t('warn.noSerial') + ' ' + t('warn.useChrome');
  $('bleNA').hidden = !noBle;
  $('bleNA').textContent = t('warn.noBle') + ' ' + t('warn.useChrome');
  $('btnQuickUSB').title = noSerial ? $('usbNA').textContent : '';
  $('btnQuickBLE').title = noBle ? $('bleNA').textContent : '';
}

// ========== Connection details ==========
// Lines identifying the connected device: shown in the top-bar tooltip and in
// Advanced settings > Connection.
function connDetailLines() {
  const c = state.conn;
  const hex4 = v => (v == null) ? null : v.toString(16).toUpperCase().padStart(4, '0');
  const addr = c.btAddr ? c.btAddr
             : (c.btAddrTimedOut ? t('conn.addrUnknown') : t('conn.addrFetching'));
  const lines = [];
  if (state.connectionType === 'demo') {
    return [t('demo.detail'), `${t('conn.deviceName')}: ${demo.dev.bleName}`, t('demo.detailNote')];
  }
  if (state.connectionType === 'ble') {
    lines.push(t('conn.detailBle'));
    if (c.bleName) lines.push(`${t('conn.deviceName')}: ${c.bleName}`);
    lines.push(`${t('conn.address')}: ${addr}`);
    // Firmware that cannot report its address still gets the browser's identifier.
    if (!c.btAddr && c.bleId) lines.push(`${t('conn.browserId')}: ${c.bleId}`);
  } else {
    lines.push(t('conn.detailUsb'));
    const vid = hex4(c.usbVendorId), pid = hex4(c.usbProductId);
    if (vid && pid) lines.push(`${t('conn.vidpid')}: ${vid}:${pid}`);
    // Web Serial does not expose the COM port number.
    lines.push(`${t('conn.comPort')}: ${t('conn.comUnavailable')}`);
    lines.push(`${t('conn.boardAddr')}: ${addr}`);
  }
  return lines;
}

function renderConnDetail() {
  const list = $('connDetail');
  const show = state.isConnected || state.reconnecting;
  $('connDetailGroup').hidden = !show;
  list.textContent = '';
  if (show) {
    for (const line of connDetailLines()) {
      const li = document.createElement('li');
      li.textContent = line;
      list.appendChild(li);
    }
  }
  renderStatus();
}

// ========== Device settings (Advanced drawer) ==========
const FEATURE_KEYS = { SD: 'sdEnabled', EXT: 'extEnabled', OLED: 'oledEnabled', BUZZER: 'buzzerEnabled', VIB: 'vibEnabled' };

function renderThreshInfo() {
  const el = $('threshInfo');
  if (!state.isConnected) el.textContent = '';
  else if (busy.autoThresh) el.textContent = t('thresh.calibrating', { m: busy.autoThreshM });
  else if (state.threshold != null) el.textContent = t('thresh.current', { sig: state.threshold, duty: state.pwmDuty ?? '?' });
  else el.textContent = t('thresh.fetching');
}

function renderPwmInfo() {
  const el = $('pwmInfo');
  if (!state.isConnected) el.textContent = '';
  else if (state.pwmCalibrating) el.textContent = t('pwm.calibrating', { target: pwmCalTarget });
  else if (state.pwmDuty != null) el.textContent = t('pwm.current', { duty: state.pwmDuty });
  else el.textContent = t('pwm.fetching');
}

function renderBeepInfo() {
  const el = $('beepInfo');
  if (!state.isConnected) el.textContent = '';
  else if (state.beepMin != null) el.textContent = t('beep.current', { min: state.beepMin, max: state.beepMax, ms: state.beepMs });
  else el.textContent = t('beep.fetching');
}

function renderVibInfo() {
  const el = $('vibInfo');
  if (!state.isConnected) el.textContent = '';
  else if (state.vibMin != null) el.textContent = t('vib.current', { min: state.vibMin, max: state.vibMax });
  else el.textContent = t('vib.fetching');
}

const modeName = m => m ? m.charAt(0) + m.slice(1).toLowerCase() : '--';

function renderModeInfo() {
  const el = $('modeInfo');
  if (!state.isConnected) el.textContent = '';
  else if (busy.modeSwitch) el.textContent = t('mode.switching', { mode: modeName(busy.modeSwitch) });
  else if (state.mode) el.textContent = t('mode.current', { mode: modeName(state.mode) });
  else el.textContent = t('mode.fetching');
}

function renderModeButtons() {
  $('modeSelect').querySelectorAll('button').forEach(btn => {
    btn.disabled = !state.isConnected;
    btn.classList.toggle('active', state.isConnected && btn.dataset.mode === state.mode);
  });
  $('modeBadge').textContent = modeName(state.mode);
}

function renderFeatures() {
  qsa('.switch[data-feature]').forEach(sw => {
    const v = state[FEATURE_KEYS[sw.dataset.feature]];
    sw.disabled = !state.isConnected;
    sw.setAttribute('aria-checked', v === true ? 'true' : 'false');
    if (state.isConnected && v == null) {
      sw.dataset.unknown = '';
      sw.title = t('feat.fetching');
    } else {
      delete sw.dataset.unknown;
      sw.title = state.isConnected ? t(v ? 'common.on' : 'common.off') : '';
    }
  });
}

function renderBleNameInfo() {
  const el = $('bleNameInfo');
  el.style.whiteSpace = 'pre-line';
  if (busy.rename) { el.textContent = t('conn.bleNameSaving', { name: busy.rename }); return; }
  el.textContent = state.bleName
    ? t('conn.bleNameCurrent', { name: state.bleName }) + '\n' + t('conn.bleNameHint')
    : t('conn.bleNameHint');
}

function renderDeviceControls() {
  const on = state.isConnected;
  ['btnSetThresh', 'btnGetThresh', 'btnGetPwm', 'btnSetBleName', 'btnSetBeep', 'btnTestBeep', 'btnSetVib']
    .forEach(id => { $(id).disabled = !on; });
  $('btnAutoThresh').disabled = !on || busy.autoThresh;
  $('btnAutoPwm').disabled = !on || state.pwmCalibrating;
  $('btnSetPwm').disabled = !on || state.pwmCalibrating;
  $('btnTestVib').disabled = !on || busy.testVib;
  // The baud rate applies to the next USB connection.
  $('advBaudRate').disabled = on && state.connectionType === 'usb';
  $('drawerOffline').hidden = on;
  renderModeButtons();
  renderFeatures();
}

function renderDeviceAll() {
  renderThreshInfo();
  renderPwmInfo();
  renderBeepInfo();
  renderVibInfo();
  renderModeInfo();
  renderBleNameInfo();
  renderDeviceControls();
}

// Inline message under a field group instead of alert(); cleared on the next edit.
function fieldMsg(id, text) {
  const el = $(id);
  el.textContent = text;
  el.hidden = false;
  const group = el.closest('.group') || el.parentElement;
  const clear = () => { el.hidden = true; group.removeEventListener('input', clear); };
  group.addEventListener('input', clear);
}

// ========== Numbers under the graphs ==========
function updateStats() {
  const s = state.stats;
  const n = s.n;   // every event received, including any dropped from memory at the cap
  $('statTotalEvents').textContent = n.toLocaleString(uiLocale());
  $('ds_total').textContent = n;

  if (n === 0) {
    $('statRate').textContent = '0.000';
    $('statRateErr').textContent = '—';
    $('statAdc').textContent = '--';
    $('statDeadtime').textContent = '--';
    $('statElapsed').textContent = '00:00:00';
    ['ds_elapsed', 'ds_rate', 'ds_rateStd', 'ds_devCounts', 'ds_liveTime', 'ds_deadtime', 'ds_adcMean', 'ds_adcMax',
     'ds_temp', 'ds_tempStd', 'ds_tempRange', 'ds_hum', 'ds_humRange', 'ds_press', 'ds_pressRange', 'ds_digRate', 'ds_anaMean']
      .forEach(id => { $(id).textContent = '--'; });
    return;
  }

  const r = rateSummary();
  const elapsedStr = formatTime(r.elapsedUs / 1000); // formatTime expects ms
  $('statElapsed').textContent = elapsedStr;
  $('ds_elapsed').textContent = elapsedStr + ` (${(r.elapsedUs / 1e6).toFixed(1)} s)`;

  $('statRate').textContent = r.rate.toFixed(3);
  $('statRateErr').textContent = r.rateStd.toFixed(3);
  $('ds_rate').textContent = r.rate.toFixed(4) + ' cps';
  $('ds_rateStd').textContent = r.rateStd.toFixed(4) + ' cps';
  $('ds_devCounts').textContent = r.counts;
  $('ds_liveTime').textContent = formatTime(Math.max(0, r.liveUs) / 1000) + ` (${(r.liveUs / 1e6).toFixed(1)} s)`;

  // Deadtime of this session only (the board's counter runs from boot / RESET).
  const deadSec = r.deadUs / 1e6;
  $('statDeadtime').textContent = deadSec.toFixed(3);
  $('ds_deadtime').textContent = deadSec.toFixed(3) + ' s';

  const avgAdc = s.sumAdc / n;
  $('statAdc').textContent = avgAdc.toFixed(0);
  $('ds_adcMean').textContent = avgAdc.toFixed(1);
  $('ds_adcMax').textContent = s.maxAdc;

  // Each BME280 field is divided by its own count of valid readings; with no
  // sensor the firmware prints "nan" and there is nothing to average (R-12).
  if (s.nTemp > 0) {
    const avgTemp = s.sumTemp / s.nTemp;
    const tempStd = Math.sqrt(Math.max(0, s.sumTemp2 / s.nTemp - avgTemp * avgTemp));
    $('ds_temp').textContent = avgTemp.toFixed(2) + ' °C';
    $('ds_tempStd').textContent = tempStd.toFixed(2) + ' °C';
    $('ds_tempRange').textContent = `${s.maxTemp.toFixed(1)} / ${s.minTemp.toFixed(1)} °C`;
  } else {
    $('ds_temp').textContent = $('ds_tempStd').textContent = $('ds_tempRange').textContent = '--';
  }
  if (s.nHum > 0) {
    $('ds_hum').textContent = (s.sumHum / s.nHum).toFixed(2) + ' %';
    $('ds_humRange').textContent = `${s.maxHum.toFixed(1)} / ${s.minHum.toFixed(1)} %`;
  } else {
    $('ds_hum').textContent = $('ds_humRange').textContent = '--';
  }
  if (s.nPress > 0) {
    $('ds_press').textContent = (s.sumPress / s.nPress).toFixed(2) + ' hPa';
    $('ds_pressRange').textContent = `${s.maxPress.toFixed(1)} / ${s.minPress.toFixed(1)} hPa`;
  } else {
    $('ds_press').textContent = $('ds_pressRange').textContent = '--';
  }

  $('ds_digRate').textContent = s.digHits.map(h => ((h / n) * 100).toFixed(1) + '%').join(' / ');
  $('ds_anaMean').textContent = s.sumAna.map(a => (a / n).toFixed(0)).join(' / ');
}

function updateEnvCards() {
  const n = state.events.length;
  const last = n > 0 ? state.events[n - 1] : null;
  const f = v => (last && !isNaN(v)) ? v.toFixed(1) : '--';
  $('envTemp').textContent  = f(last && last.temp_c);
  $('envHum').textContent   = f(last && last.hum_pct);
  $('envPress').textContent = f(last && last.press_hpa);
}

function updateExtGrid() {
  const n = state.events.length;
  const last = n > 0 ? state.events[n - 1] : null;
  let html = '<span class="ext-list">';
  for (let i = 1; i <= 3; i++) {
    const d = last ? last['d' + i] : null;
    const a = last ? last['a' + i] : '--';
    const title = t('ext.cellTitle', { n: i, d: last ? d : '--', a });
    html += `<span class="ext" title="${esc(title)}"><span class="ext-n">${i}</span>` +
            `<span class="ext-dot${d === 1 ? ' on' : ''}"></span>${esc(a)}</span>`;
  }
  $('extGrid').innerHTML = html + '</span>';
}

function updateTable() {
  const tbody = $('dataTableBody');
  const events = state.events;
  const maxRows = 100;
  // Only the newest maxRows can survive the trim below, so don't build the rest.
  const from = Math.max(lastTableLength, events.length - maxRows);
  const fmt = (v, d = 1) => (isNaN(v) ? '--' : v.toFixed(d));
  for (let i = from; i < events.length; i++) {
    const ev = events[i];
    const row = tbody.insertRow(0);
    // Local time on screen (R-13); saved files keep UTC with a trailing Z.
    row.innerHTML = `<td>${ev.count}</td>
      <td>${formatLocalTimestamp(ev.pc_timestamp)}</td>
      <td>${ev.timestamp_us}</td>
      <td>${ev.adc}</td>
      <td>${ev.deadtime_us}</td>
      <td>${fmt(ev.temp_c, 1)}</td>
      <td>${fmt(ev.hum_pct, 1)}</td>
      <td>${fmt(ev.press_hpa, 1)}</td>
      <td>${ev.d1}</td><td>${ev.d2}</td><td>${ev.d3}</td>
      <td>${ev.a1}</td><td>${ev.a2}</td><td>${ev.a3}</td>`;
  }
  lastTableLength = events.length;
  while (tbody.rows.length > maxRows) tbody.deleteRow(tbody.rows.length - 1);
}

function updateRawDisplay() {
  const el = $('rawDataDisplay');
  el.textContent = state.rawLines.length ? state.rawLines.join('\n') : t('raw.waiting');
  el.scrollTop = el.scrollHeight;
}

function renderExportButtons() {
  const off = exporting || state.events.length === 0;
  $('btnExportDat').disabled = off;
  $('btnExportCsv').disabled = off;
}

function showMemWarningUI() {
  const el = $('memWarning');
  el.hidden = !memWarned;
  if (memWarned) el.textContent = t('warn.memCap', { n: MAX_EVENTS.toLocaleString() });
}

function updateUIBatch() {
  if (!uiDirty) return;
  uiDirty = false;
  updateTable();
  updateEnvCards();
  updateExtGrid();
  updateRawDisplay();
  $('noDataMsg').hidden = state.events.length > 0;
  renderExportButtons();
  renderDemoBand();
}

function updateStatsBatch() {
  if (!statsDirty) return;
  statsDirty = false;
  updateStats();
}

// ========== Graphs ==========
function redrawCharts() {
  if (document.body.dataset.view !== 'measure') return;
  drawHistogram($('histogramChart'));
  drawHitOverlay($('histOverlay'), performance.now());
  drawRate($('rateChart'));
  $('rateDataCount').textContent = state.rateHistory.length;
}

// One rate point per refresh, from the board's counters (core). The histogram
// is redrawn on the same beat; the hit highlight runs on its own.
function refreshCharts() {
  if (document.body.dataset.view === 'measure') drawHistogram($('histogramChart'));
  updateRateChart();
}

let chartRefreshMode = '3000';  // '1000' | '3000' | '10000' | 'manual'
let chartRefreshTimer = null;

function applyChartRefreshMode(mode) {
  chartRefreshMode = mode;
  if (chartRefreshTimer) { clearInterval(chartRefreshTimer); chartRefreshTimer = null; }
  $('refreshSelect').querySelectorAll('button').forEach(b => {
    b.classList.toggle('active', b.dataset.interval === mode);
  });
  if (mode === 'manual') {
    $('btnRefreshNow').disabled = false;
  } else {
    $('btnRefreshNow').disabled = true;
    chartRefreshTimer = setInterval(refreshCharts, parseInt(mode));
  }
}

// Bins hit in the last moment glow; the loop runs only while something glows.
let hitLoopOn = false;
function startHitLoop() {
  if (hitLoopOn || reducedMotion || document.body.dataset.view !== 'measure') return;
  hitLoopOn = true;
  requestAnimationFrame(hitFrame);
}
function hitFrame() {
  const active = drawHitOverlay($('histOverlay'), performance.now());
  if (active && document.body.dataset.view === 'measure' && !document.hidden) requestAnimationFrame(hitFrame);
  else hitLoopOn = false;
}

// PNG of a graph. The canvas is transparent, so paint it white first, or the
// axes vanish in viewers with a dark background. Saved at displayed size x DPR.
function saveChartPng(canvasId, baseName) {
  const src = $(canvasId);
  if (!src || !src.width || !src.height) return;
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(src, 0, 0);
  const name = `${getFilePrefix()}_${baseName}_${formatDateForFile()}.png`;
  out.toBlob(blob => { if (blob) downloadBlob(name, blob); }, 'image/png');
}

// ========== Save rail ==========
function updateAutoSaveUI() {
  const as = state.autoSave;
  const enabled = !!(as.enabled && as.dirHandle);
  const st = $('autoSaveStatus');
  $('autoSaveIntro').hidden = enabled;
  $('selectFolderLabel').textContent = t(enabled ? 'autosave.change' : 'autosave.selectFolder');
  $('btnSelectFolder').className = 'btn ' + (enabled ? 'btn-line' : 'btn-primary');
  $('btnPreFolder').hidden = enabled;
  $('preFolderInfo').hidden = !enabled;
  $('fabDot').classList.toggle('on', enabled && !as.lastError);
  if (!enabled) { st.hidden = true; return; }

  const format = settings.autoSaveFormat;
  const main = format === 'csv' ? 'csv' : 'dat';
  const ext = format === 'both' ? '.dat / .csv' : '.' + format;
  // The file actually written last, or the one the next write will start.
  const stem = as.lastFile[main]
    ? as.lastFile[main].replace(/\.(dat|csv)$/, '')
    : `${demo.on ? 'DEMO_' : ''}${as.prefix || getFileBase()}_${formatLocalDate(new Date())}`;
  const pending = autoSavePendingCount();
  const parts = [
    `<div class="as-head">${esc(t('autosave.saving'))}</div>`,
    `<div class="as-file">${esc(stem + ext)}</div>`,
    `<div class="as-count">${esc(t('autosave.written', { n: as.written[main].toLocaleString(uiLocale()) }))}</div>`,
  ];
  if (as.intervalMs >= 2 * AUTOSAVE_MIN_INTERVAL_MS) {
    parts.push(`<div class="as-note">${esc(t('autosave.slow', { sec: Math.round(as.intervalMs / 1000) }))}</div>`);
  }
  // Events that would be lost if the tab closed right now (N-15).
  if (pending > 0 && (as.intervalMs >= 2 * AUTOSAVE_MIN_INTERVAL_MS || as.lastError)) {
    parts.push(`<div class="as-note">${esc(t('autosave.pending', { n: pending }))}</div>`);
  }
  if (as.lastError) parts.push(`<div class="as-err">${esc(t('autosave.writeError', { msg: as.lastError }))}</div>`);
  st.className = 'autosave-status' + (as.lastError ? ' as-error' : '');
  st.innerHTML = parts.join('');
  st.hidden = false;
}

// The band stays while synthetic data is on screen, even after the demo stops.
function renderDemoBand() {
  const n = state.events.length;
  const synthetic = demo.on || (n > 0 && state.events[n - 1].demo);
  if ($('demoBanner').hidden === !synthetic) return;
  $('demoBanner').hidden = !synthetic;
  syncHeights();
}

function renderDemoUI() {
  $('demoSection').hidden = !demo.on;
  renderDemoBand();
  $('demoRateLabel').textContent = t('demo.rate', { r: demoFmtRate(demo.rate) });
  $('demoScenarioInfo').textContent = t('demo.sc.' + demo.scenario);
  $('demoScenario').querySelectorAll('button').forEach(b => {
    b.classList.toggle('active', b.dataset.scenario === demo.scenario);
  });
  renderDemoInfo();
}

function renderDemoInfo() {
  const el = $('demoInfo');
  if (!demo.on) { el.textContent = ''; return; }
  const now = performance.now();
  const lines = [t('demo.info', {
    lam: demoFmtRate(demoRate(now)),
    n: demo.count.toLocaleString(uiLocale()),
    temp: demo.env.temp.toFixed(1),
    press: demo.env.press.toFixed(1),
  })];
  if (demo.scope.on) lines.push(t('demo.infoScope'));
  else if (now < demo.burstUntilMs) lines.push(t('demo.infoBurst'));
  el.textContent = lines.join('\n');
}

// ========== Server upload (Advanced drawer) ==========
function uploadSetButtons() {
  const u = state.upload;
  const loggedIn = !!u.token;
  $('btnUploadLogin').disabled  = u.loggingIn || u.enabled;
  $('btnUploadStart').disabled  = !loggedIn || u.enabled || u.loggingIn || demo.on;
  $('btnUploadStop').disabled   = !u.enabled;
  $('btnUploadResend').disabled = !loggedIn || !u.enabled;
  $('btnUploadLogout').disabled = !loggedIn || u.enabled;
  // Locking the identity fields while running avoids silently switching streams
  // mid-run; everything else stays editable.
  ['uploadServer', 'uploadStationId', 'uploadPassword'].forEach(id => { $(id).disabled = u.enabled; });
}

function updateUploadUI() {
  const u = state.upload;
  const el = $('uploadStatus');
  const counters = $('uploadCounters');
  uploadSetButtons();
  const queued = u.queue.length;
  let cls = 'idle', text;
  if (u.loggingIn) {
    text = t('upload.stLoggingIn');
  } else if (u.authError) {
    cls = 'error'; text = u.lastError || t('upload.stAuthError');
  } else if (!u.serverUrl || !u.stationId || !u.token) {
    text = t('upload.stNotConfigured');
  } else if (!u.enabled) {
    text = t('upload.stReady', { id: u.stationId });
  } else if (navigator.onLine === false) {
    cls = 'warn'; text = t('upload.stOffline', { queued });
  } else if (u.attempt > 0) {
    const sec = Math.max(0, Math.ceil((u.nextAttemptMs - Date.now()) / 1000));
    cls = 'warn'; text = t('upload.stRetrying', { attempt: u.attempt, sec, msg: u.lastError || '' });
  } else if (queued > UPLOAD_QUEUE_SOFT) {
    cls = 'warn'; text = t('upload.stBacklog', { queued });
  } else {
    cls = 'active'; text = t('upload.stActive', { mode: u.apiMode, sent: u.sent, queued });
  }
  el.className = 'upload-status ' + cls;
  el.textContent = text;

  // Losses and refusals are always visible, never folded into the main line.
  const extra = [];
  if (u.dropped > 0) extra.push(t('upload.stDropped', { n: u.dropped }));
  if (u.rejected.length > 0) extra.push(t('upload.stRejected', { n: u.rejected.length }));
  if (u.enabled && u.apiMode === 'legacy') extra.push(t('upload.legacyMode'));
  if (isInsecureServerUrl(u.serverUrl)) extra.push(t('upload.insecure'));
  counters.textContent =
    t('upload.counters', { sent: u.sent, queued, skipped: u.skipped, dropped: u.dropped, rejected: u.rejected.length }) +
    (extra.length ? '\n' + extra.join('\n') : '');
}

Hooks.readUploadForm = () => {
  const u = state.upload;
  u.serverUrl   = $('uploadServer').value.trim().replace(/\/+$/, '');
  u.stationId   = $('uploadStationId').value.trim();
  u.deviceLabel = $('uploadDeviceLabel').value.trim();
  u.lat         = $('uploadLat').value.trim();
  u.lon         = $('uploadLon').value.trim();
  u.decimate    = Math.max(1, parseInt($('uploadDecimate').value) || 1);
  u.remember    = $('uploadRemember').checked;
  uploadPassword = $('uploadPassword').value;
};

function fillUploadForm() {
  const u = state.upload;
  $('uploadServer').value      = u.serverUrl;
  $('uploadStationId').value   = u.stationId;
  $('uploadDeviceLabel').value = u.deviceLabel;
  $('uploadLat').value         = u.lat;
  $('uploadLon').value         = u.lon;
  $('uploadDecimate').value    = String(u.decimate);
  $('uploadRemember').checked  = u.remember;
  $('uploadPassword').value    = uploadPassword;
  $('uploadRememberWarn').hidden = !u.remember;
}

// ========== Oscilloscope view ==========
function scopeStats() {
  const last = scope.traces[scope.traces.length - 1];
  $('scopePeak').textContent  = last ? Math.round(last.peak) : '--';
  $('scopeTPeak').textContent = last ? last.tPeak.toFixed(1) : '--';
  $('scopeCount').textContent = scope.count;
  $('scopeBad').textContent   = scope.bad;
  const now = Date.now();
  $('scopeFps').textContent = (scope.stamps.filter(s => now - s < 5000).length / 5).toFixed(1);
}

// Scope left on by an earlier page while this one is not showing it.
function renderScopeBadge() {
  const el = $('scopeBadge');
  const on = scope.deviceOn && state.isConnected && !scope.active;
  el.hidden = !on;
  if (!on) return;
  const since = scope.deviceOnSinceMs ? formatTime(Date.now() - scope.deviceOnSinceMs) : '';
  el.textContent = t('scope.countingPausedFor', { time: since });
  el.title = t('scope.chipTitle');
}

// In the scope view the top bar says, all the time, that counting is stopped.
function renderScopeState() {
  const el = $('scopeState');
  if (!scope.active) { el.textContent = ''; return; }
  if (!state.isConnected) {
    el.innerHTML = `<span class="mode-text">${esc(t('scope.title'))} · ${esc(t('common.notConnected'))}</span>`;
  } else if (scope.deviceOn) {
    const since = scope.deviceOnSinceMs ? formatTime(Date.now() - scope.deviceOnSinceMs) : '';
    el.innerHTML = `<span class="stop-mark"></span>` +
      `<span class="stop-text">${esc(t('scope.countingPausedFor', { time: since }))}</span>` +
      `<span class="mode-text">${esc(t('scope.title'))}</span>`;
  } else {
    el.innerHTML = `<span class="mode-text">${esc(t('scope.preparing'))}</span>`;
  }
}

// The trigger buttons and the re-arm box follow the settings (which the board's replies also set).
// Free-run has no trigger, so there is nothing to re-arm.
function renderScopeTrig() {
  const free = settings.scopeTrig === 'FREE';
  document.querySelectorAll('#scopeTrig button').forEach(b => {
    const on = b.dataset.trig === (free ? 'FREE' : 'NORMAL');
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  $('scopeRearm').value = settings.scopeRearm;
  $('scopeRearm').disabled = free;
  $('scopeRearmBox').classList.toggle('muted', free);
}

function renderScopeControls() {
  renderScopeTrig();
  $('scopeBleWarn').hidden = state.connectionType !== 'ble';
  $('scopeFreezeLabel').textContent = t(scope.frozen ? 'scope.unfreeze' : 'scope.freeze');
  $('scopeFreeze').querySelector('use').setAttribute('href', scope.frozen ? '#i-play' : '#i-pause');
}

async function openScope() {
  if (scope.active || !state.isConnected) return;
  if (lsGet('consoleScopeNoConfirm') !== '1') {
    const ok = await askConfirm({
      title: t('scope.confirmTitle'),
      body: t('scope.confirmBody'),
      ok: t('scope.confirmOk'),
      skipKey: 'consoleScopeNoConfirm',
    });
    if (!ok || scope.active || !state.isConnected) return;
  }
  closeDrawer();
  closePop();
  scopeEnter();   // SET_SCOPE_RATE + SET_SCOPE:ON through the command queue
  renderView();
  renderScopeControls();
  scopeStats();
}

// Leaving always turns the scope off, or counting would stay stopped.
function closeScope() {
  if (!scope.active) return;
  scopeLeave();
  renderView();
  renderScopeBadge();
}
Hooks.closeScope = closeScope;

// ========== Advanced drawer ==========
let drawerReturnFocus = null;
function openDrawer() {
  const d = $('drawer');
  if (d.classList.contains('open')) return;
  drawerReturnFocus = document.activeElement;
  d.classList.add('open');
  d.setAttribute('aria-hidden', 'false');
  $('btnOpenAdvanced').setAttribute('aria-expanded', 'true');
  $('btnCloseDrawer').focus({ preventScroll: true });
}
function closeDrawer() {
  const d = $('drawer');
  if (!d.classList.contains('open')) return;
  d.classList.remove('open');
  d.setAttribute('aria-hidden', 'true');
  $('btnOpenAdvanced').setAttribute('aria-expanded', 'false');
  closePop();
  if (drawerReturnFocus && document.contains(drawerReturnFocus)) drawerReturnFocus.focus({ preventScroll: true });
}

// ========== Confirmation dialog ==========
function askConfirm({ title, body, ok, danger, skipKey }) {
  const dlg = $('dlg');
  if (typeof dlg.showModal !== 'function') return Promise.resolve(window.confirm(title + '\n\n' + body));
  return new Promise(resolve => {
    $('dlgTitle').textContent = title;
    $('dlgBody').textContent = body;
    $('dlgOk').textContent = ok || t('common.ok');
    $('dlgOk').className = 'btn btn-primary' + (danger ? ' dlg-ok-danger' : '');
    $('dlgSkipWrap').hidden = !skipKey;
    $('dlgSkip').checked = false;
    dlg.returnValue = '';
    // Resolve from the buttons themselves: Chrome delays the dialog's 'close'
    // event while the page is in the background, which left the answer pending.
    let done = false;
    const finish = yes => {
      if (done) return;
      done = true;
      $('dlgOk').removeEventListener('click', onOk);
      $('dlgCancel').removeEventListener('click', onCancel);
      dlg.removeEventListener('close', onClose);
      if (dlg.open) dlg.close(yes ? 'ok' : 'cancel');
      if (yes && skipKey && $('dlgSkip').checked) lsSet(skipKey, '1');
      resolve(yes);
    };
    const onOk = e => { e.preventDefault(); finish(true); };
    const onCancel = e => { e.preventDefault(); finish(false); };
    const onClose = () => finish(dlg.returnValue === 'ok');   // Esc and anything else
    $('dlgOk').addEventListener('click', onOk);
    $('dlgCancel').addEventListener('click', onCancel);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    (danger ? $('dlgCancel') : $('dlgOk')).focus();
  });
}

// ========== Glossary popover ==========
let popFor = null;
function openPop(btn) {
  const [title, body] = glossary(btn.dataset.term);
  $('popTitle').textContent = title;
  $('popBody').textContent = body;
  const pop = $('pop');
  pop.hidden = false;
  const r = btn.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const x = Math.min(Math.max(8, r.left + r.width / 2 - pw / 2), window.innerWidth - pw - 8);
  let y = r.bottom + 8;
  if (y + ph > window.innerHeight - 8) y = Math.max(8, r.top - ph - 8);
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
  if (popFor && popFor !== btn) popFor.setAttribute('aria-expanded', 'false');
  popFor = btn;
  btn.setAttribute('aria-expanded', 'true');
}
function closePop() {
  $('pop').hidden = true;
  if (popFor) popFor.setAttribute('aria-expanded', 'false');
  popFor = null;
}

// ========== Language ==========
function setLanguage(lang) {
  currentLang = (lang === 'ja') ? 'ja' : 'en';
  lsSet('uiLang', currentLang);
  applyLanguage();
}

function applyLanguage() {
  document.documentElement.lang = currentLang;
  document.title = t('app.title');
  qsa('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  qsa('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  qsa('[data-i18n-title]').forEach(el => {
    const s = t(el.dataset.i18nTitle);
    el.title = s;
    el.setAttribute('aria-label', s);
  });
  qsa('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  qsa('.term').forEach(el => {
    const s = t('gloss.label', { term: glossary(el.dataset.term)[0] });
    el.title = s;
    el.setAttribute('aria-label', s);
  });
  qsa('.lang button').forEach(b => {
    b.classList.toggle('active', b.dataset.lang === currentLang);
    b.setAttribute('aria-pressed', b.dataset.lang === currentLang ? 'true' : 'false');
  });
  if (popFor) openPop(popFor);
  renderEverything();
}

function renderEverything() {
  renderView();
  renderStatus();
  renderMessages();
  renderConnectAvailability();
  renderDeviceAll();
  renderConnDetail();
  renderScopeBadge();
  renderScopeState();
  renderScopeControls();
  renderDemoUI();
  updateAutoSaveUI();
  updateUploadUI();
  updateStats();
  updateEnvCards();
  updateExtGrid();
  updateRawDisplay();
  showMemWarningUI();
  renderExportButtons();
  scopeStats();
  redrawCharts();
  if (scope.active) drawScope($('scopeCanvas'));
}

// ========== Core notifications ==========
Bus.on('status', renderStatus);
Bus.on('connDetail', renderConnDetail);
Bus.on('messages', renderMessages);
Bus.on('alert', a => { uiAlert = a; renderMessages(); });
// "Clear the demo data first" has done its job once the data is cleared.
Bus.on('cleared', () => { if (uiAlert && /^demo\.mixed/.test(uiAlert.key)) { uiAlert = null; renderMessages(); } });
Bus.on('paused', () => { renderTopActions(); renderStatus(); });

Bus.on('conn', connected => {
  if (!connected) {
    busy.autoThresh = false;
    busy.testVib = false;
    busy.modeSwitch = null;
  }
  renderView();
  renderStatus();
  renderMessages();
  renderDeviceAll();
  renderConnDetail();
  renderScopeBadge();
  renderScopeControls();
  renderDemoUI();
  updateUploadUI();
});

Bus.on('device', key => {
  switch (key) {
    case 'thresh':
      $('threshSignal').value = settings.threshSignal;
      busy.autoThresh = false;
      renderThreshInfo();
      renderDeviceControls();
      if (scope.active) drawScope($('scopeCanvas'));
      break;
    case 'pwm':
      $('pwmDuty').value = state.pwmDuty;
      renderThreshInfo();
      renderPwmInfo();
      break;
    case 'pwmCal':
      renderPwmInfo();
      renderDeviceControls();
      break;
    case 'mode':
      busy.modeSwitch = null;
      renderModeInfo();
      renderModeButtons();
      break;
    case 'margin':
      $('autoMargin').value = state.autoMargin;
      break;
    case 'beep':
      $('beepMin').value = state.beepMin;
      $('beepMax').value = state.beepMax;
      $('beepMs').value = state.beepMs;
      renderBeepInfo();
      break;
    case 'vib':
      $('vibMin').value = state.vibMin;
      $('vibMax').value = state.vibMax;
      renderVibInfo();
      break;
    case 'blename':
      $('bleName').value = settings.bleName;
      $('advBleName').value = settings.bleName;
      busy.rename = null;
      renderBleNameInfo();
      renderStatus();
      break;
    case 'feature':
      renderFeatures();
      break;
    case 'scopeRate':
      $('scopeRate').value = settings.scopeRate;
      break;
    case 'scopeRearm':
    case 'scopeTrig':
      renderScopeTrig();
      if (scope.active) drawScope($('scopeCanvas'));
      break;
  }
});

Bus.on('hit', () => { pingLiveDot(); startHitLoop(); });
Bus.on('hist', () => {
  if (document.body.dataset.view !== 'measure') return;
  drawHistogram($('histogramChart'));
  drawHitOverlay($('histOverlay'), performance.now());
});
Bus.on('rate', () => {
  $('rateDataCount').textContent = state.rateHistory.length;
  if (document.body.dataset.view === 'measure') drawRate($('rateChart'));
});

Bus.on('autosave', updateAutoSaveUI);
Bus.on('upload', updateUploadUI);
Bus.on('uploadForm', fillUploadForm);
Bus.on('uploadPasswordCleared', () => { $('uploadPassword').value = ''; });
Bus.on('memwarn', showMemWarningUI);

let exportHideTimer = null;
Bus.on('export', d => {
  const el = $('exportStatus');
  if (d.busy !== undefined) { renderExportButtons(); return; }
  el.hidden = false;
  if (d.error) {
    el.className = 'warn-text';
    el.textContent = t('export.error', { msg: d.error });
    return;
  }
  el.className = 'hint';
  if (d.finished) {
    el.textContent = t('export.saved', { n: d.total.toLocaleString(uiLocale()) });
    clearTimeout(exportHideTimer);
    exportHideTimer = setTimeout(() => { if (!exporting) el.hidden = true; }, 4000);
  } else {
    el.textContent = t('export.progress', { done: d.done.toLocaleString(uiLocale()), total: d.total.toLocaleString(uiLocale()) });
  }
});

Bus.on('scopeDevice', () => { renderScopeBadge(); renderScopeState(); });
Bus.on('scopeMode', () => { renderView(); renderScopeControls(); });
Bus.on('scopeStats', scopeStats);
Bus.on('scopeDraw', () => { if (scope.active) drawScope($('scopeCanvas')); });

Bus.on('demo', renderDemoUI);
Bus.on('demoInfo', renderDemoInfo);

Bus.on('cleared', () => {
  $('dataTableBody').innerHTML = '';
  $('noDataMsg').hidden = false;
  $('exportStatus').hidden = true;
  $('rateDataCount').textContent = 0;
  updateRawDisplay();
  showMemWarningUI();
  renderExportButtons();
  updateStats();
  updateEnvCards();
  updateExtGrid();
  renderDemoBand();
  renderView();
  redrawCharts();
});

// ========== Controls ==========
function bindControls() {
  // --- language
  qsa('.lang button').forEach(btn => btn.addEventListener('click', () => setLanguage(btn.dataset.lang)));

  // --- detector model
  qsa('.model[data-model]').forEach(card => card.addEventListener('click', () => chooseModel(card.dataset.model)));
  $('btnChangeModel').addEventListener('click', showModelChooser);

  // --- connect (user activation: call straight through)
  $('btnConnectUSB').addEventListener('click', connectUSB);
  $('btnConnectBLE').addEventListener('click', connectBLE);
  $('btnConnectDemo').addEventListener('click', connectDemo);
  $('btnQuickUSB').addEventListener('click', connectUSB);
  $('btnQuickBLE').addEventListener('click', connectBLE);
  $('btnQuickDemo').addEventListener('click', connectDemo);
  $('btnDisconnect').addEventListener('click', disconnect);
  $('btnPauseLog').addEventListener('click', toggleLogging);
  $('btnPreFolder').addEventListener('click', selectSaveFolder);

  // Both name boxes are the same setting (the Bluetooth name filter).
  ['bleName', 'advBleName'].forEach(id => {
    $(id).addEventListener('input', () => {
      settings.bleName = $(id).value;
      const other = id === 'bleName' ? 'advBleName' : 'bleName';
      $(other).value = $(id).value;
    });
  });
  ['baudRate', 'advBaudRate'].forEach(id => {
    $(id).addEventListener('change', () => {
      settings.baudRate = parseInt($(id).value) || 9600;
      $('baudRate').value = $('advBaudRate').value = String(settings.baudRate);
    });
  });

  // --- top bar
  $('btnOpenScope').addEventListener('click', openScope);
  $('btnCloseScope').addEventListener('click', closeScope);
  $('btnOpenAdvanced').addEventListener('click', () => {
    if ($('drawer').classList.contains('open')) closeDrawer(); else openDrawer();
  });
  $('btnCloseDrawer').addEventListener('click', closeDrawer);

  // --- graphs
  $('binWidth').addEventListener('change', () => {
    settings.binWidth = parseInt($('binWidth').value);
    rebuildHistogram();
    uiDirty = true;
  });
  $('histLogScale').addEventListener('change', () => {
    settings.histLog = $('histLogScale').checked;
    if (document.body.dataset.view === 'measure') {
      drawHistogram($('histogramChart'));
      drawHitOverlay($('histOverlay'), performance.now());
    }
  });
  $('btnSaveHistPng').addEventListener('click', () => saveChartPng('histogramChart', 'histogram'));
  $('btnSaveRatePng').addEventListener('click', () => saveChartPng('rateChart', 'rate'));
  $('refreshSelect').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => applyChartRefreshMode(btn.dataset.interval));
  });
  $('btnRefreshNow').addEventListener('click', refreshCharts);

  // --- data tabs
  qsa('.data-tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      qsa('.data-tabs button').forEach(b => b.setAttribute('aria-selected', b === btn ? 'true' : 'false'));
      qsa('.dpanel').forEach(p => { p.hidden = p.id !== 'dtab-' + btn.dataset.dtab; });
    });
  });

  // --- save rail
  $('btnSelectFolder').addEventListener('click', selectSaveFolder);
  $('autoSaveFormat').addEventListener('change', () => {
    settings.autoSaveFormat = $('autoSaveFormat').value;
    updateAutoSaveUI();
  });
  $('fileComment').addEventListener('input', () => { settings.fileComment = $('fileComment').value; });
  $('btnExportDat').addEventListener('click', exportDat);
  $('btnExportCsv').addEventListener('click', exportCsv);
  // Clears the page AND resets the board's counter (RESET). Ask whenever it
  // would do something irreversible: data on the page, or a board to reset.
  $('btnClearData').addEventListener('click', async () => {
    if (state.events.length > 0 || state.isConnected) {
      const ok = await askConfirm({
        title: t('confirm.clearTitle'), body: t('confirm.clear'), ok: t('confirm.clearOk'), danger: true,
      });
      if (!ok) return;
    }
    clearAllData();
  });
  $('btnSaveFab').addEventListener('click', () => document.body.classList.toggle('rail-open'));
  $('btnCloseRail').addEventListener('click', () => document.body.classList.remove('rail-open'));

  // --- demo
  $('demoScenario').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      demo.scenario = btn.dataset.scenario;
      demo.burstUntilMs = 0;
      demo.nextBurstMs = performance.now() + 4000;
      renderDemoUI();
    });
  });
  $('demoRate').addEventListener('input', () => {
    demo.rate = demoSliderToRate(parseInt($('demoRate').value) || 0);
    $('demoRateLabel').textContent = t('demo.rate', { r: demoFmtRate(demo.rate) });
  });
  $('btnDemoBurst').addEventListener('click', demoInjectBurst);
  $('demoSound').addEventListener('change', () => {
    demo.sound = $('demoSound').checked;
    // An AudioContext can only be started from a user action, so create it here.
    if (demo.sound) {
      try {
        if (!demo.audio) demo.audio = new (window.AudioContext || window.webkitAudioContext)();
        if (demo.audio.state === 'suspended') demo.audio.resume();
      } catch (_) {}
    }
  });

  // --- thresholds and trigger
  $('threshSignal').addEventListener('input', () => { settings.threshSignal = $('threshSignal').value; });
  $('btnSetThresh').addEventListener('click', () => {
    const sig = parseInt($('threshSignal').value);
    if (isNaN(sig) || sig < 0 || sig > ADC_MAX) { fieldMsg('threshMsg', t('alert.threshRange', { max: ADC_MAX })); return; }
    sendCommand(`SET_THRESH:${sig}`);
  });
  $('btnGetThresh').addEventListener('click', () => sendCommand('GET_THRESH'));
  $('btnAutoThresh').addEventListener('click', () => {
    const m = parseInt($('autoMargin').value);
    if (isNaN(m) || m < 0 || m > ADC_MAX) { fieldMsg('marginMsg', t('alert.marginRange', { max: ADC_MAX })); return; }
    busy.autoThresh = true;
    busy.autoThreshM = m;
    renderThreshInfo();
    renderDeviceControls();
    sendCommand(`AUTO_THRESH:${m}`);
    setTimeout(() => { busy.autoThresh = false; renderThreshInfo(); renderDeviceControls(); }, 3000);
  });
  // Comparator threshold (D2 PWM), R-4.
  $('btnSetPwm').addEventListener('click', () => {
    // Number('') is 0, which would send SET_PWM:0 from an empty box
    const raw = $('pwmDuty').value.trim();
    const duty = raw === '' ? NaN : Number(raw);
    if (!Number.isInteger(duty) || duty < 0 || duty > 255) { fieldMsg('pwmMsg', t('alert.pwmRange')); return; }
    sendCommand(`SET_PWM:${duty}`);
  });
  $('btnGetPwm').addEventListener('click', () => sendCommand('GET_PWM'));
  $('btnAutoPwm').addEventListener('click', () => {
    const rawTarget = $('pwmTarget').value.trim();
    const target = rawTarget === '' ? NaN : Number(rawTarget);
    if (!Number.isInteger(target) || target < 0) { fieldMsg('pwmTargetMsg', t('alert.pwmTarget')); return; }
    pwmCalTarget = target;
    setPwmCalibrating(true);
    sendCommand(target === 50 ? 'AUTO_PWM' : `AUTO_PWM:${target}`);
  });
  $('modeSelect').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!state.isConnected || btn.disabled) return;
      const m = btn.dataset.mode;
      if (!VALID_MODES.includes(m)) return;
      busy.modeSwitch = m;
      renderModeInfo();
      sendCommand(`SET_MODE:${m}`);
    });
  });

  // --- feature switches: send the opposite of what the board reported
  qsa('.switch[data-feature]').forEach(sw => {
    sw.addEventListener('click', () => {
      if (!state.isConnected || sw.disabled) return;
      const feat = sw.dataset.feature;
      const cur = state[FEATURE_KEYS[feat]];
      sendCommand(`SET_${feat}:${cur === true ? 'OFF' : 'ON'}`);
    });
  });

  // --- beep / vibration
  $('btnSetBeep').addEventListener('click', () => {
    const mn = parseInt($('beepMin').value), mx = parseInt($('beepMax').value), ms = parseInt($('beepMs').value);
    if (isNaN(mn) || isNaN(mx) || isNaN(ms) || mn < 50 || mx <= mn || mx > 20000 || ms < 1 || ms > 500) {
      fieldMsg('beepMsg', t('beep.range'));
      return;
    }
    sendCommand(`SET_BEEP:${mn},${mx},${ms}`);
  });
  $('btnTestBeep').addEventListener('click', () => sendCommand('BEEP_TEST'));
  $('btnSetVib').addEventListener('click', () => {
    const mn = parseInt($('vibMin').value), mx = parseInt($('vibMax').value);
    if (isNaN(mn) || isNaN(mx) || mn < 1 || mx <= mn || mx > 500) { fieldMsg('vibMsg', t('vib.range')); return; }
    sendCommand(`SET_VIB_MS:${mn},${mx}`);
  });
  // VIB_TEST blocks the firmware while it vibrates three times.
  $('btnTestVib').addEventListener('click', () => {
    busy.testVib = true;
    renderDeviceControls();
    sendCommand('VIB_TEST');
    setTimeout(() => { busy.testVib = false; renderDeviceControls(); }, 2000);
  });

  // --- Bluetooth name. Saved locally only when the board answers BLENAME: (R-7).
  $('btnSetBleName').addEventListener('click', async () => {
    const name = ($('advBleName').value || '').trim();
    if (!/^[\x20-\x7E]{1,19}$/.test(name)) { fieldMsg('bleNameMsg', t('alert.bleName')); return; }
    const ok = await askConfirm({ title: t('confirm.renameTitle'), body: t('confirm.rename', { name }), ok: t('confirm.renameOk') });
    if (!ok) return;
    sendCommand(`SET_BLENAME:${name}`);
    busy.rename = name;
    renderBleNameInfo();
  });

  // --- server upload
  $('btnUploadLogin').addEventListener('click', () => { uploadLogin(); });
  $('btnUploadStart').addEventListener('click', uploadStart);
  $('btnUploadStop').addEventListener('click', () => { uploadStop(); });
  $('btnUploadLogout').addEventListener('click', uploadLogout);
  $('btnUploadResend').addEventListener('click', uploadResend);
  $('uploadRemember').addEventListener('change', () => {
    state.upload.remember = $('uploadRemember').checked;
    $('uploadRememberWarn').hidden = !state.upload.remember;
    uploadPassword = $('uploadPassword').value;
    saveUploadConfig();
  });
  ['uploadServer', 'uploadStationId', 'uploadDeviceLabel', 'uploadLat', 'uploadLon', 'uploadDecimate'].forEach(id => {
    $(id).addEventListener('change', () => {
      readUploadForm();
      saveUploadConfig();
      updateUploadUI();
    });
  });
  $('uploadPassword').addEventListener('change', () => {
    uploadPassword = $('uploadPassword').value;
    if (state.upload.remember) saveUploadConfig();
  });

  // --- oscilloscope controls
  $('scopeRate').addEventListener('change', () => {
    const v = Math.min(20, Math.max(1, parseInt($('scopeRate').value) || 3));
    $('scopeRate').value = v;
    settings.scopeRate = v;
    if (state.isConnected && scope.active) sendCommand('SET_SCOPE_RATE:' + v);
  });
  // Re-arm: how far below the threshold the signal has to fall before the next waveform is taken
  // (default 5). The line follows the threshold, also while it is dragged. An empty or unreadable
  // box goes back to the default. The board answers with SCOPE_REARM:, which settles the box.
  $('scopeRearm').addEventListener('change', () => {
    let v = parseInt($('scopeRearm').value);
    if (isNaN(v)) v = 5;
    v = Math.min(ADC_MAX, Math.max(0, v));
    settings.scopeRearm = String(v);
    $('scopeRearm').value = settings.scopeRearm;
    if (state.isConnected && scope.active) sendCommand('SET_SCOPE_REARM:' + v);
    drawScope($('scopeCanvas'));
  });
  // Trigger / free-run. The waveforms already on screen belong to the other kind: start over.
  document.querySelectorAll('#scopeTrig button').forEach(btn => btn.addEventListener('click', () => {
    const next = btn.dataset.trig === 'FREE' ? 'FREE' : 'NORMAL';
    if (next === settings.scopeTrig) return;
    settings.scopeTrig = next;
    scope.traces = [];
    renderScopeTrig();
    if (state.isConnected && scope.active) sendCommand('SET_SCOPE_TRIG:' + next);
    drawScope($('scopeCanvas'));
  }));
  $('scopePersist').addEventListener('change', () => {
    settings.scopePersist = $('scopePersist').value;
    drawScope($('scopeCanvas'));
  });
  $('scopeAutoY').addEventListener('change', () => {
    settings.scopeAutoY = $('scopeAutoY').checked;
    drawScope($('scopeCanvas'));
  });
  $('scopeFreeze').addEventListener('click', () => {
    scope.frozen = !scope.frozen;
    renderScopeControls();
  });
  $('scopeClear').addEventListener('click', () => {
    scope.traces = []; scope.raw = []; scope.count = 0; scope.bad = 0; scope.stamps = [];
    scopeStats();
    drawScope($('scopeCanvas'));
  });
  $('scopeSave').addEventListener('click', () => {
    if (!scope.raw.length) return;
    const hdr = `#WF ver=1 mode=DMA board_rev=v2 source=index.html thr=${settings.threshSignal}`;
    const blob = new Blob([hdr + '\n' + scope.raw.join('\n') + '\n'], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `scope_${formatDateForFile()}.wfm`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // --- threshold line in the scope: grab it, pull it, let go
  // The new value goes to the board once, on release (arrow keys: shortly after the last press).
  // A command per pointer move would flood the serial / Bluetooth command queue.
  const scopeCv = $('scopeCanvas');
  const thrNear = (x0, y0, touch) => {
    const p = scopeView.plot;
    if (!p || p.thrY == null || !scope.active || !state.isConnected) return false;
    const r = scopeCv.getBoundingClientRect();
    const x = x0 - r.left, y = y0 - r.top;
    return x >= p.padL - 6 && x <= p.padL + p.pw + 6 && Math.abs(y - p.thrY) <= (touch ? 18 : 10);
  };
  const thrApply = v => { settings.threshSignal = v; $('threshSignal').value = v; };
  const thrHover = on => {
    if (scopeView.hover === on) return;
    scopeView.hover = on;
    scopeCv.classList.toggle('thr-hot', on);
    drawScope(scopeCv);
  };
  const thrEnd = (e, commit) => {
    const d = scopeView.drag;
    if (!d) return;
    scopeView.drag = null;
    scopeCv.classList.remove('thr-drag');
    if (commit && d.thr !== d.start) {
      thrApply(d.thr);
      if (state.isConnected) sendCommand(`SET_THRESH:${d.thr}`);
    } else {
      thrApply(d.start);   // cancelled, or put back where it was
    }
    scopeView.hover = thrNear(e.clientX, e.clientY, e.pointerType === 'touch');
    scopeCv.classList.toggle('thr-hot', scopeView.hover);
    drawScope(scopeCv);
  };
  scopeCv.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !thrNear(e.clientX, e.clientY, e.pointerType === 'touch')) return;
    const p = scopeView.plot, start = parseInt(settings.threshSignal);
    scopeView.drag = { thr: start, start, yLo: p.yLo, yHi: p.yHi, dy: e.clientY - scopeCv.getBoundingClientRect().top - p.thrY };
    scopeCv.classList.add('thr-drag');
    try { scopeCv.setPointerCapture(e.pointerId); } catch (_) { /* the pointer is already gone */ }
    e.preventDefault();
    drawScope(scopeCv);
  });
  scopeCv.addEventListener('pointermove', e => {
    const d = scopeView.drag;
    if (!d) { thrHover(thrNear(e.clientX, e.clientY, e.pointerType === 'touch')); return; }
    const v = scopeValueAtY(e.clientY - scopeCv.getBoundingClientRect().top - d.dy, d.yLo, d.yHi);
    if (v === d.thr) return;
    d.thr = v;
    thrApply(v);
    drawScope(scopeCv);
  });
  scopeCv.addEventListener('pointerup', e => thrEnd(e, true));
  scopeCv.addEventListener('lostpointercapture', e => thrEnd(e, false));   // after pointerup this finds nothing to do
  scopeCv.addEventListener('pointerleave', () => { if (!scopeView.drag) thrHover(false); });
  // A touch that starts on the line must not scroll the page instead (touch-action cannot be switched per spot).
  scopeCv.addEventListener('touchstart', e => {
    const tp = e.touches[0];
    if (tp && thrNear(tp.clientX, tp.clientY, true)) e.preventDefault();
  }, { passive: false });
  let thrKeyTimer = null;
  scopeCv.addEventListener('keydown', e => {
    const step = { ArrowUp: 1, ArrowDown: -1, PageUp: 100, PageDown: -100 }[e.key];
    const cur = parseInt(settings.threshSignal);
    if (!step || isNaN(cur) || scopeView.drag || !scope.active || !state.isConnected) return;
    e.preventDefault();
    const v = Math.min(ADC_MAX, Math.max(0, cur + (e.shiftKey && Math.abs(step) === 1 ? step * 10 : step)));
    thrApply(v);
    drawScope(scopeCv);
    clearTimeout(thrKeyTimer);
    thrKeyTimer = setTimeout(() => { if (state.isConnected) sendCommand(`SET_THRESH:${v}`); }, 400);
  });

  // --- drawer: section links, and each section remembers whether it was open
  qsa('#drawerNav a').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      const sec = document.querySelector(a.getAttribute('href'));
      if (!sec) return;
      sec.open = true;
      sec.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
    });
  });
  qsa('details.adv').forEach(d => {
    const saved = lsGet('consoleAdv:' + d.id);
    if (saved === '1') d.open = true;
    if (saved === '0') d.open = false;
    d.addEventListener('toggle', () => lsSet('consoleAdv:' + d.id, d.open ? '1' : '0'));
  });

  // --- glossary
  qsa('.term').forEach(b => { b.innerHTML = svgIcon('help'); b.setAttribute('aria-expanded', 'false'); });
  document.addEventListener('click', e => {
    const term = e.target.closest('.term');
    if (term) {
      e.preventDefault();
      if (popFor === term) closePop(); else openPop(term);
      return;
    }
    if (!e.target.closest('#pop')) closePop();
  });
  window.addEventListener('scroll', closePop, { passive: true, capture: true });

  // --- keyboard: Esc closes the innermost thing that is open
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || $('dlg').open) return;
    if (!$('pop').hidden) { closePop(); return; }
    if ($('drawer').classList.contains('open')) { closeDrawer(); return; }
    if (document.body.classList.contains('rail-open')) { document.body.classList.remove('rail-open'); return; }
    if (scope.active) closeScope();
  });
}

// ========== Start ==========
document.addEventListener('DOMContentLoaded', () => {
  currentLang = detectLanguage();
  modelChosen = lsGet(MODEL_KEY) === 'v2' && !new URLSearchParams(location.search).has('choose');
  renderModelChooser();

  // Inputs -> settings, and the Bluetooth name remembered from the last board.
  const savedBleName = lsGet('bleName');
  if (savedBleName) {
    settings.bleName = savedBleName;
    state.bleName = savedBleName;
  }
  $('bleName').value = $('advBleName').value = settings.bleName;
  settings.baudRate = parseInt($('baudRate').value) || 9600;
  settings.binWidth = parseInt($('binWidth').value);
  settings.histLog = $('histLogScale').checked;
  settings.autoSaveFormat = $('autoSaveFormat').value;
  settings.fileComment = $('fileComment').value;
  settings.threshSignal = $('threshSignal').value;
  settings.scopeRate = parseInt($('scopeRate').value) || 3;
  settings.scopePersist = $('scopePersist').value;
  settings.scopeAutoY = $('scopeAutoY').checked;

  bindControls();
  loadUploadConfig();
  demo.rate = demoSliderToRate(parseInt($('demoRate').value) || 50);
  rebuildHistogram();
  applyLanguage();

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(syncHeights).observe($('topbar'));
    new ResizeObserver(syncHeights).observe($('msgs'));
    let pending = false;
    new ResizeObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; redrawCharts(); });
    }).observe($('histBox'));
    new ResizeObserver(() => { if (document.body.dataset.view === 'measure') drawRate($('rateChart')); }).observe($('rateBox'));
    new ResizeObserver(() => { if (scope.active) drawScope($('scopeCanvas')); }).observe($('scopeWrap'));
  }
  window.addEventListener('resize', syncHeights);
  // Fonts arrive after the first paint; redraw the canvases with them.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { syncHeights(); redrawCharts(); });

  setInterval(updateUIBatch, UI_UPDATE_INTERVAL);
  setInterval(updateStatsBatch, STATS_UPDATE_INTERVAL);
  // Keeps the "not yet written" count in the auto-save status current (N-15).
  setInterval(() => { if (state.autoSave.enabled) updateAutoSaveUI(); }, 1000);
  applyChartRefreshMode(chartRefreshMode);
  coreStart();
});
