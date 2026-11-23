'use strict';
// CosmicRay Console デスクトップ版（Electron）
//
// 中身は arduino/v2/console のページそのもの。アプリ本体がするのは、ブラウザではできない次のことだけ。
//   - ウィンドウを閉じてもトレイに残って記録を続ける（裏でもタイマーを間引かない）
//   - つないでいる間は PC をスリープさせない
//   - 起動したとき・抜き差しのあとに、前回の基板へ自動でつなぐ
//   - 自動保存を、決まったフォルダへ直接書く（起動するたびにフォルダを選び直さない）
//   - ログインしたら起動する（インストールした版だけ）
// 終わるときは必ずコンソールの disconnect() を通す。ESP32-S3 は DTR と RTS が一度に下がると
// ダウンロードモードに入って数えなくなるので、ポートをいきなり閉じてはいけない。

const {
  app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain, protocol, net, shell,
  powerSaveBlocker, powerMonitor, session,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const ports = require('./lib/ports');
const savedir = require('./lib/savedir');
const Settings = require('./lib/settings');
const { createBleChooser } = require('./lib/blechooser');

// ---------- コマンドライン（主に試験用） ----------
function argValue(name) {
  const p = `--${name}=`;
  const a = process.argv.find(x => x.startsWith(p));
  return a ? a.slice(p.length) : null;
}
const hasArg = (name) => process.argv.includes(`--${name}`);
const opt = {
  profile: argValue('profile'),          // 設定・localStorage の置き場所を別にする（試験用）
  saveDir: argValue('save-dir'),         // 保存先をこのフォルダに固定する（試験用。設定には残さない）
  port: argValue('port'),                // 自動接続でこのポート名だけを開く（例 COM62。試験用）
  hidden: hasArg('hidden'),              // ウィンドウを出さずにトレイで始める（ログイン時の起動）
  demo: hasArg('demo'),                  // 起動したらデモにつなぐ（試験用）
  capture: argValue('capture'),          // この PNG に画面を保存する（試験用）
  captureDelay: Number(argValue('capture-delay')) || 8,
  hideAfter: Number(argValue('hide-after')) || 0,   // この秒数のあとウィンドウを隠す（試験用）
  quitAfter: Number(argValue('quit-after')) || 0,   // この秒数のあと、ふつうの手順で終わる（試験用）
  // ここから下は開発中（パッケージしていない）だけ効く
  testJs: argValue('test-js'),           // コンソールが用意できたら、このファイルの JS をページで動かす
  chooserCancel: hasArg('chooser-cancel'),   // 人向けのポート選択画面を出さずに「キャンセル」とする
  chooserFirst: hasArg('chooser-first'),     // Bluetooth の一覧を出さずに、最初に見つかった機器を選ぶ
};
// ポータブル版（electron-builder の portable）は、置いた場所の環境変数を渡してくる。
// 設定と保存はその exe の隣に置き、PC に何も残さない（USB メモリに入れて持ち歩ける）。
const PORTABLE_DIR = process.env.PORTABLE_EXECUTABLE_DIR || null;
if (opt.profile) app.setPath('userData', path.resolve(opt.profile));
else if (PORTABLE_DIR) app.setPath('userData', path.join(PORTABLE_DIR, 'CosmicRayConsole-data'));

const APP_ID = 'com.accel-kitchen.cosmicray-console';
const CONSOLE_ORIGIN = 'app://console';
const CONSOLE_URL = `${CONSOLE_ORIGIN}/index.html`;
const USB_RETRY_MS = 10000;
const BLE_RETRY_MS = 60000;
const QUIT_TIMEOUT_MS = 10000;

// ---------- ログ ----------
function logFile() { return path.join(app.getPath('userData'), 'desktop.log'); }
// 標準出力の先が閉じていても（パイプの相手が先に終わったなど）止まらないように。
for (const s of [process.stdout, process.stderr]) { if (s && s.on) s.on('error', () => {}); }
function log(...parts) {
  const line = `${new Date().toISOString()} ` +
    parts.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  try { console.log(line); } catch (_) {}
  try {
    const f = logFile();
    try { if (fs.statSync(f).size > 2 * 1024 * 1024) fs.renameSync(f, f + '.1'); } catch (_) {}
    fs.appendFileSync(f, line + '\n');
  } catch (_) {}
}

// ---------- 文言 ----------
const STR = {
  ja: {
    show: 'ウィンドウを表示',
    openFolder: '保存先フォルダを開く',
    changeFolder: '保存先を変更…',
    autoConnect: '起動時・抜き差しのあとに自動でつなぐ',
    preventSleep: 'つないでいる間はスリープさせない',
    closeToTray: 'ウィンドウを閉じてもトレイで記録を続ける',
    openAtLogin: 'ログインしたら起動する',
    openAtLoginDev: 'ログインしたら起動する（インストール版のみ。ポータブル版では使えません）',
    quit: '終了（記録を止める）',
    notConnected: '未接続',
    reconnecting: '再接続を待っています',
    recording: '記録中',
    paused: '一時停止中',
    events: '件',
    saveTo: '保存先',
    saveOff: '自動保存なし',
    saveError: '保存エラー',
    trayHintTitle: 'CosmicRay Console は動き続けています',
    trayHint: 'ウィンドウを閉じても、トレイ（通知領域）で記録を続けます。止めるときはトレイのアイコンから「終了」を選んでください。',
    pickPortTitle: 'ポートを選ぶ',
    pickPort: '検出器のポートを選んでください',
    pickPortDetail: '★ は前回つないだ基板です。',
    noPorts: 'シリアルポートが見つかりません',
    noPortsDetail: 'USB ケーブルを差し直してから、もう一度「USB で接続」を押してください。',
    pickBleTitle: 'Bluetooth の機器を選ぶ',
    pickBle: '検出器を選んでください',
    noBle: 'Bluetooth の検出器が見つかりません',
    noBleDetail: '検出器の電源と、PC の Bluetooth がオンになっているかを確かめてください。',
    cancel: 'キャンセル',
    quitConfirm: '記録を止めて終了しますか？',
    quitConfirmDetail: '検出器との接続を切ってから終了します。基板は数え続けます（SD カードがあればそこにも記録されます）。',
    quitYes: '終了する',
  },
  en: {
    show: 'Show window',
    openFolder: 'Open save folder',
    changeFolder: 'Change save folder…',
    autoConnect: 'Connect automatically at start and after replugging',
    preventSleep: 'Keep the PC awake while connected',
    closeToTray: 'Keep recording in the tray when the window is closed',
    openAtLogin: 'Start when I sign in',
    openAtLoginDev: 'Start when I sign in (installed app only, not the portable one)',
    quit: 'Quit (stop recording)',
    notConnected: 'Not connected',
    reconnecting: 'Waiting to reconnect',
    recording: 'Recording',
    paused: 'Paused',
    events: 'events',
    saveTo: 'Saving to',
    saveOff: 'Auto-save off',
    saveError: 'Save error',
    trayHintTitle: 'CosmicRay Console is still running',
    trayHint: 'Recording continues in the system tray. To stop, choose Quit from the tray icon.',
    pickPortTitle: 'Choose a port',
    pickPort: 'Choose the detector port',
    pickPortDetail: '★ marks the board you used last time.',
    noPorts: 'No serial ports found',
    noPortsDetail: 'Replug the USB cable, then press Connect (USB) again.',
    pickBleTitle: 'Choose a Bluetooth device',
    pickBle: 'Choose the detector',
    noBle: 'No Bluetooth detector found',
    noBleDetail: 'Check that the detector is powered and that Bluetooth is on.',
    cancel: 'Cancel',
    quitConfirm: 'Stop recording and quit?',
    quitConfirmDetail: 'The app disconnects from the detector first. The board keeps counting (and keeps logging to its SD card, if any).',
    quitYes: 'Quit',
  },
};
let lang = 'ja';
const T = (k) => (STR[lang] && STR[lang][k]) || STR.ja[k] || k;

// ---------- 状態 ----------
let settings = Settings.DEFAULTS;
let settingsFile = null;
let win = null;
let tray = null;
let quitting = false;
let lastStatus = null;          // desktop.js から届いた最新の状態
let userDisconnected = false;   // 利用者が自分で「切断」を押した（自動では再接続しない）
let autoPick = false;           // アプリが始めた接続の途中（ポートを自動で選ぶ）
let autoBusy = false;
let blockerId = null;
let retryTimer = null;
let consoleReady = false;
let testJsDone = false;        // --test-js は最初のページで 1 回だけ
let trayOk = false;             // トレイのアイコンが出せた（出せなければ、閉じたら隠さずに終わる）
// 選んだ機器は、つながって基板が名乗ってから（GET_VER の答えかイベントが届いてから）覚える。
// 間違えて選んだポート（Bluetooth の COM、別の ESP32）を、以後ずっと開きに行かないように。
let pendingSerial = null;
let pendingBle = null;
let eventsAtConnect = 0;
const grantedDirs = new Set();  // コンソールに渡した保存フォルダ（これ以外には書かない）

function saveSettings() {
  try { Settings.save(settingsFile, settings); } catch (e) { log('settings save failed', e.message); }
}

function consoleRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, 'console') : path.join(__dirname, '..', 'console');
}

