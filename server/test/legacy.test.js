'use strict';
// Importing the OLD server's data (src/legacy.js, scripts/import-legacy.js). The row shapes in the fixtures
// are copied from the real files (inspect-old-data.sh, 2026-11-22); names and positions are made up.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseDatFile, parseLocalDate, parseIsoUtc } = require('../src/legacy');
const stats = require('../src/stats');
const { boot, readAllBytes } = require('./helpers');

const C7 = (ev, date, time, adc, sipm = '29.79', dead = '74841', temp = '26.7') => [ev, date, time, adc, sipm, dead, temp].join('\t');

test('legacy: a Japan-time date becomes the exact UTC time (checked against the epoch column of the real rows)', () => {
  assert.equal(parseLocalDate('2026-06-16-08-32-52.951000').iso, '2026-06-15T23:32:52.951000Z');
  assert.equal(parseLocalDate('2025-10-16-15-34-13.970000').iso, '2025-10-16T06:34:14.067000Z'.replace('14.067', '13.970'));
  assert.equal(parseLocalDate('2025-08-15-20-47-31.650').iso, '2025-08-15T11:47:31.650000Z');   // 3 fraction digits (JavaScript writer)
  assert.equal(parseLocalDate('2025-08-15-20-47-31.909745').us % 1000000, 909745, 'microseconds survive');
  assert.equal(parseLocalDate('2026-01-01-00-30-00.000000').iso, '2025-12-31T15:30:00.000000Z', 'across midnight and the new year');
  for (const bad of ['NaN-NaN-NaN-NaN-NaN-NaN.000NaN', '2025-02-31-00-00-00.000', '2026-06-16-25-00-00.000', '2026-06-16-08-60-00.000', '', 'hello', '2000-01-01-00-00-00.000']) {
    assert.equal(parseLocalDate(bad), null, bad);
  }
});

test('legacy: the three row shapes become records, and a row that cannot be read is counted, not guessed', () => {
  const text = [
    C7('12596', '2026-06-16-08-32-52.951000', '1781566373076000', '174'),            // C7
    C7('12597', '2026-06-16-08-32-52.997000', '1781566373120000', '89', '21.05', '74847', 'NaN'),
    '1\t2026-06-16-10-00-00.909745\t231\t483',                                        // A (integer third column)
    '2\t2026-06-16-10-00-02.191648\t1651\t48',
    '\n',
    'only\ttwo',                                                                      // 2 fields
    C7('x', '2026-06-16-08-32-52.951000', '1781566373076000', '174'),                 // event is not a number
    C7('5', 'NaN-NaN-NaN-NaN-NaN-NaN.000NaN', '1781566373076000', '174'),             // no usable time
    C7('6', '2026-06-16-08-32-53.000000', '1781566373100000', '70000'),               // adc out of range
  ].join('\n');
  const r = parseDatFile(text, '2026-06-16.dat');
  assert.deepEqual(r.layouts, { C7: 2, C7b: 0, A: 2, B: 0 });
  assert.deepEqual(r.skipped, { '2_fields': 1, bad_number: 1, bad_time: 1, bad_adc: 1 });
  const [a, b, c, d] = r.records;
  assert.equal(a.t, '2026-06-15T23:32:52.951000Z');
  assert.equal(a.time_us, 1781566373076000, 'the TIME column is kept as time_us');
  assert.equal(a.vol_mv, 29.79); assert.equal(a.deadtime_ms, 74841); assert.equal(a.temp_c, 26.7);
  assert.equal(b.temp_c, null, '"NaN" is no temperature');
  assert.equal(c.adc, 483, 'layout A: the last column is the ADC value (an estimate)');
  assert.equal(c.vol_mv, null); assert.equal(c.deadtime_ms, null); assert.equal(c.temp_c, null);
  assert.equal(c.lx, '231', 'the column that is not understood is kept');
  assert.equal(c.time_us, parseLocalDate('2026-06-16-10-00-00.909745').us, 'layout A: time_us follows the date');
  assert.match(c.lg, /^A:2026-06-16:\d+$/);
  assert.notEqual(a.run_id, c.run_id, 'a change of layout starts a new run');
  assert.equal(c.run_id, d.run_id);
});

