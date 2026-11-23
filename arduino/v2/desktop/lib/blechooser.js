'use strict';
// Web Bluetooth の機器選び（Electron の select-bluetooth-device に答える段取り）。
// Electron に依存しないので node --test で試せる。main.js がダイアログやログを渡して使う。
//
// Electron は、探している間に select-bluetooth-device を何度も（機器が見つかるたびに）出す。
// そのたびに渡される callback は別の関数のことがあるので、関数で「同じ要求か」を見分けてはいけない
// （1.0.3 まではそうしていたため、最初の 5 秒で「見つかりません」を出して要求を取り消してしまい、
//  そのあとの一覧で選んでも、もう取り消された要求に答えるだけで何も起きなかった）。
// 1 回の requestDevice を 1 つの「回」として扱い、答えるときはいつも最新の callback を使う。

const DEFAULTS = {
  firstWaitMs: 2500,   // 1 台目が見つかってから、ほかの機器も集めるために待つ
  scanMs: 20000,       // これだけ探して何も無ければ「見つかりません」
  autoMs: 15000,       // 自動接続で、前回の機器を待つ長さ
  trailingMs: 1500,    // 答えたあとに遅れて届く通知は、次の要求とみなさない
};

// deps:
//   isAuto()            … いまの要求がアプリの自動接続か
//   pickAuto(devices)   … 自動接続で選ぶ機器（前回の機器）か null
//   pickFirst           … 試験用: 一覧を出さずに最初の機器を選ぶ
//   choose(devices)     … 人に選んでもらう。Promise<device | null>
//   notFound()          … 「見つかりません」を見せる。Promise
//   onPicked(device)    … 選ばれた機器（覚えるかどうかは呼び出し側）
//   log(...)            … ログ
//   now / setTimeout / clearTimeout … 試験で差し替える
function createBleChooser(deps, options) {
  const o = Object.assign({}, DEFAULTS, options || {});
  const now = deps.now || Date.now;
  const setT = deps.setTimeout || setTimeout;
  const clearT = deps.clearTimeout || clearTimeout;
  const log = deps.log || (() => {});
  let round = null;
  let lastDoneAt = -Infinity;

  function finish(r, device) {
    if (r.done) return;
    r.done = true;
    clearT(r.scanTimer);
    clearT(r.showTimer);
    lastDoneAt = now();
    if (round === r) round = null;
    if (device && deps.onPicked) deps.onPicked(device);
    log('ble: answer', device ? `picked ${device.deviceId}` : 'cancelled');
    try { r.callback(device ? device.deviceId : ''); } catch (e) { log('ble: callback failed', e && e.message); }
  }

  async function showChooser(r) {
    if (r.done || r.dialogOpen) return;
    r.dialogOpen = true;
    clearT(r.scanTimer);
    let d = null;
    try { d = await deps.choose(r.devices.slice()); } catch (e) { log('ble: chooser failed', e && e.message); }
    r.dialogOpen = false;
    finish(r, d || null);
  }

  // select-bluetooth-device のたびに呼ぶ
  function onSelect(deviceList, callback) {
    if (!round) {
      if (now() - lastDoneAt < o.trailingMs) return;
      const r = { callback, devices: [], auto: !!(deps.isAuto && deps.isAuto()), done: false, dialogOpen: false, seen: '' };
      round = r;
      log('ble: scanning', { auto: r.auto });
      r.scanTimer = setT(() => {
        if (r.done || r.dialogOpen) return;
        if (r.auto) { finish(r, null); return; }
        if (r.devices.length) { showChooser(r); return; }
        r.dialogOpen = true;
        Promise.resolve(deps.notFound && deps.notFound()).catch(() => {}).then(() => {
          r.dialogOpen = false;
          finish(r, null);
        });
      }, r.auto ? o.autoMs : o.scanMs);
    }
    const r = round;
    r.callback = callback;          // いつも最新のものに答える
    r.devices = Array.isArray(deviceList) ? deviceList : [];
    const seen = r.devices.map(d => `${d.deviceName || '?'}@${d.deviceId}`).join(', ');
    if (seen !== r.seen) { r.seen = seen; log('ble: devices', seen || '(none)'); }

    if (r.auto) {
      const d = deps.pickAuto && deps.pickAuto(r.devices);
      if (d) finish(r, d);
      return;
    }
    if (deps.pickFirst && r.devices.length) { finish(r, r.devices[0]); return; }
    // 1 台目が見つかったら、少し待ってほかの機器も集めてから一覧を出す
    if (r.devices.length && !r.showTimer && !r.dialogOpen) {
      r.showTimer = setT(() => showChooser(r), o.firstWaitMs);
    }
  }

  return { onSelect, get busy() { return !!round; } };
}

module.exports = { createBleChooser, DEFAULTS };