function iconPath(name) { return path.join(__dirname, 'build', name); }

function defaultSaveDir() {
  if (opt.saveDir) return path.resolve(opt.saveDir);
  if (settings.saveDir) return settings.saveDir;
  return PORTABLE_DIR ? path.join(PORTABLE_DIR, 'CosmicRay') : path.join(app.getPath('documents'), 'CosmicRay');
}

function dirInfo(p) {
  const full = path.resolve(p);
  fs.mkdirSync(full, { recursive: true });
  grantedDirs.add(full);
  return { path: full, name: path.basename(full) };
}

function checkDir(dir) {
  const full = path.resolve(String(dir));
  if (!grantedDirs.has(full)) throw new Error('save folder was not granted: ' + full);
  return full;
}

// ---------- 単一起動 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (argv.includes('--quit')) { gracefulQuit({ confirm: false }); return; }
    showWindow();
  });
  start();
}

function start() {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  }]);

  app.whenReady().then(() => {
    lang = (app.getLocale() || '').toLowerCase().startsWith('ja') ? 'ja' : 'en';
    settingsFile = path.join(app.getPath('userData'), 'desktop-settings.json');
    settings = Settings.load(settingsFile);
    app.setAppUserModelId(APP_ID);
    log(`start v${app.getVersion()} electron ${process.versions.electron} packaged=${app.isPackaged} portable=${!!PORTABLE_DIR} ${process.platform}`,
        { argv: process.argv.slice(1), userData: app.getPath('userData') });

    if (process.platform === 'darwin') setUpMacMenu();
    serveConsole();
    setUpSession();
    setUpIpc();
    applyLoginItem();
    createTray();
    createWindow();

    powerMonitor.on('suspend', () => {
      log('power: suspend');
      runInConsole('desktopFlush()').catch(() => {});
    });
    powerMonitor.on('resume', () => {
      log('power: resume');
      scheduleAutoConnect(5000, 'resume');
    });

    if (opt.quitAfter > 0) setTimeout(() => gracefulQuit({ confirm: false }), opt.quitAfter * 1000);
  });

  app.on('before-quit', (e) => {
    if (!quitting) { e.preventDefault(); gracefulQuit({ confirm: false }); }
  });
  app.on('window-all-closed', () => { if (quitting) app.quit(); });
  // Mac: Dock のアイコンを押したら、隠していたウィンドウを出す。
  app.on('activate', () => showWindow());
}