test('legacy: layout B (adc first, a decimal third column) is told from A, and gets event numbers 1, 2, 3', () => {
  const text = ['545\t2025-08-15-20-47-31.650\t26.69\t35', '485\t2025-08-15-20-47-32.646\t23.41\t69', '371\t2025-08-15-20-47-33.641\t22.24\t64'].join('\n');
  const r = parseDatFile(text, '2025-08-15.dat');
  assert.deepEqual(r.layouts, { C7: 0, C7b: 0, A: 0, B: 3 });
  assert.deepEqual(r.records.map((x) => [x.event, x.adc, x.vol_mv, x.deadtime_ms]), [[1, 545, 26.69, 35], [2, 485, 23.41, 69], [3, 371, 22.24, 64]]);
  assert.ok(r.records.every((x) => /^B:/.test(x.lg)));
});

test('legacy: the earlier 7-column writer (day, then the full time) and the ISO-UTC rows are read too (both found on the real files)', () => {
  // waseda, 2025-08-26: "1 <TAB> 2025-08-26 <TAB> 2025-08-26-22-39-23.402000 <TAB> 89 <TAB> 21.05 <TAB> 374 <TAB> 26.05"
  const c7b = ['1\t2025-08-26\t2025-08-26-22-39-23.402000\t89\t21.05\t374\t26.05', '2\t2025-08-26\t2025-08-26-22-39-24.402000\t90\t21.5\t380\t26.1'].join('\n');
  const r = parseDatFile(c7b, '2025-08-26.dat');
  assert.deepEqual(r.layouts, { C7: 0, C7b: 2, A: 0, B: 0 });
  assert.deepEqual(r.skipped, {});
  assert.equal(r.records[0].t, '2025-08-26T13:39:23.402000Z', 'Japan time, like C7');
  assert.deepEqual([r.records[0].event, r.records[0].adc, r.records[0].vol_mv, r.records[0].deadtime_ms, r.records[0].temp_c], [1, 89, 21.05, 374, 26.05]);
  assert.equal(r.records[0].time_us, parseLocalDate('2025-08-26-22-39-23.402000').us, 'no device time: time_us follows the date');
  assert.match(r.records[0].lg, /^C7b:2025-08-26:1$/);

  // test, 2025-08-15, file "2025-08-15T07:15:08.853Z.dat": "458 <TAB> 2025-08-15T07:15:08.853Z <TAB> 20.59 <TAB> 41"
  const iso = ['458\t2025-08-15T07:15:08.853Z\t20.59\t41', '460\t2025-08-15T07:15:09.900Z\t21.00\t42'].join('\n');
  const q = parseDatFile(iso, '2025-08-15T07:15:08.853Z.dat');
  assert.deepEqual(q.layouts, { C7: 0, C7b: 0, A: 0, B: 2 });
  assert.equal(q.records[0].t, '2025-08-15T07:15:08.853000Z', 'already UTC: no 9-hour shift');
  assert.equal(q.records[0].adc, 458); assert.equal(q.records[0].vol_mv, 20.59);
  assert.equal(q.records[0].run_id, 'legacy-2025-08-15-1', 'the day in the file name is still found');
  assert.equal(parseIsoUtc('2025-02-31T00:00:00Z'), null);
  assert.equal(parseIsoUtc('2025-08-15T07:15:08Z').iso, '2025-08-15T07:15:08.000000Z');
});

test('legacy: a restarted board (the event counter goes back) starts a new run, so the hourly counts are not mixed', () => {
  const text = [
    C7('12968', '2026-06-16-08-36-12.018000', '1781566572142000', '63'),
    C7('12969', '2026-06-16-08-36-12.118000', '1781566572242000', '64'),
    C7('658', '2026-06-16-09-00-05.158000', '1781568006116000', '551'),
    C7('659', '2026-06-16-09-00-05.258000', '1781568006216000', '552'),
  ].join('\r\n');                                                         // Windows line ends are fine
  const r = parseDatFile(text, '2026-06-16.dat');
  assert.deepEqual(r.records.map((x) => x.run_id), ['legacy-2026-06-16-1', 'legacy-2026-06-16-1', 'legacy-2026-06-16-2', 'legacy-2026-06-16-2']);
});

// ------------------------------------------------------------------ the script

