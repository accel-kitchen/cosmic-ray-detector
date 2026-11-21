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
  // The desktop app (desktop.js) picks the save folder itself and returns a folder
  // handle, or null when cancelled. In the browser it stays null: showDirectoryPicker.
  pickSaveFolder: null,
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
// v2.1 基板のファーム（FW 2.1.x、ログ形式 FMT:3）。先頭 13 列は v2 と同じ並びで、後ろに
// Base[ADC] Peak[mV] PeakT[us] Flags Dt1[us] Dt2[us] Dt3[us] が付く。3 列目 ADC は「整形パルスの高さ − 直前のベースライン」。
const EVENT_TOKEN_COUNT_FMT3 = 20;
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
    coincAny: 0,         // 外部検出器 1〜3 のどれかが同時だったイベントの数（同時計数）
    sumAna:  [0, 0, 0],
    // v2.1（FMT:3）のイベントだけ: Flags の内訳（1 = 前後と重なり、2 = ADC 飽和、16 = ベースライン 55 mV 未満）
    nFmt3: 0, flagPile: 0, flagSat: 0, flagLowBase: 0,
  };
}

// v2.1 だけにある基板の値（MCP4728 の VTH / OFS、A0 の静止値、ゲインの推定、HV の監視値、NOISE の結果）。
// v2 / OKOME のファームはこれらを出さないので、ずっと null のまま。
function newV21State() {
  return {
    fw: null, board: null,
    vth: null,          // コンパレータのしきい値 [mV]（MCP4728 ch A。アンプ出力の絶対電圧）
    ofs: null,          // ベースラインの持ち上げ [mV]（MCP4728 ch C）
    baseMv: null,       // A0 の静止値 [mV]（GET_BASE / #CFG）。55 mV 未満は小さいパルスが欠ける
    tp2Mv: null,        // AUTO_VTH から推定したアンプ出力の静止電圧 [mV]
    gain: null,         // ch C の傾きから推定したゲイン
    hvV: null, hvMonMv: null, hvK: null,   // HV の監視値（固定 29.0 V。変えられない）
    coinWin: null,
    noise: null,        // 最後の NOISE: の結果 { n, mean, rms, p2, p50, p98, min, max, zero, trim }
    vthCal: false,      // AUTO_VTH の掃引中
    vthSweep: null,     // 掃引の最新の点 { mv, rate }
    vthResult: null,    // "AUTO_VTH: release ... knee ..." の行
    cal: null,          // 'CALIBRATE' | 'AUTO_BASE' 実行中
    calMsg: null,       // 較正の最新の経過の行
    noiseBusy: false,   // NOISE の測定中
    lastWarn: null,     // 最後の "### WARN: ..." / "### ERROR: ..."
  };
}

