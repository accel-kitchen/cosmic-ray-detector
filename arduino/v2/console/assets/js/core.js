// CosmicRay Recorder v2 console - core
//
// 通信・行の解析・計数率・自動保存・ダウンロード・サーバー送信・オシロのデータ処理・デモ。
// v2/index.html から中身を変えずに移した。プロトコルとファイル形式の取り決めは
// ../../../description.md のとおり（ファームの出力を変えたらそちらと両方を直す）。
//
// このファイルは画面に触れない。
//   - 画面の入力欄にあった値は `settings` から読む（画面側が書き込む）。
//   - 状態が変わったら Bus.emit() で知らせ、描画は ui.js が受け持つ。
//   - 画面からしか取れない値は Hooks 経由で受け取る。
// 通常の <script> で読み込むので、トップレベルの const / let は ui.js からも見える。

'use strict';

// ========== Bus (core -> screen notifications) ==========
const Bus = (() => {
  const handlers = {};
  return {
    on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); },
    emit(name, data) {
      const list = handlers[name];
      if (!list) return;
      for (const fn of list) {
        try { fn(data); } catch (e) { console.error(`Bus handler for "${name}" failed:`, e); }
      }
    },
  };
})();

// Things only the screen can answer. ui.js replaces these.
const Hooks = {
  readUploadForm() {},   // copy the upload form into state.upload / uploadPassword
  closeScope() {},       // leave the oscilloscope view (turns the scope off)
};

// Values that used to be read straight from input elements.
const settings = {
  baudRate: 9600,
  bleName: 'CosmicRay',      // name filter for Bluetooth connect (the input box)
  autoSaveFormat: 'dat',     // 'dat' | 'csv' | 'both'
  fileComment: '',
  binWidth: 64,
  histLog: false,
  threshSignal: 120,         // signal-threshold input box (also stamped into .wfm)
  scopeRate: 3,
  scopeRearm: '5',           // re-arm level = threshold - this offset (kept as typed)
  scopeTrig: 'NORMAL',       // 'NORMAL' (trigger on the threshold) | 'FREE' (free-run, no trigger)
  scopePersist: 20,
  scopeAutoY: false,         // off: the axis stays 0..4095, so a threshold being dragged does not make it jump
};

// ========== Firmware constants (match description.md) ==========
const ADC_MAX = 4095;                  // 12-bit ADC
const EVENT_TOKEN_COUNT_GPS = 18;      // 13 + PPS_UTC[s] PPS_dt[us] PPS_period[us] Lat Lon (GPS 対応ファーム。旧ファームは 13)
const EVENT_TOKEN_COUNT = 13;          // count, time_us, adc, deadtime_us, T, H, P, d1..3, a1..3
const VALID_MODES = ['DIGITAL', 'DUAL', 'ANALOG'];

// Throttling / memory caps (to keep the page responsive under high event rates)
const GPS_LOG_MAX           = 200000;  // 保存用に持つ GPS 行の上限 (PPS は 10 秒ごとなので約 23 日分)
const MAX_EVENTS            = 1000000; // cap on state.events kept in memory (table/recompute/download). Oldest dropped past this, with a visible warning.
// Trimming the head of a 1M-element array is O(n), so it is done in chunks:
// the array may overshoot MAX_EVENTS by this much, then one splice brings it back.
const EVENTS_TRIM_CHUNK     = 50000;
const UI_UPDATE_INTERVAL    = 300;     // ms between chart/table/card refreshes
const STATS_UPDATE_INTERVAL = 1000;    // ms between stats-card refreshes
const MAX_RATE_HISTORY      = 200;     // cap on state.rateHistory
const RATE_WINDOW_US        = 10e6;    // rate chart: each point averages at least this much device time

// ========== Auto-save ==========
// Chrome copies the whole file into a swap file every time createWritable(keepExistingData)
// opens it, so one append costs O(file size). The flush interval is stretched to keep
// that copy below AUTOSAVE_IO_DUTY of wall time, measured from the actual write time.
// The cap bounds how much a closed tab or a crash can lose; files are split at
// AUTOSAVE_SPLIT_BYTES so the copy, and with it the interval, stays small (N-15).
const AUTOSAVE_MIN_INTERVAL_MS = 1000;
const AUTOSAVE_MAX_INTERVAL_MS = 15000;
const AUTOSAVE_IO_DUTY         = 0.05;
const AUTOSAVE_SPLIT_BYTES     = 64 * 1024 * 1024;
const AUTOSAVE_PREFIX_WAIT_MS  = 5000;  // how long the first write waits for BLENAME: before using the stored name

// ========== BLE reconnect ==========
const BLE_RECONNECT_MIN_MS     = 1000;
const BLE_RECONNECT_MAX_MS     = 30000;
const BLE_CONNECT_TIMEOUT_MS   = 20000;

// ========== Commands ==========
const CMD_GAP_MS               = 80;     // pause between the GET_* queries sent after connecting
const SCOPE_KEEPALIVE_MS       = 15000;  // firmware turns the scope off after 60 s without any command
const SCOPE_IDLE_RETURN_MS     = 10 * 60 * 1000;  // scope tab left alone this long -> back to Analysis (N-6)

// ========== Server upload ==========
const UPLOAD_TICK_MS       = 1000;   // flush interval, same cadence as auto-save
const UPLOAD_QUEUE_SOFT    = 5000;   // warn + suggest decimation past this
const UPLOAD_QUEUE_HARD    = 50000;  // start dropping oldest past this (counted, never silent)
const UPLOAD_LEGACY_CONC   = 4;      // parallel single-event POSTs against the legacy API
const UPLOAD_LEGACY_BATCH  = 20;     // events taken per tick in legacy mode
const UPLOAD_BACKOFF_MAX   = 60000;  // 60 s ceiling
const UPLOAD_REJECT_CAP    = 100;    // cap on the remembered reject list
const UPLOAD_HTTP_TIMEOUT  = 15000;  // ms per request
const UPLOAD_STORE_KEY     = 'crd_upload_v1';
const UPLOAD_SECRET_KEY    = 'crd_upload_secret_v1';   // only written when "remember" is on
const UPLOAD_TOKEN_KEY     = 'crd_upload_token_v1';    // sessionStorage, used when "remember" is off

// ========== BLE UUIDs (Nordic UART Service) ==========
const BLE_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const BLE_TX_UUID      = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';  // Notify (device -> web)
const BLE_RX_UUID      = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';  // Write  (web -> device)

// ========== State ==========
// Incremental sums over every event received (not just the ones still in memory,
// so averages stay right after the MAX_EVENTS cap). BME280 fields keep their own
// counts because the firmware prints "nan" when the sensor is missing (R-12).
function newStats() {
  return {
    n: 0,
    nTemp: 0, sumTemp: 0, sumTemp2: 0, minTemp: Infinity, maxTemp: -Infinity,
    nHum: 0,  sumHum: 0,  minHum:  Infinity, maxHum:  -Infinity,
    nPress: 0, sumPress: 0, minPress: Infinity, maxPress: -Infinity,
    sumAdc: 0, maxAdc: 0,
    digHits: [0, 0, 0],
    sumAna:  [0, 0, 0],
  };
}

function newRateState() {
  return {
    seg: null,       // { id, base: {count,timeUs,deadUs}, last: {count,timeUs,deadUs} }
    nextId: 1,
    done: { counts: 0, elapsedUs: 0, deadUs: 0 },   // closed segments
    chartLast: null, // event used for the previous rate-chart point
    boardAddr: null, // BTADDR of the board these totals came from (N-5)
  };
}

const state = {
  connectionType: null,  // null | 'usb' | 'ble'
  // USB Serial
  port: null,
  reader: null,
  writer: null,
  readLoopPromise: null,
  // BLE
  bleDevice: null,
  bleServer: null,
  bleRxChar: null,
  // 接続先の識別情報。ブラウザから取れるものと、ファームに問い合わせて得るものの両方。
  //   Web Serial は VID/PID しか公開しない（COM 番号は仕様上取得できない）。
  //   Web Bluetooth の device.id はオリジン固有の不透明 ID で MAC ではない。
  //   btAddr は GET_BTADDR の応答（= 基板の BLE アドレス）。USB 接続でも取れる。
  conn: { usbVendorId: null, usbProductId: null, bleId: null, bleName: null, btAddr: null, btAddrTimedOut: false },
  // BLE auto-reconnect (R-10). bleUserDisconnect tells onBLEDisconnected that
  // the drop was requested, so it must not start retrying.
  bleTxChar: null,
  bleUserDisconnect: false,
  reconnecting: false,
  reconnectAttempt: 0,
  reconnectAtMs: 0,
  bleNameKnown: false,    // BLENAME: arrived during this connection (fixes the auto-save prefix)
  connectedAtMs: 0,
  // Common
  isConnected: false,
  paused: false,          // web-side logging pause (Stop/Resume); device keeps measuring
  events: [],
  rateHistory: [],
  sessionStart: null,
  rawLines: [],
  stats: newStats(),
  // Count rate from the board's own counters (R-1). A segment is a stretch where
  // count / time / deadtime only grow; it closes on RESET, reboot or disconnect.
  // Rate = counts / live time summed over segments, the same formula as the OLED.
  rate: newRateState(),
  mode: null,             // 'DIGITAL' | 'DUAL' | 'ANALOG' | null
  threshold: null,        // int (0-4095)
  pwmDuty: null,          // int (0-255), comparator threshold on D2
  pwmCalibrating: false,  // AUTO_PWM in progress
  hv: null,               // OMAME only: SiPM bias setting in V (25.9 | 27.1 | 27.9) | null
  sdEnabled: null,        // bool | null
  extEnabled: null,       // bool | null
  oledEnabled: null,      // bool | null
  buzzerEnabled: null,    // bool | null
  vibEnabled: null,       // bool | null
  gpsEnabled: null,       // bool | null
  gpsLog: [],             // 測定データと一緒に保存する GPS の行 { kind:'gps', pc_timestamp, line, demo } (イベントと同じ到着順)
  gpsRec: { pps: 0, pos: 0, lastPpsUtc: null, lastPpsAt: 0, clockDiffMs: null },  // 記録した PPS / 位置の件数と最新の PPS
  gps: null,              // GPS の受信状況 { valid, fix, sats, lat, lon, alt, nmea, ppsCount, ppsAgeMs, ... } | null
  beepMin: null,          // int Hz (pitch at threshold) | null
  beepMax: null,          // int Hz (pitch at ADC max) | null
  beepMs: null,           // int ms (beep duration) | null
  vibMin: null,           // int ms (vibration length at threshold) | null
  vibMax: null,           // int ms (vibration length at ADC max) | null
  autoSave: {
    dirHandle: null,
    // One queue per format, so a failure in one format only retries that format
    // and never duplicates lines already written to the other (R-2 d).
    queues: { dat: [], csv: [] },
    written: { dat: 0, csv: 0 },
    prefix: null,      // file name base, fixed at the first write of a session (R-2 c)
    parts: {},         // "<fmt>|<prefix>|<date>" -> current part number of a split file
    lastFile: { dat: null, csv: null },   // file name last written, per format
    enabled: false,
    flushing: false,   // re-entrancy lock so overlapping flushes don't corrupt the file
    nextFlushMs: 0,
    intervalMs: AUTOSAVE_MIN_INTERVAL_MS,
    lastError: null,
  },
  // Server upload. Deliberately a separate queue from autoSave: the two have
  // different enablement lifetimes, different retry semantics (disk failures are
  // usually permanent, network ones transient) and different drop policies
  // (disk must never drop; the network mirror may, because disk is the record).
  upload: {
    // configuration (persisted, except the password -- see saveUploadConfig)
    serverUrl: '',
    stationId: '',
    deviceLabel: '',
    lat: '',
    lon: '',
    decimate: 1,
    remember: false,
    token: null,
    tokenExpMs: 0,
    apiMode: 'legacy',    // only 'legacy' in Phase 1; 'v2' arrives with C-12
    // runtime
    enabled: false,
    loggingIn: false,
    queue: [],            // references to the SAME event objects held in state.events
    flushing: false,      // re-entrancy lock
    inFlight: null,       // Set of the events in the batch being sent (N-3)
    attempt: 0,
    nextAttemptMs: 0,
    lastError: null,
    authError: false,
    runId: null,
    // clock anchor (see uploadClockUs). Advanced for every event in arrival
    // order, whether or not upload is on, so ev.wall_us is fixed once (R-11).
    anchorWallUs: 0,
    anchorDevUs: 0,
    anchorCount: 0,
    // counters
    sent: 0, failed: 0, dropped: 0, skipped: 0,
    rejected: [],
    backlogSince: 0,
  },
};

// Session-scoped password. Deliberately NOT part of `state` and NOT persisted by
// default: it lives only for the lifetime of this tab so an overnight run can
// silently re-login after a 401. Written to localStorage only if the user opts in.
let uploadPassword = '';

// ========== Histogram data ==========
// The page used to keep the counts inside the chart object. They live here now;
// the chart only draws them. hitMs is the time each bin was last hit (for the
// short highlight on screen).
const hist = { binWidth: 64, counts: [], hitMs: [] };

function getNumBins() {
  return Math.ceil((ADC_MAX + 1) / settings.binWidth);
}

function rebuildHistogram() {
  const binWidth = settings.binWidth;
  const numBins = getNumBins();
  const counts = new Array(numBins).fill(0);
  state.events.forEach(ev => {
    const bin = Math.min(Math.floor(ev.adc / binWidth), numBins - 1);
    counts[bin]++;
  });
  hist.binWidth = binWidth;
  hist.counts = counts;
  hist.hitMs = new Array(numBins).fill(0);
  Bus.emit('hist');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ========== Connection errors (shown on the page, R-8) ==========
// Kept as key + params so a language switch can redraw the message.
let connErrorMsg = null;

function showConnError(key, params) {
  connErrorMsg = { key, params };
  renderConnError();
}

function clearConnError() {
  connErrorMsg = null;
  renderConnError();
}

function renderConnError() {
  Bus.emit('messages');
}

// Notices that are not errors (a different board, the scope tab closed for
// inactivity). Same key + params scheme as the connection error.
let pageNoticeMsg = null;

function showNotice(key, params) {
  pageNoticeMsg = { key, params };
  renderNotice();
}

function clearNotice() {
  pageNoticeMsg = null;
  renderNotice();
}

function renderNotice() {
  Bus.emit('messages');
}

function errMsg(e) {
  if (!e) return '?';
  return e.message ? `${e.name ? e.name + ': ' : ''}${e.message}` : String(e.name || e);
}

// Closing the port / device chooser without picking anything is not an error.
// (A missing Bluetooth adapter is also a NotFoundError, so look at the message.)
function isUserCancel(e) {
  if (!e) return false;
  if (e.name === 'AbortError') return true;
  return e.name === 'NotFoundError' && /cancel|selected/i.test(e.message || '');
}

// Shared tail of every successful connect (USB, BLE, demo, BLE reconnect).
function onConnected(opts) {
  const reconnect = !!(opts && opts.reconnect);
  // A reconnect is the same board and the same clock, so it keeps the upload run
  // and the user's "Stop Logging" (a radio dropout must not restart logging, N-12).
  if (!reconnect) startUploadRun();
  const keepPaused = reconnect && state.paused;
  state.connectedAtMs = Date.now();
  state.bleNameKnown = false;
  clearConnError();
  applyConnectionState(true);
  if (keepPaused) setLoggingPaused(true);
  refreshDeviceState();
  // The scope tab may already be open: put the firmware into scope mode too (R-6).
  if (scope.active) scopeEnter();
}
// ========== USB Serial Connection ==========
const usbTextEncoder = new TextEncoder();
let usbBootloaderRecoveryDone = false;

// The ESP-ROM banner means the chip is sitting in download mode instead of
// running the firmware. Pulsing RTS while DTR stays low emulates pressing
// the reset button with the boot strap released, so the app boots normally.
async function recoverFromBootloader() {
  if (usbBootloaderRecoveryDone) return;
  if (state.connectionType !== 'usb' || !state.port) return;
  usbBootloaderRecoveryDone = true;
  try {
    await state.port.setSignals({ dataTerminalReady: false, requestToSend: true });
    await new Promise(r => setTimeout(r, 100));
    await state.port.setSignals({ dataTerminalReady: false, requestToSend: false });
    await new Promise(r => setTimeout(r, 100));
    await state.port.setSignals({ dataTerminalReady: true, requestToSend: true });
  } catch (e) {
    console.error('Bootloader recovery failed:', e);
  }
}

// Demo (synthetic) and real events are never mixed on one screen: they would share the histogram,
// the stats and the rate, and a manual export would put real rows under a DEMO_ name with the
// "NOT a measurement" note (C-6). Ask for a Clear first.
function mixesDemo(nextIsDemo) {
  return state.events.some(e => !!e.demo !== nextIsDemo);
}

async function connectUSB() {
  if (state.isConnected || state.reconnecting) return;
  if (mixesDemo(false)) { Bus.emit('alert', { key: 'demo.mixedReal' }); return; }
  clearConnError();

  let port;
  try {
    port = await navigator.serial.requestPort();
  } catch (e) {
    if (!isUserCancel(e)) {
      console.error('USB port request failed:', e);
      showConnError(e.name === 'SecurityError' ? 'err.security' : 'err.usb', { msg: errMsg(e) });
    }
    return;
  }

  try {
    await port.open({ baudRate: parseInt(settings.baudRate) });
  } catch (e) {
    // NetworkError ("Failed to open serial port") nearly always means another
    // program holds the port, e.g. the Arduino IDE Serial Monitor.
    console.error('USB open failed:', e);
    showConnError('err.usbOpen', { msg: errMsg(e) });
    return;
  }

  try {
    // ESP32-S3 native USB (USB-Serial-JTAG) maps DTR/RTS onto the auto-reset
    // circuit: the half-asserted state the browser leaves after open() can
    // reset the chip into the ROM bootloader. Assert both to disarm it.
    try {
      await port.setSignals({ dataTerminalReady: true, requestToSend: true });
    } catch (_) {}
    usbBootloaderRecoveryDone = false;

    state.writer = port.writable.getWriter();
    state.port = port;
    state.connectionType = 'usb';
    state.isConnected = true;
    state.sessionStart = new Date();
    // getInfo() が返すのは USB の VID/PID だけ。COM 番号はブラウザからは見えない。
    const info = (typeof port.getInfo === 'function') ? (port.getInfo() || {}) : {};
    state.conn.usbVendorId  = info.usbVendorId ?? null;
    state.conn.usbProductId = info.usbProductId ?? null;
    state.conn.bleId = null;
    state.conn.bleName = null;

    state.readLoopPromise = readLoopUSB(port);
    onConnected();
  } catch (e) {
    // The port opened but setup failed: close it again, or the next attempt
    // would fail with "port is already open".
    console.error('USB connection failed:', e);
    showConnError('err.usb', { msg: errMsg(e) });
    state.isConnected = false;
    state.connectionType = null;
    if (state.writer) { try { state.writer.releaseLock(); } catch (_) {} state.writer = null; }
    state.port = null;
    try { await port.close(); } catch (_) {}
    applyConnectionState(false);
  }
}

async function readLoopUSB(port) {
  const reader = port.readable.getReader();
  state.reader = reader;
  const decoder = new TextDecoder();

  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        processLine(line.replace(/\r$/, '').trim());
      }
    }
  } catch (e) {
    if (state.isConnected) {
      console.error('USB read error:', e);
      showConnError('err.usbLost', { msg: errMsg(e) });
      disconnect();
    }
  } finally {
    try { reader.releaseLock(); } catch (_) {}
  }
}

