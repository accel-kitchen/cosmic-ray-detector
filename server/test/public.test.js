'use strict';
// Phase 5: the statistics behind the graphs, and what the public map and the summary reveal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { boot, consoleEvent, NOW } = require('./helpers');
const stats = require('../src/stats');
const { deleteAccount, pruneUnverified } = require('../src/accounts');

const iso = (ms) => new Date(ms).toISOString();
const HOUR0 = Date.parse('2026-11-21T10:00:00.000Z');

// Send events (one per second of device time) for the given event numbers of one run.
async function send(t, tok, station, run, eventNumbers, { start = HOUR0, extra = {} } = {}) {
  for (const n of eventNumbers) {
    const r = await t.call('POST', `/upload-data/${station}`, {
      token: tok,
      body: consoleEvent({ event: n, time: n * 1e6, run_id: run, adc: 100 + n, timestamp_utc: iso(start + n * 1000), ...extra }),
    });
    assert.equal(r.status, 200, `event ${n}`);
  }
}

const dump = (db) => JSON.stringify({
  h: db.prepare('SELECT * FROM stats_hourly ORDER BY station_id, run_id, hour').all(),
  a: db.prepare('SELECT * FROM stats_adc ORDER BY station_id, day, bin').all(),
});

// ---------------------------------------------------------------------------- statistics

test('stats: thinned uploads still give the true event count and rate (the device counter, not the row count)', async () => {
  const t = await boot();
  try {
    await t.seed('sendai');
    const tok = await t.loginToken('sendai');
    // the console sends every 3rd event: 1, 4, 7, 10, 13 (5 rows), one event per device-second
    await send(t, tok, 'sendai', 'run-a', [1, 4, 7, 10, 13]);
    const [h] = stats.hourlySeries(t.inst.db, 'sendai', '2026-11-21T10');
    assert.equal(h.hour, '2026-11-21T10');
    assert.equal(h.count, 13, '13 events happened although only 5 rows arrived');
    assert.equal(Math.round(h.rate_per_min), 60, '1 event per second = 60 per minute');
    assert.equal(t.inst.db.prepare('SELECT rows FROM stats_hourly').get().rows, 5);
  } finally { await t.close(); }
});

test('stats: arrival order does not matter (the console sends 4 requests at once)', async () => {
  const a = await boot(); const b = await boot();
  try {
    for (const [t, order] of [[a, [1, 2, 3, 4, 5, 6]], [b, [4, 2, 6, 1, 5, 3]]]) {
      await t.seed('sendai');
      const tok = await t.loginToken('sendai');
      await send(t, tok, 'sendai', 'run-a', order);
    }
    assert.equal(dump(a.inst.db), dump(b.inst.db));
  } finally { await a.close(); await b.close(); }
});

test('stats: a rebuild from the JSONL files gives exactly what the incremental update gave', async () => {
  const t = await boot();
  try {
    await t.seed('sendai'); await t.seed('osaka');
    const s = await t.loginToken('sendai'); const o = await t.loginToken('osaka');
    await send(t, s, 'sendai', 'run-a', [1, 2, 4, 8, 9, 10]);                       // hour 10
    await send(t, s, 'sendai', 'run-a', [3600 + 1, 3600 + 5], { start: HOUR0 });    // crosses into hour 11
    await send(t, s, 'sendai', 'run-b', [1, 2, 3], { start: HOUR0 + 2 * 3600e3 });  // a second run, hour 12... (before NOW)
    await send(t, s, 'sendai', 'run-a', [20], { extra: { temp: null } });           // no sensor
    await send(t, s, 'sendai', 'run-a', [21], { extra: { temp: 31.5 } });
    await send(t, o, 'osaka', 'run-x', [1, 2, 3], { extra: { adc: 4095 } });        // top ADC bin
    // events from a wrong PC clock: kept on disk, but not in the statistics
    const bad = await t.call('POST', '/upload-data/sendai', { token: s, body: consoleEvent({ event: 99, time: 99e6, run_id: 'run-a', timestamp_utc: '2001-01-01T00:00:00.000Z' }) });
    assert.equal(bad.json.clock_suspect, true);

    const before = dump(t.inst.db);
    assert.equal(JSON.parse(before).h.length, 4, '(sendai, run-a, 10), (sendai, run-a, 11), (sendai, run-b, 12), (osaka, run-x, 10)');
    const n = stats.rebuild(t.inst.db, t.dir);
    assert.equal(dump(t.inst.db), before, 'incremental == rebuild');
    assert.equal(n, 6 + 2 + 3 + 1 + 1 + 3, 'the badclock event is not counted');
    assert.equal(stats.rebuild(t.inst.db, t.dir), n);                 // and it is repeatable
    assert.equal(dump(t.inst.db), before);

    // rebuilding one station leaves the other alone
    stats.rebuild(t.inst.db, t.dir, 'osaka');
    assert.equal(dump(t.inst.db), before);

    // no row for the wrong clock, in any hour
    assert.equal(t.inst.db.prepare("SELECT COUNT(*) n FROM stats_hourly WHERE hour < '2015'").get().n, 0);
    const adc = stats.adcHistogram(t.inst.db, 'osaka', '2026-11-01');
    assert.equal(adc.bins[63], 3, 'ADC 4095 lands in the last bin (4095/64 = 63)');
    assert.equal(adc.bins.reduce((a, b) => a + b, 0), 3);
  } finally { await t.close(); }
});

