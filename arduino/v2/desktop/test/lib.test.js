'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ports = require('../lib/ports');
const savedir = require('../lib/savedir');
const Settings = require('../lib/settings');

const V2 = { portId: '1', portName: 'COM62', displayName: 'USB シリアル デバイス', vendorId: '12346', productId: '4097', serialNumber: '11:22:33:44:55:66' };
const OTHER_ESP = { portId: '2', portName: 'COM70', displayName: 'USB シリアル デバイス', vendorId: '12346', productId: '4097', serialNumber: 'AA:BB:CC:DD:EE:FF' };
const BT = { portId: '3', portName: 'COM5', displayName: 'Bluetooth リンク経由の標準シリアル' };

test('toId reads decimal and hex', () => {
  assert.strictEqual(ports.toId('12346'), 0x303a);
  assert.strictEqual(ports.toId('303a'), 0x303a);
  assert.strictEqual(ports.toId('0x303A'), 0x303a);
  assert.strictEqual(ports.toId(0x2886), 0x2886);
  assert.strictEqual(ports.toId(''), null);
  assert.strictEqual(ports.toId(undefined), null);
});

test('auto-pick takes only the remembered board, matched by serial number', () => {
  const saved = ports.rememberPort(V2);
  assert.strictEqual(ports.pickAutoPort([OTHER_ESP, BT, V2], { saved }), V2);
  assert.strictEqual(ports.pickAutoPort([OTHER_ESP, BT], { saved }), null);   // 別の ESP32 は開かない
  assert.strictEqual(ports.pickAutoPort([V2], { saved: null }), null);        // 覚えていなければ選ばない
  // COM 番号が変わっても同じ基板なら選ぶ
  assert.strictEqual(ports.pickAutoPort([Object.assign({}, V2, { portName: 'COM80' })], { saved }).portName, 'COM80');
});

test('auto-pick without a serial number needs the same port name', () => {
  const noSn = { portId: '9', portName: 'COM9', vendorId: '10374', productId: '32837' };
  const saved = ports.rememberPort(noSn);
  assert.strictEqual(ports.pickAutoPort([noSn], { saved }), noSn);
  assert.strictEqual(ports.pickAutoPort([Object.assign({}, noSn, { portName: 'COM10' })], { saved }), null);
});

test('forced port name wins and is case-insensitive', () => {
  assert.strictEqual(ports.pickAutoPort([OTHER_ESP, V2], { forcePortName: 'com62' }), V2);
  assert.strictEqual(ports.pickAutoPort([OTHER_ESP], { forcePortName: 'COM62' }), null);
});

test('chooser puts the remembered board first, then known detector VIDs', () => {
  const saved = ports.rememberPort(V2);
  const order = ports.orderForChooser([BT, OTHER_ESP, V2], saved);
  assert.deepStrictEqual(order.map(p => p.portName), ['COM62', 'COM70', 'COM5']);
  assert.match(ports.choiceLabel(V2, saved), /COM62 .*\[303a:1001\] ★$/);
  assert.doesNotMatch(ports.choiceLabel(OTHER_ESP, saved), /★/);
});

test('BLE auto-pick needs the remembered device id', () => {
  const list = [{ deviceId: 'A', deviceName: 'CosmicRay-1' }, { deviceId: 'B', deviceName: 'CosmicRay-2' }];
  assert.strictEqual(ports.pickAutoBle(list, { deviceId: 'B' }).deviceName, 'CosmicRay-2');
  assert.strictEqual(ports.pickAutoBle(list, null), null);
  assert.strictEqual(ports.pickAutoBle(list, { deviceId: 'C' }), null);
});

test('file names: only plain names inside the folder', () => {
  for (const ok of ['OHASHI_2026-11-21.dat', 'CosmicRay-ABCD_2026-11-21_02.csv', '屋上_2026-11-21.dat', 'report.txt']) {
    assert.ok(savedir.checkName(ok), ok);
  }
  for (const bad of ['../x.dat', '..\\x.dat', 'a/b.dat', 'C:x.dat', '.hidden.dat', 'x.exe', 'con.dat', 'x.dat.', '', 'a'.repeat(300) + '.dat', 'x\u0000.dat']) {
    assert.ok(!savedir.checkName(bad), bad);
  }
});

test('append writes at the end and reports a length mismatch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crdesk-'));
  const sub = path.join(dir, 'new');
  assert.strictEqual(await savedir.fileSize(sub, 'a.dat'), -1);
  let r = await savedir.appendFile(sub, 'a.dat', '# header\n1\n', 0);
  assert.deepStrictEqual(r, { ok: true, mismatch: false, before: 0 });
  r = await savedir.appendFile(sub, 'a.dat', '2\n', 11);
  assert.strictEqual(r.mismatch, false);
  r = await savedir.appendFile(sub, 'a.dat', '3\n', 5);
  assert.strictEqual(r.mismatch, true);
  assert.strictEqual(fs.readFileSync(path.join(sub, 'a.dat'), 'utf8'), '# header\n1\n2\n3\n');
  await assert.rejects(savedir.appendFile(sub, '../evil.dat', 'x', null), /bad file name/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('settings fill in defaults and survive a round trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crdesk-'));
  const f = path.join(dir, 's.json');
  assert.deepStrictEqual(Settings.load(f), Settings.DEFAULTS);
  Settings.save(f, Object.assign({}, Settings.DEFAULTS, { autoConnect: false }));
  assert.strictEqual(Settings.load(f).autoConnect, false);
  assert.strictEqual(Settings.load(f).closeToTray, true);
  fs.writeFileSync(f, '{broken');
  assert.deepStrictEqual(Settings.load(f), Settings.DEFAULTS);
  fs.rmSync(dir, { recursive: true, force: true });
});