// ========== BLE Connection ==========
let bleBuffer = '';
let bleReconnectGen = 0;

// GATT connect + service discovery + notifications. Used for the first connect
// and for every automatic reconnect of the same device. `stillWanted` is checked
// after the awaits: if Disconnect was pressed meanwhile, the attempt gives up
// without touching the page's BLE state or adding a listener (N-11).
async function bleAttach(device, stillWanted) {
  const wanted = stillWanted || (() => true);
  const cancelled = () => {
    const e = new Error('BLE connect cancelled');
    e.name = 'AbortError';
    return e;
  };
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error('GATT connect timed out');
      e.name = 'TimeoutError';
      reject(e);
    }, BLE_CONNECT_TIMEOUT_MS);
  });
  try {
    const server = await Promise.race([device.gatt.connect(), timeout]);
    const service = await server.getPrimaryService(BLE_SERVICE_UUID);
    const txChar = await service.getCharacteristic(BLE_TX_UUID);
    const rxChar = await service.getCharacteristic(BLE_RX_UUID);
    if (!wanted()) throw cancelled();
    // A reconnect may hand back the same characteristic object; never stack listeners.
    if (state.bleTxChar) state.bleTxChar.removeEventListener('characteristicvaluechanged', handleBLEData);
    txChar.removeEventListener('characteristicvaluechanged', handleBLEData);
    txChar.addEventListener('characteristicvaluechanged', handleBLEData);
    await txChar.startNotifications();
    if (!wanted()) {
      txChar.removeEventListener('characteristicvaluechanged', handleBLEData);
      throw cancelled();
    }
    bleBuffer = '';
    state.bleServer = server;
    state.bleTxChar = txChar;
    state.bleRxChar = rxChar;
  } finally {
    clearTimeout(timer);
  }
}

async function connectBLE() {
  if (state.isConnected || state.reconnecting) return;
  if (mixesDemo(false)) { Bus.emit('alert', { key: 'demo.mixedReal' }); return; }
  clearConnError();
  const targetName = (settings.bleName || modelProfile.bleDefault).trim() || modelProfile.bleDefault;

  let device;
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [modelProfile.blePrefix ? { namePrefix: targetName } : { name: targetName }],
      optionalServices: [BLE_SERVICE_UUID]
    });
  } catch (e) {
    if (!isUserCancel(e)) {
      console.error('BLE device request failed:', e);
      showConnError(e.name === 'SecurityError' ? 'err.security' : 'err.ble', { msg: errMsg(e) });
    }
    return;
  }

  try {
    await bleAttach(device);
  } catch (e) {
    console.error('BLE connection failed:', e);
    try { device.gatt.disconnect(); } catch (_) {}
    const network = e && (e.name === 'NetworkError' || e.name === 'TimeoutError');
    showConnError(network ? 'err.bleNetwork' : 'err.ble', { msg: errMsg(e) });
    return;
  }

  state.bleDevice = device;
  state.bleUserDisconnect = false;
  state.connectionType = 'ble';
  state.isConnected = true;
  state.sessionStart = new Date();
  // device.id はオリジンごとにハッシュ化された不透明 ID。実アドレスは
  // GET_BTADDR でファームから受け取る（BTADDR: 行）。
  state.conn.bleId = device.id || null;
  state.conn.bleName = device.name || targetName;
  state.conn.usbVendorId = null;
  state.conn.usbProductId = null;

  device.addEventListener('gattserverdisconnected', onBLEDisconnected);
  onConnected();
}

function handleBLEData(event) {
  const value = event.target.value;
  const decoder = new TextDecoder();
  const chunk = decoder.decode(value);
  bleBuffer += chunk;
  const lines = bleBuffer.split('\n');
  bleBuffer = lines.pop();
  for (const line of lines) {
    processLine(line.replace(/\r$/, '').trim());
  }
}

function onBLEDisconnected() {
  const device = state.bleDevice;
  state.bleServer = null;
  state.bleRxChar = null;
  bleBuffer = '';
  if (state.bleUserDisconnect || !device) return;  // disconnect() does the teardown
  if (state.reconnecting) return;                  // a retry dropped again; the loop carries on

  // Unexpected drop (out of range, board rebooted, ...). Keep the session --
  // auto-save file, upload run, rate segment -- and try to get the link back (R-10).
  state.isConnected = false;
  state.reconnecting = true;
  state.reconnectAttempt = 0;
  setScopeDeviceOn(false);
  // Best-effort drain of both sinks while the link is down.
  flushAutoSave({ force: true }).catch(() => {});
  flushUpload({ final: true }).catch(() => {});
  applyConnectionState(false);
  bleReconnectLoop(device);
}

async function bleReconnectLoop(device) {
  const gen = ++bleReconnectGen;
  const alive = () => state.reconnecting && gen === bleReconnectGen;
  let delay = BLE_RECONNECT_MIN_MS;

  while (alive()) {
    state.reconnectAttempt++;
    state.reconnectAtMs = Date.now() + delay;
    // Wait in 1 s steps so the header can count down.
    while (alive() && Date.now() < state.reconnectAtMs) {
      Bus.emit('status');
      await sleep(Math.min(1000, state.reconnectAtMs - Date.now()));
    }
    if (!alive()) return;
    state.reconnectAtMs = 0;
    Bus.emit('status');

    try {
      await bleAttach(device, alive);
    } catch (e) {
      // Cancelled by Disconnect: disconnect() has already dropped the link, and
      // the user may be connecting this same device again -- leave it alone.
      if (!alive()) return;
      console.warn('BLE reconnect failed:', e);
      try { device.gatt.disconnect(); } catch (_) {}
      delay = Math.min(delay * 2, BLE_RECONNECT_MAX_MS);
      continue;
    }

    if (!alive()) return;
    state.reconnecting = false;
    state.reconnectAttempt = 0;
    state.connectionType = 'ble';
    state.isConnected = true;
    onConnected({ reconnect: true });
    return;
  }
}

// ========== Disconnect (common) ==========
async function disconnect() {
  // Stop a pending BLE reconnect first.
  if (state.reconnecting) {
    state.reconnecting = false;
    bleReconnectGen++;
  }
  state.isConnected = false;
  state.bleUserDisconnect = true;
  // 先に止めないと、下の flush を待っている間も合成イベントが積み上がる。
  if (state.connectionType === 'demo') demoStop();

  // Persist any events still queued for auto-save before tearing down.
  // Disk first (it is the record), then drain the network queue.
  try { await flushAutoSave({ force: true }); } catch (_) {}
  // Do not wait for the network: with a server that never answers, the final drain can take
  // over a minute while the port stays open and the header still says "connected" (C-3).
  // The 1 s tick keeps draining the queue because u.enabled is untouched.
  flushUpload({ final: true }).catch(() => {});

  if (state.connectionType === 'usb') {
    try {
      if (state.reader) {
        try { await state.reader.cancel(); } catch (_) {}
        state.reader = null;
      }
      if (state.readLoopPromise) {
        try { await state.readLoopPromise; } catch (_) {}
        state.readLoopPromise = null;
      }
      if (state.writer) {
        try { await state.writer.close(); } catch (_) {}
        try { state.writer.releaseLock(); } catch (_) {}
        state.writer = null;
      }
      if (state.port) {
        try { await state.port.close(); } catch (_) {}
        state.port = null;
      }
    } catch (e) {
      console.error('USB disconnect error:', e);
    }
  } else if (state.connectionType === 'ble') {
    const device = state.bleDevice;
    try {
      if (device) {
        device.removeEventListener('gattserverdisconnected', onBLEDisconnected);
        // Always call it: besides dropping a live link, it aborts a GATT connect
        // that a reconnect attempt still has in flight (N-11).
        device.gatt.disconnect();
      }
    } catch (e) {
      console.error('BLE disconnect error:', e);
    }
    if (state.bleTxChar) state.bleTxChar.removeEventListener('characteristicvaluechanged', handleBLEData);
    state.bleDevice = null;
    state.bleServer = null;
    state.bleTxChar = null;
    state.bleRxChar = null;
    bleBuffer = '';
  }

  // Lines that arrived while the transport was being torn down still belong to
  // this session: write them under this session's file name before it is reset.
  try { await flushAutoSave({ force: true }); } catch (_) {}

  state.connectionType = null;
  setScopeDeviceOn(false);
  // The session ends here: close the rate segment and let the next session
  // pick its own auto-save file prefix.
  rateCloseSegment();
  endAutoSaveSession();
  applyConnectionState(false);
}

// ========== Send Command (routes to active transport) ==========
// Every command goes through one promise chain, so a BLE write never starts while
// the previous one is still in flight ("GATT operation already in progress", R-5).
let cmdChain = Promise.resolve();

function sendCommand(cmd) {
  cmdChain = cmdChain.then(() => sendCommandNow(cmd)).catch(() => {});
  return cmdChain;
}

async function sendCommandNow(cmd) {
  if (!state.isConnected) return;

  if (state.connectionType === 'demo') {
    demoCommand(cmd);
    return;
  }

  if (state.connectionType === 'usb') {
    if (!state.writer) return;
    try {
      await state.writer.write(usbTextEncoder.encode(cmd + '\n'));
    } catch (e) {
      console.error('USB send error:', e);
    }
  } else if (state.connectionType === 'ble') {
    const ch = state.bleRxChar;
    if (!ch) return;
    try {
      const data = usbTextEncoder.encode(cmd + '\n');
      // BLE Notify / Write MTU is typically 20 B; chunk to stay safe.
      // The firmware joins the chunks until '\n'.
      for (let i = 0; i < data.length; i += 20) {
        const chunk = data.slice(i, i + 20);
        if (typeof ch.writeValueWithResponse === 'function') await ch.writeValueWithResponse(chunk);
        else await ch.writeValue(chunk);
      }
    } catch (e) {
      console.error('BLE send error:', e);
    }
  }
}

// Queries sent after connecting and after the board reboots. GET_BLENAME goes
// first because the auto-save file name waits for it.
const REFRESH_COMMANDS = [
  'GET_BLENAME', 'GET_THRESH', 'GET_PWM', 'GET_MODE', 'GET_SCOPE',
  'GET_SD', 'GET_EXT', 'GET_OLED', 'GET_BUZZER', 'GET_VIB', 'GET_GPS',
  'GET_AUTO_MARGIN', 'GET_BEEP', 'GET_VIB_MS', 'GET_BTADDR',
];
let refreshGen = 0;

// ========== Detector model profile ==========
// OHASHI (v2, ESP32-S3) と OMAME (MUON FOB, nRF52840) は同じ行の形式・同じコマンド名で話す。
// 違いは「この基板に無いもの」と「OMAME だけにあるもの」だけなので、ページは 1 つのまま、
// 機種ごとの差をこの表に集める。'v2' の値は従来の挙動そのもの（既定）。
//   bleDefault : Bluetooth の名前の既定（入力欄の初期値）
//   blePrefix  : true なら前方一致で探す（MuonFob の既定名は MuonFob-XXXX で、下 4 桁が個体ごとに違う）
//   bleKey     : 最後に使った名前を覚える localStorage のキー（機種どうしで混ざらないように分ける）
//   refresh    : 接続直後と再起動後に送る問い合わせ
//   hv         : 高電圧の設定（GET_HV / SET_HV）がある
const MODEL_PROFILES = {
  v2: {
    id: 'v2',
    bleDefault: 'CosmicRay', blePrefix: false, bleKey: 'bleName',
    refresh: REFRESH_COMMANDS,
    hv: false,
  },
  omame: {
    id: 'omame',
    bleDefault: 'MuonFob', blePrefix: true, bleKey: 'bleName_omame',
    // OMAME には GPS が無い（GET_GPS は "Unknown command" になる）。GET_HV は OMAME だけ。
    refresh: REFRESH_COMMANDS.filter(c => c !== 'GET_GPS').concat('GET_HV'),
    hv: true,
  },
};
let modelProfile = MODEL_PROFILES.v2;

// 機種を切り替える。画面側（ui.js）が選択の直後と起動時に呼ぶ。
function setModelProfile(id) {
  modelProfile = MODEL_PROFILES[id] || MODEL_PROFILES.v2;
}

// Sent one at a time through the command chain; a newer call supersedes an older one.
async function refreshDeviceState() {
  const gen = ++refreshGen;
  // GET_BTADDR は新しめのファームだけが応答する。無応答なら「取得不可」に切り替える。
  state.conn.btAddr = null;
  state.conn.btAddrTimedOut = false;
  if (modelProfile.hv) state.hv = null;   // GET_HV の応答が来るまで「取得中」
  // Give a board that is still booting a moment before the first GET.
  await sleep(800);
  for (const cmd of modelProfile.refresh) {
    if (gen !== refreshGen || !state.isConnected) return;
    await sendCommand(cmd);
    await sleep(CMD_GAP_MS);
  }
  await sleep(1500);
  if (gen === refreshGen && state.isConnected && !state.conn.btAddr) {
    state.conn.btAddrTimedOut = true;
    Bus.emit('connDetail');
  }
}

let pwmCalTarget = 0;
let pwmCalTimer = null;

function setPwmDutyState(duty) {
  state.pwmDuty = duty;
  Bus.emit('device', 'pwm');
}

// AUTO_PWM blocks the firmware for ~8 s (32 duty steps x 200 ms). The buttons
// stay down until PWM: arrives, with a timeout in case the reply is lost.
function setPwmCalibrating(on) {
  state.pwmCalibrating = !!on;
  if (pwmCalTimer) { clearTimeout(pwmCalTimer); pwmCalTimer = null; }
  if (on) pwmCalTimer = setTimeout(() => setPwmCalibrating(false), 15000);
  Bus.emit('device', 'pwmCal');
}

// The firmware stops counting while the scope runs. Make that impossible to miss
// (R-6), including for how long it has been stopped (N-6).
function setScopeDeviceOn(on) {
  on = !!on;
  if (on && !scope.deviceOn) scope.deviceOnSinceMs = Date.now();
  if (!on) scope.deviceOnSinceMs = 0;
  scope.deviceOn = on;
  Bus.emit('scopeDevice');
}

// ========== Data Processing ==========
let uiDirty = false;     // table/env/ext/histogram/rawDisplay
let statsDirty = false;  // stats cards