function makeOldServer() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-old-'));
  const data = path.join(root, 'cosmicray-data');
  const put = (st, name, text) => { fs.mkdirSync(path.join(data, st), { recursive: true }); fs.writeFileSync(path.join(data, st, name), text); };
  const conf = (id, lat, lon, comment) => JSON.stringify({ id, comment, gps_latitude: lat, gps_longitude: lon, created_at: '2025-06-21T13:35:00.000Z', server_setup_at: '2025-06-21T13:35:01.000Z' });

  // sendai: C7 rows in the evening of one Japan day (two UTC days), plus older 4-column rows
  put('sendai', 'config.json', conf('sendai', '38.2682', '140.8694', 'SECRET-NOTE-1'));
  const jst = ['2026-05-12-08-50-00', '2026-05-12-08-55-00', '2026-05-12-08-59-00', '2026-05-12-09-05-00', '2026-05-12-09-10-00', '2026-05-12-09-15-00'];   // = UTC 23:50 .. 00:15
  put('sendai', '2026-05-12.dat', jst.map((d, i) => C7(String(i + 1), d + '.000000', String(1778000000000000 + i * 1000000), String(100 + i))).join('\n') + '\n');
  put('sendai', '2025-06-21.dat', ['1\t2025-06-21-22-35-21.909745\t231\t483', '2\t2025-06-21-22-35-23.191648\t1651\t48'].join('\n') + '\n');
  // test: layout B rows, and a file whose name and rows were spoiled by the old writer
  put('test', 'config.json', conf('test', '35.0', '139.0', 'SECRET-NOTE-2'));
  put('test', '2025-08-15.dat', ['545\t2025-08-15-20-47-31.650\t26.69\t35', '485\t2025-08-15-20-47-32.646\t23.41\t69'].join('\n') + '\n');
  put('test', 'NaN-NaN-NaN.dat', '449\tNaN-NaN-NaN-NaN-NaN-NaN.000NaN\t20.4\t36\n');
  // waseda: will collide with a live account in one of the tests
  put('waseda', 'config.json', conf('waseda', '35.7', '139.7', 'x'));
  put('waseda', '2026-03-07.dat', C7('1', '2026-03-07-00-46-57.545000', '1772812017652000', '575') + '\n');
  fs.mkdirSync(path.join(data, 'Bad Dir'), { recursive: true });
  fs.writeFileSync(path.join(data, 'users.json.note'), 'a stray file next to the stations');
  return root;
}

const runScript = (t, args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'import-legacy.js'), ...args], {
  env: { ...process.env, JWT_SECRET: t.cfg.jwtSecret, DATA_DIR: t.dir, SCRYPT_N: '1024' }, encoding: 'utf8' });

test('import script: a dry run reads and reports, writes nothing, and prints no position or note', async () => {
  const t = await boot(); const old = makeOldServer();
  try {
    const r = runScript(t, ['--from', old, '--station', 'sendai', '--station', 'test']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /DRY RUN/);
    assert.match(r.stdout, /sendai[\s\S]*C7 6, C7b 0, A 2, B 0/);
    assert.match(r.stdout, /test[\s\S]*C7 0, C7b 0, A 0, B 2/);
    assert.match(r.stdout, /bad_time=1/, 'the spoiled row is reported');
    assert.ok(!fs.existsSync(path.join(t.dir, 'events', 'sendai')), 'no files in a dry run');
    assert.equal(t.inst.db.prepare('SELECT COUNT(*) n FROM users').get().n, 0, 'no account in a dry run');
    for (const secret of ['SECRET-NOTE', '38.2682', '140.8694']) assert.ok(!(r.stdout + r.stderr).includes(secret), `${secret} is not printed`);
  } finally { await t.close(); fs.rmSync(old, { recursive: true, force: true }); }
});