test('stats: the temperature average ignores events without a sensor', async () => {
  const t = await boot();
  try {
    await t.seed('sendai');
    const tok = await t.loginToken('sendai');
    await send(t, tok, 'sendai', 'r', [1], { extra: { temp: 20 } });
    await send(t, tok, 'sendai', 'r', [2], { extra: { temp: 30 } });
    await send(t, tok, 'sendai', 'r', [3], { extra: { temp: null } });
    assert.equal(stats.hourlySeries(t.inst.db, 'sendai', '2026-11-21T10')[0].temp_c, 25);
  } finally { await t.close(); }
});

test('stats: a rebuild skips a torn last line and unusable lines instead of failing', async () => {
  const t = await boot();
  try {
    await t.seed('sendai');
    const tok = await t.loginToken('sendai');
    await send(t, tok, 'sendai', 'r', [1, 2, 3]);
    const f = path.join(t.dir, 'events', 'sendai', '2026-11-21.jsonl');
    fs.appendFileSync(f, '{"t":"2026-11-21T10:00:04.000Z","event":4,"time_us":4000000,"adc":10,"run_id":"r"\n');   // cut off mid-write
    fs.appendFileSync(f, 'not json at all\n');
    assert.equal(stats.rebuild(t.inst.db, t.dir), 3);
  } finally { await t.close(); }
});

// ---------------------------------------------------------------------------- public map

const SECRETS = ['SECRET-COMMENT', 'SECRET-LABEL', 'secret-mail@example.org', 'scrypt$', 'hunter2-private'];

async function populate(t) {
  const mk = async (id, status = 'active') => { await t.seed(id, status); return id; };
  await mk('shown');            // listed, active, has a position
  await mk('hidden');           // active, NOT listed
  await mk('off-air', 'disabled');
  await mk('nopos');            // listed but no position yet
  await mk('pending', 'pending_email');
  const db = t.inst.db;
  const tok = await t.loginToken('shown');
  const hid = await t.loginToken('hidden');
  const np = await t.loginToken('nopos');
  await t.call('POST', '/setup-id', { token: tok, body: { id: 'shown', comment: 'SECRET-COMMENT-1', gps_latitude: '35.6812', gps_longitude: '139.7671' } });
  await t.call('POST', '/setup-id', { token: hid, body: { id: 'hidden', comment: 'SECRET-COMMENT-2', gps_latitude: '34.7', gps_longitude: '135.5' } });
  await send(t, tok, 'shown', 'r1', [1, 2, 3], { extra: { device_label: 'SECRET-LABEL-1' } });
  await send(t, hid, 'hidden', 'r2', [1, 2], { extra: { device_label: 'SECRET-LABEL-2' } });
  await send(t, np, 'nopos', 'r3', [1], {});
  db.prepare("UPDATE users SET email = 'secret-mail@example.org' WHERE id = 'shown'").run();
  db.prepare("UPDATE users SET password_hash = 'scrypt$hunter2-private$x' WHERE id = 'off-air'").run();
  db.prepare("INSERT OR IGNORE INTO stations (id) VALUES ('off-air')").run();
  db.prepare("INSERT OR IGNORE INTO stations (id) VALUES ('pending')").run();
  db.prepare("UPDATE stations SET listed = 1, lat_grid = 35.65, lon_grid = 139.75, public_description = 'Hello <b>world</b> from a rooftop' WHERE id = 'shown'").run();
  db.prepare("UPDATE stations SET listed = 1, lat_grid = 36.05, lon_grid = 140.05 WHERE id IN ('off-air','pending')").run();   // listed, but the account is not active
  db.prepare("UPDATE stations SET listed = 1 WHERE id = 'nopos'").run();
  return { shown: tok, hidden: hid };
}