// GPS の行 (GPS スイッチが ON のときだけファームが出す):
//   "### GPS fix=1 sats=8 lat=35.681236 lon=139.767125 alt=12.3"            (60 秒ごと)
//   "### GPS status: nmea=ok valid=1 fix=1 sats=8 lat=.. lon=.. alt=.. utc=.." (GET_GPS の応答 1/2)
//   "### GPS status: pps_count=.. pps_age_ms=.. pps_period_us=.. sync=.. lines_ok=.. lines_bad=.." (同 2/2)
// 拾ったら true を返す。"### GPS: UART1 ..." のような説明行は拾わない。
function parseGpsLine(line) {
  // 記録する行: "### PPS <t_us> <utc_epoch_s>" と "### GPS fix=..." (ファームが SD に書くものと同じ形)。
  // 測定の一時停止中は、イベントと同じく記録しない。
  const pps = line.match(/^#+\s*PPS\s+(\d+)\s+(\d+)\s*$/i);
  if (pps) {
    recordGpsLine(line, true, parseInt(pps[2]));
    Bus.emit('device', 'gps');
    return true;
  }
  const m = line.match(/^#+\s*GPS\s+(status:|fix=)/i);
  if (!m) return false;
  const g = state.gps || (state.gps = {});
  const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  for (const [, k, v] of line.matchAll(/(\w+)=(\S+)/g)) {
    switch (k) {
      case 'nmea':          g.nmea = v === 'ok'; break;
      case 'valid':         g.valid = v === '1'; break;
      case 'fix':           g.fix = num(v); break;
      case 'sats':          g.sats = num(v); break;
      case 'lat':           g.lat = num(v); break;
      case 'lon':           g.lon = num(v); break;
      case 'alt':           g.alt = num(v); break;
      case 'utc':           g.utc = num(v); break;
      case 'pps_count':     g.ppsCount = num(v); break;
      case 'pps_age_ms':    g.ppsAgeMs = num(v); break;
      case 'pps_period_us': g.ppsPeriodUs = num(v); break;
      case 'sync':          g.sync = num(v); break;
      case 'lines_ok':      g.linesOk = num(v); break;
      case 'lines_bad':     g.linesBad = num(v); break;
    }
  }
  if (m[1].toLowerCase() === 'fix=') g.valid = true;   // 位置の行は有効な RMC のときだけ出る
  g.updatedAt = Date.now();
  if (m[1].toLowerCase() === 'fix=') recordGpsLine(line, false);
  Bus.emit('device', 'gps');
  return true;
}

// GPS の行を保存の対象に入れる。測定データ (.dat / .csv) には '#' で始まる行としてそのまま入る。
// pandas なら read_csv(path, comment='#') で読み飛ばせる。
function recordGpsLine(line, isPps, utc) {
  const r = state.gpsRec;
  if (isPps) {
    r.lastPpsUtc = utc; r.lastPpsAt = Date.now();
    // PPS 行はファームが RMC を受けた直後に出すので、PC の時計で見て PPS から 0〜1 秒ほど遅れて届く。
    // それを大きく外れるときは、NMEA の秒と PPS の対応が 1 秒ずれているか、PC の時計が合っていない。
    r.clockDiffMs = r.lastPpsAt - utc * 1000;
  }
  if (state.paused) return;
  if (isPps) r.pps++; else r.pos++;
  const rec = { kind: 'gps', pc_timestamp: Date.now(), line: line.replace(/^#+/, '###'), demo: state.connectionType === 'demo' };
  state.gpsLog.push(rec);
  if (state.gpsLog.length > GPS_LOG_MAX) state.gpsLog.splice(0, state.gpsLog.length - GPS_LOG_MAX);
  if (state.autoSave.enabled) {
    const fmt = settings.autoSaveFormat;
    if (fmt === 'dat' || fmt === 'both') state.autoSave.queues.dat.push(rec);
    if (fmt === 'csv' || fmt === 'both') state.autoSave.queues.csv.push(rec);
  }
}

function processLine(line) {
  if (!line) return;

  state.rawLines.push(line);
  if (state.rawLines.length > 100) state.rawLines.shift();
  uiDirty = true;

  // ROM bootloader output — the chip was reset into download mode when the
  // port opened. Reboot it into the app (once per connection).
  if (line.startsWith('ESP-ROM:') || line.includes('waiting for download')) {
    recoverFromBootloader();
    return;
  }

  // Firmware boot banner — the device (re)booted, so re-query its state.
  // The GETs land while setup() is still running and are answered once
  // loop() starts draining the RX buffer.
  if (line.startsWith('Booting')) {
    refreshDeviceState();
    // A reboot always comes up with the scope OFF; re-enter if the tab is open.
    setScopeDeviceOn(false);
    if (scope.active && state.isConnected) scopeEnter();
    return;
  }

  // Threshold response: "THRESH:<sig> DUTY:<duty>" (space-separated)
  if (line.startsWith('THRESH:')) {
    const m = line.match(/^THRESH:\s*(\d+)\s+DUTY:\s*(\d+)/i);
    if (m) {
      const sig = parseInt(m[1]);
      const duty = parseInt(m[2]);
      state.threshold = sig;
      setPwmDutyState(duty);
      settings.threshSignal = sig;
      Bus.emit('device', 'thresh');
    }
    return;
  }

  // Comparator PWM response: "PWM:<duty>" (SET_PWM / GET_PWM / AUTO_PWM, R-4).
  // Must be handled here: otherwise it falls through to the event-line check.
  if (line.startsWith('PWM:')) {
    const duty = parseInt(line.substring(4).trim());
    if (!isNaN(duty)) {
      setPwmDutyState(duty);
      if (state.pwmCalibrating) setPwmCalibrating(false);
    }
    return;
  }

  // Mode response / boot-time mode line: "MODE:DIGITAL" etc.
  if (line.startsWith('MODE:')) {
    const modeStr = line.substring(5).trim().toUpperCase();
    if (VALID_MODES.includes(modeStr)) {
      state.mode = modeStr;
      Bus.emit('device', 'mode');
    }
    return;
  }

  // Auto-calibrate margin response: "AUTO_MARGIN:<n>"
  if (line.startsWith('AUTO_MARGIN:')) {
    const n = parseInt(line.substring(12).trim());
    if (!isNaN(n)) {
      state.autoMargin = n;
      Bus.emit('device', 'margin');
    }
    return;
  }

  // Beep pitch mapping response: "BEEP:<min>,<max>,<ms>"
  if (line.startsWith('BEEP:')) {
    const p = line.substring(5).trim().split(',');
    if (p.length >= 3) {
      const mn = parseInt(p[0]), mx = parseInt(p[1]), ms = parseInt(p[2]);
      if (!isNaN(mn) && !isNaN(mx) && !isNaN(ms)) {
        state.beepMin = mn;
        state.beepMax = mx;
        state.beepMs = ms;
        Bus.emit('device', 'beep');
      }
    }
    return;
  }

  // Vibration length mapping response: "VIBMS:<min>,<max>"
  // 先に見ること。後段の機能トグル表は 'VIB:' で前方一致するが、
  // "VIBMS:" は 'VIB:' で始まらないので取り違えは起きない。
  if (line.startsWith('VIBMS:')) {
    const p = line.substring(6).trim().split(',');
    if (p.length >= 2) {
      const mn = parseInt(p[0]), mx = parseInt(p[1]);
      if (!isNaN(mn) && !isNaN(mx)) {
        state.vibMin = mn;
        state.vibMax = mx;
        Bus.emit('device', 'vib');
      }
    }
    return;
  }

  // BLE name response: "BLENAME:<name>"
  // The name is stored only once the board itself reports it, so a rename that
  // the board truncated or rejected never ends up in the BLE scan filter (R-7).
  if (line.startsWith('BLENAME:')) {
    const name = line.substring(8).trim();
    if (name) {
      state.bleName = name;
      state.bleNameKnown = true;
      settings.bleName = name;
      // デモの仮想基板の名前は保存しない。次に実機へ BLE 接続するときの
      // 名前フィルタを、デモで付けた名前で上書きしてしまうため（N-16）。
      if (state.connectionType !== 'demo') {
        try { localStorage.setItem(modelProfile.bleKey, name); } catch (_) {}
      }
      Bus.emit('device', 'blename');
    }
    return;
  }

  // "BTADDR:aa:bb:cc:dd:ee:ff" — 基板の BLE アドレス。USB 接続でも返ってくるので
  // どの基板に繋がっているかの識別に使える。
  if (line.startsWith('BTADDR:')) {
    const addr = line.substring(7).trim().toUpperCase();
    if (addr) {
      state.conn.btAddr = addr;
      state.conn.btAddrTimedOut = false;
      Bus.emit('connDetail');
      noteBoardAddress(addr);
    }
    return;
  }

  // Feature toggle responses: "SD:ON" / "SD:OFF" / "EXT:..." / "OLED:..." / "BUZZER:..." / "VIB:..."
  for (const [prefix, key, btnId] of [
    ['SD:',     'sdEnabled',     'featSD'],
    ['EXT:',    'extEnabled',    'featEXT'],
    ['OLED:',   'oledEnabled',   'featOLED'],
    ['BUZZER:', 'buzzerEnabled', 'featBUZZER'],
    ['VIB:',    'vibEnabled',    'featVIB'],
    ['GPS:',    'gpsEnabled',    'featGPS'],
  ]) {
    if (line.startsWith(prefix)) {
      const val = line.substring(prefix.length).trim().toUpperCase();
      if (val === 'ON' || val === 'OFF') {
        state[key] = (val === 'ON');
        if (key === 'gpsEnabled' && !state.gpsEnabled) state.gps = null;
        Bus.emit('device', 'feature');
        return;
      }
    }
  }

  // Boot header / informational lines
  if (line.startsWith('###') || line.startsWith('#')) {
    if (parseGpsLine(line)) return;
    // OMAME だけ: "### HV: 27.1 V (HV_TRIM Hi-Z)" (起動時 / GET_HV / SET_HV の応答)。
    // "### HV changed: ..." や "### HV ..." の説明行は数字が続かないので拾わない。
    const hv = line.match(/^#+\s*HV:\s*(\d+(?:\.\d+)?)\s*V\b/i);
    if (hv && modelProfile.hv) {
      state.hv = parseFloat(hv[1]);
      Bus.emit('device', 'hv');
      return;
    }
    // "### Signal threshold: 120 (Duty 30)"
    const m = line.match(/Signal threshold:\s*(\d+)\s*\(Duty\s*(\d+)\)/i);
    if (m) {
      const sig = parseInt(m[1]);
      const duty = parseInt(m[2]);
      state.threshold = sig;
      setPwmDutyState(duty);
      settings.threshSignal = sig;
      Bus.emit('device', 'thresh');
    }
    return;
  }

  // System messages (don't treat as data, but let them live in raw log).
  if (/^(Booting|BLE:|SD:|BME280:|OLED)/i.test(line)) return;

  // Oscilloscope waveform line (scope mode):
  //   WF,<evt>,<t_ms>,U,<npre>,<ntot>,<period_ns>,<v0>,<v1>,...
  // 空白を含まないので下の split(/\s+/) では拾えない。ここで横取りする。
  // ロギング一時停止中でもオシロは見えるべきなので、state.paused の判定より前に置く。
  if (line.startsWith('WF,')) {
    scopeOnLine(line);
    return;
  }
  if (line.startsWith('SCOPE:')) {
    setScopeDeviceOn(line.substring(6).trim().toUpperCase() === 'ON');
    // Left on by an earlier page (its OFF on unload never arrived): counting
    // would stay stopped without anyone noticing. Turn it off (R-6).
    if (scope.deviceOn && !scope.active && state.isConnected) sendCommand('SET_SCOPE:OFF');
    return;
  }
  if (line.startsWith('SCOPE_RATE:')) {
    const v = parseInt(line.substring(11));
    if (!isNaN(v)) { settings.scopeRate = v; Bus.emit('device', 'scopeRate'); }
    return;
  }
  // SCOPE_REARM:<offset> (the re-arm level is the threshold minus this), SCOPE_TRIG:NORMAL | SCOPE_TRIG:FREE
  if (line.startsWith('SCOPE_REARM:')) {
    const a = line.substring(12).trim();
    if (/^\d+$/.test(a)) { settings.scopeRearm = String(parseInt(a)); Bus.emit('device', 'scopeRearm'); }
    return;
  }
  if (line.startsWith('SCOPE_TRIG:')) {
    const a = line.substring(11).trim().toUpperCase();
    if (a === 'FREE' || a === 'NORMAL') { settings.scopeTrig = a; Bus.emit('device', 'scopeTrig'); }
    return;
  }

  // Logging paused (web side): keep showing raw lines and control responses,
  // but stop recording incoming data events. The device keeps measuring, so the
  // event count will show a gap once logging resumes.
  if (state.paused) return;

  // Event line: exactly 13 whitespace-separated tokens. A line that lost its CR/LF and was
  // glued to the next one has more, a truncated one has fewer: drop both (C-1). The firmware
  // sets the USB-CDC TX timeout to 0 while counting, so a stalled host can lose a line's tail.
  const parts = line.split(/\s+/);
  const withGps = parts.length === EVENT_TOKEN_COUNT_GPS;
  if (parts.length !== EVENT_TOKEN_COUNT && !withGps) return;

  const count       = parseInt(parts[0]);
  const timestampUs = parseInt(parts[1]);   // device Time, microseconds (v2 firmware)
  const adc         = parseInt(parts[2]);
  const deadtimeUs  = parseInt(parts[3]);   // device cumulative Deadtime, microseconds (v2)
  // The BME280 values are only plausible numbers or "nan" (no sensor); anything else is noise.
  const plausible = (v, lo, hi) => (v >= lo && v <= hi ? v : NaN);
  const tempC       = plausible(parseFloat(parts[4]), -40, 125);
  const humPct      = plausible(parseFloat(parts[5]), 0, 100);
  const pressHpa    = plausible(parseFloat(parts[6]), 300, 1100);
  const dig = [parseInt(parts[7]),  parseInt(parts[8]),  parseInt(parts[9])];
  const ana = [parseInt(parts[10]), parseInt(parts[11]), parseInt(parts[12])];

  // Range checks: a glued or cut line shows up as an impossible value. Digital inputs are
  // 0/1 (digitalRead), analog inputs and the ADC are 12-bit.
  const inAdc = v => Number.isInteger(v) && v >= 0 && v <= ADC_MAX;
  if (!(Number.isInteger(count) && count >= 1 && Number.isInteger(timestampUs) && timestampUs >= 0 &&
        inAdc(adc) && Number.isInteger(deadtimeUs) && deadtimeUs >= 0 &&
        dig.every(d => d === 0 || d === 1) && ana.every(inAdc))) return;

  // GPS 対応ファームの末尾 5 列。GPS なしは "0 -1 0 nan nan"。
  let ppsUtc = 0, ppsDt = -1, ppsPeriod = 0, lat = NaN, lon = NaN;
  if (withGps) {
    ppsUtc = parseInt(parts[13]); ppsDt = parseInt(parts[14]); ppsPeriod = parseInt(parts[15]);
    lat = parseFloat(parts[16]); lon = parseFloat(parts[17]);
    if (!(Number.isInteger(ppsUtc) && ppsUtc >= 0 && Number.isInteger(ppsDt) && ppsDt >= -1 &&
          Number.isInteger(ppsPeriod) && ppsPeriod >= 0)) return;
    if ((!isNaN(lat) && Math.abs(lat) > 90) || (!isNaN(lon) && Math.abs(lon) > 180)) return;
    if (ppsDt < 0 || ppsUtc === 0 || ppsPeriod === 0) { ppsUtc = 0; ppsDt = -1; ppsPeriod = 0; }
  }

  const event = {
    count,
    timestamp_us: timestampUs,
    pc_timestamp: Date.now(),
    adc,
    deadtime_us: deadtimeUs,
    temp_c: tempC,
    hum_pct: humPct,
    press_hpa: pressHpa,
    // Plain fields rather than two small arrays: up to MAX_EVENTS of these stay
    // in memory, and each array costs an extra heap object per event (R-17).
    d1: dig[0], d2: dig[1], d3: dig[2],
    a1: ana[0], a2: ana[1], a3: ana[2],
    pps_utc: ppsUtc, pps_dt_us: ppsDt, pps_period_us: ppsPeriod,   // 直前の PPS の UTC[s]・そこからの経過[µs]・PPS の間隔[µs] (GPS なしは 0 / -1 / 0)
    lat, lon,
    seg: 0,           // rate segment id (set by rateTrack)
    wall_us: 0,       // device clock mapped onto wall time, fixed at arrival (R-11)
    demo: state.connectionType === 'demo',   // never uploaded, even by Re-send
    run: state.upload.runId,  // the connection it arrived in; Re-send keeps to the current one (N-13)
    uploaded: false,  // set when the server accepted it (R-3)
    rejected: false,  // set when the server refused it with HTTP 400
  };
  event.wall_us = uploadClockUs(event);
  rateTrack(event);

  state.events.push(event);

  if (state.events.length > MAX_EVENTS + EVENTS_TRIM_CHUNK) {
    const drop = state.events.length - MAX_EVENTS;
    state.events.splice(0, drop);
    lastTableLength = Math.max(0, lastTableLength - drop);
  }
  if (state.events.length > MAX_EVENTS) showMemWarning();

  if (state.autoSave.enabled) {
    const fmt = settings.autoSaveFormat;
    if (fmt === 'dat' || fmt === 'both') state.autoSave.queues.dat.push(event);
    if (fmt === 'csv' || fmt === 'both') state.autoSave.queues.csv.push(event);
  }

  if (state.upload.enabled) {
    enqueueUpload(event);
  }

  // Incremental stats
  const s = state.stats;
  s.n++;
  if (!isNaN(tempC))  { s.nTemp++; s.sumTemp  += tempC;  s.sumTemp2 += tempC * tempC;
                        if (tempC  < s.minTemp)  s.minTemp  = tempC;
                        if (tempC  > s.maxTemp)  s.maxTemp  = tempC; }
  if (!isNaN(humPct)) { s.nHum++; s.sumHum   += humPct;
                        if (humPct < s.minHum)   s.minHum   = humPct;
                        if (humPct > s.maxHum)   s.maxHum   = humPct; }
  if (!isNaN(pressHpa)) { s.nPress++; s.sumPress += pressHpa;
                          if (pressHpa < s.minPress) s.minPress = pressHpa;
                          if (pressHpa > s.maxPress) s.maxPress = pressHpa; }
  s.sumAdc  += adc;
  if (adc > s.maxAdc) s.maxAdc = adc;
  for (let i = 0; i < 3; i++) {
    if (dig[i] === 1) s.digHits[i]++;
    if (!isNaN(ana[i])) s.sumAna[i] += ana[i];
  }

  // Update histogram bin
  const binWidth = settings.binWidth;
  const numBins = getNumBins();
  const bin = Math.min(Math.floor(adc / binWidth), numBins - 1);
  if (hist.binWidth === binWidth && hist.counts.length === numBins) {
    hist.counts[bin]++;
  } else {
    rebuildHistogram();
  }
  hist.hitMs[bin] = performance.now();
  Bus.emit('hit', bin);

  statsDirty = true;
}

let lastTableLength = 0;

// ========== Count rate (board counters, R-1) ==========
// The page used to divide "events received by the browser" by "board time since
// boot", which reads ~0 cps when it attaches to a board that has run for hours,
// ignores deadtime (scope dwell, OLED) and drifts once MAX_EVENTS is reached.
// Instead, take differences of the board's own count / time / deadtime between
// the start and the latest event of a segment and divide by live time -- the same
// formula the OLED uses. A segment ends when the counters go backwards (RESET,
// reboot, rename) or the user disconnects; segments are summed.
// The totals run from the last "Clear Data" -- like Total Events and the
// histogram -- across disconnects and reconnects (N-5).

// The totals only mean something for one board. When a different board reports
// its address while data from another one is on the page, say so.
function noteBoardAddress(addr) {
  const r = state.rate;
  if (r.boardAddr && r.boardAddr !== addr && state.stats.n > 0) {
    showNotice('notice.boardChanged', { prev: r.boardAddr, now: addr });
  }
  r.boardAddr = addr;
}

function rateBaseOf(ev) {
  // count 1 means the board just started counting (boot or RESET), so the
  // stretch from its zero point up to this event belongs to the session too.
  return ev.count === 1
    ? { count: 0, timeUs: 0, deadUs: 0 }
    : { count: ev.count, timeUs: ev.timestamp_us, deadUs: ev.deadtime_us };
}

function rateTrack(ev) {
  const r = state.rate;
  const seg = r.seg;
  if (seg && (ev.count <= seg.last.count || ev.timestamp_us < seg.last.timeUs ||
              ev.deadtime_us < seg.last.deadUs)) {
    rateCloseSegment();
  }
  if (!r.seg) {
    r.seg = { id: r.nextId++, base: rateBaseOf(ev), last: null };
  }
  r.seg.last = { count: ev.count, timeUs: ev.timestamp_us, deadUs: ev.deadtime_us };
  ev.seg = r.seg.id;
}

function rateSegDiff(seg) {
  if (!seg || !seg.last) return { counts: 0, elapsedUs: 0, deadUs: 0 };
  return {
    counts:    seg.last.count  - seg.base.count,
    elapsedUs: seg.last.timeUs - seg.base.timeUs,
    deadUs:    seg.last.deadUs - seg.base.deadUs,
  };
}

function rateCloseSegment() {
  const r = state.rate;
  if (!r.seg) return;
  const d = rateSegDiff(r.seg);
  r.done.counts    += d.counts;
  r.done.elapsedUs += d.elapsedUs;
  r.done.deadUs    += d.deadUs;
  r.seg = null;
  r.chartLast = null;
}

function rateSummary() {
  const r = state.rate;
  const d = rateSegDiff(r.seg);
  const counts    = r.done.counts    + d.counts;
  const elapsedUs = r.done.elapsedUs + d.elapsedUs;
  const deadUs    = r.done.deadUs    + d.deadUs;
  const liveUs    = elapsedUs - deadUs;
  const liveSec   = liveUs / 1e6;
  return {
    counts, elapsedUs, deadUs, liveUs,
    rate:    liveSec > 0 ? counts / liveSec : 0,
    rateStd: liveSec > 0 ? Math.sqrt(counts) / liveSec : 0,
  };
}


// ========== Auto-Save ==========
let autoSaveRun = null;   // the flush in progress (awaited by forced flushes, N-1)

async function selectSaveFolder() {
  if (!('showDirectoryPicker' in window)) {
    Bus.emit('alert', { key: 'alert.fsApi' });
    return;
  }
  try {
    // Must be the first await, while the click's user activation is still valid.
    const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    // Whatever is still queued for the previous folder goes there first. A forced
    // flush also waits for a write already in progress, so none of it can end up
    // in the new folder.
    try { await flushAutoSave({ force: true }); } catch (_) {}
    const as = state.autoSave;
    as.dirHandle = dirHandle;
    as.enabled = true;
    as.prefix = null;
    as.parts = {};
    as.lastFile = { dat: null, csv: null };
    as.written = { dat: 0, csv: 0 };
    as.intervalMs = AUTOSAVE_MIN_INTERVAL_MS;
    as.nextFlushMs = 0;
    as.lastError = null;
    Bus.emit('autosave');
  } catch (e) {
    if (e.name !== 'AbortError') console.error('Folder select error:', e);
  }
}

// Appends content, writing the header first only when the file is still empty.
// Deciding by file size (not by "first write of this page session") means a
// reconnect, a re-selected folder or a second page never puts a header row in
// the middle of a file (R-2 b).
async function appendToFile(dirHandle, filename, content, header) {
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const file = await fileHandle.getFile();
  const writable = await fileHandle.createWritable({ keepExistingData: true });
  try {
    await writable.seek(file.size);
    await writable.write(file.size === 0 && header ? header + content : content);
    await writable.close();
  } catch (e) {
    // Drop the swap file instead of leaving a half-written one behind.
    try { await writable.abort(); } catch (_) {}
    throw e;
  }
}

async function fileSizeIn(dirHandle, filename) {
  try {
    const fh = await dirHandle.getFileHandle(filename);   // no create: just look
    return (await fh.getFile()).size;
  } catch (e) {
    if (e && e.name === 'NotFoundError') return 0;
    throw e;
  }
}

// Every append makes Chrome copy the whole file, so a file is closed off at
// AUTOSAVE_SPLIT_BYTES and the day continues in <prefix>_<date>_02, _03, ...
// (each with its own header). Ordinary cosmic-ray runs never get there; a
// strong source can (N-15). Looking up the size does not copy anything.
async function autoSaveFileName(dirHandle, prefix, day, fmt) {
  const as = state.autoSave;
  const key = `${fmt}|${prefix}|${day}`;
  let part = as.parts[key] || 1;
  const nameOf = n => n === 1 ? `${prefix}_${day}.${fmt}` : `${prefix}_${day}_${String(n).padStart(2, '0')}.${fmt}`;
  while (await fileSizeIn(dirHandle, nameOf(part)) >= AUTOSAVE_SPLIT_BYTES) part++;
  as.parts[key] = part;
  return nameOf(part);
}

const DAT_COLUMNS = '# Event\tPC_Timestamp\tTime[us]\tADC[0-4095]\tDeadtime[us]\tTemp[C]\tHum[%]\tPress[hPa]\tDig1\tDig2\tDig3\tAna1\tAna2\tAna3\tPPS_UTC_s\tPPS_dt_us\tPPS_period_us\tLat\tLon\tUTC_GPS\n';
const CSV_COLUMNS = 'Event,PC_Timestamp,Time_us,ADC,Deadtime_us,Temp_C,Hum_pct,Press_hPa,Dig1,Dig2,Dig3,Ana1,Ana2,Ana3,PPS_UTC_s,PPS_dt_us,PPS_period_us,Lat,Lon,UTC_GPS\n';

// One header builder for every path -- auto-save and download, .dat and .csv --
// so all files carry the same metadata (R-15). Metadata lines start with '#';
// in the CSV they come before the column row (pandas: read_csv(path, comment='#')).
// The values are the ones known when the file is created. `isDemo` comes from
// the events being written, not from whether the demo is running right now.
function buildFileHeader(format, isDemo) {
  const lines = [];
  const comment = settings.fileComment;
  if (comment) for (const l of comment.split(/\r?\n/)) lines.push('# ' + l);
  if (isDemo) lines.push(DEMO_FILE_NOTE.trimEnd());
  lines.push('# Source: CosmicRay Recorder v2 (v2/index.html)');
  // OMAME だけ追加する注釈行（# で始まるので列の読み取りには影響しない。OHASHI の出力は従来どおり）
  if (modelProfile.id === 'omame') {
    lines.push('# Detector model: OMAME (MUON FOB). Temp column = nRF52840 die temperature, not ambient; Hum / Press = nan; Dig / Ana = 0.');
    if (state.hv != null) lines.push(`# SiPM bias setting: ${state.hv} V`);
  }
  if (state.bleName)           lines.push(`# Device: ${state.bleName}`);
  if (state.conn.btAddr)       lines.push(`# Board address: ${state.conn.btAddr}`);
  if (state.mode)              lines.push(`# Trigger mode: ${state.mode}`);
  if (state.threshold != null) lines.push(`# Signal threshold: ${state.threshold} / 4095`);
  if (state.pwmDuty != null && modelProfile.id !== 'omame') lines.push(`# Comparator PWM duty: ${state.pwmDuty} / 255`);   // OMAME にコンパレータは無い
  if (state.gpsEnabled) {
    const g = state.gps;
    if (g && g.valid && g.lat != null && g.lon != null) {
      lines.push(`# GPS position: lat ${g.lat.toFixed(6)} lon ${g.lon.toFixed(6)}` + (g.alt != null ? ` alt ${g.alt.toFixed(1)} m` : '') + (g.sats != null ? ` (${g.sats} satellites)` : ''));
    }
    lines.push('# GPS: "### PPS <Time[us]> <UTC unix seconds>" lines mark the 1PPS edges on the same clock as Time[us]; "### GPS fix=.." lines give the position.');
  }
  lines.push('# PC_Timestamp: UTC (trailing Z). Time / Deadtime: board counters in microseconds since boot or RESET.');
  lines.push('# Column 2 (PC_Timestamp) is added by this page, so later columns sit one to the right of the firmware / SD log.');
  lines.push('# PPS_UTC_s / PPS_dt_us / PPS_period_us / Lat / Lon come from the firmware (empty without GPS). UTC_GPS (last column) = PPS_UTC_s + PPS_dt_us / PPS_period_us, computed by this page.');
  return lines.join('\n') + '\n' + (format === 'csv' ? CSV_COLUMNS : DAT_COLUMNS);
}

// File name base from the board's BLE name, without the DEMO_ mark.
function getFileBase() {
  const fallback = modelProfile.bleDefault;
  const name = (state.bleName || state.conn.bleName || fallback).trim();
  return name.replace(/[^A-Za-z0-9_\-]/g, '_') || fallback;
}

// デモの合成データは、あとから本物と取り違えないようファイル名の頭で分かるようにする。
function getFilePrefix(isDemo = demo.on) {
  return (isDemo ? 'DEMO_' : '') + getFileBase();
}

// イベントの UTC (GPS)。直前の PPS の UTC に、PPS からの経過を PPS の間隔で割った分を足す。
// 間隔で割るのは、水晶の誤差 (数十 ppm なら 1 秒で数十 µs) を消すため。GPS なしは null。
function eventUtcParts(ev) {
  if (!ev.pps_period_us || ev.pps_dt_us < 0 || !ev.pps_utc) return null;
  const totalUs = Math.round(ev.pps_dt_us * 1e6 / ev.pps_period_us);
  return { s: ev.pps_utc + Math.floor(totalUs / 1e6), us: totalUs % 1e6 };
}

// 2026-11-12T01:02:03.123456Z (µs まで)。GPS なしは空。
function eventUtcString(ev) {
  const u = eventUtcParts(ev);
  if (!u) return '';
  return new Date(u.s * 1000).toISOString().slice(0, 19) + '.' + String(u.us).padStart(6, '0') + 'Z';
}

// ファームのイベント行の末尾 5 列 + 計算した UTC。GPS なしは空欄。
function eventGpsFields(ev) {
  const has = ev.pps_dt_us >= 0 && ev.pps_utc > 0;
  const deg = v => (isNaN(v) ? '' : v.toFixed(5));
  return [has ? ev.pps_utc : '', has ? ev.pps_dt_us : '', has ? ev.pps_period_us : '', deg(ev.lat), deg(ev.lon), eventUtcString(ev)];
}

// Pressure keeps the firmware's one decimal; a second digit would be invented precision.
function eventToDatLine(ev) {
  if (ev.kind === 'gps') return ev.line + '\n';
  const pcTs = new Date(ev.pc_timestamp).toISOString().replace('T', '-').replace(/:/g, '-');
  const f = (v, d = 1) => (isNaN(v) ? '' : v.toFixed(d));
  return `${ev.count}\t${pcTs}\t${ev.timestamp_us}\t${ev.adc}\t${ev.deadtime_us}\t${f(ev.temp_c, 1)}\t${f(ev.hum_pct, 1)}\t${f(ev.press_hpa, 1)}\t${ev.d1}\t${ev.d2}\t${ev.d3}\t${ev.a1}\t${ev.a2}\t${ev.a3}\t${eventGpsFields(ev).join('\t')}\n`;
}

function eventToCsvLine(ev) {
  if (ev.kind === 'gps') return ev.line + '\n';
  const f = (v, d = 1) => (isNaN(v) ? '' : v.toFixed(d));
  return `${ev.count},${new Date(ev.pc_timestamp).toISOString()},${ev.timestamp_us},${ev.adc},${ev.deadtime_us},${f(ev.temp_c, 1)},${f(ev.hum_pct, 1)},${f(ev.press_hpa, 1)},${ev.d1},${ev.d2},${ev.d3},${ev.a1},${ev.a2},${ev.a3},${eventGpsFields(ev).join(',')}\n`;
}

// Writes one format's queue to `dir` under the file name base `base`. Both are
// fixed by the caller before the first await (N-1). Events are grouped by their
// own local date, so a batch that straddles midnight is split between the two
// days' files (R-2 a), and by their own demo mark, so synthetic events always go
// to a DEMO_ file even when the demo has already been stopped (N-4).
// On failure only this format's unwritten tail goes back on its queue (R-2 d).
async function flushAutoSaveFormat(fmt, dir, base) {
  const as = state.autoSave;
  const batch = as.queues[fmt];
  if (batch.length === 0) return;
  as.queues[fmt] = [];
  const lineOf = fmt === 'dat' ? eventToDatLine : eventToCsvLine;
  let i = 0;
  try {
    while (i < batch.length) {
      const d0 = new Date(batch[i].pc_timestamp);
      const day = formatLocalDate(d0);
      const nextMidnight = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + 1).getTime();
      const isDemo = !!batch[i].demo;
      const parts = [];
      let j = i, nEvents = 0;
      while (j < batch.length && batch[j].pc_timestamp < nextMidnight && !!batch[j].demo === isDemo) {
        if (batch[j].kind !== 'gps') nEvents++;
        parts.push(lineOf(batch[j++]));
      }
      const name = await autoSaveFileName(dir, (isDemo ? 'DEMO_' : '') + base, day, fmt);
      await appendToFile(dir, name, parts.join(''), buildFileHeader(fmt, isDemo));
      as.written[fmt] += nEvents;
      as.lastFile[fmt] = name;
      i = j;
    }
  } catch (e) {
    // concat, not spread: the queue can be very large.
    as.queues[fmt] = batch.slice(i).concat(as.queues[fmt]);
    throw e;
  }
}

async function flushAutoSave(opts) {
  const force = !!(opts && opts.force);
  const as = state.autoSave;
  // Re-entrancy guard: the 1 s interval can fire again before a slow write
  // finishes; two writers seeking/appending to the same file corrupt it.
  // A forced flush (disconnect, folder change, page hidden) must not skip: it
  // waits for the write in progress and then writes whatever is left (N-1).
  while (as.flushing) {
    if (!force) return;
    try { await autoSaveRun; } catch (_) {}
  }
  if (!as.enabled || !as.dirHandle) return;
  if (!force && Date.now() < as.nextFlushMs) return;
  if (as.queues.dat.length === 0 && as.queues.csv.length === 0) return;

  // The file name base is fixed at the first write of a session and kept until
  // disconnect (R-2 c). Wait briefly for the board to report its BLE name, mode
  // and thresholds, otherwise the first lines would go to a file named after
  // the previously used board and the header would lack the settings.
  if (!as.prefix) {
    const ready = force || !state.isConnected ||
      (state.bleNameKnown && state.mode != null && state.threshold != null) ||
      (Date.now() - state.connectedAtMs >= AUTOSAVE_PREFIX_WAIT_MS);
    if (!ready) return;
    as.prefix = getFileBase();
  }

  // Fix the destination now. Disconnect and folder selection replace these
  // while the writes below are being awaited (N-1).
  const dir = as.dirHandle;
  const base = as.prefix;

  as.flushing = true;
  const t0 = performance.now();
  autoSaveRun = (async () => {
    let err = null;
    for (const fmt of ['dat', 'csv']) {
      try {
        await flushAutoSaveFormat(fmt, dir, base);
      } catch (e) {
        console.error(`Auto-save ${fmt} write error:`, e);
        if (!err) err = e;
      }
    }
    as.lastError = err ? (err.message || String(err)) : null;
  })();
  try {
    await autoSaveRun;
  } finally {
    as.flushing = false;
    // Every append makes Chrome copy the whole file, so stretch the interval as
    // the file grows, keeping that copy to a few percent of wall time (R-2 e).
    // The cap bounds what a crash can lose; the file split keeps writes short.
    const took = performance.now() - t0;
    as.intervalMs = Math.min(AUTOSAVE_MAX_INTERVAL_MS,
                             Math.max(AUTOSAVE_MIN_INTERVAL_MS, took / AUTOSAVE_IO_DUTY));
    as.nextFlushMs = Date.now() + as.intervalMs;
    Bus.emit('autosave');
  }
}

function autoSavePendingCount() {
  const q = state.autoSave.queues;
  return Math.max(q.dat.length, q.csv.length);
}

// End of a measurement session: the next one picks its own file prefix.
function endAutoSaveSession() {
  state.autoSave.prefix = null;
  Bus.emit('autosave');
}

// ========== Server Upload ==========
// Mirrors the auto-save trio (queue -> 1 s interval -> flush with a re-entrancy
// lock and requeue-on-failure), but over HTTP. Auto-save is the record; this is
// a mirror, which is what licenses the bounded queue and the drop policy below.

// --- config persistence ----------------------------------------------------

function loadUploadConfig() {
  const u = state.upload;
  try {
    const raw = localStorage.getItem(UPLOAD_STORE_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      u.serverUrl   = c.serverUrl || '';
      u.stationId   = c.stationId || '';
      u.deviceLabel = c.deviceLabel || '';
      u.lat         = (c.gps && c.gps.lat != null) ? c.gps.lat : '';
      u.lon         = (c.gps && c.gps.lon != null) ? c.gps.lon : '';
      u.decimate    = Number(c.decimate) > 0 ? Number(c.decimate) : 1;
      u.remember    = !!c.rememberPassword;
      // The token is only kept across browser restarts when "remember" is on.
      if (u.remember) {
        u.token      = c.token || null;
        u.tokenExpMs = Number(c.tokenExpMs) || 0;
      }
    }
  } catch (_) {}
  if (!u.remember) {
    try {
      const tk = JSON.parse(sessionStorage.getItem(UPLOAD_TOKEN_KEY) || 'null');
      if (tk && tk.token) { u.token = tk.token; u.tokenExpMs = Number(tk.tokenExpMs) || 0; }
    } catch (_) {}
  }

  // Only read the password back if the user opted in.
  if (u.remember) {
    try { uploadPassword = localStorage.getItem(UPLOAD_SECRET_KEY) || ''; } catch (_) {}
  }

  // A stored token past its expiry is useless; drop it so the UI shows "not configured".
  if (u.tokenExpMs && Date.now() >= u.tokenExpMs) {
    u.token = null;
    u.tokenExpMs = 0;
  }

  Bus.emit('uploadForm');

  // Write the settings straight back. With "remember" off this removes a token
  // that an older version of this page left in localStorage (N-14).
  saveUploadConfig();
}

function saveUploadConfig() {
  const u = state.upload;
  try {
    localStorage.setItem(UPLOAD_STORE_KEY, JSON.stringify({
      v: 1,
      serverUrl: u.serverUrl,
      stationId: u.stationId,
      deviceLabel: u.deviceLabel,
      gps: { lat: u.lat, lon: u.lon },
      decimate: u.decimate,
      rememberPassword: u.remember,
      // A valid token is enough to upload, so it is treated like the password:
      // persisted only on opt-in, otherwise kept for this tab only (R-9).
      token: u.remember ? u.token : null,
      tokenExpMs: u.remember ? u.tokenExpMs : 0,
    }));
    // The password is stored ONLY on explicit opt-in, and cleared the moment it
    // is turned off. No obfuscation: base64/XOR would only imply protection that
    // isn't there.
    if (u.remember) {
      localStorage.setItem(UPLOAD_SECRET_KEY, uploadPassword);
    } else {
      localStorage.removeItem(UPLOAD_SECRET_KEY);
    }
  } catch (_) {}
  try {
    if (!u.remember && u.token) {
      sessionStorage.setItem(UPLOAD_TOKEN_KEY, JSON.stringify({ token: u.token, tokenExpMs: u.tokenExpMs }));
    } else {
      sessionStorage.removeItem(UPLOAD_TOKEN_KEY);
    }
  } catch (_) {}
}

// The form lives on the screen; ui.js copies it into state.upload / uploadPassword.
function readUploadForm() {
  Hooks.readUploadForm();
}

// --- clock -----------------------------------------------------------------

// Anchor the device's microsecond clock to the browser wall clock.
// pc_timestamp alone is jittery (USB/BLE deliver bursts of buffered lines that
// all get nearly the same value); timestamp_us alone has precise spacing but no
// wall time. Combining them gives real sub-millisecond spacing on an absolute
// timeline, and re-anchors on reboot or an NTP step.
function uploadClockUs(ev) {
  const u = state.upload;
  const devUs = ev.timestamp_us;
  const wallUs = ev.pc_timestamp * 1000;
  const reboot = devUs < u.anchorDevUs || ev.count < u.anchorCount;
  const derived = u.anchorWallUs + (devUs - u.anchorDevUs);
  const drift = Math.abs(derived - wallUs);

  if (!u.anchorWallUs || reboot || drift > 5000000) {   // 5 s
    u.anchorWallUs = wallUs;
    u.anchorDevUs = devUs;
    u.anchorCount = ev.count;
    return wallUs;
  }
  u.anchorCount = ev.count;
  return derived;
}

// The server parser splits on '-' and needs >= 6 parts, in LOCAL time.
// Sending ISO-8601 would yield 3 parts, which makes the server name the file
// after its own UTC date and write a corrupt datetime column.
function formatServerTimestamp(epochUs) {
  const d = new Date(Math.floor(epochUs / 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const frac = ((epochUs % 1000000) + 1000000) % 1000000;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-` +
         `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.${p(frac, 6)}`;
}

function startUploadRun() {
  const u = state.upload;
  u.runId = (globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID()
          : 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  u.anchorWallUs = 0;
  u.anchorDevUs = 0;
  u.anchorCount = 0;
}

// --- payload ---------------------------------------------------------------

// v2 event -> legacy /upload-data/:id body.
// Lost in this mode: hum_pct, press_hpa, dig[0..2], ana[0..2], ADC bit depth,
// keV energy, coincidence config and run identity. Surfaced in the UI as
// upload.legacyMode so it is never a silent omission.
function eventToLegacyPayload(ev) {
  const u = state.upload;
  // Fixed when the event arrived (R-11). Computing it here, at send time, let a
  // retried old event look like a reboot and re-anchor the clock for later ones.
  const us = ev.wall_us || (ev.pc_timestamp * 1000);
  return {
    event: ev.count,
    timestamp: formatServerTimestamp(us),
    time: ev.timestamp_us,
    adc: ev.adc,
    // v2 has no SiPM amplitude channel; this is the ADC pin voltage in mV.
    // A computed value, not a measured one -- documented in server-plan.html.
    vol: +(ev.adc / ADC_MAX * 3300).toFixed(3),
    // v2 counts deadtime in microseconds; the legacy column follows the
    // CosmicWatch convention of milliseconds.
    deadtime: Math.round(ev.deadtime_us / 1000),
    temp: ev.temp_c,
    // Ignored by the legacy handler, but forward-compatible and it closes the
    // timezone hole for anything that later reads these rows.
    timestamp_utc: new Date(Math.floor(us / 1000)).toISOString(),
    tz: (Intl.DateTimeFormat().resolvedOptions().timeZone || ''),
    tz_offset_min: -new Date().getTimezoneOffset(),
    run_id: ev.run || u.runId,
    device_label: u.deviceLabel || undefined,
  };
}

// --- queue -----------------------------------------------------------------

function enqueueUpload(ev) {
  const u = state.upload;

  // デモの合成イベントは測定サーバへ送らない。本物の観測データを汚さないため。
  if (ev.demo || state.connectionType === 'demo') return;

  if (u.decimate > 1 && (ev.count % u.decimate) !== 0) {
    u.skipped++;
    return;
  }

  u.queue.push(ev);

  if (u.queue.length > UPLOAD_QUEUE_HARD) {
    // Drop OLDEST: the newest events are what makes a live server view useful,
    // and the dropped ones still exist on disk and in state.events (recoverable
    // with "Re-send buffered events"). Always counted, never silent.
    const drop = u.queue.length - UPLOAD_QUEUE_HARD;
    u.queue.splice(0, drop);
    u.dropped += drop;
  }
}

// --- HTTP ------------------------------------------------------------------

function uploadUrl(path) {
  return state.upload.serverUrl + path;
}

// Single choke point for every request. Never throws: returns a result object,
// so callers can branch on status without try/catch noise.
async function uploadFetch(path, { method = 'GET', body = null, auth = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_HTTP_TIMEOUT);
  try {
    const headers = {};
    if (body !== null) headers['Content-Type'] = 'application/json';
    if (auth && state.upload.token) headers['Authorization'] = `Bearer ${state.upload.token}`;

    const res = await fetch(uploadUrl(path), {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
      credentials: 'omit',   // keeps the request non-credentialed so the server's
                             // Access-Control-Allow-Origin: * is honoured
      cache: 'no-store',
    });

    let json = null;
    try { json = await res.json(); } catch (_) {}
    return { ok: res.ok, status: res.status, json, err: null };
  } catch (e) {
    // Network error, CORS rejection, timeout -- indistinguishable by design in
    // the Fetch spec, so they share one retryable branch.
    return { ok: false, status: 0, json: null, err: e.name === 'AbortError' ? 'timeout' : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function decodeJwtExpMs(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.exp ? payload.exp * 1000 : 0;
  } catch (_) {
    return 0;
  }
}

async function uploadLogin() {
  const u = state.upload;
  readUploadForm();

  if (!u.serverUrl || !u.stationId || !uploadPassword) {
    u.lastError = t('upload.needFields');
    u.authError = true;
    Bus.emit('upload');
    return false;
  }
  try {
    const parsed = new URL(u.serverUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('scheme');
  } catch (_) {
    u.lastError = t('upload.badUrl');
    u.authError = true;
    Bus.emit('upload');
    return false;
  }

  u.loggingIn = true;
  u.authError = false;
  u.lastError = null;
  Bus.emit('upload');

  const login = await uploadFetch('/auth/login', {
    method: 'POST',
    body: { id: u.stationId, password: uploadPassword },
  });

  if (!login.ok || !login.json || !login.json.token) {
    u.loggingIn = false;
    u.authError = true;
    // A status of 0 means the request never completed: on a mixed-content or
    // CORS failure the browser tells us nothing more, so point at the likely cause.
    u.lastError = login.status === 0
      ? t('upload.corsHint')
      : t('upload.loginFail', { msg: (login.json && (login.json.error || login.json.message)) || `HTTP ${login.status}` });
    Bus.emit('upload');
    return false;
  }

  u.token = login.json.token;
  u.tokenExpMs = decodeJwtExpMs(u.token);

  // The station directory must exist before any upload is accepted (the server
  // answers 404 otherwise), and /setup-id is idempotent, so run it every login.
  const setup = await uploadFetch('/setup-id', {
    method: 'POST',
    auth: true,
    body: {
      id: u.stationId,
      comment: settings.fileComment || u.deviceLabel || 'CosmicRay Recorder v2',
      gps_latitude: u.lat === '' ? null : u.lat,
      gps_longitude: u.lon === '' ? null : u.lon,
      created_at: new Date().toISOString(),
    },
  });

  u.loggingIn = false;

  if (!setup.ok) {
    u.authError = true;
    u.lastError = t('upload.loginFail', {
      msg: (setup.json && (setup.json.error || setup.json.message)) || `HTTP ${setup.status}`,
    });
    Bus.emit('upload');
    return false;
  }

  u.authError = false;
  u.lastError = null;
  saveUploadConfig();
  Bus.emit('upload');
  return true;
}

// Keeps a usable token in hand. Refresh needs a still-valid token (the server
// was hardened so an unauthenticated refresh can no longer mint one), which is
// exactly why the session password is kept in memory.
// `force` is used after a 401/403: a token can be rejected while still being
// inside its stated expiry (server restart with a new JWT_SECRET, revoked user),
// and without forcing we would keep retrying a dead token every tick forever
// instead of surfacing an auth error.
async function uploadEnsureAuth(force) {
  const u = state.upload;
  if (!u.token) return false;

  const expiringSoon = u.tokenExpMs && (Date.now() > u.tokenExpMs - 5 * 60 * 1000);
  if (!force && !expiringSoon) return true;

  const r = await uploadFetch('/auth/refresh', { method: 'POST', auth: true, body: {} });
  if (r.ok && r.json && r.json.token) {
    u.token = r.json.token;
    u.tokenExpMs = decodeJwtExpMs(u.token);
    saveUploadConfig();
    return true;
  }
  if (uploadPassword) return await uploadLogin();

  u.authError = true;
  u.lastError = t('upload.stAuthError');
  return false;
}

// Legacy API: one HTTP request per event, so run a few concurrently.
// Returns per-event outcomes rather than a single verdict, which is what lets
// flushUpload() discard only the events the server actually refused.
async function sendBatchLegacy(batch) {
  const u = state.upload;
  const results = new Array(batch.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= batch.length) return;
      const r = await uploadFetch(`/upload-data/${encodeURIComponent(u.stationId)}`, {
        method: 'POST',
        auth: true,
        body: eventToLegacyPayload(batch[i]),
      });
      results[i] = r;
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_LEGACY_CONC, batch.length) }, worker)
  );
  return results;
}

function uploadBackoffMs(attempt) {
  const base = Math.min(1000 * Math.pow(2, Math.max(0, attempt - 1)), UPLOAD_BACKOFF_MAX);
  return base * (0.8 + 0.4 * Math.random());   // jitter, so many stations recovering
                                               // from one restart don't synchronise
}

// --- flush -----------------------------------------------------------------

async function flushUpload(opts) {
  const final = !!(opts && opts.final);
  const u = state.upload;

  if (!u.enabled || !u.token) return;
  if (u.flushing) return;                        // same idiom as autoSave.flushing
  if (!final && Date.now() < u.nextAttemptMs) return;
  if (u.queue.length === 0) return;

  // Skip entirely while offline: no point burning backoff attempts on requests
  // the browser will refuse to make.
  if (navigator.onLine === false) {
    Bus.emit('upload');
    return;
  }

  u.flushing = true;
  try {
    let rounds = 0;
    do {
      if (!await uploadEnsureAuth()) {
        // A failed refresh or login backs off like any other failure. Without this the
        // refresh and the login are retried every second, by every station at once (C-4).
        u.attempt++;
        u.nextAttemptMs = Date.now() + uploadBackoffMs(u.attempt);
        return;
      }

      const batch = u.queue.splice(0, UPLOAD_LEGACY_BATCH);
      if (batch.length === 0) return;

      // Out of the queue but not marked yet while the requests are in flight:
      // Re-send has to treat these as already queued (N-3).
      u.inFlight = new Set(batch);
      const results = await sendBatchLegacy(batch);

      const retry = [];
      let ok = 0;
      let authFailed = false;
      let lastMsg = null;

      for (let i = 0; i < batch.length; i++) {
        const r = results[i];
        // Marked on the event itself so "Re-send" skips it (R-3).
        if (r && r.ok) { batch[i].uploaded = true; ok++; continue; }

        const status = r ? r.status : 0;
        if (status === 401 || status === 403) {
          authFailed = true;
          retry.push(batch[i]);
        } else if (status === 400) {
          // Poison event: the server will never accept it. Record and move on
          // rather than blocking the queue forever.
          batch[i].rejected = true;
          if (u.rejected.length < UPLOAD_REJECT_CAP) {
            u.rejected.push({ count: batch[i].count, reason: (r.json && r.json.error) || 'rejected' });
          }
          u.failed++;
        } else {
          retry.push(batch[i]);
          lastMsg = (r && (r.err || (r.json && r.json.error))) || `HTTP ${status}`;
        }
      }

      u.sent += ok;

      if (retry.length) {
        // Head requeue with concat (not spread) to avoid argument-count limits
        // on large arrays -- same reasoning as the auto-save path.
        u.queue = retry.concat(u.queue);
        u.inFlight = null;
        u.failed += retry.length;
        u.attempt++;
        u.lastError = lastMsg;
        u.nextAttemptMs = Date.now() + uploadBackoffMs(u.attempt);

        if (authFailed) {
          const recovered = await uploadEnsureAuth(true);
          if (!recovered) { u.authError = true; return; }
          u.nextAttemptMs = Date.now();   // credentials refreshed, retry promptly
        }
        return;   // let the next tick (or the next `final` round) carry on
      }

      u.inFlight = null;
      u.attempt = 0;
      u.lastError = null;
      u.authError = false;
      rounds++;
    } while (final && u.queue.length > 0 && rounds < 200);
  } finally {
    u.inFlight = null;
    u.flushing = false;
    Bus.emit('upload');
  }
}

// --- actions ---------------------------------------------------------------

function uploadStart() {
  const u = state.upload;
  if (!u.token) return;
  if (demo.on) { Bus.emit('alert', { key: 'demo.uploadBlocked' }); return; }
  readUploadForm();
  saveUploadConfig();
  if (!u.runId) startUploadRun();
  u.enabled = true;
  u.attempt = 0;
  u.nextAttemptMs = 0;
  u.lastError = null;
  Bus.emit('upload');
}

async function uploadStop() {
  const u = state.upload;
  u.enabled = true;                       // keep the gate open for the final drain
  try { await flushUpload({ final: true }); } catch (_) {}
  u.enabled = false;
  Bus.emit('upload');
}

function uploadLogout() {
  const u = state.upload;
  u.enabled = false;
  u.token = null;
  u.tokenExpMs = 0;
  u.authError = false;
  u.lastError = null;
  uploadPassword = '';
  Bus.emit('uploadPasswordCleared');
  try { localStorage.removeItem(UPLOAD_SECRET_KEY); } catch (_) {}
  saveUploadConfig();
  Bus.emit('upload');
}

// Plain http:// to anything but this machine sends the password in the clear (R-9).
function isInsecureServerUrl(url) {
  try {
    const p = new URL(url);
    return p.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(p.hostname);
  } catch (_) {
    return false;
  }
}

// Re-queue events still in memory that never reached the server: the hard-cap
// drop case and events captured before upload was switched on. Events the server
// already accepted or refused are skipped, so the server gets no duplicates (R-3),
// and so are the ones in the batch being sent right now (N-3). Only events of the
// current connection are taken: older ones may come from another board and would
// be filed under this run (N-13).
// Only the free part of the queue is filled -- otherwise the cap would push out
// the very events being re-sent -- so a large backlog takes several presses.
function uploadResend() {
  const u = state.upload;
  const room = UPLOAD_QUEUE_HARD - u.queue.length;
  if (room <= 0) return;
  const already = new Set(u.queue);
  if (u.inFlight) for (const ev of u.inFlight) already.add(ev);
  const add = [];
  for (const ev of state.events) {
    if (add.length >= room) break;
    if (ev.uploaded || ev.rejected || ev.demo || already.has(ev)) continue;
    if (ev.run !== u.runId) continue;
    if (u.decimate > 1 && (ev.count % u.decimate) !== 0) continue;
    add.push(ev);
  }
  if (add.length === 0) return;
  // Older than anything already queued, so they go in front (oldest first).
  u.queue = add.concat(u.queue);
  u.attempt = 0;
  u.nextAttemptMs = 0;
  Bus.emit('upload');
}

function setLoggingPaused(paused) {
  state.paused = !!paused && state.isConnected;
  Bus.emit('paused');
  if (state.isConnected) Bus.emit('status');
}

function toggleLogging() {
  if (!state.isConnected) return;
  setLoggingPaused(!state.paused);
}

// The state half of the old connection-UI update: what a connection change does
// to the page's view of the device. The screen redraws on the 'conn' event.
function applyConnectionState(connected) {
  if (connected) {
    setLoggingPaused(false);
  } else {
    // While a BLE reconnect is pending the session continues.
    const retrying = state.reconnecting;
    // A pending reconnect keeps the user's pause; onConnected() restores it (N-12).
    if (!retrying) setLoggingPaused(false);
    state.mode = null;
    state.threshold = null;
    state.pwmDuty = null;
    if (pwmCalTimer) { clearTimeout(pwmCalTimer); pwmCalTimer = null; }
    state.pwmCalibrating = false;
    state.sdEnabled = null;
    state.extEnabled = null;
    state.oledEnabled = null;
    state.buzzerEnabled = null;
    state.vibEnabled = null;
    state.gpsEnabled = null;
    state.gps = null;
    state.beepMin = null;
    state.beepMax = null;
    state.beepMs = null;
    state.vibMin = null;
    state.vibMax = null;
    // A pending reconnect is the same board: keep its identity for the header.
    if (!retrying) {
      state.conn = { usbVendorId: null, usbProductId: null, bleId: null, bleName: null, btAddr: null, btAddrTimedOut: false };
    }
  }
  Bus.emit('conn', !!connected);
}

// ========== Rate Calculation ==========
// One point per refresh, from the board's counters rather than browser arrival
// times (USB / BLE deliver lines in bursts, R-14). The point covers the device
// time since the previous point, and at least RATE_WINDOW_US: it runs from the
// last event at or before that start (E_a) to the newest event (E_now), and its
// rate is (count difference) / (live time difference). Plotted at E_now's wall
// time on a real time axis.
function updateRateChart() {
  const events = state.events;
  const n = events.length;
  if (n === 0) return;
  const now = events[n - 1];
  const prev = state.rate.chartLast;
  if (prev === now) return;   // nothing new since the last point

  let start = now.timestamp_us - RATE_WINDOW_US;
  if (prev && prev.seg === now.seg && prev.timestamp_us < start) start = prev.timestamp_us;

  // Walk back within the same segment to the last event at or before `start`.
  let a = null;
  for (let i = n - 2; i >= 0; i--) {
    const ev = events[i];
    if (ev.seg !== now.seg) break;
    a = ev;
    if (ev.timestamp_us <= start) break;
  }
  if (!a) return;   // only one event in this segment so far

  const counts = now.count - a.count;
  const liveUs = (now.timestamp_us - a.timestamp_us) - (now.deadtime_us - a.deadtime_us);
  state.rate.chartLast = now;
  if (counts <= 0 || liveUs <= 0) return;

  state.rateHistory.push({ t: now.wall_us / 1000, rate: counts / (liveUs / 1e6) });
  if (state.rateHistory.length > MAX_RATE_HISTORY) state.rateHistory.shift();

  Bus.emit('rate');
}

// ========== Memory cap warning ==========
let memWarned = false;
function showMemWarning() {
  if (memWarned) return;
  memWarned = true;
  renderMemWarning();
}
function renderMemWarning() {
  Bus.emit('memwarn');
}

// ========== File Export (non-blocking, streaming) ==========
const EXPORT_CHUNK = 20000;   // events per write / UI-yield while exporting
let exporting = false;

function exportDat() { exportData('dat'); }
function exportCsv() { exportData('csv'); }

function mergeGpsLog(evs, log) {
  if (!log.length) return evs.slice();
  const out = [];
  let g = 0;
  for (const ev of evs) {
    while (g < log.length && log[g].pc_timestamp < ev.pc_timestamp) out.push(log[g++]);
    out.push(ev);
  }
  while (g < log.length) out.push(log[g++]);
  return out;
}

const yieldToUI = () => new Promise(r => setTimeout(r, 0));

function setExportBusy(busy) {
  Bus.emit('export', { busy });
}

function updateExportStatus(done, total, finished) {
  Bus.emit('export', { done, total, finished: !!finished });
}

async function exportData(format) {
  if (exporting || state.events.length === 0) return;
  exporting = true;
  setExportBusy(true);

  // Snapshot so events arriving (or being dropped at the cap) mid-export don't shift indices.
  // GPS の行 (PPS / 位置) をイベントの到着順に差し込む。同時刻ならイベントが先。
  const events = mergeGpsLog(state.events, state.gpsLog);
  const total = events.length;

  // Any synthetic event in the file makes it a demo file, whether or not the
  // demo is still running (N-4).
  const isDemo  = demo.on || events.some(ev => ev.demo);
  const isDat   = format === 'dat';
  const prefix  = getFilePrefix(isDemo);
  const dateStr = formatDateForFile(state.sessionStart || new Date());
  const filename = `${prefix}_${dateStr}.${isDat ? 'dat' : 'csv'}`;
  const lineOf  = isDat ? eventToDatLine : eventToCsvLine;
  const mime    = isDat ? 'text/plain;charset=utf-8' : 'text/csv;charset=utf-8';

  const header = buildFileHeader(isDat ? 'dat' : 'csv', isDemo);

  try {
    let writable = null;
    // showSaveFilePicker must be the FIRST await after the click so the user
    // activation is still valid (the sync setup above does not consume it).
    if (window.showSaveFilePicker) {
      try {
        const handle = await showSaveFilePicker({
          suggestedName: filename,
          types: [{
            description: isDat ? 'Data file' : 'CSV file',
            accept: isDat ? { 'text/plain': ['.dat'] } : { 'text/csv': ['.csv'] },
          }],
        });
        writable = await handle.createWritable();
      } catch (e) {
        if (e && e.name === 'AbortError') return;   // user cancelled; finally restores UI
        console.warn('showSaveFilePicker unavailable, falling back to download:', e);
        writable = null;
      }
    }

    if (writable) {
      // Stream straight to disk: no giant string, no Blob, no size limit.
      await writable.write(header);
      for (let i = 0; i < total; i += EXPORT_CHUNK) {
        const end = Math.min(i + EXPORT_CHUNK, total);
        const sub = [];
        for (let j = i; j < end; j++) sub.push(lineOf(events[j]));
        await writable.write(sub.join(''));
        updateExportStatus(end, total);
        await yieldToUI();
      }
      await writable.close();
    } else {
      // Fallback: build chunk strings into an array (O(n)) then one Blob — no O(n²) concat.
      const parts = [header];
      for (let i = 0; i < total; i += EXPORT_CHUNK) {
        const end = Math.min(i + EXPORT_CHUNK, total);
        const sub = [];
        for (let j = i; j < end; j++) sub.push(lineOf(events[j]));
        parts.push(sub.join(''));
        updateExportStatus(end, total);
        await yieldToUI();
      }
      downloadBlob(filename, new Blob(parts, { type: mime }));
    }
    updateExportStatus(total, total, true);
  } catch (e) {
    console.error('Export error:', e);
    Bus.emit('export', { error: String(e && e.message ? e.message : e) });
  } finally {
    exporting = false;
    setExportBusy(false);
  }
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadFile(filename, content) {
  downloadBlob(filename, new Blob([content], { type: 'text/plain;charset=utf-8' }));
}

// ========== Utilities ==========
function formatTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatDateForFile(date) {
  const d = date || new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0') + '_' +
    String(d.getHours()).padStart(2, '0') + '-' +
    String(d.getMinutes()).padStart(2, '0') + '-' +
    String(d.getSeconds()).padStart(2, '0');
}

// Local calendar date (YYYY-MM-DD). Auto-save file names use this, not
// toISOString(), so the file changes at local midnight (R-2 a).
function formatLocalDate(date) {
  const d = (date instanceof Date) ? date : new Date(date);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// "YYYY-MM-DD HH:MM:SS.mmm" in local time, for the data table (R-13).
function formatLocalTimestamp(ms) {
  const d = new Date(ms);
  return formatLocalDate(d) + ' ' +
    String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0') + ':' +
    String(d.getSeconds()).padStart(2, '0') + '.' +
    String(d.getMilliseconds()).padStart(3, '0');
}

// ========== Oscilloscope ==========
// タブを開いている間だけファームに SET_SCOPE:ON を送り、WF, 行を受けて描く。
// Chart.js ではなく生 canvas を使うのは、毎イベント全体を描き直すため
// （Chart.js のデータセット更新＋アニメーションは数 Hz でも重い）。
const scope = {
  active: false,     // タブが開いている
  enteredAtMs: 0,    // タブを開いた時刻（無操作で解析タブへ戻す判定に使う）
  deviceOn: false,   // ファームが SCOPE:ON を返した
  deviceOnSinceMs: 0,// その時刻（ヘッダに計数停止の経過時間を出す）
  frozen: false,
  traces: [],        // 新しいものほど後ろ
  raw: [],           // 保存用の生 WF, 行
  count: 0,
  bad: 0,
  stamps: [],
  drawPending: false,
};

function scopeOnLine(line) {
  const p = line.split(',');
  // 宣言された点数と実際の項目数が食い違う行は捨てる。
  // USB CDC の送信が詰まると行が途中で切れることがあるため。
  if (p.length < 7) { scope.bad++; Bus.emit('scopeStats'); return; }
  const kind = p[3];
  const npre = +p[4], ntot = +p[5], periodNs = +p[6];
  if (kind !== 'U' || !(ntot > 0) || !(npre >= 0) || npre >= ntot ||
      p.length !== 7 + ntot || !(periodNs > 0)) {
    scope.bad++; Bus.emit('scopeStats'); return;
  }

  const v = new Float32Array(ntot);
  for (let i = 0; i < ntot; i++) {
    const x = +p[7 + i];
    if (!isFinite(x)) { scope.bad++; Bus.emit('scopeStats'); return; }
    v[i] = x;
  }

  const dtUs = periodNs / 1000;
  let base = 0;
  for (let i = 0; i < npre; i++) base += v[i];
  base = npre > 0 ? base / npre : v[0];

  let peak = -Infinity, pi = 0;
  for (let i = 0; i < ntot; i++) { const a = v[i] - base; if (a > peak) { peak = a; pi = i; } }

  scope.count++;
  scope.stamps.push(Date.now());
  if (scope.stamps.length > 200) scope.stamps.shift();
  scope.raw.push(line);
  if (scope.raw.length > 2000) scope.raw.shift();

  if (scope.frozen) { Bus.emit('scopeStats'); return; }

  scope.traces.push({ v, npre, dtUs, base, peak, tPeak: (pi - npre) * dtUs, ntot });
  const keep = Math.max(1, (parseInt(settings.scopePersist) || 0) + 1);
  while (scope.traces.length > keep) scope.traces.shift();

  Bus.emit('scopeStats');
  if (!scope.drawPending) {
    scope.drawPending = true;
    requestAnimationFrame(() => { scope.drawPending = false; Bus.emit('scopeDraw'); });
  }
}

// Called when the tab opens, and again after (re)connecting or a reboot while
// it is open. The commands go through the command queue in order: the settings first,
// then ON, so that the first waveform already follows them.
function scopeEnter() {
  if (!scope.active) scope.enteredAtMs = Date.now();
  scope.active = true;
  Bus.emit('scopeMode');
  if (state.isConnected) {
    sendCommand('SET_SCOPE_RATE:' + (parseInt(settings.scopeRate) || 3));
    sendCommand('SET_SCOPE_TRIG:' + (settings.scopeTrig === 'FREE' ? 'FREE' : 'NORMAL'));
    sendCommand('SET_SCOPE_REARM:' + (parseInt(settings.scopeRearm) >= 0 ? parseInt(settings.scopeRearm) : 5));
    sendCommand('SET_SCOPE:ON');
  }
  scopeStartKeepalive();
  Bus.emit('scopeDraw');
}

function scopeLeave() {
  scope.active = false;
  scopeStopKeepalive();
  // 計数を再開させる。接続が切れていれば送れないが、ファーム側は再起動時に
  // 必ず OFF、さらにコマンドが 60 秒来なければ自分で OFF に戻る。
  if (state.isConnected) sendCommand('SET_SCOPE:OFF');
  Bus.emit('scopeMode');
}

// The firmware turns the scope off by itself after 60 s without any command,
// so a page that closed without sending OFF cannot leave counting stopped.
// While the tab is open, keep it alive -- and if the board reports OFF anyway
// (watchdog, DMA start failure), ask once per period instead of in a loop.
let scopeKeepaliveTimer = null;

function scopeStartKeepalive() {
  if (scopeKeepaliveTimer) return;
  scopeKeepaliveTimer = setInterval(() => {
    if (!scope.active || !state.isConnected) return;
    sendCommand(scope.deviceOn ? 'GET_SCOPE' : 'SET_SCOPE:ON');
  }, SCOPE_KEEPALIVE_MS);
}

function scopeStopKeepalive() {
  if (scopeKeepaliveTimer) { clearInterval(scopeKeepaliveTimer); scopeKeepaliveTimer = null; }
}

// The keepalive keeps the scope -- and the stopped counting -- going for as long
// as the tab is open. Someone who walks away from it would lose the whole night,
// so after SCOPE_IDLE_RETURN_MS without any input the page goes back to the
// Analysis tab, which turns the scope off, and says so (N-6).
let lastUserActivityMs = Date.now();
['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(type => {
  document.addEventListener(type, () => { lastUserActivityMs = Date.now(); }, { passive: true, capture: true });
});

function scopeIdleTick() {
  if (scope.deviceOn) Bus.emit('scopeDevice');   // keep the "stopped for mm:ss" current
  if (!scope.active || !state.isConnected) return;
  const idleSince = Math.max(lastUserActivityMs, scope.enteredAtMs);
  if (Date.now() - idleSince < SCOPE_IDLE_RETURN_MS) return;
  Hooks.closeScope();
  showNotice('notice.scopeIdle', { min: Math.round(SCOPE_IDLE_RETURN_MS / 60000) });
}

// Closing the tab: try to turn the scope off, write what auto-save still holds,
// and if events are still unwritten ask the browser to confirm leaving -- the
// write gets the time the dialog is open (N-15).
window.addEventListener('beforeunload', (e) => {
  if (scope.active && state.isConnected) sendCommand('SET_SCOPE:OFF');
  const as = state.autoSave;
  if (as.enabled && as.dirHandle && autoSavePendingCount() > 0) {
    flushAutoSave({ force: true }).catch(() => {});
    e.preventDefault();
    e.returnValue = '';
  }
});

// Switching away (another tab, minimising, closing on mobile) is often the last
// chance to run; write right away instead of waiting for the next interval.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushAutoSave({ force: true }).catch(() => {});
});
window.addEventListener('pagehide', () => { flushAutoSave({ force: true }).catch(() => {}); });

// ========== Demo Mode (virtual detector) ==========
// 実機が無くても UI の動きを一通り見せるための仮想検出器。
// やっていることは「ファームが吐くのと同じ 1 行を組み立てて processLine() に渡す」
// だけで、解析・ヒストグラム・レート・オシロ・保存のどの経路にもデモ専用の分岐を
// 持ち込んでいない。画面に出るものは実機と完全に同じ道を通る。
//
// 数値は v2 実機の実測に合わせてある:
//   - 減衰時定数とベースラインノイズは avg_waveform_20260721_122238.csv の平均波形から
//     (605 ADC のピークが 12us ごとに 0.946 倍 -> tau ~= 200us、sem*sqrt(n) -> sigma ~= 2.7 LSB)
//   - 波形の点数・サンプル周期はファームの SCOPE_PRE / SCOPE_POST / SCOPE_FS_HZ と同じ
//   - デッドタイムの内訳もファームの処理順 (COIN 同期待ち -> ADC -> OLED) に合わせてある

const DEMO_SCOPE_PRE       = 32;      // ファームの SCOPE_PRE
const DEMO_SCOPE_POST      = 128;     // ファームの SCOPE_POST
const DEMO_SCOPE_PERIOD_NS = 12000;   // 83.333 kHz = 12.0 us/点
const DEMO_TICK_MS         = 100;
const DEMO_BASELINE        = 86;      // ピークホールド出力のベースライン [ADC]
const DEMO_NOISE_LSB       = 2.7;     // 1 掃引あたりのベースラインノイズ sigma
const DEMO_TAU_US          = 200;     // ピークホールドの放電時定数
const DEMO_RISE_US         = 1.5;     // ピークホールドの追従 (1 サンプルよりずっと速い)
const DEMO_EVT_DEADTIME_US = 68;      // EXT 無しの 1 イベント処理時間
const DEMO_EXT_DEADTIME_US = 45;      // COIN 同期待ち + ANA 3ch 読み
const DEMO_OLED_DEADTIME_US = 34000;  // OLED 1 回の書き換え
const DEMO_DISPLAY_INTERVAL_MS = 2000;
const DEMO_BARO_COEFF      = 0.002;   // 気圧効果 = -0.2 %/hPa (ミューオンの実測相場)
const DEMO_RATE_MIN = 0.2, DEMO_RATE_MAX = 60;   // スライダ両端 [cps]
const DEMO_SOURCE_GAIN = 6;           // 線源シナリオのレート倍率
const DEMO_BEEP_MIN_GAP_MS = 60;      // 音が団子にならない程度に間引く
// 保存ファイルの先頭に入れる注意書き。あとから本物の測定と取り違えないように。
const DEMO_FILE_NOTE = '# *** DEMO MODE: synthetic data generated in the browser - NOT a measurement ***\n';

const demo = {
  on: false,
  scenario: 'background',
  rate: 3.5,             // スライダで決まる基準レート [cps]
  sound: false,
  timer: null,
  startMs: 0,
  lastMs: 0,
  count: 0,
  deadtimeUs: 0,
  nextEventMs: 0,
  burstUntilMs: 0,
  burstGain: 1,
  nextBurstMs: 0,
  lastDisplayMs: 0,
  lastInfoMs: 0,
  lastBeepMs: 0,
  phase: Math.random() * Math.PI * 2,
  env: { temp: 23.6, hum: 47.0, press: 1013.4, tempGoal: 25.6 },
  // 仮想デバイスの設定値 (ファームの Preferences 相当)。
  dev: {
    threshold: 120, duty: 34, mode: 'DIGITAL', autoMargin: 50,
    sd: false, ext: true, oled: true, buzzer: true, vib: false, gps: false,
    beepMin: 500, beepMax: 4000, beepMs: 25,
    vibMin: 20, vibMax: 120,
    bleName: 'CosmicRay',
  },
  scope: { on: false, rate: 3, enterMs: 0, emitted: 0, nextMs: 0, rearm: 5, trig: 'NORMAL' },
  audio: null,
};

// 機種ごとの仮想基板。OHASHI（v2）は上の demo.dev そのまま。
// OMAME は実機ファームの応答に合わせる: PWM は無し(0)、トリガーは ANALOG のみ、SD / EXT / GPS は無い、
// OLED のスイッチは LED、HV は 3 段（0 = 25.9 V / 1 = 27.1 V / 2 = 27.9 V）。
demo.devs = {
  v2: demo.dev,
  omame: {
    threshold: 120, duty: 0, mode: 'ANALOG', autoMargin: 50,
    sd: false, ext: false, oled: true, buzzer: true, vib: false, gps: false,
    beepMin: 500, beepMax: 4000, beepMs: 25,
    vibMin: 20, vibMax: 120,
    bleName: 'MuonFob',
    hv: 1,
  },
};
const DEMO_HV_TEXT = ['25.9', '27.1', '27.9'];
const DEMO_HV_TRIM = ['High', 'Hi-Z', 'Low'];

// オシロの 1 窓の形。OHASHI は 12 us 間隔でピークホールド出力、OMAME は 6 us 間隔でアンプの生の出力
// （16 点前 + 1 + 64 点後 = 81 点、ファームの SCOPE_PRE / SCOPE_POST）。
function demoWaveGeom() {
  return modelProfile.id === 'omame'
    ? { pre: 16, post: 64, periodNs: 6000, tauUs: 25, riseUs: 2 }
    : { pre: DEMO_SCOPE_PRE, post: DEMO_SCOPE_POST, periodNs: DEMO_SCOPE_PERIOD_NS, tauUs: DEMO_TAU_US, riseUs: DEMO_RISE_US };
}

// --- 乱数 -------------------------------------------------------------------

function demoRandN() {           // 標準正規 (Box-Muller)
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function demoExp(mean) {         // 指数分布 (ポアソン過程の待ち時間)
  return -mean * Math.log(1 - Math.random());
}

// Landau 近似 (Moyal)。exp(-y) が chi^2_1 に一致するので y = -2 ln|Z| で引ける。
// 最頻値 0・右に長い裾という形が、薄いシンチを突き抜けるミューオンの波高分布に近い。
function demoLandau(mpv, xi) {
  let z = Math.abs(demoRandN());
  if (z < 1e-9) z = 1e-9;
  return mpv + xi * (-2 * Math.log(z));
}

function demoClipAdc(x) {
  let v = Math.round(x);
  // 飽和はきっちり 4095 に張り付かず、ADC ノイズで天井付近に散る (実測の .dat も 4044〜4084)。
  if (v > ADC_MAX) v = ADC_MAX - Math.round(Math.abs(demoRandN()) * 8);
  if (v < 0) v = 0;
  return v;
}

// --- 波高分布 ---------------------------------------------------------------

function demoSampleAdcRaw(shower) {
  const thr = demo.dev.threshold;
  const u = Math.random();
  if (shower) {
    // 空気シャワーの多重ヒットは 1 本ぶんの Landau より重い側に寄る。
    return demoLandau(1150, 105) * (1.0 + 0.9 * Math.random());
  }
  if (demo.scenario === 'source') {
    if (u < 0.45)      return thr + demoExp(120);             // 連続部の立ち上がり
    if (u < 0.82)      return 760 + demoRandN() * 46;         // 光電ピーク (FWHM ~14%)
    if (u < 0.97)      return thr + 40 + Math.random() * 560; // コンプトンの棚
    return demoLandau(1150, 105);                             // 宇宙線ミューオンも混ざる
  }
  if (u < 0.60)        return thr + demoExp(95);              // 環境ガンマ + ノイズ裾
  if (u < 0.975)       return demoLandau(1150, 105);          // ミューオンの Landau ピーク
  return demoLandau(2300, 380);                               // 大きい落とし込み / 飽和寸前
}

// トリガはしきい値超えでしか掛からないので、下回った値は引き直す。
// こちらは ADC の天井でクリップする前の「本当の波高」。波形を描くときは
// これを使うと、飽和した事象の頭が 4095 で平らに潰れて実機と同じ見え方になる。
function demoSampleAdcTrue(shower) {
  const thr = demo.dev.threshold;
  for (let i = 0; i < 8; i++) {
    const v = demoSampleAdcRaw(shower);
    if (v > thr) return v;
  }
  return thr + 1 + Math.random() * 30;
}

function demoSampleAdc(shower) {
  return demoClipAdc(demoSampleAdcTrue(shower));
}

// ベースラインは温度でゆっくり動く (実機のアナログ段と同じ癖)。
function demoBaseline() {
  return DEMO_BASELINE + (demo.env.temp - 25) * 0.8;
}

// --- レート -----------------------------------------------------------------

function demoRate(nowMs) {
  const tSec = (nowMs - demo.startMs) / 1000;
  // ゆっくりした変動。実際は気温・気圧・上空の大気の厚みが効くが、ここでは
  // 「見て分かる程度のうねり」をまとめて 2 本の正弦で表している。
  const slow = 1 + 0.10 * Math.sin(2 * Math.PI * tSec / 240 + demo.phase)
                 + 0.05 * Math.sin(2 * Math.PI * tSec / 67);
  // 気圧効果: レート ∝ exp(-beta * dP)。beta は実測の相場で -0.2 %/hPa。
  const baro = Math.exp(-DEMO_BARO_COEFF * (demo.env.press - 1013.25));
  const burst = (nowMs < demo.burstUntilMs) ? demo.burstGain : 1;
  const scn = (demo.scenario === 'source') ? DEMO_SOURCE_GAIN : 1;
  return Math.max(0.01, demo.rate * scn * slow * baro * burst);
}

function demoMaybeBurst(nowMs) {
  if (nowMs < demo.nextBurstMs) return;
  if (demo.scenario === 'shower') {
    demo.burstUntilMs = nowMs + 600 + Math.random() * 2400;
    demo.burstGain    = 4 + Math.random() * 8;
    demo.nextBurstMs  = nowMs + demoExp(22000);
  } else {
    // 通常・線源シナリオでも、ごくたまに小さな群れが来る。
    demo.burstUntilMs = nowMs + 300 + Math.random() * 900;
    demo.burstGain    = 2 + Math.random() * 2;
    demo.nextBurstMs  = nowMs + demoExp(120000);
  }
}

function demoInjectBurst() {
  if (!demo.on) return;
  const now = performance.now();
  demo.burstUntilMs = now + 1200 + Math.random() * 1800;
  demo.burstGain    = 8 + Math.random() * 10;
  demo.nextBurstMs  = Math.max(demo.nextBurstMs, now + 15000);
}

// --- 環境 (BME280) ----------------------------------------------------------

function demoUpdateEnv(dtMs) {
  const e = demo.env;
  const k = dtMs / 1000, s = Math.sqrt(Math.max(0, k));
  // 電源投入後にじわっと暖まり、その後は室温のゆらぎを追いかけるだけ。
  e.temp  += (e.tempGoal - e.temp) * 0.004 * k + demoRandN() * 0.012 * s;
  e.tempGoal += demoRandN() * 0.02 * s;
  e.hum   += ((58 - e.temp * 0.5) - e.hum) * 0.003 * k + demoRandN() * 0.03 * s;
  e.press += demoRandN() * 0.015 * s;          // 気圧はランダムウォーク (天気)
  if (e.temp  < 10)   e.temp  = 10;   if (e.temp  > 45)   e.temp  = 45;
  if (e.tempGoal < 12) e.tempGoal = 12; if (e.tempGoal > 40) e.tempGoal = 40;
  if (e.hum   < 5)    e.hum   = 5;    if (e.hum   > 95)   e.hum   = 95;
  if (e.press < 960)  e.press = 960;  if (e.press > 1050) e.press = 1050;
}

// --- イベント ---------------------------------------------------------------

function demoMakeEvent(tMs) {
  const d = demo.dev;
  const shower = (tMs < demo.burstUntilMs) && Math.random() < 0.75;
  const adc = demoSampleAdc(shower);
  demo.count++;

  // デッドタイム: 1 イベントの処理時間 + 2 秒ごとの OLED 書き換え。
  demo.deadtimeUs += DEMO_EVT_DEADTIME_US + (d.ext ? DEMO_EXT_DEADTIME_US : 0)
                   + Math.round(Math.abs(demoRandN()) * 12);
  if (modelProfile.id === 'omame') {
    // OMAME: 画面の書き換えは無い。LED が 10 ms 光る間と、止まってから数え直すまでの 10 ms が
    // デッドタイム（ファームの LED_MS / SETTLE_MS）。ブザー・振動も同様に数えない。
    if (d.oled) demo.deadtimeUs += 20000;
  } else if (d.oled && tMs - demo.lastDisplayMs >= DEMO_DISPLAY_INTERVAL_MS) {
    demo.lastDisplayMs = tMs;
    demo.deadtimeUs += DEMO_OLED_DEADTIME_US + Math.round(demoRandN() * 1500);
  }

  const dig = [0, 0, 0], ana = [0, 0, 0];
  if (d.ext) {
    // 外部 3 台。シャワー中は 3 台が揃って鳴りやすく、通常は偶然同時計数だけ。
    const p = shower ? [0.82, 0.64, 0.41] : [0.030, 0.018, 0.009];
    for (let i = 0; i < 3; i++) {
      dig[i] = (Math.random() < p[i]) ? 1 : 0;
      ana[i] = dig[i] ? demoClipAdc(demoLandau(820, 130))
                      : Math.round(12 + Math.abs(demoRandN()) * 6);
    }
  }

  const e = demo.env;
  // OMAME: 温度は nRF52840 のチップ温度、湿度と気圧は "nan"（BME280 が無い）。
  const omame = modelProfile.id === 'omame';
  // ファームの snprintf("%lu %llu %d %llu %.1f %.1f %.1f %d %d %d %d %d %d %lu %ld %lu %.5f %.5f") と同じ並び。
  // 末尾 5 列 (PPS_UTC / PPS_dt / PPS_period / Lat / Lon) は GPS 対応ファームだけ。GPS が OFF なら "0 -1 0 nan nan"。
  const tUs = Math.round((tMs - demo.startMs) * 1000);
  let gpsTail = [];
  if (!omame) {
    if (d.gps) {
      const secN = Math.floor((tUs - 137) / 1000000);
      gpsTail = [demoUtcBase() + secN, tUs - (secN * 1000000 + 137), 1000003, '35.68124', '139.76712'];
    } else {
      gpsTail = [0, -1, 0, 'nan', 'nan'];
    }
  }
  processLine([
    demo.count,
    tUs,
    adc,
    demo.deadtimeUs,
    omame ? (e.temp + 6).toFixed(1) : e.temp.toFixed(1),
    omame ? 'nan' : e.hum.toFixed(1),
    omame ? 'nan' : e.press.toFixed(1),
    dig[0], dig[1], dig[2], ana[0], ana[1], ana[2],
    ...gpsTail,
  ].join(' '));

  if (demo.sound && d.buzzer) demoBeep(adc, tMs);
}

// --- 波形 (オシロ) ----------------------------------------------------------

// free = 連続撮影（トリガーなし）。トリガーを待たずに窓を出すので、たいていはベースライン
// とノイズだけで、窓の中に事象が入ったときだけパルスが見える。
function demoEmitWaveform(tMs, free) {
  const G = demoWaveGeom();
  const npre = G.pre;
  const ntot = G.pre + 1 + G.post;
  const dtUs = G.periodNs / 1000;
  const base = demoBaseline();
  const winSec = ntot * dtUs / 1e6;
  const shower = (tMs < demo.burstUntilMs) && Math.random() < 0.75;
  const pulse = !free || Math.random() < 1 - Math.exp(-demoRate(tMs) * winSec);
  const amp = pulse ? demoSampleAdcTrue(shower) - base : 0;

  // パルスの起点はトリガ点の 4〜12us 前。コンパレータが出てから DMA のトリガ点まで
  // に ISR ぶんの遅れがあるので、実機でもトリガ点ではピークホールドが既に頂点に
  // 達している (実測平均波形も t=-12us は地、t=0 が頂点)。どこにずれるかは事象ごとに
  // 違うので、頂点直後の減衰の位相が少しずつばらつく。
  // 連続撮影ではトリガ点がないので、窓のどこに来てもよい。
  const tStart = free ? Math.random() * (ntot * dtUs - 100) - npre * dtUs
                      : -(4 + 8 * Math.random());
  const tau = G.tauUs * (0.88 + 0.24 * Math.random());

  const raw = new Float64Array(ntot);
  let mx = 0;
  if (pulse) {
    for (let i = 0; i < ntot; i++) {
      const t = (i - npre) * dtUs - tStart;
      const s = (t < 0) ? 0 : (1 - Math.exp(-t / G.riseUs)) * Math.exp(-t / tau);
      raw[i] = s;
      if (s > mx) mx = s;
    }
  }
  // 次の事象が窓の中に入ってくる = パイルアップ。レートを上げると実際に増える。
  if (pulse && !free && Math.random() < 1 - Math.exp(-demoRate(tMs) * winSec)) {
    const t2 = Math.random() * (ntot - npre) * dtUs;
    const amp2 = (demoSampleAdc(false) - base) / Math.max(1, amp);
    const tau2 = G.tauUs * (0.88 + 0.24 * Math.random());
    for (let i = 0; i < ntot; i++) {
      const t = (i - npre) * dtUs - t2;
      if (t < 0) continue;
      raw[i] += amp2 * mx * (1 - Math.exp(-t / G.riseUs)) * Math.exp(-t / tau2);
    }
  }

  const k = (mx > 0) ? amp / mx : 0;
  const v = new Array(ntot);
  for (let i = 0; i < ntot; i++) {
    let s = Math.round(base + raw[i] * k + demoRandN() * DEMO_NOISE_LSB);
    if (s < 0) s = 0;
    if (s > ADC_MAX) s = ADC_MAX;
    v[i] = s;
  }

  demo.scope.emitted++;
  processLine('WF,' + demo.scope.emitted + ',' + Math.round(tMs - demo.scope.enterMs) +
              ',U,' + npre + ',' + ntot + ',' + G.periodNs + ',' + v.join(','));
}

// ファームの再アームの規則。トリガーモードでは、ベースライン（約 86）が再アームの水準より
// 下まで来ないと、波形は 1 本も出ない。水準 = しきい値 − オフセット（既定 5）。
function demoScopeRearmLevel() {
  return Math.max(0, demo.dev.threshold - demo.scope.rearm);
}
function demoScopeCanArm() {
  // 再アームは、ベースラインがノイズで水準以下まで落ちたときに掛かる。水準が、ベースラインの
  // 4σ 下より低いと、その落ち込みがほとんど来ないので、波形は実質出ない。
  return demoScopeRearmLevel() >= DEMO_BASELINE - Math.ceil(4 * DEMO_NOISE_LSB);
}

// --- ブザー (Web Audio) -----------------------------------------------------

function demoBeep(adc, tMs, force) {
  if (!force && tMs - demo.lastBeepMs < DEMO_BEEP_MIN_GAP_MS) return;
  demo.lastBeepMs = tMs;
  const d = demo.dev;
  try {
    if (!demo.audio) demo.audio = new (window.AudioContext || window.webkitAudioContext)();
    const ac = demo.audio;
    if (ac.state === 'suspended') ac.resume();
    // ファームと同じ対数マッピング: f = fmin * (fmax/fmin)^x,
    // x = (ln adc - ln thr) / (ln ADC_MAX - ln thr)
    const thr = Math.max(1, d.threshold);
    let x = 0;
    if (adc > thr && ADC_MAX > thr) {
      x = (Math.log(adc) - Math.log(thr)) / (Math.log(ADC_MAX) - Math.log(thr));
      x = Math.min(1, Math.max(0, x));
    }
    const f = d.beepMin * Math.pow(d.beepMax / d.beepMin, x);
    const dur = Math.max(0.005, d.beepMs / 1000);
    const t0 = ac.currentTime;
    const osc = ac.createOscillator(), g = ac.createGain();
    osc.type = 'square';                       // 圧電ブザーの音色に寄せる
    osc.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.07, t0 + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  } catch (_) {}
}

// --- 本体のループ -----------------------------------------------------------

function demoTick() {
  if (!demo.on) return;
  const now = performance.now();
  // タブが裏に回っていた間ぶんを一気に生成しないよう、1 tick の進みは頭打ちにする。
  const dt = Math.min(500, Math.max(0, now - demo.lastMs));
  demo.lastMs = now;

  demoUpdateEnv(dt);
  demoMaybeBurst(now);

  if (demo.scope.on) {
    // ファームはオシロ ON の間、計数を止める (### SCOPE: ON - counting is PAUSED)。
    // デモも同じにしておかないと「オシロを開くとレートが落ちる」実機の癖が出ない。
    const free = demo.scope.trig === 'FREE';
    const eff = Math.min(demo.scope.rate, demoRate(now));
    let guard = 0;
    while (demo.scope.nextMs <= now && guard++ < 8) {
      // 連続撮影は一定の間隔で窓を出す。トリガーモードは事象が来たときだけ、しかも
      // ベースラインが再アームの水準より下に出られるときだけ（出られなければ 1 本も出ない）。
      if (free) {
        demoEmitWaveform(demo.scope.nextMs, true);
        demo.scope.nextMs += 1000 / Math.max(1, demo.scope.rate);
      } else {
        if (demoScopeCanArm()) demoEmitWaveform(demo.scope.nextMs, false);
        demo.scope.nextMs += demoExp(1000 / Math.max(0.05, eff));
      }
    }
  } else {
    let guard = 0;
    while (demo.nextEventMs <= now && guard++ < 600) {
      demoMakeEvent(demo.nextEventMs);
      demo.nextEventMs += demoExp(1000 / demoRate(demo.nextEventMs));
    }
  }

  // GPS が ON のデモは、実機と同じ形の PPS 行 (10 秒ごと) と位置の行 (60 秒ごと) を出す。
  if (demo.dev.gps && now >= (demo.nextPpsMs || 0)) {
    const sec = Math.floor((now - demo.startMs) / 1000);
    const utc = demoUtcBase() + sec;
    processLine('### PPS ' + (sec * 1000000 + 137) + ' ' + utc);
    if (sec % 60 < 10 || !demo.gpsFixLogged) {
      demo.gpsFixLogged = true;
      processLine('### GPS fix=1 sats=9 lat=35.681236 lon=139.767125 alt=12.3');
    }
    demo.nextPpsMs = now + 10000;
  }

  if (now - demo.lastInfoMs > 500) {
    demo.lastInfoMs = now;
    Bus.emit('demoInfo');
  }
}

// --- 仮想デバイスのコマンド応答 ---------------------------------------------
// ファームの executeCommand() と同じ文字列を返す。実機と同じ行しか流さないので、
// 受け側 (processLine) にデモ用の分岐は要らない。

function demoCommand(cmd) {
  const d = demo.dev;
  const say = (line, ms) => setTimeout(() => { if (demo.on) processLine(line); }, ms == null ? 30 : ms);
  const threshLine = () => 'THRESH:' + d.threshold + ' DUTY:' + d.duty;
  const clampI = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  if (modelProfile.id === 'omame' && demoCommandOmame(cmd, d, say)) return;

  if (cmd.startsWith('SET_THRESH:')) {
    const n = parseInt(cmd.slice(11));
    if (!isNaN(n)) d.threshold = clampI(n, 0, ADC_MAX);
    say(threshLine());
  } else if (cmd === 'GET_THRESH') {
    say(threshLine());
  } else if (cmd === 'AUTO_THRESH' || cmd.startsWith('AUTO_THRESH:')) {
    if (cmd.startsWith('AUTO_THRESH:')) {
      const m = parseInt(cmd.slice(12));
      if (!isNaN(m)) d.autoMargin = clampI(m, 0, ADC_MAX);
    }
    say('### Auto-calibrating threshold...');
    // 実機は 100 点 x 10ms = 約 1 秒ノイズを眺めてから返す。
    setTimeout(() => {
      if (!demo.on) return;
      const mn = Math.round(Math.abs(demoRandN()) * 3);
      const mx = Math.round(24 + Math.abs(demoRandN()) * 10);
      d.threshold = Math.min(ADC_MAX, mx + d.autoMargin);
      processLine('### Auto-threshold calib: min=' + mn + ' max=' + mx +
                  ' margin=' + d.autoMargin + ' -> thr=' + d.threshold);
      processLine(threshLine());
      processLine('AUTO_MARGIN:' + d.autoMargin);
    }, 1200);
  } else if (cmd === 'GET_AUTO_MARGIN') {
    say('AUTO_MARGIN:' + d.autoMargin);
  } else if (cmd.startsWith('SET_AUTO_MARGIN:')) {
    const m = parseInt(cmd.slice(16));
    if (!isNaN(m)) d.autoMargin = clampI(m, 0, ADC_MAX);
    say('AUTO_MARGIN:' + d.autoMargin);
  } else if (cmd.startsWith('SET_PWM:')) {
    const n = parseInt(cmd.slice(8));
    if (!isNaN(n)) d.duty = clampI(n, 0, 255);
    say('PWM:' + d.duty);
  } else if (cmd === 'GET_PWM') {
    say('PWM:' + d.duty);
  } else if (cmd === 'AUTO_PWM' || cmd.startsWith('AUTO_PWM:')) {
    // 実機は duty を 0 -> 255 まで 8 刻みで掃引し、ノイズ山を越えて反応回数が
    // target 以下に落ちた点 + 2 刻みを採る（約 7 秒ブロック）。デモは結果だけ短く返す。
    const target = cmd.startsWith('AUTO_PWM:') ? Math.max(0, parseInt(cmd.slice(9)) || 0) : 50;
    say('### AUTO_PWM sweep: duty,comp_rate[/s]');
    setTimeout(() => {
      if (!demo.on) return;
      const knee = 72 + Math.round(Math.abs(demoRandN()) * 6 / 8) * 8;
      d.duty = clampI(knee + 16, 0, 255);
      processLine('### AUTO_PWM done: duty=' + d.duty + ' comp_rate=' +
                  Math.round(Math.min(target, 30) * Math.random()) + '/s (noise peak=' +
                  Math.round(40000 + Math.random() * 20000) + '/s, target<=' + target + '/s)');
      processLine('PWM:' + d.duty);
    }, 3000);
  } else if (cmd === 'RESET') {
    demoResetCounters(performance.now());
    say('RESET:OK');
  } else if (cmd.startsWith('SET_MODE:')) {
    const m = cmd.slice(9).toUpperCase();
    if (VALID_MODES.includes(m)) d.mode = m;
    say('MODE:' + d.mode);
  } else if (cmd === 'GET_MODE') {
    say('MODE:' + d.mode);
  } else if (cmd === 'GET_BLENAME') {
    say('BLENAME:' + d.bleName);
  } else if (cmd.startsWith('SET_BLENAME:')) {
    const n = cmd.slice(12).trim();
    if (/^[\x20-\x7E]{1,24}$/.test(n)) {
      d.bleName = n;
      say('BLENAME:' + n);
      say('### BLE name saved. Restarting in 1s...', 40);
      // 実機はここで 1 秒待って再起動する。待つ間は loop() が止まるので計数もしない。
      // 再起動すると計数・経過時間・デッドタイムは 0 から、オシロは OFF になる。
      demo.nextEventMs = Math.max(demo.nextEventMs, performance.now() + 2500);
      setTimeout(() => {
        if (!demo.on) return;
        const now = performance.now();
        demo.scope.on = false;
        demoResetCounters(now);
        demo.nextEventMs = now + 1000;   // 起動処理の間は計数しない
        demoBootBanner();
      }, 1500);
    } else {
      say('### BLE name invalid (1-24 printable ASCII chars).');
    }
  } else if (cmd === 'GET_BTADDR') {
    say('BTADDR:DE:A0:C0:DE:00:01');   // 実在しない見るからにデモ用のアドレス
  } else if (cmd.startsWith('SET_BEEP:')) {
    const p = cmd.slice(9).split(',').map(x => parseInt(x));
    if (p.length >= 3 && p.every(x => !isNaN(x))) {
      d.beepMin = p[0]; d.beepMax = p[1]; d.beepMs = p[2];
    }
    say('BEEP:' + d.beepMin + ',' + d.beepMax + ',' + d.beepMs);
  } else if (cmd === 'GET_BEEP') {
    say('BEEP:' + d.beepMin + ',' + d.beepMax + ',' + d.beepMs);
  } else if (cmd === 'BEEP_TEST') {
    if (demo.sound) {
      // ファームは min -> max を 5 段で鳴らす。ここでも同じ幅を聞かせる。
      for (let i = 0; i < 5; i++) {
        const a = Math.round(d.threshold * Math.pow(ADC_MAX / d.threshold, i / 4));
        setTimeout(() => demoBeep(a, performance.now(), true), i * 120);
      }
    }
  } else if (cmd.startsWith('SET_VIB_MS:')) {
    const p = cmd.slice(11).split(',').map(x => parseInt(x));
    if (p.length >= 2 && p.every(x => !isNaN(x))) { d.vibMin = p[0]; d.vibMax = p[1]; }
    say('VIBMS:' + d.vibMin + ',' + d.vibMax);
  } else if (cmd === 'GET_VIB_MS') {
    say('VIBMS:' + d.vibMin + ',' + d.vibMax);
  } else if (cmd === 'VIB_TEST') {
    if (navigator.vibrate) { try { navigator.vibrate([80, 60, 80, 60, 80]); } catch (_) {} }
  } else if (cmd.startsWith('SET_SCOPE_RATE:')) {
    const r = parseInt(cmd.slice(15));
    if (!isNaN(r)) demo.scope.rate = clampI(r, 1, 20);
    say('SCOPE_RATE:' + demo.scope.rate);
  } else if (cmd === 'GET_SCOPE_RATE') {
    say('SCOPE_RATE:' + demo.scope.rate);
  } else if (cmd.startsWith('SET_SCOPE_REARM:')) {
    const a = cmd.slice(16).trim();
    if (/^\d+$/.test(a) && parseInt(a) <= ADC_MAX) demo.scope.rearm = parseInt(a);
    say('SCOPE_REARM:' + demo.scope.rearm);
  } else if (cmd === 'GET_SCOPE_REARM') {
    say('SCOPE_REARM:' + demo.scope.rearm);
  } else if (cmd.startsWith('SET_SCOPE_TRIG:')) {
    const a = cmd.slice(15).toUpperCase();
    if (a === 'FREE' || a === 'NORMAL') demo.scope.trig = a;
    say('SCOPE_TRIG:' + demo.scope.trig);
  } else if (cmd === 'GET_SCOPE_TRIG') {
    say('SCOPE_TRIG:' + demo.scope.trig);
  } else if (cmd.startsWith('SET_SCOPE:')) {
    demoSetScope(cmd.slice(10).toUpperCase() === 'ON');
  } else if (cmd === 'GET_SCOPE') {
    say(demo.scope.on ? 'SCOPE:ON' : 'SCOPE:OFF');
  } else {
    // 機能トグル (SET_SD / SET_EXT / SET_OLED / SET_BUZZER / SET_VIB と GET_*)
    for (const [name, key] of [['SD', 'sd'], ['EXT', 'ext'], ['OLED', 'oled'],
                               ['BUZZER', 'buzzer'], ['VIB', 'vib'], ['GPS', 'gps']]) {
      if (cmd === 'GET_' + name) {
        say(name + ':' + (d[key] ? 'ON' : 'OFF'));
        if (name === 'GPS' && d.gps) demoGpsStatus(say);
        return;
      }
      if (cmd.startsWith('SET_' + name + ':')) {
        const val = cmd.slice(name.length + 5).toUpperCase();
        if (val === 'ON' || val === 'OFF') d[key] = (val === 'ON');
        say(name + ':' + (d[key] ? 'ON' : 'OFF'));
        if (name === 'GPS' && d.gps) demoGpsStatus(say);
        return;
      }
    }
  }
}

// OMAME（MUON FOB）の実機ファームが OHASHI と違う答え方をするコマンド。処理したら true を返し、
// 残りは demoCommand の共通の処理（しきい値・ブザー・振動・オシロ・BLE 名など）に任せる。
// 文言は firmware/muon_fob/muon_fob.ino の runCommand と同じ。
function demoCommandOmame(cmd, d, say) {
  if (cmd.startsWith('SET_PWM:') || cmd.startsWith('AUTO_PWM')) {
    say('### MuonFob has no comparator threshold (ANALOG trigger only).');
    say('PWM:0', 40);
  } else if (cmd === 'GET_PWM') {
    say('PWM:0');
  } else if (cmd === 'GET_THRESH' || cmd.startsWith('SET_THRESH:')) {
    if (cmd.startsWith('SET_THRESH:')) {
      const n = parseInt(cmd.slice(11));
      if (!isNaN(n) && n >= 0 && n <= ADC_MAX) d.threshold = n;
    }
    say('THRESH:' + d.threshold + ' DUTY:0');
  } else if (cmd === 'AUTO_THRESH' || cmd.startsWith('AUTO_THRESH:')) {
    if (cmd.startsWith('AUTO_THRESH:')) {
      const m = parseInt(cmd.slice(12));
      if (!isNaN(m)) d.autoMargin = Math.min(ADC_MAX, Math.max(0, m));
    }
    say('### Auto-calibrating threshold...');
    setTimeout(() => {
      if (!demo.on) return;
      const mn = Math.round(Math.abs(demoRandN()) * 3);
      const mx = Math.round(24 + Math.abs(demoRandN()) * 10);
      d.threshold = Math.min(ADC_MAX, mx + d.autoMargin);
      processLine('### Auto-threshold calib: min=' + mn + ' max=' + mx +
                  ' margin=' + d.autoMargin + ' -> thr=' + d.threshold);
      processLine('THRESH:' + d.threshold + ' DUTY:0');
      processLine('AUTO_MARGIN:' + d.autoMargin);
    }, 1200);
  } else if (cmd.startsWith('SET_MODE:')) {
    if (cmd.slice(9) !== 'ANALOG') say('### MuonFob: only the ANALOG trigger is available (no comparator).');
    say('MODE:ANALOG', 40);
  } else if (cmd === 'GET_MODE') {
    say('MODE:ANALOG');
  } else if (cmd.startsWith('SET_SD:')) {
    say('### MuonFob: no microSD on this board.'); say('SD:OFF', 40);
  } else if (cmd === 'GET_SD') {
    say('SD:OFF');
  } else if (cmd.startsWith('SET_EXT:')) {
    say('### MuonFob: no external inputs on this board.'); say('EXT:OFF', 40);
  } else if (cmd === 'GET_EXT') {
    say('EXT:OFF');
  } else if (cmd === 'GET_HV') {
    say('### HV: ' + DEMO_HV_TEXT[d.hv] + ' V (HV_TRIM ' + DEMO_HV_TRIM[d.hv] + ')');
  } else if (cmd.startsWith('SET_HV:')) {
    const a = cmd.slice(7);
    const lv = DEMO_HV_TEXT.indexOf(a);
    if (lv >= 0) {
      d.hv = lv;
      // 昇圧が落ち着くまで計数しない（ファームの blankFor(50)）。
      demo.nextEventMs = Math.max(demo.nextEventMs, performance.now() + 50);
      say('### HV changed: run AUTO_THRESH after a few seconds (the gain moved).');
    } else {
      say('### SET_HV: use 25.9, 27.1 or 27.9');
    }
    say('### HV: ' + DEMO_HV_TEXT[d.hv] + ' V (HV_TRIM ' + DEMO_HV_TRIM[d.hv] + ')', 60);
  } else if (cmd === 'GET_STAT') {
    say('### STAT count=' + demo.count + ' elapsed_us=' + Math.round((performance.now() - demo.startMs) * 1000) +
        ' dead_us=' + demo.deadtimeUs + ' overruns=0 dropped_lines=0 thr=' + d.threshold + ' hv=' + DEMO_HV_TEXT[d.hv]);
  } else if (cmd === 'GET_GPS' || cmd.startsWith('SET_GPS:')) {
    say('### Unknown command: ' + cmd + ' (HELP for the list)');
  } else {
    return false;
  }
  return true;
}

// デモ用の GPS 応答 (屋外で測位できているときの形)。
// デモ開始 (Time[us] = 0) の UTC 秒。デモの PPS / イベントの UTC はここからの経過で決める。
function demoUtcBase() {
  if (demo.utcBase == null || demo.utcBaseFor !== demo.startMs) {
    demo.utcBase = Math.floor(Date.now() / 1000) - Math.floor((performance.now() - demo.startMs) / 1000);
    demo.utcBaseFor = demo.startMs;
  }
  return demo.utcBase;
}

function demoGpsStatus(say) {
  say('### GPS status: nmea=ok valid=1 fix=1 sats=9 lat=35.681236 lon=139.767125 alt=12.3 utc=' + Math.floor(Date.now() / 1000), 60);
  say('### GPS status: pps_count=' + 600 + ' pps_age_ms=412 pps_period_us=1000003 sync=12 lines_ok=480 lines_bad=0', 90);
}

// RESET と再起動の共通部分: 計数・経過時間・デッドタイムを 0 からやり直す。
function demoResetCounters(now) {
  demo.count = 0;
  demo.deadtimeUs = 0;
  demo.startMs = now;
  demo.lastDisplayMs = now;
  // 予定済みの次のイベントが新しい起点より前に残っていると、
  // RESET 直後の最初のイベントの時刻が負になる（N-16）。
  if (demo.nextEventMs < now) demo.nextEventMs = now;
  // オシロ中の RESET は、ファームと同じく閉じたときに計上する滞在時間を
  // RESET 以降の分にする（N-2）。
  if (demo.scope.on) demo.scope.enterMs = now;
}

function demoSetScope(on) {
  const s = demo.scope;
  // ファームと同じく、すでにその状態なら何も返さない（fw の scopeSetOn）。
  if (on === s.on) return;
  const now = performance.now();
  if (on) {
    s.on = true;
    s.enterMs = now;
    s.emitted = 0;
    s.nextMs = now + 200;
    processLine('### SCOPE: ON - counting is PAUSED while the scope is open.');
    processLine(modelProfile.id === 'omame'
      ? '###        SIG is the raw amplifier output (this board has no peak-hold).'
      : '###        A0 is the PEAK-HOLD output, not the raw amplifier pulse.');
    processLine(s.trig === 'FREE'
      ? '###        FREE-RUN: no trigger, one window every ' + Math.round(1000 / Math.max(1, s.rate)) + ' ms.'
      : '###        trigger above ' + demo.dev.threshold + ', re-arm at or below ' + demoScopeRearmLevel() +
        ' (threshold - ' + s.rearm + ').');
    processLine('SCOPE:ON');
  } else {
    s.on = false;
    // 実機は「オシロを開いていた時間」をまるごとデッドタイムに足す。
    // ここを省くと、オシロを閉じたあとの平均レートが実機より高く出てしまう。
    demo.deadtimeUs += Math.round((now - s.enterMs) * 1000);
    demo.nextEventMs = now + demoExp(1000 / demoRate(now));
    processLine('### SCOPE: OFF - counting resumed.');
    processLine('SCOPE:OFF');
  }
}

function demoBootBanner() {
  const d = demo.dev;
  if (modelProfile.id === 'omame') {
    [
      'Booting MuonFob v0.1...',
      '### MuonFob v0.1 (XIAO nRF52840) - cosmic-ray-detector-keyholder',
      '### DEMO BOARD - synthetic data, no hardware attached',
      '### Signal threshold: ' + d.threshold + ' (Duty 0)',
      'MODE:ANALOG', 'SD:OFF', 'EXT:OFF', d.oled ? 'OLED:ON' : 'OLED:OFF', d.vib ? 'VIB:ON' : 'VIB:OFF',
      '### Trigger: ANALOG only. SIG (amplifier output, no peak-hold) sampled every 6 us; peak = 3-point parabola.',
      '### OLED switch = the 3 RGB LEDs (no OLED on this board). SD / EXT are not fitted.',
      '### Temp = nRF52840 die temperature (not ambient). Hum / Press = nan.',
      '### HV: ' + DEMO_HV_TEXT[d.hv] + ' V (HV_TRIM ' + DEMO_HV_TRIM[d.hv] + ')',
      '### Event Time[us] ADC[0-4095] Deadtime[us] Temp[C] Hum[%] Press[hPa] Dig1 Dig2 Dig3 Ana1 Ana2 Ana3',
    ].forEach((l, i) => setTimeout(() => { if (demo.on) processLine(l); }, 60 + i * 40));
    return;
  }
  const lines = [
    'Booting v2...',
    '### Accel Kitchen',
    '### https://accel-kitchen.com/',
    '### info@accel-kitchen.com',
    '### DEMO BOARD - synthetic data, no hardware attached',
    '### Signal threshold: ' + d.threshold + ' (Duty ' + d.duty + ')',
    '### Event Time[us] ADC[0-4095] Deadtime[us] Temp[C] Hum[%] Press[hPa] Dig1 Dig2 Dig3 Ana1 Ana2 Ana3',
  ];
  lines.forEach((l, i) => setTimeout(() => { if (demo.on) processLine(l); }, 60 + i * 40));
}

// --- 接続 / 切断 ------------------------------------------------------------

function connectDemo() {
  if (state.isConnected || state.reconnecting) return;
  if (mixesDemo(true)) { Bus.emit('alert', { key: 'demo.mixedDemo' }); return; }
  const now = performance.now();

  demo.on = true;
  demo.startMs = now;
  demo.lastMs = now;
  demo.lastDisplayMs = now;
  demo.lastInfoMs = 0;
  demo.nextEventMs = now + 200;
  demo.nextBurstMs = now + 15000 + Math.random() * 20000;
  demo.burstUntilMs = 0;
  demo.count = 0;
  demo.deadtimeUs = 0;
  demo.phase = Math.random() * Math.PI * 2;
  demo.scope = { on: false, rate: parseInt(settings.scopeRate) || 3, enterMs: 0, emitted: 0, nextMs: 0 };
  // BLE 名は画面の入力欄をそのまま名乗る。デモが勝手に別名を保存して、
  // 次に実機へ BLE 接続するときの名前フィルタを壊さないため。
  demo.dev = demo.devs[modelProfile.id] || demo.devs.v2;
  demo.dev.bleName = (settings.bleName || modelProfile.bleDefault).trim() || modelProfile.bleDefault;

  state.connectionType = 'demo';
  state.isConnected = true;
  state.sessionStart = new Date();
  state.conn = { usbVendorId: null, usbProductId: null, bleId: null,
                 bleName: demo.dev.bleName, btAddr: null, btAddrTimedOut: false };

  demoBootBanner();
  demo.timer = setInterval(demoTick, DEMO_TICK_MS);
  // 実機と同じ後処理（状態の問い合わせ、オシロタブが開いていれば SET_SCOPE:ON）。
  onConnected();
}

function demoStop() {
  if (demo.timer) { clearInterval(demo.timer); demo.timer = null; }
  demo.on = false;
  demo.scope.on = false;
  Bus.emit('demo');
}

// --- デモ用 UI --------------------------------------------------------------

function demoSliderToRate(v) {
  // 端の 0.2 cps から 60 cps まで対数で振る (低レート側の操作性を残すため)。
  return DEMO_RATE_MIN * Math.pow(DEMO_RATE_MAX / DEMO_RATE_MIN, v / 100);
}

function demoFmtRate(r) {
  return r >= 10 ? r.toFixed(0) : r.toFixed(1);
}

// ========== Clear data ==========
// Clears the page AND resets the board's counter (RESET). The screen asks first.
function clearAllData() {
  if (state.isConnected) sendCommand('RESET');
  state.events = [];
  state.gpsLog = [];
  state.gpsRec = { pps: 0, pos: 0, lastPpsUtc: null, lastPpsAt: 0, clockDiffMs: null };
  state.rateHistory = [];
  state.rawLines = [];
  state.stats = newStats();
  state.rate = newRateState();
  clearNotice();   // e.g. the "different board" notice asked for exactly this
  lastTableLength = 0;
  uiDirty = false;
  statsDirty = false;
  memWarned = false;
  rebuildHistogram();
  Bus.emit('cleared');
}

// Recovering from an outage should not wait out the remaining backoff.
window.addEventListener('online', () => {
  state.upload.nextAttemptMs = 0;
  Bus.emit('upload');
});
window.addEventListener('offline', () => Bus.emit('upload'));

// Timers that belong to the data side. Started by ui.js once the screen is ready.
function coreStart() {
  setInterval(scopeIdleTick, 1000);
  setInterval(flushAutoSave, 1000);
  // Registered after auto-save so that within one tick the disk write is issued
  // first: local storage is the record, the server is a mirror.
  setInterval(flushUpload, UPLOAD_TICK_MS);
}
