'use strict';
// シリアルポートと Bluetooth 機器の選び方。Electron に依存しない純粋な関数なので node --test で試せる。

// Electron の portList の vendorId / productId は文字列で渡ってくる。
// 10 進（"12346"）でも 16 進（"303a"、"0x303a"）でも同じ数に直す。
function toId(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().toLowerCase();
  if (/^0x[0-9a-f]+$/.test(s)) return parseInt(s, 16);
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  if (/^[0-9a-f]+$/.test(s)) return parseInt(s, 16);
  return null;
}

function hex4(n) {
  return n == null ? '----' : n.toString(16).padStart(4, '0');
}

// 覚えておく形。portId は Chromium がその場で振る番号なので覚えない。
function rememberPort(p) {
  return {
    vendorId: toId(p.vendorId),
    productId: toId(p.productId),
    serialNumber: p.serialNumber || null,
    portName: p.portName || null,
    displayName: p.displayName || null,
  };
}

// Windows の Electron 45 では、ESP32-S3 の内蔵 USB にも serialNumber が付いてこなかった（2026-11-21、COM64）。
// そのときは VID/PID とポート名で照合する。Windows は同じ基板にはふつう同じ COM 番号を振り直す。
function samePort(p, saved) {
  if (!saved) return false;
  const vid = toId(p.vendorId), pid = toId(p.productId);
  if (saved.serialNumber) {
    // シリアル番号があればそれで決める（ESP32-S3 の USB はチップごとに違う番号を持つ）。
    return p.serialNumber === saved.serialNumber && vid === saved.vendorId && pid === saved.productId;
  }
  // シリアル番号の無い機器は、VID/PID とポート名がそろったときだけ同じとみなす。
  return vid != null && vid === saved.vendorId && pid === saved.productId &&
         !!p.portName && p.portName === saved.portName;
}

// アプリ自身が始めた接続（起動時・抜き差し後）で、ポートを自動で選ぶ。
// 選んでよいのは「前回つないだ基板」だけ。forcePortName（試験用の --port=COM62）があればそれだけ。
// 見つからなければ null（＝何も選ばずに取り消す。勝手に別の基板を開かない）。
function pickAutoPort(portList, { saved, forcePortName } = {}) {
  const list = Array.isArray(portList) ? portList : [];
  if (forcePortName) {
    const want = String(forcePortName).toUpperCase();
    return list.find(p => String(p.portName || '').toUpperCase() === want) || null;
  }
  return list.find(p => samePort(p, saved)) || null;
}

// 人が選ぶときの並び。前回の基板を先頭に。
function choiceLabel(p, saved) {
  const vid = toId(p.vendorId), pid = toId(p.productId);
  const name = p.displayName || 'Serial port';
  const ids = vid != null ? ` [${hex4(vid)}:${hex4(pid)}]` : '';
  const mark = samePort(p, saved) ? ' ★' : '';
  return `${p.portName || '?'} — ${name}${ids}${mark}`;
}

// 検出器に使っている USB の VID: Espressif（ESP32-S3 内蔵 USB）、Arduino（Nano ESP32）、Seeed（XIAO nRF52840 = OKOME）。
const KNOWN_VIDS = new Set([0x303a, 0x2341, 0x2886]);

// 前回の基板 → 検出器らしい USB 機器 → そのほか（Bluetooth の COM ポートなど）の順。同じ組の中は元の順のまま。
function orderForChooser(portList, saved) {
  const list = Array.isArray(portList) ? portList.slice() : [];
  const score = p => (samePort(p, saved) ? 2 : 0) + (KNOWN_VIDS.has(toId(p.vendorId)) ? 1 : 0);
  return list.map((p, i) => ({ p, i, s: score(p) }))
             .sort((a, b) => (b.s - a.s) || (a.i - b.i))
             .map(x => x.p);
}

// Bluetooth: 前回の機器 ID と同じものだけを自動で選ぶ。
function pickAutoBle(deviceList, saved) {
  if (!saved || !saved.deviceId) return null;
  return (deviceList || []).find(d => d.deviceId === saved.deviceId) || null;
}

module.exports = { toId, hex4, rememberPort, samePort, pickAutoPort, choiceLabel, orderForChooser, pickAutoBle };