// Mac はメニューバーが無いと、コピー・貼り付け（⌘C / ⌘V）も ⌘Q も効かない。
// 再読み込み（⌘R）は入れない（読み込み直すと、つないだまま画面が消える）。
// ⌘Q は before-quit を通るので、ほかの終わり方と同じく disconnect() してから終わる。
function setUpMacMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { label: lang === 'ja' ? '表示' : 'View', submenu: [
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
      { role: 'togglefullscreen' }, { role: 'toggleDevTools' },
    ] },
    { role: 'windowMenu' },
  ]));
}

// ---------- app://console/ でコンソールを配る ----------
function serveConsole() {
  const root = path.resolve(consoleRoot());
  protocol.handle('app', async (req) => {
    const u = new URL(req.url);
    if (u.host !== 'console') return new Response('not found', { status: 404 });
    let rel = decodeURIComponent(u.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.resolve(root, '.' + rel);
    if (file !== root && !file.startsWith(root + path.sep)) return new Response('forbidden', { status: 403 });
    try {
      const st = await fs.promises.stat(file);
      if (!st.isFile()) return new Response('not found', { status: 404 });
    } catch (_) {
      return new Response('not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

// ---------- 権限・ポート選択 ----------
function fromConsole(origin) {
  return typeof origin === 'string' && origin.startsWith(CONSOLE_ORIGIN);
}

function setUpSession() {
  const ses = session.defaultSession;

  ses.setPermissionCheckHandler((_wc, _permission, requestingOrigin) => fromConsole(requestingOrigin));
  ses.setPermissionRequestHandler((wc, _permission, callback, details) => {
    callback(fromConsole((details && details.requestingUrl) || (wc && wc.getURL())));
  });
  ses.setDevicePermissionHandler((details) => fromConsole(details.origin));

  ses.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    const isMain = !!win && webContents === win.webContents;
    log('serial: ports', portList.map(p => ({
      portName: p.portName, displayName: p.displayName, vendorId: p.vendorId,
      productId: p.productId, serialNumber: p.serialNumber,
    })), { auto: autoPick && isMain });

    if (autoPick && isMain) {
      const p = ports.pickAutoPort(portList, { saved: settings.lastSerial, forcePortName: opt.port });
      if (p) {
        log('serial: auto-picked', p.portName);
        pendingSerial = ports.rememberPort(p);
        callback(p.portId);
      } else {
        callback('');
      }
      return;
    }
    chooseSerialPort(portList, webContents).then((p) => {
      if (!p) { callback(''); return; }
      if (isMain) pendingSerial = ports.rememberPort(p);   // 書き込みページで選んだポートは覚えない
      callback(p.portId);
    }).catch((e) => { log('serial: chooser failed', e.message); callback(''); });
  });
}

// つながった機器が検出器だと分かったら、次からの自動接続の相手として覚える。
function commitRemembered(s) {
  const identified = s.identified || (s.events || 0) > eventsAtConnect;
  if (!s.connected || !identified) return;
  if (s.type === 'usb' && pendingSerial) {
    settings.lastSerial = pendingSerial;
    settings.lastTransport = 'usb';
    pendingSerial = null;
    saveSettings();
    log('remembered serial device', settings.lastSerial, { board: s.board || null });
  } else if (s.type === 'ble' && pendingBle) {
    settings.lastBle = pendingBle;
    settings.lastTransport = 'ble';
    pendingBle = null;
    saveSettings();
    log('remembered BLE device', settings.lastBle, { board: s.board || null });
  }
}

async function chooseSerialPort(portList, webContents) {
  const parent = BrowserWindow.fromWebContents(webContents) || win;
  if (opt.chooserCancel && !app.isPackaged) { log('serial: chooser shown (test: cancelled)'); return null; }
  if (!portList.length) {
    await dialog.showMessageBox(parent, { type: 'info', title: T('pickPortTitle'), message: T('noPorts'), detail: T('noPortsDetail') });
    return null;
  }
  const ordered = ports.orderForChooser(portList, settings.lastSerial);
  const buttons = ordered.map(p => ports.choiceLabel(p, settings.lastSerial)).concat(T('cancel'));
  const r = await dialog.showMessageBox(parent, {
    type: 'question', title: T('pickPortTitle'), message: T('pickPort'),
    detail: settings.lastSerial ? T('pickPortDetail') : undefined,
    buttons, cancelId: buttons.length - 1, defaultId: 0, noLink: false,
  });
  return r.response < ordered.length ? ordered[r.response] : null;
}

// Web Bluetooth の機器選び。段取りは lib/blechooser.js（1 回の要求に、いつも最新の callback で 1 回だけ答える）。
function setUpBluetooth(wc) {
  const isMain = () => !!win && !win.isDestroyed() && wc === win.webContents;
  const parent = () => BrowserWindow.fromWebContents(wc) || win;
  const chooser = createBleChooser({
    isAuto: () => autoPick && isMain(),
    pickAuto: (devices) => ports.pickAutoBle(devices, settings.lastBle),
    pickFirst: opt.chooserFirst && !app.isPackaged,
    choose: (devices) => chooseBle(devices, wc),
    notFound: () => dialog.showMessageBox(parent(), { type: 'info', title: T('pickBleTitle'), message: T('noBle'), detail: T('noBleDetail') }),
    onPicked: (d) => { if (isMain()) pendingBle = { deviceId: d.deviceId, deviceName: d.deviceName || null }; },
    log,
  });
  wc.on('select-bluetooth-device', (event, deviceList, callback) => {
    event.preventDefault();
    chooser.onSelect(deviceList, callback);
  });
}

async function chooseBle(devices, wc) {
  const parent = BrowserWindow.fromWebContents(wc) || win;
  if (!devices.length) {
    await dialog.showMessageBox(parent, { type: 'info', title: T('pickBleTitle'), message: T('noBle'), detail: T('noBleDetail') });
    return null;
  }
  const saved = settings.lastBle;
  const ordered = devices.slice().sort((a, b) =>
    (saved && b.deviceId === saved.deviceId ? 1 : 0) - (saved && a.deviceId === saved.deviceId ? 1 : 0));
  const buttons = ordered.map(d => `${d.deviceName || '(no name)'}  ${d.deviceId}` +
    (saved && d.deviceId === saved.deviceId ? ' ★' : '')).concat(T('cancel'));
  const r = await dialog.showMessageBox(parent, {
    type: 'question', title: T('pickBleTitle'), message: T('pickBle'),
    buttons, cancelId: buttons.length - 1, defaultId: 0, noLink: false,
  });
  return r.response < ordered.length ? ordered[r.response] : null;
}

// ---------- コンソールとのやりとり ----------
const CONSOLE_PAGES = ['/', '/index.html', '/v1.html'];
function isConsolePage(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'app:' && u.host === 'console' && CONSOLE_PAGES.includes(u.pathname);
  } catch (_) { return false; }
}
function fromMainConsole(e) {
  return !!win && !win.isDestroyed() && e.sender === win.webContents &&
         e.senderFrame && isConsolePage(e.senderFrame.url);
}

function setUpIpc() {
  const guard = (fn) => async (e, ...args) => {
    if (!fromMainConsole(e)) throw new Error('not allowed');
    return fn(...args);
  };
  ipcMain.handle('desk:saveDir', guard(async () => dirInfo(defaultSaveDir())));
  ipcMain.handle('desk:chooseSaveDir', guard(async () => pickSaveDir()));
  ipcMain.handle('desk:fileSize', guard(async (dir, name) => savedir.fileSize(checkDir(dir), name)));
  ipcMain.handle('desk:appendFile', guard(async (dir, name, text, pos) => {
    const r = await savedir.appendFile(checkDir(dir), name, text, pos);
    if (r.mismatch) log('save: file length changed outside the app', name, { expected: pos, actual: r.before });
    return r.ok;
  }));

  ipcMain.on('desk:status', (e, s) => {
    if (!fromMainConsole(e) || !s || typeof s !== 'object') return;
    const prev = lastStatus;
    lastStatus = s;
    onStatus(prev, s);
  });
  ipcMain.on('desk:userAction', (e, a) => {
    if (!fromMainConsole(e)) return;
    log('user:', a);
    if (a === 'disconnect') userDisconnected = true;
    else if (/^connect-/.test(a)) userDisconnected = false;
  });
  ipcMain.on('desk:ready', (e, pageName) => {
    if (!fromMainConsole(e)) return;
    log('console ready', pageName);
    consoleReady = true;
    if (opt.demo) {
      runInConsole('connectDemo()', true).catch(err => log('demo failed', err.message));
    } else {
      scheduleAutoConnect(1500, 'startup');
    }
    if (opt.testJs && !app.isPackaged && !testJsDone) {
      testJsDone = true;
      const code = fs.readFileSync(path.resolve(opt.testJs), 'utf8');
      runInConsole(code, true).then(r => log('test-js:', r)).catch(err => log('test-js failed', err.message));
    }
  });
}

async function pickSaveDir() {
  const r = await dialog.showOpenDialog(win, {
    title: T('changeFolder'),
    defaultPath: defaultSaveDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
  settings.saveDir = r.filePaths[0];
  saveSettings();
  log('save folder:', settings.saveDir);
  return dirInfo(settings.saveDir);
}

function runInConsole(code, userGesture) {
  if (!win || win.isDestroyed()) return Promise.reject(new Error('no window'));
  return win.webContents.executeJavaScript(code, !!userGesture);
}

function statusText(s) {
  if (!s || (!s.connected && !s.reconnecting)) return T('notConnected');
  if (s.reconnecting && !s.connected) return T('reconnecting');
  const type = s.type ? ` (${String(s.type).toUpperCase()})` : '';
  const n = (s.events || 0).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US');
  return `${s.paused ? T('paused') : T('recording')}${type} · ${n} ${T('events')}`;
}

function saveText(s) {
  const a = s && s.autoSave;
  if (!a || !a.enabled) return T('saveOff');
  if (a.error) return `${T('saveError')}: ${a.error}`;
  return `${T('saveTo')}: ${a.file || '—'}`;
}

function onStatus(prev, s) {
  const wasConn = !!(prev && prev.connected);
  const isConn = !!s.connected;
  if (wasConn !== isConn || (prev && prev.type) !== s.type) {
    log('status:', { connected: isConn, type: s.type, events: s.events, board: s.board, fw: s.fw, autoSave: s.autoSave });
    if (isConn) eventsAtConnect = s.events || 0;
  }
  if (isConn && (pendingSerial || pendingBle)) commitRemembered(s);
  if (!isConn && wasConn) { pendingSerial = null; pendingBle = null; }
  updatePower();
  updateTray();
  // 切れたとき（ケーブルが抜けた、基板が再起動した）。自分で切断したときは何もしない。
  if (wasConn && !isConn && !userDisconnected && prev.type !== 'demo') scheduleAutoConnect(3000, 'lost');
}

// ---------- 自動接続 ----------
function scheduleAutoConnect(delay, reason) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => autoConnect(reason), delay);
}

async function autoConnect(reason) {
  clearTimeout(retryTimer);
  if (quitting || !consoleReady) return;
  const transport = opt.port ? 'usb' : settings.lastTransport;
  const enabled = settings.autoConnect || !!opt.port;
  const s = lastStatus;
  const busy = s && (s.connected || s.reconnecting);
  if (!enabled || !transport || userDisconnected || busy || autoBusy) {
    // つながっていないあいだは見張り続ける（ケーブルが差し直されたら気づけるように）
    if (enabled && transport && !userDisconnected && !quitting) {
      retryTimer = setTimeout(() => autoConnect('retry'), transport === 'ble' ? BLE_RETRY_MS : USB_RETRY_MS);
    }
    return;
  }
  autoBusy = true;
  autoPick = true;
  try {
    // userGesture=true: requestPort / requestDevice は人の操作の中でないと呼べない。
    await runInConsole(`desktopConnect(${JSON.stringify(transport)})`, true);
  } catch (e) {
    log('auto-connect failed', e.message);
  } finally {
    autoPick = false;
    autoBusy = false;
  }
  const now = lastStatus;
  if (!(now && now.connected)) {
    retryTimer = setTimeout(() => autoConnect('retry'), transport === 'ble' ? BLE_RETRY_MS : USB_RETRY_MS);
  } else {
    log('auto-connect ok', { reason, transport });
  }
}

// ---------- スリープ抑止 ----------
function updatePower() {
  const s = lastStatus;
  const want = settings.preventSleep && !!(s && s.connected && s.type !== 'demo');
  if (want && blockerId == null) {
    blockerId = powerSaveBlocker.start('prevent-app-suspension');
    log('power: sleep blocked');
  } else if (!want && blockerId != null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
    log('power: sleep allowed');
  }
}

// ---------- ログイン時の起動 ----------
// ログイン時の起動を使えるか。開発中に設定すると素の electron.exe が、ポータブル版では
// 展開先の一時フォルダの exe がスタートアップに登録されてしまうので、どちらも使わない。
function loginItemAvailable() { return app.isPackaged && !PORTABLE_DIR; }

function applyLoginItem() {
  if (!loginItemAvailable()) return;
  try {
    app.setLoginItemSettings({ openAtLogin: !!settings.openAtLogin, args: ['--hidden'] });
  } catch (e) {
    log('login item failed', e.message);
  }
}

// ---------- ウィンドウ ----------
function createWindow() {
  const startHidden = (opt.hidden && trayOk) ||
    (process.platform === 'darwin' && app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin);

  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    show: false,
    title: 'CosmicRay Console',
    icon: iconPath('icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,   // 隠れていても 1 秒ごとの自動保存・送信を間引かせない
    },
  });
  win.setMenu(null);
  const wc = win.webContents;
  setUpBluetooth(wc);

  win.once('ready-to-show', () => { if (!startHidden) win.show(); });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    if (settings.closeToTray && trayOk) {
      win.hide();
      trayHint();
    } else {
      gracefulQuit({ confirm: true });
    }
  });

  // コンソールの beforeunload（未保存の確認）で閉じられなくならないように。保存は gracefulQuit で済ませる。
  wc.on('will-prevent-unload', (e) => e.preventDefault());
  // 機種を選び直して index.html ⇔ v1.html を行き来したとき。前のページの接続はページと一緒に閉じている
  // （v1 へ移る前に切断を求める作り）ので、状態を忘れて、新しいページの ready を待つ。
  wc.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    consoleReady = false;
    lastStatus = null;
    pendingSerial = null;
    pendingBle = null;
    updatePower();
    updateTray();
  });
  wc.on('console-message', (e) => {
    // 警告とエラーだけをログに残す
    const level = e.level;
    if (level === 'warning' || level === 'error' || level === 2 || level === 3) {
      log(`console[${level}]`, e.message, e.sourceId ? `${e.sourceId}:${e.lineNumber}` : '');
    }
  });
  wc.on('render-process-gone', (_e, details) => {
    log('renderer gone', details);
    if (quitting) return;
    consoleReady = false;
    lastStatus = null;
    updatePower();
    setTimeout(() => { if (!quitting && win && !win.isDestroyed()) win.loadURL(CONSOLE_URL); }, 2000);
  });
  wc.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      wc.toggleDevTools();
      e.preventDefault();
    }
  });
  if (process.platform === 'win32') {
    win.on('session-end', () => {
      // Windows のサインアウト・シャットダウン。待ってはもらえないので、線を安全な順に下げて保存だけ試す。
      log('session-end');
      runInConsole('desktopEmergency()').catch(() => {});
    });
  }

  win.loadURL(CONSOLE_URL);

  if (opt.capture) {
    setTimeout(async () => {
      try {
        const img = await wc.capturePage();
        fs.writeFileSync(path.resolve(opt.capture), img.toPNG());
        log('captured', path.resolve(opt.capture));
      } catch (e) { log('capture failed', e.message); }
    }, opt.captureDelay * 1000);
  }
  if (opt.hideAfter > 0) setTimeout(() => { if (win && !quitting) { win.hide(); log('window hidden (test)'); } }, opt.hideAfter * 1000);
}

