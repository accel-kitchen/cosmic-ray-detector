'use strict';
// アプリの設定（userData/desktop-settings.json）。コンソール自身の設定は今までどおり localStorage にある。
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  autoConnect: true,      // 起動したとき・抜き差しのあとに、前回の基板へ自動でつなぐ
  closeToTray: true,      // ウィンドウを閉じてもトレイで記録を続ける
  preventSleep: true,     // つないでいる間は PC をスリープさせない
  openAtLogin: false,     // ログインしたら起動する（インストールした版だけ）
  saveDir: null,          // 自動保存のフォルダ。null なら 書類/CosmicRay
  lastTransport: null,    // 'usb' | 'ble'
  lastSerial: null,       // ports.rememberPort() の形
  lastBle: null,          // { deviceId, deviceName }
  trayHintShown: false,   // 「トレイで続けています」の案内を出したか
};

function load(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.assign({}, DEFAULTS, raw && typeof raw === 'object' ? raw : {});
  } catch (_) {
    return Object.assign({}, DEFAULTS);
  }
}

function save(file, s) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { DEFAULTS, load, save };