test('import script: the real import reserves the id, keeps the rounded position, builds the statistics, and can be repeated', async () => {
  const t = await boot(); const old = makeOldServer();
  try {
    const r = runScript(t, ['--from', old, '--station', 'sendai', '--station', 'test', '--commit']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /OK, matches the parsed count/);

    // the account is only a reservation
    const u = t.inst.db.prepare("SELECT * FROM users WHERE id='sendai'").get();
    assert.equal(u.status, 'legacy_unclaimed'); assert.equal(u.created_via, 'legacy'); assert.equal(u.email, null);
    const login = await t.call('POST', '/auth/login', { body: { id: 'sendai', password: '!legacy-reserved' } });
    assert.equal(login.status, 401, 'the placeholder is not a password anyone can use');
    assert.equal((await t.call('POST', '/auth/login', { body: { id: 'sendai', password: 'anything-at-all-1' } })).status, 401);

    // only the rounded position; the note is private; not on the map
    const s = t.inst.db.prepare("SELECT * FROM stations WHERE id='sendai'").get();
    assert.equal(s.lat_grid, 38.25); assert.equal(s.lon_grid, 140.85);
    assert.equal(s.private_comment, 'SECRET-NOTE-1');
    assert.equal(s.listed, 0);
    assert.equal(s.event_count, 8);
    assert.ok(!readAllBytes(path.join(t.dir, 'events')).includes('38.2682'), 'the exact position is not in the event files');
    assert.equal((await t.call('GET', '/public/stations')).json.stations.length, 0);

    // files: by UTC day, header first, rows understood by the statistics
    const dir = path.join(t.dir, 'events', 'sendai');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['2025-06-21.legacy.jsonl', '2026-05-11.legacy.jsonl', '2026-05-12.legacy.jsonl'], 'one Japan day is split into two UTC days');
    const first = fs.readFileSync(path.join(dir, '2025-06-21.legacy.jsonl'), 'utf8').split('\n');
    const header = JSON.parse(first[0]);
    assert.equal(header.kind, 'header'); assert.equal(header.stream, 'legacy'); assert.equal(header.tz_offset_min, 540);
    assert.equal(JSON.parse(first[1]).t, '2025-06-21T13:35:21.909745Z');
    const series = stats.hourlySeries(t.inst.db, 'sendai', '2000-01-01T00');
    assert.equal(series.reduce((a, x) => a + x.count, 0), 8, 'every event is counted once (6 + 2)');
    assert.ok(t.inst.db.prepare("SELECT value FROM meta WHERE key='legacy_import:sendai'").get().value.includes('"rows":8'));
    // the spoiled file of "test" gave no rows, but the good one did
    assert.equal(t.inst.db.prepare("SELECT event_count FROM stations WHERE id='test'").get().event_count, 2);

    // again: same result, nothing doubled
    const before = readAllBytes(path.join(t.dir, 'events', 'sendai')).length;
    const again = runScript(t, ['--from', old, '--station', 'sendai', '--commit']);
    assert.equal(again.status, 0, again.stderr + again.stdout);
    assert.equal(readAllBytes(path.join(t.dir, 'events', 'sendai')).length, before, 'the files are written afresh, not appended to');
    assert.equal(t.inst.db.prepare("SELECT event_count FROM stations WHERE id='sendai'").get().event_count, 8);
    assert.equal(t.inst.db.prepare("SELECT COUNT(*) n FROM users WHERE id='sendai'").get().n, 1);
    // a "rebuild" from the files gives the same statistics as the import did
    const hourly = JSON.stringify(stats.hourlySeries(t.inst.db, 'sendai', '2000-01-01T00'));
    stats.rebuild(t.inst.db, t.dir, 'sendai');
    assert.equal(JSON.stringify(stats.hourlySeries(t.inst.db, 'sendai', '2000-01-01T00')), hourly);
  } finally { await t.close(); fs.rmSync(old, { recursive: true, force: true }); }
});

test('import script: a station id that a live account already uses is left alone', async () => {
  const t = await boot(); const old = makeOldServer();
  try {
    await t.seed('waseda', 'active');
    const dry = runScript(t, ['--from', old, '--station', 'waseda']);           // a dry run says so, and still reports the old data
    assert.match(dry.stdout, /waseda: WOULD BE SKIPPED on a real import: a live account \(active\)/);
    assert.match(dry.stdout, /usable 1 {2}\(C7 1,/);
    const r = runScript(t, ['--from', old, '--station', 'waseda', '--commit']);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /SKIPPED, a live account \(active\)/);
    assert.ok(!fs.existsSync(path.join(t.dir, 'events', 'waseda')));
    assert.equal(t.inst.db.prepare("SELECT status FROM users WHERE id='waseda'").get().status, 'active');
  } finally { await t.close(); fs.rmSync(old, { recursive: true, force: true }); }
});

test('import script: a directory that is not a station id is skipped, and the old users.json is never needed', async () => {
  const t = await boot(); const old = makeOldServer();
  try {
    assert.ok(!fs.existsSync(path.join(old, 'users.json')), 'the fixture has no users.json: the script must not need it');
    const r = runScript(t, ['--from', old]);
    assert.notEqual(r.status, 0, 'a skipped directory makes the exit status non-zero');
    assert.match(r.stdout, /Bad Dir: skipped/);
    assert.match(r.stdout, /waseda/);
  } finally { await t.close(); fs.rmSync(old, { recursive: true, force: true }); }
});
