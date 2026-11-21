// desktop.js — デスクトップ版（arduino/v2/desktop、Electron）とのつなぎ。
//
// ブラウザで開いたときは window.cosmicDesktop が無いので、何もしない。
// デスクトップ版では preload.js が window.cosmicDesktop を出しているので、次のことをする。
//   1. 自動保存の保存先を、アプリが覚えているフォルダにする（起動したらすぐ保存が始まる）。
//      フォルダの読み書きはアプリ本体（Node の fs）が行う。ここではそのための
//      「フォルダの代役」を作るだけで、ページから見ると showDirectoryPicker の結果と同じ形。
//   2. 接続の状態・件数・保存の状態を、数秒ごとにアプリへ知らせる（トレイの表示、スリープ抑止、自動再接続に使う）。
//   3. 利用者が自分で「切断」を押したかどうかを知らせる（押したときは自動で再接続しない）。
//   4. アプリから呼ぶ入口を window.desktop* に出す（接続・保存・終了）。ページごとの違いはここで吸収する。
//
// 2 種類のページで使う。どちらもページのスクリプトのあとに読み込む。
//   index.html（V2・v2.1・OKOME。core.js）… core.js の Hooks.pickSaveFolder / useSaveFolder を使う
//   v1.html（v1・OWAN。ページ内のスクリプト）… 同じ名前の Hooks.pickSaveFolder / useSaveFolder を v1.html に足した

(() => {
  'use strict';
  const D = window.cosmicDesktop;
  if (!D) return;

  // ---------- ページごとの違い ----------
  const isV1 = typeof connectSerial === 'function' && typeof connectUSB !== 'function';

  const page = isV1 ? {
    name: 'v1',
    connect: (transport) => (transport === 'ble' ? connectBLE() : connectSerial()),
    flush: () => flushAutoSave(true),
    linesSafe: () => {},
    transport: () => (state.transport === 'serial' ? 'usb' : (state.transport || null)),
    reconnecting: () => false,
    paused: () => false,
    board: () => state.board || null,
    fw: () => null,
    saveInfo: (as) => ({
      file: as.currentDate ? `${fileBase()}_${as.currentDate}.${$('autoSaveFormat').value === 'csv' ? 'csv' : 'dat'}` : null,
      written: as.lineCount || 0,
    }),
  } : {
    name: 'v2',
    connect: (transport) => (transport === 'ble' ? connectBLE() : connectUSB()),
    flush: () => flushAutoSave({ force: true }),
    linesSafe: () => usbLinesSafe(),
    transport: () => state.connectionType || null,
    reconnecting: () => !!state.reconnecting,
    paused: () => !!state.paused,
    board: () => state.conn.board || null,
    fw: () => state.conn.fw || null,
    saveInfo: (as) => ({
      file: as.lastFile.dat || as.lastFile.csv || null,
      written: (as.written.dat || 0) + (as.written.csv || 0),
    }),
  };

  // ---------- 1. 保存先フォルダの代役 ----------
  function notFound(name) {
    return new DOMException(`${name} not found`, 'NotFoundError');
  }

  function desktopFolder(info) {
    return {
      kind: 'directory',
      name: info.name,
      desktopPath: info.path,
      async getFileHandle(name, opts) {
        const size = await D.fileSize(info.path, name);   // ファイルが無ければ -1
        if (size < 0 && !(opts && opts.create)) throw notFound(name);
        return {
          kind: 'file',
          name,
          async getFile() {
            const s = await D.fileSize(info.path, name);
            return { name, size: Math.max(0, s) };
          },
          // appendToFile は seek(末尾) → write → close の順に呼ぶ。
          // close のときにまとめて追記する（途中で失敗したら abort で捨てる）。
          async createWritable() {
            let chunks = [];
            let pos = null;
            return {
              async seek(p) { pos = p; },
              async write(data) { chunks.push(typeof data === 'string' ? data : String(data)); },
              async close() {
                const text = chunks.join('');
                chunks = [];
                await D.appendFile(info.path, name, text, pos);
              },
              async abort() { chunks = []; },
            };
          },
        };
      },
    };
  }

  Hooks.pickSaveFolder = async () => {
    const info = await D.chooseSaveDir();   // ネイティブのフォルダ選択。取り消したら null
    return info ? desktopFolder(info) : null;
  };

  // ---------- 4. アプリから呼ぶ入口 ----------
  window.desktopApplySaveDir = async (info) => {
    if (info) await useSaveFolder(desktopFolder(info));
    return true;
  };
  window.desktopConnect = (transport) => page.connect(transport);
  window.desktopFlush = async () => { try { await page.flush(); } catch (_) {} return true; };
  // 終わる前に必ず通す。つないでいれば disconnect()（保存してから閉じる）、いなければ保存だけ。
  window.desktopQuit = async () => {
    if (state.isConnected || page.reconnecting()) { await disconnect(); return 'disconnected'; }
    try { await page.flush(); } catch (_) {}
    return 'flushed';
  };
  // Windows のサインアウト・シャットダウン。待ってもらえないので、線を安全な順に下げて保存だけ試す。
  window.desktopEmergency = () => { try { page.linesSafe(); } catch (_) {} page.flush().catch(() => {}); return true; };

  // ---------- 2. 状態の報告 ----------
  function snapshot() {
    const as = state.autoSave;
    const ev = state.events;
    const last = ev.length ? ev[ev.length - 1] : null;
    const board = page.board();
    const fw = page.fw();
    const save = page.saveInfo(as);
    return {
      page: page.name,
      connected: !!state.isConnected,
      type: page.transport(),
      reconnecting: page.reconnecting(),
      paused: page.paused(),
      events: ev.length,
      boardCount: last && Number.isFinite(last.count) ? last.count : null,
      // 基板が名乗ったか（GET_VER の答えや起動行の機種名）。アプリはこれを見てから機器を覚える。
      board,
      fw,
      identified: !!(board || fw),
      autoSave: {
        enabled: !!(as.enabled && as.dirHandle),
        desktop: !!(as.dirHandle && as.dirHandle.desktopPath),
        file: save.file,
        written: save.written,
        error: as.lastError ? String(as.lastError.message || as.lastError) : null,
      },
    };
  }

  function report() {
    try { D.status(snapshot()); } catch (_) {}
  }
  if (typeof Bus !== 'undefined') {
    Bus.on('conn', report);
    Bus.on('autosave', report);
  }
  setInterval(report, 2000);

  // ---------- 3. 利用者の操作 ----------
  // capture で先に拾う（ページのハンドラより前に、どのボタンかだけを知らせる）。
  const ACTIONS = {
    btnDisconnect: 'disconnect',
    btnConnectUSB: 'connect-usb',
    btnQuickUSB: 'connect-usb',
    btnConnectBLE: 'connect-ble',
    btnQuickBLE: 'connect-ble',
    btnConnectDemo: 'connect-demo',
    btnQuickDemo: 'connect-demo',
  };
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('button[id]');
    const action = btn && ACTIONS[btn.id];
    if (action) D.userAction(action);
  }, true);

  // ---------- 起動時 ----------
  (async () => {
    try {
      const info = await D.saveDir();
      if (info && info.path) await useSaveFolder(desktopFolder(info));
    } catch (e) {
      console.error('Desktop save folder could not be set:', e);
    }
    report();
    D.ready(page.name);
  })();
})();