// 接続先の識別情報（state.conn）。接続を切ったときとデモを始めたときにも作り直す。
function newConnState() {
  return {
    usbVendorId: null, usbProductId: null, bleId: null, bleName: null, btAddr: null, btAddrTimedOut: false,
    board: null,
    // ファームの版（GET_VER の "VER:FW=.. BOARD=.. BUILD=.."）。
    // fwState: null（聞いていない）| 'fetching' | 'known' | 'none'（答えない古いファーム）
    fw: null, fwBuild: null, fwState: null, fwLatest: null, fwChecked: false,
    // 基板の時計（SET_TIME / GET_TIME の応答 "TIME:<utc s> SRC:GPS|PC|NONE"）{ src, utc, atMs } | null
    clock: null,
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
  conn: newConnState(),
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
  hv: null,               // OKOME only: SiPM bias setting in V (25.9 | 27.1 | 27.9) | null
  v21: newV21State(),     // v2.1 only (see newV21State)
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
  state.conn.board = null;   // 基板が名乗った版（"v2.1" など）。違う機種を選んでいたら知らせる
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
    // つないだときに DTR / RTS を両方上げている。そこから DTR だけを先に下げると（RTS は高いまま）、
    // それ自体がダウンロードモードへのリセットになる（2026-11-15、v2.1 の実機で 3 回中 3 回）。
    // 先に RTS → DTR の順に両方下げてから、RTS のパルスを送る。
    await state.port.setSignals({ requestToSend: false });
    await state.port.setSignals({ dataTerminalReady: false });
    await new Promise(r => setTimeout(r, 100));
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
// RTS → DTR の順に下げる（disconnect の説明を参照）。両方とも下がっていても基板は普通に動く。
async function usbLinesSafe() {
  const port = state.port;
  if (state.connectionType !== 'usb' || !port) return;
  try { await port.setSignals({ requestToSend: false }); } catch (_) {}
  try { await port.setSignals({ dataTerminalReady: false }); } catch (_) {}
}

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
      // ESP32-S3 の USB-Serial-JTAG は DTR/RTS でチップをリセットする。つないだときに両方を上げているので、
      // そのまま close() すると両方が一度に下がり、チップが ROM のダウンロードモードに入って黙ったまま
      // 数えなくなる（2026-11-15、v2.1 の実機で 3 回中 3 回）。RTS → DTR の順に下げてから閉じれば、
      // リセットは掛からず動き続ける（4 回中 4 回）。リセット回路の無い基板には何も起きない。
      await usbLinesSafe();
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
  // 送る直前に中身を決めたいコマンド（SET_TIME の時刻）は関数で渡す。待ち行列で待った分ずれないように。
  if (typeof cmd === 'function') cmd = cmd();

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
// v2.1 のファームには GET_PWM（案内だけ返す）と GET_GPS（Unknown command）が無い。
// 代わりに GET_CFG で VTH / OFS / ゲインの推定 / HV をまとめて取り、A0 の静止値は GET_BASE で測る
// （0.2 秒。計数は止まらない）。
const REFRESH_COMMANDS_V21 = [
  'GET_BLENAME', 'GET_THRESH', 'GET_MODE', 'GET_SCOPE',
  'GET_SD', 'GET_EXT', 'GET_OLED', 'GET_BUZZER', 'GET_VIB',
  'GET_AUTO_MARGIN', 'GET_BEEP', 'GET_VIB_MS', 'GET_BTADDR',
  'GET_CFG', 'GET_BASE', 'GET_COIN_WIN',
];
let refreshGen = 0;

// ========== Detector model profile ==========
// OHASHI (v2, ESP32-S3) と OKOME (MUON FOB, nRF52840) は同じ行の形式・同じコマンド名で話す。
// 違いは「この基板に無いもの」と「OKOME だけにあるもの」だけなので、ページは 1 つのまま、
// 機種ごとの差をこの表に集める。'v2' の値は従来の挙動そのもの（既定）。
//   bleDefault : Bluetooth の名前の既定（入力欄の初期値）
//   blePrefix  : true なら前方一致で探す（MuonFob の既定名は MuonFob-XXXX で、下 4 桁が個体ごとに違う）
//   bleKey     : 最後に使った名前を覚える localStorage のキー（機種どうしで混ざらないように分ける）
//   refresh    : 接続直後と再起動後に送る問い合わせ
//   hv         : 高電圧の設定（GET_HV / SET_HV）がある（OKOME の 3 段）。v2.1 の HV は監視だけなので false
//   fmt3       : v2.1 のファーム（FMT:3）。VTH / OFS / CALIBRATE / HV の監視があり、PWM と GPS が無い。
//                保存ファイルの列も v2.1 の形（GPS の列の代わりに Base / Peak / PeakT / Flags / Dt1〜3）
//   scopeTrig  : オシロの撮り方（SET_SCOPE_TRIG）と再アーム（SET_SCOPE_REARM）がある
//   scopePausesCount : オシロを開いている間、計数が止まる（v2.1 は DMA が回り続けるので止まらない）
//   esp32      : ESP32-S3 の USB-Serial-JTAG（DTR/RTS でリセットできる）。黙ったままの基板を通常起動へ戻す対処に使う
//   ver        : GET_VER で版を聞き、SET_TIME で PC の時刻を渡す（2026-11-20 以降の v2 のファーム）。
//                古い v2 のファームは知らないコマンドに何も返さないので、送っても害はない。
//                OKOME と v2.1 のファームは "Unknown command" を返すので送らない
const MODEL_PROFILES = {
  v2: {
    id: 'v2',
    bleDefault: 'CosmicRay', blePrefix: false, bleKey: 'bleName',
    refresh: REFRESH_COMMANDS.concat('GET_VER'),
    hv: false, fmt3: false, scopeTrig: true, scopePausesCount: true, esp32: true, ver: true,
  },
  okome: {
    id: 'okome',
    bleDefault: 'MuonFob', blePrefix: true, bleKey: 'bleName_okome',
    // OKOME には GPS が無い（GET_GPS は "Unknown command" になる）。GET_HV は OKOME だけ。
    refresh: REFRESH_COMMANDS.filter(c => c !== 'GET_GPS').concat('GET_HV'),
    hv: true, fmt3: false, scopeTrig: true, scopePausesCount: true, esp32: false,
  },
  v21: {
    id: 'v21',
    // 実機の既定名は v2 と同じ CosmicRay。覚えておく名前は v2 と別のキーにする（混ざらないように）。
    bleDefault: 'CosmicRay', blePrefix: false, bleKey: 'bleName_v21',
    refresh: REFRESH_COMMANDS_V21,
    hv: false, fmt3: true, scopeTrig: false, scopePausesCount: false, esp32: true,
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
  // v2.1: 前の基板（や再起動前）の値・NOISE の結果・警告を持ち越さない。応答が来るまで「取得中」
  if (modelProfile.fmt3) { state.v21 = newV21State(); Bus.emit('device', 'v21'); }
  // 版と時計も聞き直す（再起動で PC の時刻は消える）。
  const c = state.conn;
  c.fw = null; c.fwBuild = null; c.fwState = modelProfile.ver ? 'fetching' : null; c.fwChecked = false;
  c.clock = null;
  Bus.emit('connDetail');
  // Give a board that is still booting a moment before the first GET.
  await sleep(800);
  for (const cmd of modelProfile.refresh) {
    if (gen !== refreshGen || !state.isConnected) return;
    await sendCommand(cmd);
    await sleep(CMD_GAP_MS);
  }
  // PC の時刻を渡す（UTC の unix ミリ秒）。GPS の無い基板でも、SD のログに "### TIME" の行が入り、
  // 何時の測定か後から分かる。値は送る直前に決める（待ち行列で待った分ずれないように）。
  if (modelProfile.ver && gen === refreshGen && state.isConnected) {
    await sendCommand(() => 'SET_TIME:' + Date.now());
  }
  await sleep(1500);
  if (gen === refreshGen && state.isConnected && !state.conn.btAddr) {
    state.conn.btAddrTimedOut = true;
    Bus.emit('connDetail');
  }
  // GET_VER に答えないのは 2026-11-20 より前のファーム（基板が何か返しているときだけそう判断する）。
  if (gen === refreshGen && state.isConnected && c.fwState === 'fetching' && state.lastRxMs >= state.connectedAtMs) {
    c.fwState = 'none';
    Bus.emit('connDetail');
  }
  if (gen === refreshGen && state.isConnected) checkFirmwareUpdate();
  // 問い合わせに 1 行も返ってこない USB の ESP32-S3 は、ROM のダウンロードモードで止まっていることが多い。
  // ブラウザがポートを閉じたときの DTR/RTS の動きでそこに入ることがあり（2026-11-15、v2.1 の実機で、
  // 切断のあと Saved PC が ROM を指していた）、入ったときの ESP-ROM の表示は誰も聞いていないので、
  // 上の「ESP-ROM: を見たら戻す」では気付けない。動いているファームなら必ず返事をするので、黙っていたら
  // 通常起動へのリセットを 1 回だけ試す（計数は 0 から。設定は基板に保存されたまま）。
  if (gen === refreshGen && state.isConnected && state.connectionType === 'usb' && modelProfile.esp32 &&
      !(state.lastRxMs >= state.connectedAtMs) && !usbBootloaderRecoveryDone) {
    showNotice('notice.silentReset', {});
    const resetAtMs = Date.now();
    recoverFromBootloader();
    // それでも黙っていれば、ファームが USB に出していない（Arduino IDE の USB CDC On Boot が Disabled、
    // 別のスケッチ、波形プローブなど）。リセットで直ったとは言わずに、そう知らせる。
    setTimeout(() => {
      if (state.isConnected && state.connectionType === 'usb' && !(state.lastRxMs >= resetAtMs)) {
        showNotice('notice.stillSilent', {});
      }
    }, 6000);
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
// (R-6), including for how long it has been stopped (N-6). (v2.1 keeps counting:
// the screen looks at modelProfile.scopePausesCount before saying it stopped.)
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
  recordInfoLine(line);
}

// '#' の行を、届いた順のままイベントの間に保存する（GPS の PPS / 位置の行と、PC の時刻の TIME 行）。
function recordInfoLine(line) {
  const rec = { kind: 'gps', pc_timestamp: Date.now(), line: line.replace(/^#+/, '###'), demo: state.connectionType === 'demo' };
  state.gpsLog.push(rec);
  if (state.gpsLog.length > GPS_LOG_MAX) state.gpsLog.splice(0, state.gpsLog.length - GPS_LOG_MAX);
  if (state.autoSave.enabled) {
    const fmt = settings.autoSaveFormat;
    if (fmt === 'dat' || fmt === 'both') state.autoSave.queues.dat.push(rec);
    if (fmt === 'csv' || fmt === 'both') state.autoSave.queues.csv.push(rec);
  }
}

// v2 のファーム（2026-11-20 以降）の情報行。拾ったら true。
//   "### TIME <t_us> <utc_epoch_s> src=PC" : Time[us] の t_us の瞬間の UTC がちょうど utc_epoch_s 秒（PC の時刻から）。
//                                            GPS の "### PPS <t_us> <utc_epoch_s>" と同じ並びなので、同じく保存に入れる
//   "### Firmware: FW=2.0.0 BOARD=v2 BUILD=2026-11-20" : 起動時の版の名乗り（GET_VER の応答と同じ中身）
function parseTimeInfo(line) {
  const tm = line.match(/^#+\s*TIME\s+(\d+)\s+(\d+)(?:\s+src=(\w+))?\s*$/i);
  if (tm) {
    if (!state.paused) recordInfoLine(line);
    return true;
  }
  const fw = line.match(/^#+\s*Firmware:\s*(.*)$/i);
  if (fw) {
    noteFirmware(kvPairs(fw[1], '='));
    return true;
  }
  return false;
}

// 基板が名乗った版を覚える（VER: の応答と、起動時の "### Firmware:" 行）。
function noteFirmware(kv) {
  const c = state.conn;
  if (kv.FW) c.fw = kv.FW;
  if (kv.BUILD) c.fwBuild = kv.BUILD;
  if (kv.FW || kv.BUILD) c.fwState = 'known';
  // v2.1 の画面と保存ファイルの先頭（"Detector model: v2.1 (FW …)"）が使う値。以前から VER: で入れていた
  if (kv.FW) state.v21.fw = kv.FW;
  if (kv.BOARD) { state.v21.board = kv.BOARD; noteBoardModel(kv.BOARD); }
  Bus.emit('device', 'v21');
  Bus.emit('connDetail');
  checkFirmwareUpdate();
}

// 書き込みページ（flash.html）の manifest の "version" と、基板が名乗った BUILD を比べ、
// 基板のほうが古ければ 1 接続に 1 回だけ知らせる。manifest は 1 ページで 1 回だけ読む。
// file:// で開いたときなど読めなければ（fetch が失敗する）何も言わない。デモと v2 以外の機種は対象外。
let fwManifestPromise = null;
function latestFirmwareBuild() {
  if (!fwManifestPromise) {
    fwManifestPromise = fetch('firmware/manifest-v2.json', { cache: 'no-cache' })
      .then(r => (r.ok ? r.json() : null))
      .then(j => (j && typeof j.version === 'string' ? j.version : null))
      .catch(() => null);
  }
  return fwManifestPromise;
}

async function checkFirmwareUpdate() {
  const c = state.conn;
  if (!modelProfile.ver || state.connectionType === 'demo' || c.fwChecked) return;
  if (c.fwState !== 'known' && c.fwState !== 'none') return;
  if (c.fwState === 'known' && c.board && c.board !== 'v2') return;   // 別の機種のファーム
  c.fwChecked = true;
  const latest = await latestFirmwareBuild();
  if (!latest || !state.isConnected) return;
  c.fwLatest = latest;
  Bus.emit('connDetail');
  // 先に出ている知らせ（別の基板につながった、など）は上書きしない
  if (pageNoticeMsg) return;
  if (c.fwState === 'none') showNotice('notice.fwNoVersion', { latest });
  else if (c.fwBuild && c.fwBuild < latest) showNotice('notice.fwUpdate', { have: c.fwBuild, latest });
}

// ========== v2.1 (FW 2.1.x, FMT:3) ==========
// v2.1 のファームだけが出す応答と情報行。v2 / OKOME のファームはこの形の行を出さないので、
// どの機種を選んでいても拾ってよい（違う機種の基板につないだことの検出にも使う）。
// 形式は v2.1 の arduino/description.md（.ino が正）。

// "KEY=val KEY=val"（sep '='）や "KEY:val KEY:val"（sep ':'）を { KEY: 'val' } にする。
function kvPairs(text, sep) {
  const out = {};
  const re = sep === ':' ? /([A-Za-z_0-9]+):(\S+)/g : /([A-Za-z_0-9]+)=(\S+)/g;
  for (const [, k, v] of text.matchAll(re)) out[k] = v;
  return out;
}
const v21Num = s => { const n = parseFloat(s); return Number.isFinite(n) ? n : null; };

// 基板が名乗った版と、選んでいる機種が食い違うときに 1 回だけ知らせる（接続ごと）。
function noteBoardModel(board) {
  if (!board || state.conn.board === board) return;
  state.conn.board = board;
  const isV21 = /^v2\.1/i.test(board);
  if (isV21 && !modelProfile.fmt3) showNotice('notice.boardIsV21', {});
  else if (!isV21 && modelProfile.fmt3) showNotice('notice.boardNotV21', {});
}

// 応答の行（'###' の付かないもの）。拾ったら true。
function parseV21Reply(line) {
  const v = state.v21;
  let m;
  if ((m = line.match(/^VTH:\s*(\d+(?:\.\d+)?)\s*$/))) {
    v.vth = v21Num(m[1]);
    // AUTO_VTH の結果もこの行で来る（このあと THRESH: が続く）
    v.vthCal = false;
    v.vthSweep = null;
    Bus.emit('device', 'v21');
    return true;
  }
  if ((m = line.match(/^OFS:\s*(\d+(?:\.\d+)?)\s*$/))) {
    v.ofs = v21Num(m[1]);
    if (v.cal === 'AUTO_BASE') v.cal = null;   // AUTO_BASE は最後に OFS: を返す
    Bus.emit('device', 'v21');
    return true;
  }
  if (line.startsWith('BASE:')) {
    // BASE:<A0 mV> RAW:<adc> SLOPE:<s> GAIN:<推定> OFS:<mV>
    const kv = kvPairs(line, ':');
    if (kv.BASE != null) v.baseMv = v21Num(kv.BASE);
    if (kv.GAIN != null && v21Num(kv.GAIN)) v.gain = v21Num(kv.GAIN);
    if (kv.OFS != null) v.ofs = v21Num(kv.OFS);
    Bus.emit('device', 'v21');
    return true;
  }
  if ((m = line.match(/^HV:\s*(\d+(?:\.\d+)?)\s+MON:\s*(\d+(?:\.\d+)?)\s+K:\s*(\d+(?:\.\d+)?)/))) {
    v.hvV = v21Num(m[1]);
    v.hvMonMv = v21Num(m[2]);
    v.hvK = v21Num(m[3]);
    Bus.emit('device', 'v21');
    return true;
  }
  if (line.startsWith('NOISE:')) {
    // NOISE:n=.. mean=.. rms=.. p2=.. p50=.. p98=.. min=.. max=.. zero=.. raw_p50=.. trim=..（n・zero 以外は mV）
    const kv = kvPairs(line.slice(6), '=');
    v.noise = {
      n: v21Num(kv.n), mean: v21Num(kv.mean), rms: v21Num(kv.rms),
      p2: v21Num(kv.p2), p50: v21Num(kv.p50), p98: v21Num(kv.p98),
      min: v21Num(kv.min), max: v21Num(kv.max), zero: v21Num(kv.zero), trim: v21Num(kv.trim),
    };
    v.noiseBusy = false;
    Bus.emit('device', 'v21');
    return true;
  }
  if (line.startsWith('#CFG')) {
    const kv = kvPairs(line, '=');
    if (kv.FW) v.fw = kv.FW;
    if (kv.BOARD) { v.board = kv.BOARD; noteBoardModel(kv.BOARD); }
    if (kv.VTH_mV != null) v.vth = v21Num(kv.VTH_mV);
    if (kv.OFS_mV != null) v.ofs = v21Num(kv.OFS_mV);
    // BASE_mV は使わない: ファームは計数中、イベントごとにトリガー直前の短い区間の平均で上書きするので、
    // ダークパルスの揺れでばらつく（実機で GET_BASE 61.2 mV のとき #CFG は 33.1 mV）。A0 の静止値は
    // GET_BASE（0.2 秒のトリム平均）の BASE: 行から取る（接続直後の問い合わせでも GET_BASE を送る）。
    if (kv.TP2_mV != null) v.tp2Mv = v21Num(kv.TP2_mV);    // 未測定は nan
    if (kv.GAIN != null) v.gain = v21Num(kv.GAIN) || null;  // 未測定は 0.0
    if (kv.HV_V != null) v.hvV = v21Num(kv.HV_V);
    if (kv.COIN_WIN_us != null) v.coinWin = v21Num(kv.COIN_WIN_us);
    if (kv.MODE && VALID_MODES.includes(kv.MODE)) { state.mode = kv.MODE; Bus.emit('device', 'mode'); }
    if (kv.THRESH != null && /^\d+$/.test(kv.THRESH)) {
      state.threshold = parseInt(kv.THRESH);
      settings.threshSignal = state.threshold;
      Bus.emit('device', 'thresh');
    }
    if (v.cal === 'CALIBRATE') v.cal = null;   // CALIBRATE は最後に #CFG を出す
    Bus.emit('device', 'v21');
    return true;
  }
  // VER: は v2 のファームも返すので processLine の共通の処理（noteFirmware）で拾う。
  if ((m = line.match(/^COIN_WIN:\s*(\d+)\s*$/))) {
    v.coinWin = parseInt(m[1]);
    Bus.emit('device', 'v21');
    return true;
  }
  // 受信ログに残すだけの応答（下のイベント行の判定に回さない）
  if (/^(DAC|EXT_ANA|STAT):/.test(line)) return true;
  return false;
}

// '###' の情報行。拾ったら true。
function parseV21Info(line) {
  const v = state.v21;
  const text = line.replace(/^#+\s*/, '');
  let m;
  // 較正の途中の警告（"### AUTO_BASE: WARN ..."、"### CALIBRATE: WARN ... failed" など）も、
  // 下のどの枝で拾っても画面に残す
  if (/\bWARN\b|\bERROR\b/.test(text)) v.lastWarn = text;
  if ((m = text.match(/^FMT:(\d+)\s+FW:(\S+)\s+BOARD:(\S+)/))) {
    v.fw = m[2];
    v.board = m[3];
    noteBoardModel(m[3]);
    Bus.emit('device', 'v21');
    return true;
  }
  // "### HV: 28.69 V (HV_MON 2607.8 mV x 11.000)"（起動時と 60 秒ごと。v2.1 の HV は固定で、監視だけ）
  if ((m = text.match(/^HV:\s*(\d+(?:\.\d+)?)\s*V\s*\(HV_MON\s*(\d+(?:\.\d+)?)\s*mV\s*x\s*(\d+(?:\.\d+)?)\)/))) {
    v.hvV = v21Num(m[1]);
    v.hvMonMv = v21Num(m[2]);
    v.hvK = v21Num(m[3]);
    Bus.emit('device', 'v21');
    return true;
  }
  if (/^AUTO_VTH sweep/.test(text)) {
    v.vthCal = true;
    v.vthSweep = null;
    v.vthResult = null;
    Bus.emit('device', 'v21');
    return true;
  }
  if (v.vthCal && (m = text.match(/^(\d+(?:\.\d+)?),(\d+)\s*$/))) {   // 掃引の 1 点 "### 130.0,1316940"
    v.vthSweep = { mv: parseFloat(m[1]), rate: parseInt(m[2]) };
    Bus.emit('device', 'v21');
    return true;
  }
  if (/^AUTO_VTH:/.test(text)) {
    v.vthResult = text;
    Bus.emit('device', 'v21');
    return true;
  }
  if (/^(First boot on this board|CALIBRATE:)/.test(text)) {
    if (!/written to the MCP4728/.test(text)) v.cal = 'CALIBRATE';
    v.calMsg = text;
    Bus.emit('device', 'v21');
    return true;
  }
  if (/^AUTO_BASE:/.test(text)) {
    if (v.cal !== 'CALIBRATE') v.cal = 'AUTO_BASE';
    v.calMsg = text;
    Bus.emit('device', 'v21');
    return true;
  }
  if (/^NOISE: collecting/.test(text)) {
    v.noiseBusy = true;
    Bus.emit('device', 'v21');
    return true;
  }
  if (/^(WARN|ERROR):/.test(text)) {
    v.lastWarn = text;
    Bus.emit('device', 'v21');
    return true;
  }
  return false;
}

function processLine(line) {
  if (!line) return;
  state.lastRxMs = Date.now();   // the board is talking (see refreshDeviceState)

  // SD のログの吸い出し（SDFILE: / SDLIST: / SDDATA: / SDERR:）。SDDATA の行は数 KB あるので、
  // 受信ログには頭だけを残す（sdTransferLine の中で）。"SD:ON" や "SD: init OK" はここを素通りする。
  if (line.charCodeAt(0) === 83 /* S */ && sdTransferLine(line)) return;

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

  // Threshold response: "THRESH:<sig> DUTY:<duty>" (v2 / OKOME) or "THRESH:<sig> VTH:<mV>" (v2.1)
  if (line.startsWith('THRESH:')) {
    const m = line.match(/^THRESH:\s*(\d+)(?:\s+DUTY:\s*(\d+))?(?:\s+VTH:\s*(\d+(?:\.\d+)?))?/i);
    if (m) {
      const sig = parseInt(m[1]);
      state.threshold = sig;
      if (m[2] != null) {
        setPwmDutyState(parseInt(m[2]));
        if (modelProfile.fmt3) noteBoardModel('v2');   // DUTY を返すのは v2 / OKOME のファーム
      }
      if (m[3] != null) {
        state.v21.vth = parseFloat(m[3]);
        Bus.emit('device', 'v21');
      }
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

  // ファームの版: "VER:FW=2.0.0 BOARD=v2 BUILD=2026-11-20"（v2 の GET_VER。v2.1 も同じ形で FW / BOARD を返す）
  if (line.startsWith('VER:')) {
    noteFirmware(kvPairs(line.slice(4), '='));
    return;
  }
  // 基板の時計: "TIME:<utc_epoch_s> SRC:GPS|PC|NONE"（v2 の SET_TIME / GET_TIME）
  if (line.startsWith('TIME:')) {
    const m = line.match(/^TIME:\s*(\d+)\s+SRC:\s*(\w+)/i);
    if (m) {
      state.conn.clock = { src: m[2].toUpperCase(), utc: parseInt(m[1]), atMs: Date.now() };
      Bus.emit('connDetail');
    }
    return;
  }

  // v2.1 (FW 2.1.x) の応答: VTH: / OFS: / BASE: / HV: / NOISE: / #CFG / DAC: / COIN_WIN: / EXT_ANA: / STAT:
  // v2 / OKOME のファームはこの形の行を出さない。#CFG は '#' で始まるので、下の情報行より前で拾う。
  if (parseV21Reply(line)) return;

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
    if (parseTimeInfo(line)) return;
    // OKOME だけ: "### HV: 27.1 V (HV_TRIM Hi-Z)" (起動時 / GET_HV / SET_HV の応答)。
    // "### HV changed: ..." や "### HV ..." の説明行は数字が続かないので拾わない。
    const hv = line.match(/^#+\s*HV:\s*(\d+(?:\.\d+)?)\s*V\b/i);
    if (hv && modelProfile.hv) {
      state.hv = parseFloat(hv[1]);
      Bus.emit('device', 'hv');
      return;
    }
    if (parseV21Info(line)) return;
    // "### Signal threshold: 120 (Duty 30)" (v2 / OKOME) or "### Signal threshold: 152 (VTH 212.0 mV)" (v2.1)
    const m = line.match(/Signal threshold:\s*(\d+)\s*\((?:Duty\s*(\d+)|VTH\s*(\d+(?:\.\d+)?)\s*mV)\)/i);
    if (m) {
      const sig = parseInt(m[1]);
      state.threshold = sig;
      if (m[2] != null) setPwmDutyState(parseInt(m[2]));
      if (m[3] != null) { state.v21.vth = parseFloat(m[3]); Bus.emit('device', 'v21'); }
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

  // Event line: exactly 13 whitespace-separated tokens (18 with GPS, 20 from the v2.1 firmware).
  // A line that lost its CR/LF and was glued to the next one has more, a truncated one has fewer:
  // drop both (C-1). The firmware sets the USB-CDC TX timeout to 0 while counting, so a stalled
  // host can lose a line's tail. The shape decides, not the chosen model: a board of another
  // model still shows its events (and a notice says so).
  const parts = line.split(/\s+/);
  const withGps = parts.length === EVENT_TOKEN_COUNT_GPS;
  const fmt3 = parts.length === EVENT_TOKEN_COUNT_FMT3;
  if (parts.length !== EVENT_TOKEN_COUNT && !withGps && !fmt3) return;

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

  // v2.1 の末尾 7 列。PeakT は負になりうる（ピークがトリガより前）し、Dt1〜3 は「相手 − 自分」なので符号付き。
  let baseAdc, peakMv, peakT, flags, dt;
  if (fmt3) {
    baseAdc = parseInt(parts[13]);
    peakMv = parts[14] === 'nan' ? NaN : parseFloat(parts[14]);
    peakT = parseInt(parts[15]);
    flags = parseInt(parts[16]);
    dt = [parseInt(parts[17]), parseInt(parts[18]), parseInt(parts[19])];
    if (!(inAdc(baseAdc) && (Number.isFinite(peakMv) || parts[14] === 'nan') && Number.isInteger(peakT) &&
          Number.isInteger(flags) && flags >= 0 && flags < 256 && dt.every(Number.isInteger))) return;
    if (!modelProfile.fmt3) noteBoardModel('v2.1');
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
  if (fmt3) {
    // v2.1 の列。v2 / OKOME のイベントには付けない（100 万件持つので、使わない欄は増やさない）
    event.base_adc = baseAdc;
    event.peak_mv = peakMv;
    event.peakt_us = peakT;
    event.flags = flags;
    event.dt1 = dt[0]; event.dt2 = dt[1]; event.dt3 = dt[2];
  }
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
  if (fmt3) {
    s.nFmt3++;
    if (flags & 1)  s.flagPile++;
    if (flags & 2)  s.flagSat++;
    if (flags & 16) s.flagLowBase++;
  }
  for (let i = 0; i < 3; i++) {
    if (dig[i] === 1) s.digHits[i]++;
    if (!isNaN(ana[i])) s.sumAna[i] += ana[i];
  }
  if (dig[0] === 1 || dig[1] === 1 || dig[2] === 1) s.coincAny++;

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

  pcBeep(adc);      // D-1: このパソコンでも鳴らす（スイッチが入っているときだけ）
  timerOnEvent();   // B-2: 予約した測定時間に届いたら記録を止める

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

// ========== Coincidences (外部検出器との同時計数) ==========
// 「同時」= 外部検出器 1〜3 のどれかが、自分のトリガと同時に反応したイベント（イベント行の Dig1〜3）。
// 率は「全体の計数率 × 同時だった割合」で出す。全体の率は基板のカウンタから求めているので、
// ブラウザが受け取りそこねた行があっても割合で合わせられる。誤差は同時の件数の √N から。
// 偶然に重なる分の目安は 2τ·R₁·R₂。相手の率はこの画面には来ないので、相手も同じ率（R₂ = R₁）とし、
// 反応したことのある入力の数だけ足す。2τ（窓の全幅）は、v2 のファームでは COIN_OUT を 100 µs 立て、
// 自分のトリガの 50 µs 後に相手の COIN を読むので約 100 µs（±50 µs。loop() が遅れると少し延びる）。
// v2.1 のファームは「±COIN_WIN 以内」なので 2 × COIN_WIN。
const COINC_WINDOW_V2_US = 100;

function coincSummary() {
  const s = state.stats;
  const r = rateSummary();
  if (s.n === 0 || !(r.rate > 0)) return null;
  const k = s.coincAny;
  const windowUs = modelProfile.fmt3 ? 2 * (state.v21.coinWin || 100) : COINC_WINDOW_V2_US;
  const inputs = s.digHits.filter(h => h > 0).length || 1;
  return {
    count: k,
    rate: r.rate * k / s.n,
    rateStd: r.rate * Math.sqrt(k) / s.n,
    accidental: inputs * windowUs * 1e-6 * r.rate * r.rate,
    windowUs, inputs,
  };
}

// ========== Sound from this PC (D-1) ==========
// 検出器のブザーと同じ音を PC から鳴らす（教室の後ろまで届くように、プロジェクターのスピーカーなどで）。
// 音程の対応はファームと同じ対数: f = fmin·(fmax/fmin)^x, x = (ln adc − ln thr)/(ln 4095 − ln thr)。
// fmin / fmax / 長さとしきい値は、基板が答えた値（BEEP: / THRESH:）を使う。間隔が 33 ms より詰まったら
// 鳴らさない（30 回/秒を超えたら間引く）。基板のブザーのスイッチとは別に入れ切りできる。
// AudioContext はユーザーの操作の中でしか始められないので、スイッチを入れたときに作る（pcSoundEnable）。
const PC_BEEP_MIN_GAP_MS = 33;
const pcSound = { on: false, ctx: null, lastMs: -Infinity };
try { pcSound.on = localStorage.getItem('pcSound') === '1'; } catch (_) {}

function pcSoundEnable(on) {
  pcSound.on = !!on;
  try { localStorage.setItem('pcSound', pcSound.on ? '1' : '0'); } catch (_) {}
  if (pcSound.on) {
    try {
      if (!pcSound.ctx) pcSound.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (pcSound.ctx.state === 'suspended') pcSound.ctx.resume();
    } catch (_) {}
  }
  Bus.emit('pcSound');
}

// ページを開き直すとスイッチは ON のまま戻るが、AudioContext はユーザーの操作があるまで動かせない。
// 画面のどこかを押した・キーを押したときに作り直す（ui.js が呼ぶ）。
function pcSoundWake() {
  if (!pcSound.on) return;
  try {
    if (!pcSound.ctx) pcSound.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (pcSound.ctx.state === 'suspended') pcSound.ctx.resume();
  } catch (_) {}
}

function pcBeep(adc, force) {
  if (!force && !pcSound.on) return;
  const now = performance.now();
  if (!force && now - pcSound.lastMs < PC_BEEP_MIN_GAP_MS) return;
  pcSound.lastMs = now;
  const d = state.connectionType === 'demo' && demo.dev ? demo.dev : {};
  const thr = Math.max(1, state.threshold ?? d.threshold ?? 100);
  const fmin = state.beepMin ?? d.beepMin ?? 500;
  const fmax = state.beepMax ?? d.beepMax ?? 4000;
  const ms = state.beepMs ?? d.beepMs ?? 25;
  playTone(fmin, fmax, ms, adc, thr);
}

function playTone(fmin, fmax, ms, adc, thr) {
  try {
    if (!pcSound.ctx) pcSound.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const ac = pcSound.ctx;
    if (ac.state === 'suspended') ac.resume();
    let x = 0;
    if (adc > thr && ADC_MAX > thr) x = Math.min(1, Math.max(0, (Math.log(adc) - Math.log(thr)) / (Math.log(ADC_MAX) - Math.log(thr))));
    const f = fmin * Math.pow(fmax / fmin, x);
    const dur = Math.max(0.005, ms / 1000);
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

// ========== Diagnostic report and settings backup (C-2) ==========
// 購入した人から相談を受けたとき、最初の往復（版は？ 設定は？ 何が出た？）を 1 回で済ませるための
// テキスト。値は接続直後の問い合わせでもう集めてあるので、ここでは書き出すだけで基板には何も送らない。
// GPS の位置・Bluetooth のアドレス・ページの場所（ファイルのパスにユーザー名が入ることがある）は、
// includePrivate が false なら伏せる。
function maskPrivate(line) {
  return line
    .replace(/BTADDR:\s*\S+/gi, 'BTADDR:(hidden)')
    .replace(/\b(lat|lon|alt)=[-\d.]+/gi, '$1=(hidden)')
    .replace(/^(\d+(?:\s+\S+){15})\s+\S+\s+\S+$/, '$1 (hidden) (hidden)');   // 18 列のイベント行の Lat / Lon
}

function buildDiagnosticReport(includePrivate) {
  const L = [];
  const v = x => (x == null || (typeof x === 'number' && isNaN(x)) ? '-' : String(x));
  const onOff = x => (x == null ? '-' : x ? 'ON' : 'OFF');
  const c = state.conn;
  const now = new Date();
  L.push('CosmicRay Recorder - diagnostic report');
  L.push(`Created: ${now.toISOString()} (local ${formatLocalTimestamp(now.getTime()).slice(0, 19)})`);
  L.push(`Page: ${location.protocol === 'file:' ? 'local file' : location.origin}${includePrivate ? ' ' + location.pathname : ''}`);
  L.push(`Browser: ${navigator.userAgent}`);
  L.push(`Web Serial: ${'serial' in navigator ? 'yes' : 'no'} / Web Bluetooth: ${'bluetooth' in navigator ? 'yes' : 'no'} / language: ${typeof currentLang === 'string' ? currentLang : '-'}`);
  L.push('');
  L.push('[Detector]');
  L.push(`Model chosen: ${modelProfile.id}`);
  L.push(`Connection: ${state.isConnected ? state.connectionType : 'not connected'}${state.reconnecting ? ' (reconnecting)' : ''}${state.paused ? ' (recording paused)' : ''}`);
  if (state.isConnected) L.push(`Connected for: ${formatTime(Date.now() - state.connectedAtMs)}`);
  L.push(`Name: ${v(state.bleName || c.bleName)}`);
  L.push(`Board address: ${c.btAddr ? (includePrivate ? c.btAddr : '(hidden)') : '-'}`);
  if (c.usbVendorId != null) L.push(`USB VID:PID: ${c.usbVendorId.toString(16).padStart(4, '0')}:${(c.usbProductId || 0).toString(16).padStart(4, '0')}`);
  L.push(`Firmware: ${c.fw || (modelProfile.fmt3 ? state.v21.fw : null) || (c.fwState === 'none' ? 'does not report a version (before 2026-11-20)' : '-')}` +
         (c.fwBuild ? ` build ${c.fwBuild}` : '') + (c.board ? ` board ${c.board}` : '') + (c.fwLatest ? ` / latest on the flash page ${c.fwLatest}` : ''));
  L.push(`Board clock: ${c.clock ? c.clock.src + (c.clock.utc ? ' ' + new Date(c.clock.utc * 1000).toISOString() : '') : '-'}`);
  L.push('');
  L.push('[Board settings, as last reported]');
  L.push(`Threshold: ${v(state.threshold)}  auto margin: ${v(state.autoMargin)}  PWM duty: ${v(state.pwmDuty)}  trigger mode: ${v(state.mode)}`);
  L.push(`SD: ${onOff(state.sdEnabled)}  EXT: ${onOff(state.extEnabled)}  OLED: ${onOff(state.oledEnabled)}  buzzer: ${onOff(state.buzzerEnabled)}  vibration: ${onOff(state.vibEnabled)}  GPS: ${onOff(state.gpsEnabled)}`);
  L.push(`Beep: ${v(state.beepMin)}-${v(state.beepMax)} Hz, ${v(state.beepMs)} ms  vibration: ${v(state.vibMin)}-${v(state.vibMax)} ms`);
  if (modelProfile.hv) L.push(`HV setting: ${v(state.hv)} V`);
  if (modelProfile.fmt3) {
    const w = state.v21;
    L.push(`v2.1: VTH ${v(w.vth)} mV  OFS ${v(w.ofs)} mV  A0 baseline ${v(w.baseMv)} mV  gain ${v(w.gain)}  HV ${v(w.hvV)} V  COIN_WIN ${v(w.coinWin)} us`);
    if (w.noise) L.push(`v2.1 NOISE: ${JSON.stringify(w.noise)}`);
    if (w.lastWarn) L.push(`v2.1 last warning: ${w.lastWarn}`);
  }
  if (state.gps) {
    const g = state.gps;
    L.push(`GPS: valid ${v(g.valid)} fix ${v(g.fix)} sats ${v(g.sats)} pps_age_ms ${v(g.ppsAgeMs)} lines_ok ${v(g.linesOk)} lines_bad ${v(g.linesBad)}` +
           (includePrivate ? ` lat ${v(g.lat)} lon ${v(g.lon)}` : ''));
  }
  L.push('');
  L.push('[Measurement on this page]');
  const s = state.stats, r = rateSummary();
  L.push(`Events: ${s.n}  rate: ${r.rate.toFixed(4)} +- ${r.rateStd.toFixed(4)} cps  elapsed: ${(r.elapsedUs / 1e6).toFixed(1)} s  live: ${(r.liveUs / 1e6).toFixed(1)} s  dead: ${(r.deadUs / 1e6).toFixed(3)} s`);
  if (s.n) {
    L.push(`ADC mean ${(s.sumAdc / s.n).toFixed(1)} max ${s.maxAdc}` +
           (s.nTemp ? `  temp ${(s.sumTemp / s.nTemp).toFixed(2)} C` : '') +
           (s.nHum ? `  hum ${(s.sumHum / s.nHum).toFixed(1)} %` : '') +
           (s.nPress ? `  press ${(s.sumPress / s.nPress).toFixed(1)} hPa` : ''));
    L.push(`External hits: ${s.digHits.join(' / ')}  coincident events: ${s.coincAny}`);
  }
  L.push(`Auto-save: ${state.autoSave.enabled ? 'on' : 'off'}  upload: ${state.upload && state.upload.enabled ? 'on' : 'off'}  demo data on page: ${state.events.some(e => e.demo) ? 'yes' : 'no'}`);
  if (pageNoticeMsg) L.push(`Notice on screen: ${pageNoticeMsg.key}`);
  if (connErrorMsg) L.push(`Error on screen: ${connErrorMsg.key}`);
  L.push('');
  L.push(`[Last ${state.rawLines.length} lines received]`);
  for (const line of state.rawLines) L.push(includePrivate ? line : maskPrivate(line));
  return L.join('\n') + '\n';
}

function exportDiagnosticReport(includePrivate) {
  const name = (state.bleName || state.conn.bleName || modelProfile.bleDefault).replace(/[^A-Za-z0-9_\-]/g, '_');
  downloadFile(`${name}_diagnostic_${formatDateForFile(new Date())}.txt`, buildDiagnosticReport(includePrivate));
}

// 設定の控え。基板の Preferences に保存される値だけを書き出す（トリガーモードは起動時に ANALOG に戻るので
// 入れない。Bluetooth の名前は書き込むと基板が再起動するので、控えには入れるが読み込みでは送らない）。
function buildSettingsBackup() {
  const out = {
    kind: 'cosmicray-settings', version: 1, model: modelProfile.id,
    created: new Date().toISOString(),
    device: state.bleName || null,
    firmware: state.conn.fw || (modelProfile.fmt3 ? state.v21.fw : null) || null,
    settings: {
      threshold: state.threshold, autoMargin: state.autoMargin,
      pwmDuty: modelProfile.id === 'v2' ? state.pwmDuty : null,
      sd: state.sdEnabled, ext: state.extEnabled, oled: state.oledEnabled, buzzer: state.buzzerEnabled, vib: state.vibEnabled,
      gps: modelProfile.id === 'v2' ? state.gpsEnabled : null,
      beep: state.beepMin != null ? [state.beepMin, state.beepMax, state.beepMs] : null,
      vibMs: state.vibMin != null ? [state.vibMin, state.vibMax] : null,
    },
  };
  return JSON.stringify(out, null, 2) + '\n';
}

function exportSettingsBackup() {
  const name = (state.bleName || modelProfile.bleDefault).replace(/[^A-Za-z0-9_\-]/g, '_');
  downloadFile(`${name}_settings_${formatDateForFile(new Date())}.json`, buildSettingsBackup());
}

// 控えの JSON から、送るコマンドの一覧を作る。読めない・別のものなら例外。値は範囲を確かめてから使う。
function settingsRestoreCommands(text) {
  const j = JSON.parse(text);
  if (!j || j.kind !== 'cosmicray-settings' || !j.settings) throw new Error('not a settings backup');
  const s = j.settings, cmds = [];
  const int = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;
  if (int(s.threshold, 0, ADC_MAX)) cmds.push(`SET_THRESH:${s.threshold}`);
  if (int(s.autoMargin, 0, ADC_MAX)) cmds.push(`SET_AUTO_MARGIN:${s.autoMargin}`);
  if (modelProfile.id === 'v2' && int(s.pwmDuty, 0, 255)) cmds.push(`SET_PWM:${s.pwmDuty}`);
  for (const [k, name] of [['sd', 'SD'], ['ext', 'EXT'], ['oled', 'OLED'], ['buzzer', 'BUZZER'], ['vib', 'VIB']]) {
    if (typeof s[k] === 'boolean') cmds.push(`SET_${name}:${s[k] ? 'ON' : 'OFF'}`);
  }
  if (modelProfile.id === 'v2' && typeof s.gps === 'boolean') cmds.push(`SET_GPS:${s.gps ? 'ON' : 'OFF'}`);
  if (Array.isArray(s.beep) && int(s.beep[0], 50, 20000) && int(s.beep[1], 51, 20000) && s.beep[1] > s.beep[0] && int(s.beep[2], 1, 500)) {
    cmds.push(`SET_BEEP:${s.beep[0]},${s.beep[1]},${s.beep[2]}`);
  }
  if (Array.isArray(s.vibMs) && int(s.vibMs[0], 1, 500) && int(s.vibMs[1], 2, 500) && s.vibMs[1] > s.vibMs[0]) {
    cmds.push(`SET_VIB_MS:${s.vibMs[0]},${s.vibMs[1]}`);
  }
  return { cmds, from: j };
}

async function sendRestoreCommands(cmds) {
  for (const cmd of cmds) {
    if (!state.isConnected) return;
    await sendCommand(cmd);
    await sleep(CMD_GAP_MS);
  }
}

// ========== SD logs over USB (C-4) ==========
// v2 のファーム（2026-11-20 以降）の SD_LIST / SD_READ で、microSD のログを PC に取り込む。USB だけ
// （ファームが BLE からの要求を断る。BLE は約 6.7 kB/秒が上限で、その間は数えられないため）。
// 1 回 2 KB を 16 進で受け取り、CRC-32 を確かめ、合わなければ 3 回まで頼み直す。
const SD_TIMEOUT_MS = 4000;
const sdx = { busy: false, files: null, current: null, error: null, progress: null, wait: null };

const CRC32_TABLE = (() => {
  const tb = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    tb[n] = c >>> 0;
  }
  return tb;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function sdRawLog(line) {
  state.rawLines.push(line);
  if (state.rawLines.length > 100) state.rawLines.shift();
  uiDirty = true;
}

function sdFinish(err, value) {
  const w = sdx.wait;
  if (!w) return;
  sdx.wait = null;
  clearTimeout(w.timer);
  if (err) w.reject(err); else w.resolve(value);
}

// 拾ったら true（SD の吸い出しの行）
function sdTransferLine(line) {
  if (line.startsWith('SDFILE:')) {
    const m = /^SDFILE:(\S+)\s+(\d+)/.exec(line);
    if (m && sdx.wait && sdx.wait.kind === 'list') sdx.wait.files.push({ name: m[1], size: parseInt(m[2]) });
    sdRawLog(line);
    return true;
  }
  if (line.startsWith('SDLIST:')) {
    const cur = /current=(\S+)/.exec(line);
    sdRawLog(line);
    if (sdx.wait && sdx.wait.kind === 'list') sdFinish(null, { files: sdx.wait.files, current: cur && cur[1] !== '-' ? cur[1] : null });
    return true;
  }
  if (line.startsWith('SDERR:')) {
    sdRawLog(line);
    sdFinish(new Error(line.slice(6).trim()));
    return true;
  }
  if (line.startsWith('SDDATA:')) {
    const m = /^SDDATA:(\S+) (\d+) (\d+) ([0-9a-f]{8}) ?([0-9a-f]*)$/.exec(line);
    sdRawLog(line.length > 80 ? line.slice(0, 60) + `… (${line.length} chars)` : line);
    const w = sdx.wait;
    if (!w || w.kind !== 'data') return true;
    if (!m || m[1] !== w.name || parseInt(m[2]) !== w.offset) { sdFinish(new Error('unexpected reply')); return true; }
    const len = parseInt(m[3]), hex = m[5];
    if (hex.length !== len * 2) { sdFinish(new Error('cut line')); return true; }
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    if (crc32(bytes) !== parseInt(m[4], 16)) { sdFinish(new Error('CRC mismatch')); return true; }
    sdFinish(null, bytes);
    return true;
  }
  return false;
}

function sdRequest(kind, cmd, extra) {
  return new Promise((resolve, reject) => {
    if (sdx.wait) { reject(new Error('busy')); return; }
    const w = Object.assign({ kind, resolve, reject, files: [] }, extra);
    w.timer = setTimeout(() => { if (sdx.wait === w) sdFinish(new Error('timeout')); }, SD_TIMEOUT_MS);
    sdx.wait = w;
    sendCommand(cmd);
  });
}

// USB（とデモ）だけで使える。BLE は断る。v2 のファームだけ（v2.1 / OKOME には無い）。
function sdTransferAvailable() {
  return state.isConnected && modelProfile.ver && (state.connectionType === 'usb' || state.connectionType === 'demo');
}

async function sdListFiles() {
  if (!sdTransferAvailable() || sdx.busy) return;
  sdx.busy = true; sdx.error = null; sdx.progress = null;
  Bus.emit('sd');
  try {
    const r = await sdRequest('list', 'SD_LIST');
    sdx.files = r.files.sort((a, b) => a.name.localeCompare(b.name));
    sdx.current = r.current;
  } catch (e) {
    sdx.files = null;
    sdx.error = e.message === 'timeout' && state.conn.fwState === 'none' ? 'old firmware' : e.message;
  } finally {
    sdx.busy = false;
    Bus.emit('sd');
  }
}

async function sdDownloadFile(name, size) {
  if (!sdTransferAvailable() || sdx.busy) return;
  sdx.busy = true; sdx.error = null;
  sdx.progress = { name, done: 0, size, startMs: Date.now() };
  Bus.emit('sd');
  const parts = [];
  try {
    let off = 0;
    while (off < size) {
      let bytes = null, lastErr = null;
      for (let attempt = 0; attempt < 3 && bytes == null; attempt++) {
        if (!state.isConnected) throw new Error('disconnected');
        try { bytes = await sdRequest('data', `SD_READ:${name},${off}`, { name, offset: off }); } catch (e) { lastErr = e; if (/USB only|no card|cannot open|bad arguments/.test(e.message)) break; }
      }
      if (bytes == null) throw lastErr || new Error('failed');
      if (bytes.length === 0) break;   // ファイルが短くなっていた
      parts.push(bytes);
      off += bytes.length;
      sdx.progress.done = off;
      Bus.emit('sd');
    }
    const base = getFileBase();
    downloadBlob(`${base}_SD_${name}`, new Blob(parts, { type: 'text/plain' }));
    sdx.progress.finishedMs = Date.now();
  } catch (e) {
    sdx.error = e.message;
    sdx.progress = null;
  } finally {
    sdx.busy = false;
    Bus.emit('sd');
  }
}

// ========== Measurement timer (測定時間の予約, B-2) ==========
// 「10 分測ったら止める」「1000 件で止める」。基準は予約したあとの最初のイベント（基板のカウンタの差で数える。
// 計数率と同じ物差し）。目標に届いたら、その場で記録を一時停止して音と知らせで伝える（基板は数え続ける）。
// 始めと終わりに "### MARK utc=<UTC> label=<..>" の行を保存ファイルに残す（解析ページはこの行を列の見出しと
// みなさない）。mode: 'elapsed'（経過時間 [s]）| 'live'（ライブタイム [s]）| 'counts'（件数）
const measTimer = { active: false, mode: 'elapsed', target: 0, base: null, done: null };

function timerValueOf(r, mode) {
  return mode === 'counts' ? r.counts : (mode === 'live' ? r.liveUs : r.elapsedUs) / 1e6;
}

function timerMark(label) {
  recordInfoLine(`### MARK utc=${new Date().toISOString()} label=${label}`);
}

function timerLabel() {
  const m = measTimer;
  return m.mode === 'counts' ? `${m.target}events` : `${Math.round(m.target)}s_${m.mode}`;
}

function timerStart(mode, target) {
  if (!state.isConnected || !(target > 0)) return;
  measTimer.active = true;
  measTimer.mode = mode;
  measTimer.target = target;
  measTimer.base = null;   // 次のイベントで決める
  measTimer.done = null;
  if (state.paused) setLoggingPaused(false);
  timerMark('timer_start_' + timerLabel());
  Bus.emit('timer');
}

function timerCancel() {
  if (!measTimer.active) return;
  measTimer.active = false;
  timerMark('timer_cancel');
  Bus.emit('timer');
}

// 残りと進み具合。予約していなければ null。
function timerStatus() {
  const m = measTimer;
  if (!m.active) return null;
  const done = m.base == null ? 0 : timerValueOf(rateSummary(), m.mode) - m.base;
  return { mode: m.mode, target: m.target, done, remaining: Math.max(0, m.target - done) };
}

// 記録したイベントごとに呼ぶ（processLine）
function timerOnEvent() {
  const m = measTimer;
  if (!m.active) return;
  const v = timerValueOf(rateSummary(), m.mode);
  if (m.base == null) { m.base = v; return; }
  if (v - m.base >= m.target) {
    m.active = false;
    m.done = { mode: m.mode, target: m.target, value: v - m.base, atMs: Date.now() };
    timerMark('timer_end_' + timerLabel());
    setLoggingPaused(true);
    // 「このパソコンで音を鳴らす」が ON のときだけ 3 音で知らせる（音は初期値 OFF。知らせの帯はいつも出す）
    if (pcSound.on) [0, 160, 320].forEach((ms, i) => setTimeout(() => playTone(880, 1760, 120, [300, 1200, 4095][i], 100), ms));
    showNotice('notice.timerDone', { what: timerTargetText(m.done.mode, m.done.target) });
    Bus.emit('timer');
  }
}

// "10 分（経過時間）" など。画面の言語で。
function timerTargetText(mode, target) {
  if (mode === 'counts') return t('timer.nEvents', { n: target.toLocaleString() });
  const min = target / 60;
  const amount = Number.isInteger(min) ? t('timer.nMin', { n: min }) : t('timer.nSec', { n: target });
  return amount + t(mode === 'live' ? 'timer.ofLive' : 'timer.ofElapsed');
}


// ========== Auto-Save ==========
let autoSaveRun = null;   // the flush in progress (awaited by forced flushes, N-1)

async function selectSaveFolder() {
  if (Hooks.pickSaveFolder) {
    try {
      const dirHandle = await Hooks.pickSaveFolder();
      if (dirHandle) await useSaveFolder(dirHandle);
    } catch (e) {
      console.error('Folder select error:', e);
    }
    return;
  }
  if (!('showDirectoryPicker' in window)) {
    Bus.emit('alert', { key: 'alert.fsApi' });
    return;
  }
  try {
    // Must be the first await, while the click's user activation is still valid.
    const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await useSaveFolder(dirHandle);
  } catch (e) {
    if (e.name !== 'AbortError') console.error('Folder select error:', e);
  }
}

// Start auto-saving into dirHandle (a FileSystemDirectoryHandle, or the desktop
// app's stand-in with the same getFileHandle / getFile / createWritable calls).
async function useSaveFolder(dirHandle) {
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
// v2.1: 先頭 14 列は v2 と同じ。GPS の列の代わりにファームの FMT:3 の末尾 7 列（v2.1 に GPS は無い）。
const DAT_COLUMNS_V21 = '# Event\tPC_Timestamp\tTime[us]\tADC[0-4095]\tDeadtime[us]\tTemp[C]\tHum[%]\tPress[hPa]\tDig1\tDig2\tDig3\tAna1\tAna2\tAna3\tBase[ADC]\tPeak[mV]\tPeakT[us]\tFlags\tDt1[us]\tDt2[us]\tDt3[us]\n';
const CSV_COLUMNS_V21 = 'Event,PC_Timestamp,Time_us,ADC,Deadtime_us,Temp_C,Hum_pct,Press_hPa,Dig1,Dig2,Dig3,Ana1,Ana2,Ana3,Base_ADC,Peak_mV,PeakT_us,Flags,Dt1_us,Dt2_us,Dt3_us\n';

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
  // OKOME だけ追加する注釈行（# で始まるので列の読み取りには影響しない。OHASHI の出力は従来どおり）
  if (modelProfile.id === 'okome') {
    lines.push('# Detector model: OKOME (MUON FOB). Temp column = nRF52840 die temperature, not ambient; Hum / Press = nan; Dig / Ana = 0.');
    if (state.hv != null) lines.push(`# SiPM bias setting: ${state.hv} V`);
  }
  // v2.1 だけ追加する注釈行（# 行のみ。v2 / OKOME の出力は従来どおり）
  const v21 = modelProfile.fmt3 ? state.v21 : null;
  if (v21) {
    lines.push(`# Detector model: v2.1` + (v21.fw ? ` (FW ${v21.fw}, log format FMT:3)` : ' (log format FMT:3)'));
    if (v21.vth != null) lines.push(`# Comparator threshold VTH: ${v21.vth.toFixed(1)} mV (MCP4728 ch A, absolute amplifier-output voltage)`);
    if (v21.ofs != null) lines.push(`# Baseline lift OFS: ${v21.ofs.toFixed(1)} mV (MCP4728 ch C)` + (v21.baseMv != null ? `; A0 baseline ${v21.baseMv.toFixed(1)} mV` : ''));
    if (v21.gain != null) lines.push(`# Estimated amplifier gain: x${v21.gain.toFixed(1)}`);
    if (v21.hvV != null) lines.push(`# HV (monitor): ${v21.hvV.toFixed(2)} V`);
  }
  if (state.bleName)           lines.push(`# Device: ${state.bleName}`);
  if (state.conn.btAddr)       lines.push(`# Board address: ${state.conn.btAddr}`);
  if (!v21 && state.conn.fwState === 'known' && state.conn.fw) {
    lines.push(`# Firmware: FW=${state.conn.fw}` + (state.conn.fwBuild ? ` BUILD=${state.conn.fwBuild}` : ''));
  }
  if (state.mode)              lines.push(`# Trigger mode: ${state.mode}`);
  if (state.threshold != null) lines.push(`# Signal threshold: ${state.threshold} / 4095` + (v21 ? ' (above the baseline)' : ''));
  if (state.pwmDuty != null && modelProfile.id !== 'okome' && !v21) lines.push(`# Comparator PWM duty: ${state.pwmDuty} / 255`);   // OKOME にコンパレータは無い。v2.1 は VTH
  if (state.gpsEnabled) {
    const g = state.gps;
    if (g && g.valid && g.lat != null && g.lon != null) {
      lines.push(`# GPS position: lat ${g.lat.toFixed(6)} lon ${g.lon.toFixed(6)}` + (g.alt != null ? ` alt ${g.alt.toFixed(1)} m` : '') + (g.sats != null ? ` (${g.sats} satellites)` : ''));
    }
    lines.push('# GPS: "### PPS <Time[us]> <UTC unix seconds>" lines mark the 1PPS edges on the same clock as Time[us]; "### GPS fix=.." lines give the position.');
  }
  if (state.conn.clock && state.conn.clock.src === 'PC') {
    lines.push('# TIME: "### TIME <Time[us]> <UTC unix seconds> src=PC" lines tie Time[us] to the PC clock sent at connect (SET_TIME, about +-0.1 s). GPS PPS lines take precedence.');
  }
  lines.push('# PC_Timestamp: UTC (trailing Z). Time / Deadtime: board counters in microseconds since boot or RESET.');
  lines.push('# Column 2 (PC_Timestamp) is added by this page, so later columns sit one to the right of the firmware / SD log.');
  if (v21) {
    lines.push('# ADC = height of the shaped pulse above the baseline just before it. Base[ADC] / Peak[mV] / PeakT[us] / Flags / Dt1-3[us] come from the firmware (FMT:3).');
    lines.push('# Flags (sum): 1 = overlaps another pulse, 2 = ADC saturated, 4 = peak at the edge of the search window, 8 = ANALOG trigger, 16 = baseline below 55 mV. Dt = coincident DIG_IN time - own trigger time.');
    return lines.join('\n') + '\n' + (format === 'csv' ? CSV_COLUMNS_V21 : DAT_COLUMNS_V21);
  }
  lines.push('# PPS_UTC_s / PPS_dt_us / PPS_period_us / Lat / Lon come from the firmware (empty without GPS). UTC_GPS (last column) = PPS_UTC_s + PPS_dt_us / PPS_period_us, computed by this page.');
  return lines.join('\n') + '\n' + (format === 'csv' ? CSV_COLUMNS : DAT_COLUMNS);
}

// File name base from the board's BLE name, without the DEMO_ mark.
// v2.1 の基板も既定名は CosmicRay（OHASHI と同じ）。自動保存は同じ名前・同じ日のファイルに追記し、
// 列の見出しは新しいファイルにしか書かないので、v2.1 は名前に _v21 を付けて別のファイルにする
// （列の並びが違う行が 1 つのファイルに混ざらないように）。
function getFileBase() {
  const fallback = modelProfile.bleDefault;
  const name = (state.bleName || state.conn.bleName || fallback).trim();
  const base = name.replace(/[^A-Za-z0-9_\-]/g, '_') || fallback;
  return modelProfile.fmt3 ? base + '_v21' : base;
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

// v2.1 のファームの末尾 7 列。v2.1 の形でない行（別の機種の基板）は空欄。
function eventV21Fields(ev) {
  if (ev.flags === undefined) return ['', '', '', '', '', '', ''];
  return [ev.base_adc, isNaN(ev.peak_mv) ? '' : ev.peak_mv.toFixed(1), ev.peakt_us, ev.flags, ev.dt1, ev.dt2, ev.dt3];
}

// 14 列目より後ろ: v2 / OKOME は GPS の列、v2.1 はファームの FMT:3 の列。
function eventTailFields(ev) {
  return modelProfile.fmt3 ? eventV21Fields(ev) : eventGpsFields(ev);
}

// Pressure keeps the firmware's one decimal; a second digit would be invented precision.
function eventToDatLine(ev) {
  if (ev.kind === 'gps') return ev.line + '\n';
  const pcTs = new Date(ev.pc_timestamp).toISOString().replace('T', '-').replace(/:/g, '-');
  const f = (v, d = 1) => (isNaN(v) ? '' : v.toFixed(d));
  return `${ev.count}\t${pcTs}\t${ev.timestamp_us}\t${ev.adc}\t${ev.deadtime_us}\t${f(ev.temp_c, 1)}\t${f(ev.hum_pct, 1)}\t${f(ev.press_hpa, 1)}\t${ev.d1}\t${ev.d2}\t${ev.d3}\t${ev.a1}\t${ev.a2}\t${ev.a3}\t${eventTailFields(ev).join('\t')}\n`;
}

function eventToCsvLine(ev) {
  if (ev.kind === 'gps') return ev.line + '\n';
  const f = (v, d = 1) => (isNaN(v) ? '' : v.toFixed(d));
  return `${ev.count},${new Date(ev.pc_timestamp).toISOString()},${ev.timestamp_us},${ev.adc},${ev.deadtime_us},${f(ev.temp_c, 1)},${f(ev.hum_pct, 1)},${f(ev.press_hpa, 1)},${ev.d1},${ev.d2},${ev.d3},${ev.a1},${ev.a2},${ev.a3},${eventTailFields(ev).join(',')}\n`;
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
      state.conn = newConnState();
      if (measTimer.active) { measTimer.active = false; Bus.emit('timer'); }   // 切断したら予約も終わり
      sdFinish(new Error('disconnected'));
      sdx.files = null; sdx.progress = null; sdx.error = null;
      Bus.emit('sd');
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
  // v2.1: ファームと同じ窓で読む（ベースラインは [-144, -24] µs の平均、ピークは [-12, +120] µs の最大）。
  // 窓は 1.9 ms あり、ダークパルスの揺れが大きい基板では、窓全体の最大値は別の場所の山になりやすい
  // （実機で t_peak が −372〜+1368 µs にばらついた）。v2 / OKOME は従来どおりトリガー前全部と窓全体。
  let b0 = 0, b1 = npre, p0 = 0, p1 = ntot;
  if (modelProfile.fmt3) {
    const at = us => npre + Math.round(us / dtUs);
    b0 = Math.max(0, at(-144)); b1 = Math.max(b0 + 1, Math.min(npre, at(-24) + 1));
    p0 = Math.max(0, at(-12)); p1 = Math.min(ntot, at(120) + 1);
  }
  let base = 0;
  for (let i = b0; i < b1; i++) base += v[i];
  base = b1 > b0 ? base / (b1 - b0) : v[0];

  let peak = -Infinity, pi = 0;
  for (let i = p0; i < p1; i++) { const a = v[i] - base; if (a > peak) { peak = a; pi = i; } }

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
    // v2.1 のファームには撮り方と再アームが無い（コンパレータのトリガーごとに 1 本、レート上限まで）
    if (modelProfile.scopeTrig) {
      sendCommand('SET_SCOPE_TRIG:' + (settings.scopeTrig === 'FREE' ? 'FREE' : 'NORMAL'));
      sendCommand('SET_SCOPE_REARM:' + (parseInt(settings.scopeRearm) >= 0 ? parseInt(settings.scopeRearm) : 5));
    }
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
  // タブを閉じるとブラウザがポートを閉じ、DTR/RTS が一度に下がってダウンロードモードに入るので、
  // 先に RTS → DTR の順に下げておく（間に合わないこともあるが、残っても基板は普通に動く）
  usbLinesSafe();
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
window.addEventListener('pagehide', () => { usbLinesSafe(); flushAutoSave({ force: true }).catch(() => {}); });

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
  phase: Math.random() * Math.PI * 2,
  env: { temp: 23.6, hum: 47.0, press: 1013.4, tempGoal: 25.6 },
  // 仮想デバイスの設定値 (ファームの Preferences 相当)。
  dev: {
    threshold: 120, duty: 34, mode: 'DIGITAL', autoMargin: 50,
    sd: false, ext: true, oled: true, buzzer: false, vib: false, gps: false,   // ブザーはファームと同じく初期値 OFF
    beepMin: 500, beepMax: 4000, beepMs: 25,
    vibMin: 20, vibMax: 120,
    bleName: 'CosmicRay',
  },
  scope: { on: false, rate: 3, enterMs: 0, emitted: 0, nextMs: 0, rearm: 5, trig: 'NORMAL' },
  audio: null,
};

// 機種ごとの仮想基板。OHASHI（v2）は上の demo.dev そのまま。
// OKOME は実機ファームの応答に合わせる: PWM は無し(0)、トリガーは ANALOG のみ、SD / EXT / GPS は無い、
// OLED のスイッチは LED、HV は 3 段（0 = 25.9 V / 1 = 27.1 V / 2 = 27.9 V）。
demo.devs = {
  v2: demo.dev,
  okome: {
    threshold: 120, duty: 0, mode: 'ANALOG', autoMargin: 50,
    sd: false, ext: false, oled: true, buzzer: true, vib: false, gps: false,
    beepMin: 500, beepMax: 4000, beepMs: 25,
    vibMin: 20, vibMax: 120,
    bleName: 'MuonFob',
    hv: 1,
  },
  // v2.1: 値は 2026-11-15 の 1 枚目の実機の初回起動（CALIBRATE の結果）に合わせた。
  // しきい値はベースラインからの高さ、VTH はアンプ出力の絶対電圧 [mV]、HV は固定で監視だけ。
  v21: {
    threshold: 152, duty: 0, mode: 'DIGITAL', autoMargin: 10,
    sd: true, ext: true, oled: true, buzzer: false, vib: true, gps: false,   // FW 2.1: ブザーは既定で OFF
    beepMin: 500, beepMax: 4000, beepMs: 25,
    vibMin: 20, vibMax: 120,
    bleName: 'CosmicRay',
    vth: 212.0, ofs: 922.5, slope: 0.09313, tp2: 108.0,
    hvK: 11.0, hvTrue: 28.71, coinWin: 100, extAna: 0,
  },
};
const DEMO_V21_BASE_RAW = 66;    // v2.1 の A0 の静止値 [ADC]（約 60 mV）
const DEMO_V21_NOISE_LSB = 14;   // ダークパルスの積み重なりで揺れる分（実機はもっと大きい: rms 約 48 mV）
const DEMO_HV_TEXT = ['25.9', '27.1', '27.9'];
const DEMO_HV_TRIM = ['High', 'Hi-Z', 'Low'];

// オシロの 1 窓の形。OHASHI は 12 us 間隔でピークホールド出力、OKOME は 6 us 間隔でアンプの生の出力
// （16 点前 + 1 + 64 点後 = 81 点、ファームの SCOPE_PRE / SCOPE_POST）。
// v2.1 は 12 us 間隔で整形パルス（2 極、tau 47 us。トリガーの約 46 us 後に頂点）、32 点前 + 1 + 128 点後。
function demoWaveGeom() {
  if (modelProfile.id === 'v21') return { pre: 32, post: 128, periodNs: 12000, tauUs: 46, riseUs: 0, crrc: true };
  return modelProfile.id === 'okome'
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
  if (modelProfile.id === 'okome') {
    // OKOME: 画面の書き換えは無い。LED が 10 ms 光る間と、止まってから数え直すまでの 10 ms が
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
  // OKOME: 温度は nRF52840 のチップ温度、湿度と気圧は "nan"（BME280 が無い）。
  const okome = modelProfile.id === 'okome';
  // ファームの snprintf("%lu %llu %d %llu %.1f %.1f %.1f %d %d %d %d %d %d %lu %ld %lu %.5f %.5f") と同じ並び。
  // 末尾 5 列 (PPS_UTC / PPS_dt / PPS_period / Lat / Lon) は GPS 対応ファームだけ。GPS が OFF なら "0 -1 0 nan nan"。
  const tUs = Math.round((tMs - demo.startMs) * 1000);
  if (modelProfile.id === 'v21') {
    demoMakeEventV21(tMs, tUs, adc, dig, ana);
    return;
  }
  let gpsTail = [];
  if (!okome) {
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
    okome ? (e.temp + 6).toFixed(1) : e.temp.toFixed(1),
    okome ? 'nan' : e.hum.toFixed(1),
    okome ? 'nan' : e.press.toFixed(1),
    dig[0], dig[1], dig[2], ana[0], ana[1], ana[2],
    ...gpsTail,
  ].join(' '));
  // 音は processLine の pcBeep が鳴らす（実機と同じ道すじ。PC の音のスイッチで入れ切り）
}

// v2.1 のイベント行（20 列、ファームの FMT:3 と同じ並び）。オシロが ON なら、計数を続けたまま
// トリガーごとに波形も出す（レート上限まで）。実機と同じく計数は止めない。
function demoMakeEventV21(tMs, tUs, adc, dig, ana) {
  const d = demo.dev;
  const e = demo.env;
  let base = Math.round(DEMO_V21_BASE_RAW + (e.temp - 25) * 0.6 + demoRandN() * DEMO_V21_NOISE_LSB * 0.6);
  if (base < 0) base = 0;
  const peakT = 48 + 12 * Math.max(-1, Math.min(1, Math.round(demoRandN() * 0.7)));
  let flags = 0;
  if (Math.random() < 0.02) flags |= 1;    // 前後のパルスと重なり
  if (adc >= ADC_MAX - 40) flags |= 2;     // 飽和
  if (base < 61) flags |= 16;              // A0 の静止値が 55 mV 未満（約 61 カウント）
  const dt = dig.map(h => (h ? Math.round(demoRandN() * 3) : 0));
  processLine([
    demo.count, tUs, adc, demo.deadtimeUs,
    e.temp.toFixed(1), e.hum.toFixed(1), e.press.toFixed(1),
    dig[0], dig[1], dig[2], ana[0], ana[1], ana[2],
    base, (adc * 0.905).toFixed(1), peakT, flags, dt[0], dt[1], dt[2],
  ].join(' '));
  const s = demo.scope;
  if (s.on && tMs - (s.lastWfMs || 0) >= 1000 / Math.max(1, s.rate)) {
    s.lastWfMs = tMs;
    demoEmitWaveformV21(tMs, adc, base);
  }
}

// v2.1 の A0 の 1 窓: 2 極の整形パルス（t / tau · e^(1 − t/tau)、頂点はトリガーの約 46 us 後）に、
// ダークパルスの積み重なりのようなゆっくりした揺れを足す。ADC の 0 で下が切れるのも実機と同じ。
function demoEmitWaveformV21(tMs, adc, base) {
  const G = demoWaveGeom();
  const npre = G.pre, ntot = G.pre + 1 + G.post, dtUs = G.periodNs / 1000;
  const tau = G.tauUs * (0.92 + 0.16 * Math.random());
  const t0 = -Math.random() * 4;
  const v = new Array(ntot);
  let w = demoRandN() * DEMO_V21_NOISE_LSB;
  for (let i = 0; i < ntot; i++) {
    w = 0.85 * w + 0.53 * demoRandN() * DEMO_V21_NOISE_LSB;   // 相関のある揺れ（rms ≈ NOISE_LSB）
    const t = (i - npre) * dtUs - t0;
    const p = t > 0 ? adc * (t / tau) * Math.exp(1 - t / tau) : 0;
    v[i] = Math.max(0, Math.min(ADC_MAX, Math.round(base + w + p)));
  }
  demo.scope.emitted++;
  processLine('WF,' + demo.scope.emitted + ',' + Math.round(tMs - demo.scope.enterMs) +
              ',U,' + npre + ',' + ntot + ',' + G.periodNs + ',' + v.join(','));
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
  // BEEP_TEST の音（デモの仮想基板の音域で）。イベントの音は pcBeep。
  const d = demo.dev;
  playTone(d.beepMin, d.beepMax, d.beepMs, adc, Math.max(1, d.threshold));
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

  if (demo.scope.on && modelProfile.scopePausesCount) {
    // ファームはオシロ ON の間、計数を止める (### SCOPE: ON - counting is PAUSED)。
    // （v2.1 は止めない。波形は demoMakeEventV21 がイベントのついでに出す）
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

  if (modelProfile.id === 'okome' && demoCommandOkome(cmd, d, say)) return;
  if (modelProfile.id === 'v21' && demoCommandV21(cmd, d, say)) return;

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
    demoLogPcTime(say, 40);   // 起点が変わったので、ファームと同じく TIME 行を出し直す
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
        demo.pcTime = null;              // 再起動で PC の時刻は消える
        demoResetCounters(now);
        demo.nextEventMs = now + 1000;   // 起動処理の間は計数しない
        demoBootBanner();
      }, 1500);
    } else {
      say('### BLE name invalid (1-24 printable ASCII chars).');
    }
  } else if (cmd === 'GET_VER') {
    say('VER:FW=' + DEMO_FW.fw + ' BOARD=v2 BUILD=' + DEMO_FW.build);
  } else if (cmd.startsWith('SET_TIME:')) {
    // ファームと同じく、2020〜2100 年の UTC ミリ秒だけ受け付けて、その瞬間を基準に覚える
    const ms = /^\d+$/.test(cmd.slice(9)) ? Number(cmd.slice(9)) : NaN;
    if (ms >= 1577836800000 && ms < 4102444800000) {
      demo.pcTime = { perfMs: performance.now(), utcMs: ms };
      demoLogPcTime(say);
    }
    demoSayTime(say);
  } else if (cmd === 'GET_TIME') {
    demoSayTime(say);
  } else if (cmd === 'SD_LIST') {
    demoSdFiles();
    for (const [name, bytes] of Object.entries(demo.sdFiles)) say('SDFILE:' + name + ' ' + bytes.length);
    say('SDLIST:END ' + Object.keys(demo.sdFiles).length + ' current=LOG0002.TXT', 40);
  } else if (cmd.startsWith('SD_READ:')) {
    const m = /^SD_READ:([A-Za-z0-9_.\-]{1,32}),(\d+)$/.exec(cmd);
    const bytes = m && demo.sdFiles && demo.sdFiles[m[1]];
    if (!bytes) { say('SDERR:cannot open file'); return; }
    const off = Math.min(parseInt(m[2]), bytes.length);
    const chunk = bytes.subarray(off, Math.min(bytes.length, off + 2048));
    let hex = '';
    for (const b of chunk) hex += (b < 16 ? '0' : '') + b.toString(16);
    say(`SDDATA:${m[1]} ${off} ${chunk.length} ${crc32(chunk).toString(16).padStart(8, '0')} ${hex}`, 15);
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
    if (pcSound.on) {
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

// OKOME（MUON FOB）の実機ファームが OHASHI と違う答え方をするコマンド。処理したら true を返し、
// 残りは demoCommand の共通の処理（しきい値・ブザー・振動・オシロ・BLE 名など）に任せる。
// 文言は firmware/muon_fob/muon_fob.ino の runCommand と同じ。
function demoCommandOkome(cmd, d, say) {
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

// v2.1（FW 2.1.0）の実機ファームが v2 と違う答え方をするコマンド。処理したら true を返し、
// 残り（RESET・モード・BLE 名・ブザー・振動・機能スイッチ・オシロのレート）は共通の処理に任せる。
// 文言は COSMICRAY_DETECTOR_ESP32-S3-Nano-v2.1.ino と、2026-11-15 に実機から取った応答に合わせた。
function demoCommandV21(cmd, d, say) {
  const clampI = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const f1 = x => x.toFixed(1);
  const half = x => Math.round(x * 2) / 2;   // MCP4728 は 0.5 mV 刻み
  const threshLine = () => 'THRESH:' + d.threshold + ' VTH:' + f1(d.vth);
  // A0 の静止値は ch C に比例して動く（実機: 2047.5 mV で 170.5 mV、傾き 0.09313）
  const a0At = ofs => Math.max(0, 170.5 - d.slope * (2047.5 - ofs));
  const baseMv = () => a0At(d.ofs) + demoRandN() * 1.5;
  const baseLine = () => { const b = baseMv(); return 'BASE:' + f1(b) + ' RAW:' + f1(b * 1.105) + ' SLOPE:' + d.slope.toFixed(5) + ' GAIN:' + f1(d.slope / 0.0015) + ' OFS:' + f1(d.ofs); };
  const hvMon = () => d.hvTrue / 11.0 * 1000 + demoRandN() * 1.5;
  const hvLine = () => { const m = hvMon(); return 'HV:' + (m * d.hvK / 1000).toFixed(2) + ' MON:' + f1(m) + ' K:' + d.hvK.toFixed(4); };
  const cfgLine = () => '#CFG FW=2.1.0 BOARD=v2.1 FMT=3 MODE=' + d.mode + ' VTH_mV=' + f1(d.vth) + ' OFS_mV=' + f1(d.ofs) +
    ' BASE_mV=' + f1(baseMv()) + ' TP2_mV=' + f1(d.tp2) + ' GAIN=' + f1(d.slope / 0.0015) + ' HV_V=' + (hvMon() * d.hvK / 1000).toFixed(2) +
    ' TAU_us=47 THRESH=' + d.threshold + ' EXT=' + (d.ext ? 1 : 0) + ' EXT_ANA=' + d.extAna + ' COIN_WIN_us=' + d.coinWin + ' DAC=1';
  // 決まった間隔で行を流す。計数を止めるコマンド（AUTO_VTH・AUTO_BASE・CALIBRATE）は、その間イベントを出さない。
  const script = (lines, stepMs, pause) => {
    const t0 = performance.now();
    lines.forEach((l, i) => setTimeout(() => { if (demo.on) processLine(typeof l === 'function' ? l() : l); }, 40 + i * stepMs));
    if (pause) demo.nextEventMs = Math.max(demo.nextEventMs, t0 + 40 + lines.length * stepMs);
  };
  const vthSweep = (target, margin) => {
    const rateAt = mv => Math.round(1.3e6 * Math.exp(-(mv - 130) / 7.5) * (0.9 + 0.2 * Math.random()));
    const lines = ['### AUTO_VTH sweep: VTH[mV],comp_rate[/s]'];
    let knee = 130;
    for (let mv = 130; mv <= 260; mv += 2) {
      const r = rateAt(mv);
      lines.push('### ' + f1(mv) + ',' + r);
      knee = mv;
      if (r <= target) break;
    }
    const vth = half(knee + margin);
    lines.push(() => { d.vth = vth; return '### AUTO_VTH: release 130.0 mV (TP2 ~' + f1(d.tp2) + ' mV), knee ' + f1(knee) + ' mV, VTH ' + f1(vth) +
      ' mV = TP2 + ' + f1(vth - d.tp2) + ' mV, rate ' + Math.round(target * 0.6) + '/s (target <= ' + target + '/s)'; });
    lines.push(() => 'VTH:' + f1(d.vth));
    lines.push(threshLine);
    return lines;
  };
  const baseLines = lift => {
    const ofs = half(Math.min(2047.5, Math.max(lift / d.slope, 2047.5 - (170.5 - 65.5) / d.slope)));
    return [
      '### AUTO_BASE: measuring the A0 slope against ch C (lift ' + lift + ' mV)...',
      '### AUTO_BASE: A0 170.5 mV @ch C 2047.5 mV, 151.9 mV @1847.5 mV -> slope ' + d.slope.toFixed(5) + ' (gain ~x' + f1(d.slope / 0.0015) + ')',
      () => { d.ofs = ofs; return baseLine(); },
      () => 'OFS:' + f1(d.ofs),
    ];
  };
  const threshLines = () => {
    const p50 = Math.round(a0At(d.ofs) * 1.105), p98 = p50 + 140 + Math.round(Math.random() * 10);
    return [
      '### Auto-calibrating threshold...',
      () => { d.threshold = clampI(p98 - p50 + d.autoMargin, 1, ADC_MAX);
              return '### Auto-threshold calib: n=83840 p2=0 p50=' + p50 + ' p98=' + p98 + ' max=' + (p98 + 600) +
                     ' rms=' + f1(DEMO_V21_NOISE_LSB * 3.4) + ' mV margin=' + d.autoMargin + ' -> thr=' + d.threshold; },
      threshLine,
      () => 'AUTO_MARGIN:' + d.autoMargin,
    ];
  };
  let m;

  if (cmd === 'GET_THRESH') {
    say(threshLine());
  } else if (cmd.startsWith('SET_THRESH:')) {
    const n = parseInt(cmd.slice(11));
    if (!isNaN(n)) d.threshold = clampI(n, 1, ADC_MAX);
    say(threshLine());
  } else if (cmd === 'AUTO_THRESH' || cmd.startsWith('AUTO_THRESH:')) {
    if (cmd.startsWith('AUTO_THRESH:')) {
      const mg = parseInt(cmd.slice(12));
      if (!isNaN(mg)) d.autoMargin = clampI(mg, 0, ADC_MAX);
    }
    script(threshLines(), 350, false);
  } else if (cmd === 'GET_PWM' || cmd.startsWith('SET_PWM:')) {
    say('### SET_PWM/GET_PWM are for the v2 board. On v2.1 use SET_VTH:<mV> (MCP4728 ch A).');
    say('VTH:' + f1(d.vth), 40);
  } else if (cmd === 'GET_VTH') {
    say('VTH:' + f1(d.vth));
  } else if (cmd.startsWith('SET_VTH:')) {
    const v = parseFloat(cmd.slice(8));
    if (Number.isFinite(v)) d.vth = half(Math.min(2047.5, Math.max(0, v)));
    say('VTH:' + f1(d.vth));
    say(threshLine(), 40);
  } else if ((m = cmd.match(/^AUTO_(?:VTH|PWM)(?::(\d+)(?:,(\d+(?:\.\d+)?))?)?$/))) {
    script(vthSweep(m[1] != null ? Math.max(1, parseInt(m[1])) : 50, m[2] != null ? parseFloat(m[2]) : 4), 95, true);
  } else if (cmd === 'GET_OFS') {
    say('OFS:' + f1(d.ofs));
  } else if (cmd.startsWith('SET_OFS:')) {
    const v = parseFloat(cmd.slice(8));
    if (Number.isFinite(v)) d.ofs = half(Math.min(2047.5, Math.max(0, v)));
    demo.nextEventMs = Math.max(demo.nextEventMs, performance.now() + 300);
    say('OFS:' + f1(d.ofs), 330);
  } else if ((m = cmd.match(/^(?:AUTO_BASE|SET_BASE)(?::(\d+))?$/))) {
    script(baseLines(m[1] != null ? clampI(parseInt(m[1]), 10, 300) : 90), 900, true);   // FW 2.1 の既定の持ち上げは 90 mV
  } else if (cmd === 'GET_BASE') {
    say(baseLine(), 220);
  } else if (cmd === 'CALIBRATE') {
    script([
      '### CALIBRATE: AUTO_BASE -> AUTO_VTH -> AUTO_THRESH -> MCP4728 EEPROM',
      ...baseLines(90), ...vthSweep(50, 4), ...threshLines(),
      '### CALIBRATE: ch A / ch C written to the MCP4728 EEPROM.',
      cfgLine, threshLine,
    ], 110, true);
  } else if (cmd === 'GET_DAC' || cmd === 'SAVE_DAC') {
    say('DAC:VTH=' + f1(d.vth) + ',OFS=' + f1(d.ofs) + ',EE_VTH=' + f1(d.vth) + ',EE_OFS=' + f1(d.ofs) + ',PRESENT=1');
  } else if (cmd === 'GET_HV') {
    say(hvLine());
  } else if (cmd.startsWith('SET_HV_CAL:')) {
    const v = parseFloat(cmd.slice(11));
    if (Number.isFinite(v) && v >= 20 && v <= 40) d.hvK = v * 1000 / (d.hvTrue / 11.0 * 1000);
    say(hvLine());
  } else if ((m = cmd.match(/^NOISE(?::(\d+))?$/))) {
    const ms = m[1] != null ? clampI(parseInt(m[1]), 100, 60000) : 1000;
    say('### NOISE: collecting A0 for ' + ms + ' ms (counting continues)...');
    setTimeout(() => {
      if (!demo.on) return;
      const b = a0At(d.ofs), sd = DEMO_V21_NOISE_LSB * 0.905;
      const n = Math.round(ms * 83.333);
      const zero = Math.round(n * Math.max(0, 0.5 * (1 - Math.tanh(b / sd / 1.2))) * 0.2);
      processLine('NOISE:n=' + n + ' mean=' + (b + 4).toFixed(2) + ' rms=' + sd.toFixed(2) + ' p2=' + Math.max(0, Math.round(b - 2 * sd)) +
                  ' p50=' + Math.round(b) + ' p98=' + Math.round(b + 2.4 * sd) + ' min=' + Math.max(0, Math.round(b - 4 * sd)) +
                  ' max=' + Math.round(b + 9 * sd) + ' zero=' + zero + ' raw_p50=' + Math.round(b * 1.105) + ' trim=' + (b - 0.5).toFixed(2));
    }, ms + 30);
  } else if (cmd === 'GET_STAT') {
    const live = (performance.now() - demo.startMs) / 1000 - demo.deadtimeUs / 1e6;
    say('STAT:count=' + demo.count + ' trig=' + demo.count + ' rejected=0 merged=0 lost=0 discarded=0 overflow=0 restarts=0 edges=' + demo.count +
        ' storms=0 txdrop=0 bledrop=0 live_s=' + live.toFixed(1) + ' dead_s=' + (demo.deadtimeUs / 1e6).toFixed(3));
  } else if (cmd === 'GET_CFG') {
    say(cfgLine());
  } else if (cmd === 'GET_VER') {
    say('VER:FW=2.1.0 BOARD=v2.1 FMT=3');
  } else if (cmd === 'GET_COIN_WIN') {
    say('COIN_WIN:' + d.coinWin);
  } else if (cmd.startsWith('SET_COIN_WIN:')) {
    const n = parseInt(cmd.slice(13));
    if (!isNaN(n)) d.coinWin = clampI(n, 1, 10000);
    say('COIN_WIN:' + d.coinWin);
  } else if (cmd === 'GET_EXT_ANA') {
    say('EXT_ANA:' + d.extAna);
  } else if (cmd.startsWith('SET_EXT_ANA:')) {
    const n = parseInt(cmd.slice(12));
    if (!isNaN(n)) d.extAna = clampI(n, 0, 3);
    say('EXT_ANA:' + d.extAna);
  } else if (/^(SET|GET)_(SCOPE_TRIG|SCOPE_REARM|GPS)\b/.test(cmd)) {
    say('### Unknown command: ' + cmd + ' (HELP for the list)');
  } else if (cmd.startsWith('SET_SCOPE:')) {
    const on = cmd.slice(10).toUpperCase() === 'ON';
    const s = demo.scope;
    if (on === s.on) return true;
    s.on = on;
    if (on) {
      s.enterMs = performance.now();
      s.emitted = 0;
      s.lastWfMs = 0;
      say('### SCOPE: ON - counting continues (v2.1: the DMA keeps running).');
      say('###        A0 is the shaped pulse (tau 47 us, peak ~46 us after the trigger).', 32);
      say('SCOPE:ON', 34);
    } else {
      say('### SCOPE: OFF');
      say('SCOPE:OFF', 32);
    }
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

// デモの v2 基板が名乗る版。ファーム（FW_VERSION / FW_BUILD）と同じ値にしておく。
const DEMO_FW = { fw: '2.0.0', build: '2026-11-20b' };

// デモの microSD の中身（SD_LIST / SD_READ 用）。LOG0001 は前の測定の合成ログ、LOG0002 は今の測定で
// このページが受け取ったイベントをファームの書式で並べたもの。一覧を読んだ時点の中身で固定する。
function demoSdFiles() {
  const head = [
    '### Accel Kitchen', '### Firmware: FW=' + DEMO_FW.fw + ' BOARD=v2 BUILD=' + DEMO_FW.build,
    '### DEMO BOARD - synthetic data, no hardware attached',
    '### Event Time[us] ADC[0-4095] Deadtime[us] Temp[C] Hum[%] Press[hPa] Dig1 Dig2 Dig3 Ana1 Ana2 Ana3 PPS_UTC[s] PPS_dt[us] PPS_period[us] Lat[deg] Lon[deg]',
  ];
  const old = head.slice();
  let tUs = 0, dead = 0, seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) + 0.5) / 4294967296;
  for (let n = 1; n <= 1500; n++) {
    tUs += Math.round(-Math.log(rnd()) * 300000);
    dead += 100;
    old.push(`${n} ${tUs} ${Math.round(150 + -Math.log(rnd()) * 400) % 4096} ${dead} 23.9 46.0 1012.8 0 0 0 0 0 0 0 -1 0 nan nan`);
  }
  const cur = head.slice();
  for (const g of state.gpsLog) if (/TIME|MARK/.test(g.line)) cur.push(g.line);
  for (const e of state.events) {
    if (!e.demo) continue;
    const f = v => (isNaN(v) ? 'nan' : v.toFixed(1));
    cur.push(`${e.count} ${e.timestamp_us} ${e.adc} ${e.deadtime_us} ${f(e.temp_c)} ${f(e.hum_pct)} ${f(e.press_hpa)} ${e.d1} ${e.d2} ${e.d3} ${e.a1} ${e.a2} ${e.a3} 0 -1 0 nan nan`);
  }
  const enc = new TextEncoder();
  demo.sdFiles = { 'LOG0001.TXT': enc.encode(old.join('\r\n') + '\r\n'), 'LOG0002.TXT': enc.encode(cur.join('\r\n') + '\r\n') };
}

// ファームの printTime と同じ応答。GPS が ON のデモは GPS の時刻を優先する。
function demoSayTime(say) {
  if (demo.dev.gps) say('TIME:' + Math.floor(Date.now() / 1000) + ' SRC:GPS');
  else if (demo.pcTime) say('TIME:' + Math.floor((demo.pcTime.utcMs + performance.now() - demo.pcTime.perfMs) / 1000) + ' SRC:PC');
  else say('TIME:0 SRC:NONE');
}

// ファームの logPcTime と同じ "### TIME <t_us> <utc_epoch_s> src=PC"。次の秒の境目の瞬間を、デモの Time[us] で表す。
function demoLogPcTime(say, ms) {
  if (!demo.pcTime || demo.dev.gps) return;
  const now = performance.now();
  const utcMsNow = demo.pcTime.utcMs + (now - demo.pcTime.perfMs);
  const nextSec = Math.floor(utcMsNow / 1000) + 1;
  const atMs = now + (nextSec * 1000 - utcMsNow);
  say('### TIME ' + Math.round((atMs - demo.startMs) * 1000) + ' ' + nextSec + ' src=PC', ms);
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
    processLine(modelProfile.id === 'okome'
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
  if (modelProfile.id === 'okome') {
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
  if (modelProfile.id === 'v21') {
    // 2 回目以降の起動（較正済みの基板）と同じ並び。実機の起動ログに合わせた。
    const b = Math.max(0, 170.5 - d.slope * (2047.5 - d.ofs));
    const cfg = '#CFG FW=2.1.0 BOARD=v2.1 FMT=3 MODE=' + d.mode + ' VTH_mV=' + d.vth.toFixed(1) + ' OFS_mV=' + d.ofs.toFixed(1) +
      ' BASE_mV=' + b.toFixed(1) + ' TP2_mV=' + d.tp2.toFixed(1) + ' GAIN=' + (d.slope / 0.0015).toFixed(1) + ' HV_V=' + (d.hvTrue * d.hvK / 11).toFixed(2) +
      ' TAU_us=47 THRESH=' + d.threshold + ' EXT=' + (d.ext ? 1 : 0) + ' EXT_ANA=' + d.extAna + ' COIN_WIN_us=' + d.coinWin + ' DAC=1';
    [
      'Booting v2.1...',
      '### MCP4728: found. EEPROM ch A ' + d.vth.toFixed(1) + ' mV, ch C ' + d.ofs.toFixed(1) + ' mV',
      "BLE: Advertising as '" + d.bleName + "'",
      d.sd ? 'SD: init OK at 4000000 Hz' : 'SD: disabled (SD:OFF)',
      'BME280: OK',
      '### HV: ' + (d.hvTrue * d.hvK / 11).toFixed(2) + ' V (HV_MON ' + (d.hvTrue / 11 * 1000).toFixed(1) + ' mV x ' + d.hvK.toFixed(3) + ')',
      'BASE:' + b.toFixed(1) + ' RAW:' + (b * 1.105).toFixed(1) + ' SLOPE:' + d.slope.toFixed(5) + ' GAIN:' + (d.slope / 0.0015).toFixed(1) + ' OFS:' + d.ofs.toFixed(1),
      '##########################################################################################',
      '### Accel Kitchen',
      '### https://accel-kitchen.com/',
      '### info@accel-kitchen.com',
      '### FMT:3 FW:2.1.0 BOARD:v2.1',
      '### DEMO BOARD - synthetic data, no hardware attached',
      '### Signal threshold: ' + d.threshold + ' (VTH ' + d.vth.toFixed(1) + ' mV)',
      cfg,
      'MODE:' + d.mode, d.sd ? 'SD:ON' : 'SD:OFF', d.ext ? 'EXT:ON' : 'EXT:OFF', d.oled ? 'OLED:ON' : 'OLED:OFF', d.vib ? 'VIB:ON' : 'VIB:OFF',
      '### Event Time[us] ADC Deadtime[us] Temp[C] Hum[%] Press[hPa] Dig1 Dig2 Dig3 Ana1 Ana2 Ana3 Base[ADC] Peak[mV] PeakT[us] Flags Dt1[us] Dt2[us] Dt3[us]',
      '##########################################################################################',
    ].forEach((l, i) => setTimeout(() => { if (demo.on) processLine(l); }, 60 + i * 30));
    return;
  }
  const lines = [
    'Booting v2...',
    '### Accel Kitchen',
    '### https://accel-kitchen.com/',
    '### info@accel-kitchen.com',
    '### Firmware: FW=' + DEMO_FW.fw + ' BOARD=v2 BUILD=' + DEMO_FW.build,
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
  state.conn = newConnState();
  state.conn.bleName = demo.dev.bleName;
  demo.pcTime = null;   // 新しい仮想基板は PC の時刻を知らない（実機も再起動で消える）

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
  measTimer.base = null;   // 予約中なら、消去のあとの最初のイベントから数え直す
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