test('public map: only active, listed stations with a position appear', async () => {
  const t = await boot();
  try {
    await populate(t);
    const r = await t.call('GET', '/public/stations');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.stations.map((s) => s.id), ['shown']);
    const s = r.json.stations[0];
    assert.deepEqual(Object.keys(s).sort(), ['activity', 'description', 'id', 'lat', 'legacy', 'lon']);
    assert.equal(s.legacy, false);
    assert.equal(s.lat, 35.65);
    assert.equal(s.lon, 139.75);
    assert.equal(s.description, 'Hello <b>world</b> from a rooftop', 'stored as plain text; the page must show it with textContent');
    assert.match(r.headers.get('cache-control'), /public/);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  } finally { await t.close(); }
});

test('public map: a reserved station of the old server can be on the map, marked as such; a hold keeps it off', async () => {
  const t = await boot();
  try {
    await populate(t);
    const db = t.inst.db;
    const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'admin.js'), ...args], {
      encoding: 'utf8', env: { ...process.env, DATA_DIR: t.dir, JWT_SECRET: 'test-secret-' + 'x'.repeat(40) },
    });
    for (const id of ['old-a', 'old-b', 'old-c', 'old-nopos']) {
      await t.seed(id, 'legacy_unclaimed');
      db.prepare('INSERT OR IGNORE INTO stations (id) VALUES (?)').run(id);
    }
    db.prepare("UPDATE stations SET lat_grid = 36.15, lon_grid = 140.25, last_seen_utc = '2025-09-01T00:00:00.000Z' WHERE id IN ('old-a','old-b','old-c')").run();

    assert.deepEqual((await t.call('GET', '/public/stations')).json.stations.map((s) => s.id), ['shown'], 'reserved stations start off the map');
    assert.equal(run('list-on', 'old-nopos').status, 2, 'no position: cannot be listed');

    assert.equal(run('list-off', 'old-c').status, 0);                         // a hold
    const bulk = run('list-on-legacy');
    assert.equal(bulk.status, 0, bulk.stderr);
    assert.match(bulk.stdout, /old-a: now on the public map/);
    assert.equal(bulk.stdout.includes('old-c'), false, 'a held station is left alone');
    assert.equal(bulk.stdout.includes('old-nopos'), false);

    const r = await t.call('GET', '/public/stations');
    assert.deepEqual(r.json.stations.map((s) => s.id), ['old-a', 'old-b', 'shown']);
    const a = r.json.stations.find((s) => s.id === 'old-a');
    assert.equal(a.legacy, true);
    assert.equal(a.activity, 'idle');
    assert.equal(a.description, null);
    assert.equal(r.json.stations.find((s) => s.id === 'shown').legacy, false);

    // the graphs are for logged-in people, as for any station; nobody can log in AS the reserved station
    const other = await t.loginToken('hidden');
    const sum = await t.call('GET', '/stations/old-a/summary', { token: other });
    assert.equal(sum.status, 200);
    assert.equal(sum.json.legacy, true);
    assert.equal((await t.call('GET', '/stations/old-c/summary', { token: other })).status, 404, 'held: not there for others');

    assert.equal(run('list-on-legacy').stdout.trim().startsWith('nothing to list'), true, 'a second run has nothing left to do');
  } finally { await t.close(); }
});