app.on('web-contents-created', (_e, contents) => {
  // ページの中のリンク: 同じコンソールのページ（解析・マニュアル・書き込み）はアプリの窓で、外のサイトは既定のブラウザで開く。
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(CONSOLE_ORIGIN + '/')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1200, height: 860, autoHideMenuBar: true, icon: iconPath('icon.png'),
          webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
        },
      };
    }
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (url.startsWith(CONSOLE_ORIGIN + '/')) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  contents.on('did-create-window', (child) => {
    child.setMenu(null);
    setUpBluetooth(child.webContents);
  });
});

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------- トレイ ----------
function trayImage() {
  const img = nativeImage.createFromPath(iconPath('tray.png'));
  if (img.isEmpty()) return img;
  return process.platform === 'darwin' ? img.resize({ width: 18, height: 18 }) : img.resize({ width: 16, height: 16 });
}

function createTray() {
  const img = trayImage();
  if (img.isEmpty()) {
    // アイコンが無いと、トレイに残っても見えず、終わらせる方法が無くなる
    log('tray: icon missing, the window will quit instead of hiding', iconPath('tray.png'));
    return;
  }
  tray = new Tray(img);
  trayOk = true;
  tray.setToolTip('CosmicRay Console');
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  updateTray(true);
}

let lastMenuKey = '';
function updateTray(force) {
  if (!tray || tray.isDestroyed()) return;
  const s = lastStatus;
  const line1 = statusText(s);
  const line2 = saveText(s);
  tray.setToolTip(`CosmicRay Console\n${line1}\n${line2}`.slice(0, 127));
  // メニューは中身が変わったときだけ作り直す（開いている最中に作り直すと閉じてしまう）
  const key = JSON.stringify([s && s.connected, s && s.reconnecting, s && s.type, s && s.paused,
    s && s.autoSave && [s.autoSave.enabled, s.autoSave.file, !!s.autoSave.error], settings, line1.replace(/[\d,]+/g, '')]);
  if (!force && key === lastMenuKey) return;
  lastMenuKey = key;
  const toggle = (k, after) => ({
    type: 'checkbox', checked: !!settings[k],
    click: (item) => { settings[k] = item.checked; saveSettings(); if (after) after(); updateTray(true); },
  });
  const menu = Menu.buildFromTemplate([
    { label: line1, enabled: false },
    { label: line2, enabled: false },
    { type: 'separator' },
    { label: T('show'), click: showWindow },
    { label: T('openFolder'), click: () => shell.openPath(defaultSaveDir()) },
    { label: T('changeFolder'), click: async () => {
        const info = await pickSaveDir();
        if (info) runInConsole(`desktopApplySaveDir(${JSON.stringify(info)})`).catch(e => log('apply folder failed', e.message));
      } },
    { type: 'separator' },
    Object.assign({ label: T('autoConnect') }, toggle('autoConnect', () => { if (settings.autoConnect) scheduleAutoConnect(500, 'enabled'); })),
    Object.assign({ label: T('preventSleep') }, toggle('preventSleep', updatePower)),
    Object.assign({ label: T('closeToTray') }, toggle('closeToTray')),
    Object.assign({ label: loginItemAvailable() ? T('openAtLogin') : T('openAtLoginDev'), enabled: loginItemAvailable() },
                  toggle('openAtLogin', applyLoginItem)),
    { type: 'separator' },
    { label: T('quit'), click: () => gracefulQuit({ confirm: true }) },
  ]);
  tray.setContextMenu(menu);
}

