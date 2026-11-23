'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createBleChooser } = require('../lib/blechooser');

// 時計とタイマーを手で進める
function fakeClock() {
  let t = 0;
  let timers = [];
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const h = { at: t + ms, fn }; timers.push(h); return h; },
    clearTimeout: (h) => { timers = timers.filter(x => x !== h); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
        await new Promise(r => setImmediate(r));
      }
      t = end;
      await new Promise(r => setImmediate(r));
    },
  };
}

function setup(extra) {
  const clock = fakeClock();
  const calls = { choose: [], notFound: 0, picked: [] };
  let answer = null;
  const deps = Object.assign({
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    isAuto: () => false,
    pickAuto: () => null,
    choose: async (devices) => { calls.choose.push(devices.map(d => d.deviceId)); return answer ? answer(devices) : null; },
    notFound: async () => { calls.notFound++; },
    onPicked: (d) => calls.picked.push(d.deviceId),
  }, extra || {});
  const c = createBleChooser(deps);
  return { c, clock, calls, setAnswer: (f) => { answer = f; } };
}

// 毎回ちがう callback（Electron がそうすることがある）
function cbRecorder() {
  const got = [];
  const make = (tag) => (id) => got.push({ tag, id });
  return { got, make };
}

const DEV = { deviceId: 'AA:BB', deviceName: 'CosmicRay' };
const DEV2 = { deviceId: 'CC:DD', deviceName: 'CosmicRay' };

test('the reported bug: empty list first, device later, new callback each time → the pick reaches the request', async () => {
  const { c, clock, calls, setAnswer } = setup();
  const r = cbRecorder();
  setAnswer(devs => devs[0]);
  c.onSelect([], r.make(1));                 // 探し始め（まだ空）
  await clock.advance(6000);                 // 1.0.3 はここで「見つかりません」を出して取り消していた
  assert.strictEqual(calls.notFound, 0);
  assert.deepStrictEqual(r.got, []);
  c.onSelect([DEV], r.make(2));              // 見つかった（別の callback）
  c.onSelect([DEV], r.make(3));
  await clock.advance(3000);                 // 一覧を出して、選ぶ
  assert.deepStrictEqual(calls.choose, [['AA:BB']]);
  assert.deepStrictEqual(r.got, [{ tag: 3, id: 'AA:BB' }]);   // 最新の callback に、1 回だけ
  assert.deepStrictEqual(calls.picked, ['AA:BB']);
});

test('waits for more devices after the first one, and lists them all', async () => {
  const { c, clock, calls, setAnswer } = setup();
  const r = cbRecorder();
  setAnswer(devs => devs[1]);
  c.onSelect([DEV], r.make(1));
  await clock.advance(1000);
  c.onSelect([DEV, DEV2], r.make(2));
  await clock.advance(2000);
  assert.deepStrictEqual(calls.choose, [['AA:BB', 'CC:DD']]);
  assert.deepStrictEqual(r.got, [{ tag: 2, id: 'CC:DD' }]);
});

test('devices that arrive while the list is open still get the answer on the newest callback', async () => {
  const clock = fakeClock();
  let resolveChoice;
  const r = cbRecorder();
  const c = createBleChooser({
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    choose: () => new Promise(res => { resolveChoice = res; }),
    notFound: async () => {},
  });
  c.onSelect([DEV], r.make(1));
  await clock.advance(3000);                 // 一覧が開いた
  c.onSelect([DEV, DEV2], r.make(2));        // 開いている間にも通知が来る
  await clock.advance(30000);                // 長く迷っても、探す時間切れで取り消さない
  assert.deepStrictEqual(r.got, []);
  resolveChoice(DEV);
  await clock.advance(10);
  assert.deepStrictEqual(r.got, [{ tag: 2, id: 'AA:BB' }]);
});

test('nothing found within the scan time → one "not found" and a cancel', async () => {
  const { c, clock, calls } = setup();
  const r = cbRecorder();
  c.onSelect([], r.make(1));
  await clock.advance(19000);
  c.onSelect([], r.make(2));
  await clock.advance(2000);
  assert.strictEqual(calls.notFound, 1);
  assert.deepStrictEqual(r.got, [{ tag: 2, id: '' }]);
});

test('cancel in the list answers with an empty id', async () => {
  const { c, clock } = setup();
  const r = cbRecorder();
  c.onSelect([DEV], r.make(1));
  await clock.advance(3000);
  assert.deepStrictEqual(r.got, [{ tag: 1, id: '' }]);
});

test('trailing events right after an answer are ignored; a later request starts a new round', async () => {
  const { c, clock, calls, setAnswer } = setup();
  const r = cbRecorder();
  setAnswer(devs => devs[0]);
  c.onSelect([DEV], r.make(1));
  await clock.advance(3000);
  assert.strictEqual(r.got.length, 1);
  c.onSelect([DEV], r.make(2));              // 遅れて届いた通知
  await clock.advance(5000);
  assert.strictEqual(r.got.length, 1);
  assert.strictEqual(calls.choose.length, 1);
  c.onSelect([DEV2], r.make(3));             // 次の要求
  await clock.advance(3000);
  assert.deepStrictEqual(r.got[1], { tag: 3, id: 'CC:DD' });
});

test('auto-connect picks only the remembered device, and gives up quietly', async () => {
  const saved = 'CC:DD';
  const { c, clock, calls } = setup({ isAuto: () => true, pickAuto: (ds) => ds.find(d => d.deviceId === saved) || null });
  const r = cbRecorder();
  c.onSelect([DEV], r.make(1));
  await clock.advance(5000);
  assert.deepStrictEqual(r.got, []);
  c.onSelect([DEV, DEV2], r.make(2));
  assert.deepStrictEqual(r.got, [{ tag: 2, id: 'CC:DD' }]);
  assert.strictEqual(calls.choose.length, 0);

  await clock.advance(2000);
  const r2 = cbRecorder();
  c.onSelect([DEV], r2.make(1));
  await clock.advance(16000);
  assert.deepStrictEqual(r2.got, [{ tag: 1, id: '' }]);
  assert.strictEqual(calls.notFound, 0);
});