test('public map: nothing private appears in any public or summary response', async () => {
  const t = await boot();
  try {
    const tok = await populate(t);
    const other = await t.loginToken('hidden');
    const bodies = [
      JSON.stringify((await t.call('GET', '/public/stations')).json),
      JSON.stringify((await t.call('GET', '/config.json')).json),
      JSON.stringify((await t.call('GET', '/stations/shown/summary', { token: other })).json),   // another participant
    ];
    for (const body of bodies) {
      for (const secret of SECRETS) assert.equal(body.includes(secret), false, `${secret} leaked in ${body.slice(0, 80)}`);
      assert.equal(/last_seen|event_count|password|email/i.test(body), false, 'no private field names either');
      assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(body.replace(/"hour":"[^"]+"/g, '')), false, 'no exact timestamp outside the hourly buckets');
      assert.equal(body.includes('35.6812') || body.includes('139.7671'), false, 'the exact position never exists');
    }
    // even the owner's own summary has no secrets that are not theirs to see
    const own = JSON.stringify((await t.call('GET', '/stations/shown/summary', { token: tok.shown })).json);
    for (const secret of ['scrypt$', 'hunter2-private', 'SECRET-COMMENT']) assert.equal(own.includes(secret), false);
  } finally { await t.close(); }
});

test('public map: the last-data time is only "today", "week" or "idle"', async () => {
  const t = await boot();
  try {
    await populate(t);
    const act = async () => (await t.call('GET', '/public/stations')).json.stations[0].activity;
    assert.equal(await act(), 'today');
    t.advance(2 * 24 * 3600e3);
    assert.equal(await act(), 'week');
    t.advance(6 * 24 * 3600e3);
    assert.equal(await act(), 'idle');
  } finally { await t.close(); }
});

test('summary: who may read which station (anonymous, another participant, the owner)', async () => {
  const t = await boot();
  try {
    const tok = await populate(t);
    const get = (id, token, q = '') => t.call('GET', `/stations/${id}/summary${q}`, { token });

    assert.equal((await get('shown')).status, 401, 'anonymous: no graphs');
    assert.equal((await get('shown', 'garbage')).status, 401);

    const other = await get('shown', tok.hidden);
    assert.equal(other.status, 200, 'a logged-in participant sees a station on the map');
    assert.equal(other.json.mine, false);
    for (const k of ['last_seen_utc', 'event_count', 'listed']) assert.equal(k in other.json, false, `${k} is for the owner only`);

    assert.equal((await get('hidden', tok.shown)).status, 404, 'an unlisted station does not exist for others');
    assert.equal((await get('off-air', tok.shown)).status, 404, 'nor does a disabled one');
    assert.equal((await get('nobody-here', tok.shown)).status, 404);
    assert.equal((await get('..%2F..%2Fetc', tok.shown)).status, 404);

    const own = await get('hidden', tok.hidden);
    assert.equal(own.status, 200, 'the owner sees their own unlisted station');
    assert.equal(own.json.mine, true);
    assert.equal(own.json.listed, false);
    assert.equal(typeof own.json.last_seen_utc, 'string');
    assert.equal(own.json.event_count, 2);
  } finally { await t.close(); }
});

test('summary: shape, window and clamping', async () => {
  const t = await boot();
  try {
    const tok = await populate(t);
    const r = await t.call('GET', '/stations/shown/summary?days=1', { token: tok.shown });
    assert.equal(r.status, 200);
    assert.equal(r.json.days, 1);
    assert.equal(r.json.hourly.length, 1);
    assert.equal(r.json.hourly[0].count, 3);
    assert.equal(r.json.totals.events, 3);
    assert.equal(r.json.adc.bins.length, 64);
    assert.equal(r.json.adc.bin_width, 64);
    assert.equal(r.headers.get('cache-control'), 'private, no-store');

    assert.equal((await t.call('GET', '/stations/shown/summary?days=9999', { token: tok.shown })).json.days, 30);
    assert.equal((await t.call('GET', '/stations/shown/summary?days=0', { token: tok.shown })).json.days, 7);
    assert.equal((await t.call('GET', '/stations/shown/summary?days=abc', { token: tok.shown })).json.days, 7);

    t.advance(3 * 24 * 3600e3);                                       // the data is now 3 days old
    assert.equal((await t.call('GET', '/stations/shown/summary?days=1', { token: tok.shown })).json.hourly.length, 0);
    assert.equal((await t.call('GET', '/stations/shown/summary?days=7', { token: tok.shown })).json.hourly.length, 1);
  } finally { await t.close(); }
});

test('summary: reading is rate limited per user', async () => {
  const t = await boot({ limits: { read: { capacity: 3, refillPerSec: 0.001 } } });
  try {
    const tok = await populate(t);
    for (let i = 0; i < 3; i++) assert.equal((await t.call('GET', '/stations/shown/summary', { token: tok.shown })).status, 200);
    const r = await t.call('GET', '/stations/shown/summary', { token: tok.shown });
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  } finally { await t.close(); }
});

test('config.json: no map tiles and a closed registration by default; a provider only when chosen', async () => {
  const t = await boot();
  try {
    const c = (await t.call('GET', '/config.json')).json;
    assert.equal(c.registration_open, false);
    assert.equal(c.tile, null, 'nothing is sent to a third party unless the operator picks a provider');
    assert.match(c.consent_version, /^draft/);
  } finally { await t.close(); }
  const g = await boot({ mapTile: 'gsi' });
  try {
    const c = (await g.call('GET', '/config.json')).json;
    assert.match(c.tile.url, /^https:\/\/cyberjapandata\.gsi\.go\.jp\/xyz\/std\//);
    assert.equal(c.tile.attribution_text, '地理院タイル');
    assert.match(c.tile.attribution_url, /^https:\/\/maps\.gsi\.go\.jp\//);
  } finally { await g.close(); }
  const o = await boot({ mapTile: 'osm' });
  try {
    const c = (await o.call('GET', '/config.json')).json;
    assert.match(c.tile.url, /^https:\/\/tile\.openstreetmap\.org\//);
    assert.match(c.tile.attribution_text, /OpenStreetMap contributors/);
  } finally { await o.close(); }
});

// ---------------------------------------------------------------------------- removing accounts

test('deleteAccount removes the rows, the statistics and the files, and keeps the id from being re-used', async () => {
  const t = await boot();
  try {
    const tok = await populate(t);
    await send(t, tok.shown, 'shown', 'r9', [10, 11]);
    const dir = path.join(t.dir, 'events', 'shown');
    assert.ok(fs.existsSync(dir));
    t.inst.db.prepare("INSERT INTO auth_tokens (user_id,kind,token_hash,expires_at,created_at) VALUES ('shown','reset','h','2030-01-01','2026-01-01')").run();

    const r = deleteAccount(t.inst.db, t.dir, 'shown', { nowIso: iso(NOW) });
    assert.equal(r.filesRemoved, true);
    assert.equal(fs.existsSync(dir), false);
    for (const [table, col] of [['users', 'id'], ['stations', 'id'], ['stats_hourly', 'station_id'], ['stats_adc', 'station_id'], ['ingest_keys', 'station_id'], ['auth_tokens', 'user_id']]) {
      assert.equal(t.inst.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${col} = 'shown'`).get().n, 0, table);
    }
    assert.equal(t.inst.db.prepare("SELECT COUNT(*) n FROM deleted_ids WHERE id='shown'").get().n, 1);
    assert.equal(t.inst.db.prepare("SELECT COUNT(*) n FROM users WHERE id='hidden'").get().n, 1, 'other accounts are untouched');
    assert.ok(fs.existsSync(path.join(t.dir, 'events', 'hidden')));
    assert.equal((await t.call('GET', '/public/stations')).json.stations.length, 0);
    // the old token no longer works
    assert.equal((await t.call('GET', '/stations/hidden/summary', { token: tok.shown })).status, 401);
  } finally { await t.close(); }
});

test('pruneUnverified drops only old, never-confirmed registrations', async () => {
  const t = await boot();
  try {
    const db = t.inst.db;
    const ins = db.prepare("INSERT INTO users (id,password_hash,status,created_at) VALUES (?,?,?,?)");
    const old = iso(NOW - 8 * 24 * 3600e3), fresh = iso(NOW - 1 * 24 * 3600e3);
    ins.run('old-pending', 'h', 'pending_email', old);
    ins.run('new-pending', 'h', 'pending_email', fresh);
    ins.run('old-active', 'h', 'active', old);
    const n = pruneUnverified(db, t.dir, { nowMs: NOW, days: 7 });
    assert.equal(n, 1);
    const left = db.prepare('SELECT id FROM users ORDER BY id').all().map((r) => r.id);
    assert.deepEqual(left, ['new-pending', 'old-active']);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM deleted_ids WHERE id='old-pending'").get().n, 0, 'no tombstone: nothing of value was stored');
  } finally { await t.close(); }
});

// ---------------------------------------------------------------------------- operator CLI

test('admin CLI: list, list-on needs a position and an active account, show hides the hash, delete needs --yes', async () => {
  const t = await boot();
  try {
    await populate(t);
    const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'admin.js'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, DATA_DIR: t.dir, JWT_SECRET: 'test-secret-' + 'x'.repeat(40) },
    });

    const list = run('list');
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /shown/);

    const show = run('show', 'off-air');
    assert.equal(show.status, 0);
    assert.equal(show.stdout.includes('scrypt$'), false, 'the password hash is never printed');
    assert.equal(show.stdout.includes('password_hash'), false);

    const bad = run('list-on', 'pending');
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /pending_email/);
    const nopos = run('list-on', 'hidden');                           // active, and the position was sent at setup
    assert.equal(nopos.status, 0, nopos.stderr);
    assert.equal(t.inst.db.prepare("SELECT listed FROM stations WHERE id='hidden'").get().listed, 1);
    assert.equal(run('list-off', 'hidden').status, 0);
    assert.equal(t.inst.db.prepare("SELECT listed FROM stations WHERE id='hidden'").get().listed, 0);

    assert.equal(run('delete', 'hidden').status, 2, 'no --yes, no deletion');
    assert.equal(t.inst.db.prepare("SELECT COUNT(*) n FROM users WHERE id='hidden'").get().n, 1);
    assert.equal(run('delete', 'hidden', '--yes').status, 0);
    assert.equal(t.inst.db.prepare("SELECT COUNT(*) n FROM users WHERE id='hidden'").get().n, 0);
    assert.equal(fs.existsSync(path.join(t.dir, 'events', 'hidden')), false);

    assert.equal(run('disable', 'shown').status, 0);
    assert.equal((await t.call('GET', '/public/stations')).json.stations.length, 0, 'a disabled station leaves the map');
    assert.equal(run('nonsense').status, 2);
  } finally { await t.close(); }
});

test('first start after an upgrade builds the statistics from the files that are already there, once', async () => {
  const { loadConfig } = require('../src/config');
  const { createApp } = require('../src/app');
  const t = await boot();
  const dir = t.dir;
  try {
    await t.seed('sendai');
    const tok = await t.loginToken('sendai');
    await send(t, tok, 'sendai', 'run-a', [1, 2, 3, 4, 5]);
    const built = dump(t.inst.db);
    // make it look like data written by the release BEFORE the upgrade: files and keys, but no statistics and no marker
    t.inst.db.exec("DELETE FROM stats_hourly; DELETE FROM stats_adc; DELETE FROM meta;");
    assert.equal(JSON.parse(dump(t.inst.db)).h.length, 0);
    t.inst.close();                                                   // (the server object is still up; only its database is closed)
    const cfg = loadConfig({ JWT_SECRET: 'test-secret-' + 'x'.repeat(40), DATA_DIR: dir, SCRYPT_N: '1024' }, { quiet: true });
    const again = await createApp(cfg, { now: () => NOW });
    assert.equal(dump(again.db), built, 'rebuilt from the files, same numbers as the live updates gave');
    assert.ok(again.db.prepare("SELECT value FROM meta WHERE key = 'stats_built'").get());
    // and only once: a start with the marker set does not touch the statistics again
    again.db.prepare("UPDATE stats_hourly SET rows = 999").run();
    again.close();
    const third = await createApp(cfg, { now: () => NOW });
    assert.equal(third.db.prepare('SELECT MIN(rows) m FROM stats_hourly').get().m, 999);
    third.close();
  } finally {
    await t.close();                                                   // closes the HTTP server too (closing a closed database is harmless)
  }
});