function trayHint() {
  if (settings.trayHintShown || !tray) return;
  settings.trayHintShown = true;
  saveSettings();
  try {
    if (process.platform === 'win32') tray.displayBalloon({ title: T('trayHintTitle'), content: T('trayHint'), iconType: 'info' });
  } catch (_) {}
}

// ---------- 終了 ----------
function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

async function gracefulQuit({ confirm } = {}) {
  if (quitting) return;
  const s = lastStatus;
  if (confirm && s && s.connected && s.type !== 'demo') {
    const parent = win && !win.isDestroyed() && win.isVisible() ? win : undefined;
    const r = await dialog.showMessageBox(parent, {
      type: 'question', title: 'CosmicRay Console', message: T('quitConfirm'), detail: T('quitConfirmDetail'),
      buttons: [T('quitYes'), T('cancel')], defaultId: 0, cancelId: 1, noLink: true,
    });
    if (r.response !== 0) return;
  }
  quitting = true;
  clearTimeout(retryTimer);
  log('quit: disconnecting');
  try {
    // 接続していれば disconnect()（保存 → 線を RTS → DTR の順に下げる → 閉じる）。いなければ保存だけ。
    const r = await withTimeout(runInConsole('desktopQuit()'), QUIT_TIMEOUT_MS);
    log('quit:', r);
  } catch (e) {
    log('quit: disconnect failed', e.message);
  }
  if (blockerId != null) { powerSaveBlocker.stop(blockerId); blockerId = null; }
  if (tray && !tray.isDestroyed()) tray.destroy();
  log('quit: bye');
  app.quit();
}
