'use strict';
// Contract tests for the console-compatible API (plan, section 7).
// They pin down what the console depends on: which status means "drop the
// event" (400), "log in again" (401/403) or "retry" (429/5xx), and that every
// response -- errors included -- carries the CORS headers the browser needs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { boot, consoleEvent, readAllBytes } = require('./helpers');

const SECRET = 'test-secret-' + 'x'.repeat(40);

function eventsOf(dir, station, day) {
  const f = path.join(dir, 'events', station, `${day}.jsonl`);
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------- CORS -----

test('CORS: OPTIONS preflight answers 204 with the headers the console needs', async () => {
  const t = await boot();
  try {
    for (const p of ['/auth/login', '/setup-id', '/auth/refresh', '/upload-data/sendai', '/anything']) {
      const r = await t.call('OPTIONS', p, {
        headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST',
                   'Access-Control-Request-Headers': 'content-type,authorization' },
      });
      assert.equal(r.status, 204, p);
      assert.equal(r.headers.get('access-control-allow-origin'), '*', p);
      const allowed = (r.headers.get('access-control-allow-headers') || '').toLowerCase();
      assert.match(allowed, /authorization/, p);
      assert.match(allowed, /content-type/, p);
      assert.match(r.headers.get('access-control-allow-methods') || '', /POST/, p);
      assert.equal(r.headers.get('access-control-allow-credentials'), null, 'must not be set: it would void "*"');
    }
  } finally { await t.close(); }
});

test('CORS: error responses carry the CORS headers too', async () => {
  const t = await boot();
  try {
    await t.seed('sendai');
    const cases = [
      ['wrong password (401)', () => t.call('POST', '/auth/login', { body: { id: 'sendai', password: 'nope-nope' } }), 401],
      ['missing fields (400)', () => t.call('POST', '/auth/login', { body: {} }), 400],
      ['malformed JSON (400)', () => t.call('POST', '/auth/login', { body: '{not json', headers: { 'Content-Type': 'application/json' } }), 400],
      ['unknown route (404)', () => t.call('GET', '/no/such/route'), 404],
      ['no token (401)', () => t.call('POST', '/upload-data/sendai', { body: consoleEvent() }), 401],
      ['oversized body (413)', () => t.call('POST', '/auth/login', { body: { id: 'sendai', password: 'x'.repeat(50000) } }), 413],
    ];
    for (const [name, run, status] of cases) {
      const r = await run();
      assert.equal(r.status, status, name);
      assert.equal(r.headers.get('access-control-allow-origin'), '*', name);
      assert.equal(typeof (r.json && r.json.error), 'string', `${name}: JSON error body`);
    }
  } finally { await t.close(); }
});

// ---------------------------------------------------------------- auth -----

test('login: success returns a JWT with an exp; ids are case-insensitive and trimmed', async () => {
  const t = await boot();
  try {
    await t.seed('sendai');
    const r = await t.call('POST', '/auth/login', { body: { id: '  SendAI ', password: 'pw-12345678' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.success, true);
    assert.equal(r.json.user.id, 'sendai');
    const p = jwt.verify(r.json.token, SECRET, { algorithms: ['HS256'] });
    assert.ok(p.exp > Date.now() / 1000 - 1e9, 'exp present');
    assert.equal(p.sub, 'sendai');
  } finally { await t.close(); }
});

test('login: wrong password, unknown id and malformed id are indistinguishable (401)', async () => {
  const t = await boot();
  try {
    await t.seed('sendai');
    const a = await t.call('POST', '/auth/login', { body: { id: 'sendai', password: 'wrong-password' } });
    const b = await t.call('POST', '/auth/login', { body: { id: 'nobody', password: 'wrong-password' } });
    const c = await t.call('POST', '/auth/login', { body: { id: '../etc', password: 'wrong-password' } });
    for (const r of [a, b, c]) {
      assert.equal(r.status, 401);
      assert.deepEqual(r.json, { error: 'Invalid credentials' });
    }
  } finally { await t.close(); }
});

test('login: account state is revealed only after the right password', async () => {
  const t = await boot();
  try {
    await t.seed('legacy-a', 'legacy_unclaimed');
    await t.seed('pending-a', 'pending_email');
    await t.seed('off-a', 'disabled');

    const legacy = await t.call('POST', '/auth/login', { body: { id: 'legacy-a', password: 'pw-12345678' } });
    assert.equal(legacy.status, 403);
    assert.ok(legacy.json.error.includes(t.cfg.claimUrl), 'tells the user where to register an email');

    assert.equal((await t.call('POST', '/auth/login', { body: { id: 'pending-a', password: 'pw-12345678' } })).status, 403);
    assert.equal((await t.call('POST', '/auth/login', { body: { id: 'off-a', password: 'pw-12345678' } })).status, 403);

    // A wrong password on the same accounts must not leak their state.
    for (const id of ['legacy-a', 'pending-a', 'off-a']) {
      const r = await t.call('POST', '/auth/login', { body: { id, password: 'wrong-password' }, ip: '198.51.100.9' });
      assert.equal(r.status, 401, id);
    }
  } finally { await t.close(); }
});

test('tokens: refresh works; revoked, expired, forged and "alg none" tokens are 401', async () => {
  const t = await boot();
  try {
    await t.seed('sendai');
    const tok = await t.loginToken('sendai');

    const rf = await t.call('POST', '/auth/refresh', { token: tok, body: {} });
    assert.equal(rf.status, 200);
    assert.ok(rf.json.token);
    assert.equal((await t.call('POST', '/setup-id', { token: rf.json.token, body: { id: 'sendai' } })).status, 200);

    assert.equal((await t.call('POST', '/auth/refresh', { body: {} })).status, 401, 'no token');
    assert.equal((await t.call('POST', '/auth/refresh', { token: 'garbage', body: {} })).status, 401);

    const expired = jwt.sign({ sub: 'sendai', ver: 0 }, SECRET, { algorithm: 'HS256', expiresIn: -10 });
    const e = await t.call('POST', '/auth/refresh', { token: expired, body: {} });
    assert.equal(e.status, 401);
    assert.equal(e.json.error, 'Token expired');

    const forged = jwt.sign({ sub: 'sendai', ver: 0 }, 'some-other-secret-' + 'y'.repeat(30), { algorithm: 'HS256' });
    assert.equal((await t.call('POST', '/auth/refresh', { token: forged, body: {} })).status, 401);

    const none = [
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'sendai', ver: 0 })).toString('base64url'),
      '',
    ].join('.');
    assert.equal((await t.call('POST', '/auth/refresh', { token: none, body: {} })).status, 401);

    // Bumping token_version (password change, suspension) kills every issued token.
    t.inst.db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run('sendai');
    const r = await t.call('POST', '/auth/refresh', { token: tok, body: {} });
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'Token revoked');
  } finally { await t.close(); }
});

// ------------------------------------------------------------ setup-id -----

test('setup-id: needs auth, own station only, and is idempotent', async () => {
  const t = await boot();
  try {
    await t.seed('sendai');
    await t.seed('osaka');
    const tok = await t.loginToken('sendai');
    const body = { id: 'sendai', comment: 'CosmicRay Recorder v2', gps_latitude: null, gps_longitude: null,
                   created_at: '2026-11-21T00:00:00Z' };

    assert.equal((await t.call('POST', '/setup-id', { body })).status, 401);
    assert.equal((await t.call('POST', '/setup-id', { token: tok, body: { ...body, id: 'osaka' } })).status, 403);

    for (let i = 0; i < 3; i++) {                       // the console calls it at every login
      const r = await t.call('POST', '/setup-id', { token: tok, body });
      assert.equal(r.status, 200);
      assert.equal(r.json.success, true);
    }
  } finally { await t.close(); }
});

test('setup-id: only the rounded grid centre is stored; raw coordinates are on no disk', async () => {
  const t = await boot();
  try {
    await t.seed('sendai');
    const tok = await t.loginToken('sendai');
    const r = await t.call('POST', '/setup-id', {
      token: tok,
      body: { id: 'sendai', comment: 'my private note', gps_latitude: 38.2545678, gps_longitude: 140.8399123 },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.position, { lat: 38.25, lon: 140.85 });

    const row = t.inst.db.prepare('SELECT * FROM stations WHERE id = ?').get('sendai');
    assert.equal(row.lat_grid, 38.25);
    assert.equal(row.lon_grid, 140.85);
    assert.equal(row.private_comment, 'my private note');

    // Force pending WAL pages into the main file, then scan every byte on disk.
    t.inst.db.pragma('wal_checkpoint(TRUNCATE)');
    const disk = readAllBytes(t.dir);
    for (const raw of ['38.2545678', '140.8399123', '38.25456', '140.83991']) {
      assert.equal(disk.includes(Buffer.from(raw)), false, `${raw} must not be stored`);
    }
  } finally { await t.close(); }
});

test('setup-id: coordinates as the console really sends them (text from the input boxes) are rounded', async () => {
  const t = await boot();
  try {
    await t.seed('sendai');
    const tok = await t.loginToken('sendai');
    const r = await t.call('POST', '/setup-id', {
      token: tok,
      body: { id: 'sendai', comment: 'c', gps_latitude: '38.2545678', gps_longitude: '140.8399123' },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.position, { lat: 38.25, lon: 140.85 });
    assert.equal(r.json.position_ignored, false);
    t.inst.db.pragma('wal_checkpoint(TRUNCATE)');
    assert.equal(readAllBytes(t.dir).includes(Buffer.from('38.2545678')), false);
  } finally { await t.close(); }
});

test('setup-id: invalid position is ignored (not a failed login) and keeps the stored one', async () => {
  const t = await boot();
  try {
    await t.seed('sendai');
    const tok = await t.loginToken('sendai');
    await t.call('POST', '/setup-id', { token: tok, body: { id: 'sendai', gps_latitude: 35.68, gps_longitude: 139.76 } });

    const bad = await t.call('POST', '/setup-id', { token: tok, body: { id: 'sendai', gps_latitude: 999, gps_longitude: 139.76 } });
    assert.equal(bad.status, 200);
    assert.equal(bad.json.position_ignored, true);

    const none = await t.call('POST', '/setup-id', { token: tok, body: { id: 'sendai', gps_latitude: null, gps_longitude: null } });
    assert.equal(none.status, 200);
    assert.equal(none.json.position, null);

    const row = t.inst.db.prepare('SELECT lat_grid, lon_grid FROM stations WHERE id = ?').get('sendai');
    assert.deepEqual({ ...row }, { lat_grid: 35.65, lon_grid: 139.75 }, 'earlier position not wiped');
  } finally { await t.close(); }
});

// -------------------------------------------------------------- ingest -----

test('upload: a valid event is appended to <station>/<utc-day>.jsonl behind a header line', async () => {
  const t = await boot();
  try {
    await t.seed('sendai');
    const tok = await t.loginToken('sendai');
    const r = await t.call('POST', '/upload-data/sendai', { token: tok, body: consoleEvent() });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { success: true, duplicate: false });

    const lines = eventsOf(t.dir, 'sendai', '2026-11-21');
    assert.equal(lines.length, 2);
    assert.equal(lines[0].kind, 'header');
    assert.equal(lines[0].format_version, 1);
    assert.equal(lines[0].station, 'sendai');
    assert.equal(lines[1].event, 1);
    assert.equal(lines[1].adc, 800);
    assert.equal(lines[1].vol_mv, 644.5);
    assert.equal(lines[1].deadtime_ms, 3, 'unit is in the field name: the console sends milliseconds');
    assert.equal('deadtime' in lines[1], false);
    assert.equal(lines[1].run_id, 'run-aaaa');
    assert.equal(lines[1].t, '2026-11-21T11:10:11.123Z');
    assert.ok(lines[1].rx, 'server receive time recorded');

    const st = t.inst.db.prepare('SELECT event_count, last_seen_utc FROM stations WHERE id = ?').get('sendai');
    assert.equal(st.event_count, 1);
    assert.ok(st.last_seen_utc);
  } finally { await t.close(); }
});

test('upload: the file day is the UTC day, whatever the console time zone says', async () => {
  const t = await boot();
  try {
    await t.seed('sendai');
    const tok = await t.loginToken('sendai');
    // 08:59 in Tokyo on the 21st is still the 20th in UTC; 09:00 is the 21st.
    const a = consoleEvent({ event: 1, time: 1, timestamp_utc: '2026-11-20T23:59:59.999Z', tz_offset_min: 540 });
    const b = consoleEvent({ event: 2, time: 2, timestamp_utc: '2026-11-21T00:00:00.000Z', tz_offset_min: 540 });
    assert.equal((await t.call('POST', '/upload-data/sendai', { token: tok, body: a })).status, 200);
    assert.equal((await t.call('POST', '/upload-data/sendai', { token: tok, body: b })).status, 200);
    assert.equal(eventsOf(t.dir, 'sendai', '2026-11-20').length, 2);   // header + 1
    assert.equal(eventsOf(t.dir, 'sendai', '2026-11-21').length, 2);
  } finally { await t.close(); }
});

test('upload: a retried event is not written twice; a rebooted board (event restarts at 0) is not a duplicate', async () => {
  const t = await boot();
  try {
    await t.seed('sendai');
    const tok = await t.loginToken('sendai');
    const send = (over) => t.call('POST', '/upload-data/sendai', { token: tok, body: consoleEvent(over) });

    assert.equal((await send({})).json.duplicate, false);
    const again = await send({});                                    // same run, event, time: a lost-response retry
    assert.equal(again.status, 200, 'a duplicate is a success, so the console stops retrying');
    assert.equal(again.json.duplicate, true);
    assert.equal(eventsOf(t.dir, 'sendai', '2026-11-21').length, 2, 'header + one event');

    // Board rebooted inside one console connection: same run_id and event number, new time_us.
    assert.equal((await send({ event: 1, time: 99 })).json.duplicate, false);
    // Another connection: new run_id, same event and time.
    assert.equal((await send({ run_id: 'run-bbbb' })).json.duplicate, false);
    assert.equal(eventsOf(t.dir, 'sendai', '2026-11-21').length, 4);
    assert.equal(t.inst.db.prepare('SELECT event_count FROM stations WHERE id=?').get('sendai').event_count, 3);
  } finally { await t.close(); }
});

test('upload: structurally unusable events are 400 (the console drops them)', async () => {
  const t = await boot();
  try {
    await t.seed('sendai');
    const tok = await t.loginToken('sendai');
    const bad = {
      'adc missing': { adc: undefined },
      'adc as string': { adc: '800' },
      'adc null': { adc: null },
      'adc out of range': { adc: 70000 },
      'negative event': { event: -1 },
      'fractional event': { event: 1.5 },
      'vol missing': { vol: undefined },
      'deadtime negative': { deadtime: -1 },
      'run_id missing': { run_id: undefined },
      'run_id too long': { run_id: 'x'.repeat(65) },
      'timestamp_utc missing': { timestamp_utc: undefined },
      'timestamp_utc local format': { timestamp_utc: '2026-11-21-21-10-11.123456' },
      'timestamp_utc impossible date': { timestamp_utc: '2026-13-45T00:00:00.000Z' },
    };
    for (const [name, over] of Object.entries(bad)) {
      const r = await t.call('POST', '/upload-data/sendai', { token: tok, body: consoleEvent(over) });
      assert.equal(r.status, 400, name);
      assert.equal(typeof r.json.error, 'string', name);
    }
    for (const body of [[], 'null', '42']) {
      const r = await t.call('POST', '/upload-data/sendai', { token: tok, body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
      assert.equal(r.status, 400, `body ${JSON.stringify(body)}`);
    }
    assert.equal(eventsOf(t.dir, 'sendai', '2026-11-21'), null, 'nothing was written');
  } finally { await t.close(); }
});

test('upload (Q-N14): events from a badly wrong PC clock are kept, flagged, in their own stream', async () => {
  const t = await boot();
  try {
    await t.seed('sendai');
    const tok = await t.loginToken('sendai');
    const send = (over) => t.call('POST', '/upload-data/sendai', { token: tok, body: consoleEvent(over) });

    const ancient = await send({ event: 1, time: 1, timestamp_utc: '2001-01-01T00:00:00.000Z' });
    assert.equal(ancient.status, 200);
    assert.deepEqual(ancient.json, { success: true, duplicate: false, clock_suspect: true });
    assert.equal((await send({ event: 2, time: 2, timestamp_utc: '2027-06-01T00:00:00.000Z' })).json.clock_suspect, true);

    // Filed by the day it was RECEIVED (the clock cannot place it), in <day>.badclock.jsonl.
    const bad = eventsOf(t.dir, 'sendai', '2026-11-21.badclock');
    assert.equal(bad.length, 3, 'header + 2 events');
    assert.equal(bad[0].stream, 'badclock');
    assert.equal(bad[1].t, '2001-01-01T00:00:00.000Z', 'the time it claimed is left untouched');
    assert.equal(bad[1].clock_suspect, true);
    assert.equal(eventsOf(t.dir, 'sendai', '2026-11-21'), null, 'the main stream stays clean');
    assert.equal(t.inst.db.prepare('SELECT event_count FROM stations WHERE id=?').get('sendai').event_count, 2);

    // A retry of a bad-clock event is still not written twice.
    assert.equal((await send({ event: 1, time: 1, timestamp_utc: '2001-01-01T00:00:00.000Z' })).json.duplicate, true);
    assert.equal(eventsOf(t.dir, 'sendai', '2026-11-21.badclock').length, 3);

    // A normal event goes to the main stream, without the flag in the response.
    const ok = await send({ event: 3, time: 3 });
    assert.deepEqual(ok.json, { success: true, duplicate: false });
    assert.equal(eventsOf(t.dir, 'sendai', '2026-11-21').length, 2);
  } finally { await t.close(); }
});

test('upload (Q-N14): the accepted window is 2015 .. two days ahead of the server clock', async () => {
  const t = await boot();
  try {
    await t.seed('sendai');
    const tok = await t.loginToken('sendai');
    const send = (n, iso) => t.call('POST', '/upload-data/sendai', { token: tok, body: consoleEvent({ event: n, time: n, timestamp_utc: iso }) });
    assert.equal((await send(1, '2026-11-23T11:59:00.000Z')).json.clock_suspect, undefined, 'just under two days ahead');
    assert.equal((await send(2, '2026-11-23T12:01:00.000Z')).json.clock_suspect, true, 'just over');
    assert.equal((await send(3, '2015-01-01T00:00:00.000Z')).json.clock_suspect, undefined, 'the earliest accepted instant');
    assert.equal((await send(4, '2014-12-31T23:59:59.999Z')).json.clock_suspect, true);
  } finally { await t.close(); }
});

test('upload: odd-but-usable events are kept, not refused', async () => {
  const t = await boot();
  try {
    await t.seed('sendai');
    const tok = await t.loginToken('sendai');
    const send = (over) => t.call('POST', '/upload-data/sendai', { token: tok, body: consoleEvent(over) });

    assert.equal((await send({ event: 1, time: 1, temp: null })).status, 200, 'no environment sensor');
    assert.equal((await send({ event: 2, time: 2, temp: undefined })).status, 200);
    assert.equal((await send({ event: 3, time: 3, temp: 999 })).status, 200, 'a wild reading must not destroy the event');
    assert.equal((await send({ event: 4, time: 4, device_label: 'L'.repeat(200), tz_offset_min: 99999 })).status, 200);

    const rows = eventsOf(t.dir, 'sendai', '2026-11-21').slice(1);
    assert.equal(rows[0].temp_c, null);
    assert.equal(rows[1].temp_c, null);
    assert.equal(rows[2].temp_c, 999);
    assert.equal(rows[3].device_label.length, 64);
    assert.equal(rows[3].tz_offset_min, null);
  } finally { await t.close(); }
});

test('upload: only the owner may write; the path id never decides where data lands', async () => {
  const t = await boot();
  try {
    await t.seed('sendai');
    await t.seed('osaka');
    const tok = await t.loginToken('sendai');

    assert.equal((await t.call('POST', '/upload-data/osaka', { token: tok, body: consoleEvent() })).status, 403);
    assert.equal((await t.call('POST', '/upload-data/..%2F..%2Fescape', { token: tok, body: consoleEvent() })).status, 403);
    assert.equal((await t.call('POST', '/upload-data/sendai', { body: consoleEvent() })).status, 401);
    assert.equal((await t.call('POST', '/upload-data/SENDAI', { token: tok, body: consoleEvent() })).status, 200, 'case-insensitive');

    assert.equal(eventsOf(t.dir, 'osaka', '2026-11-21'), null);
    assert.ok(eventsOf(t.dir, 'sendai', '2026-11-21'));
  } finally { await t.close(); }
});

test('upload: a station is created on first data even if setup-id was never called', async () => {
  const t = await boot();
  try {
    await t.seed('sendai');
    const tok = await t.loginToken('sendai');
    assert.equal(t.inst.db.prepare('SELECT COUNT(*) n FROM stations WHERE id=?').get('sendai').n, 0);
    assert.equal((await t.call('POST', '/upload-data/sendai', { token: tok, body: consoleEvent() })).status, 200);
    assert.equal(t.inst.db.prepare('SELECT event_count FROM stations WHERE id=?').get('sendai').event_count, 1);
  } finally { await t.close(); }
});

// ---------------------------------------------------------- rate limits -----

test('rate limit: login attempts are limited per client IP, and other IPs are unaffected', async () => {
  const t = await boot();
  try {
    await t.seed('sendai');
    // 10 attempts (here at 10 different ids, so only the per-IP bucket is in play) are
    // allowed from one IP; the 11th is refused with Retry-After.
    for (let i = 0; i < 10; i++) {
      const r = await t.call('POST', '/auth/login', { body: { id: `nobody-${i}`, password: 'wrong-password' }, ip: '203.0.113.1' });
      assert.equal(r.status, 401, `attempt ${i + 1}`);
    }
    const blocked = await t.call('POST', '/auth/login', { body: { id: 'nobody-x', password: 'wrong-password' }, ip: '203.0.113.1' });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    assert.equal(blocked.headers.get('access-control-allow-origin'), '*', '429 still carries CORS');

    // A different client, seen through the proxy header, has its own bucket.
    const other = await t.call('POST', '/auth/login', { body: { id: 'sendai', password: 'pw-12345678' }, ip: '203.0.113.2' });
    assert.equal(other.status, 200);
  } finally { await t.close(); }
});

test('rate limit (Q-N13): one address failing over and over cannot lock a station for anyone else', async () => {
  const t = await boot();
  try {
    await t.seed('sendai');
    await t.seed('osaka');
    // Address A guesses at 'sendai': 5 failures fill its (station, address) bucket.
    for (let i = 0; i < 5; i++) {
      const r = await t.call('POST', '/auth/login', { body: { id: 'sendai', password: 'wrong-password' }, ip: '203.0.113.50' });
      assert.equal(r.status, 401, `failure ${i + 1}`);
    }
    // A is now held off from 'sendai' (even with the right password)...
    const held = await t.call('POST', '/auth/login', { body: { id: 'sendai', password: 'pw-12345678' }, ip: '203.0.113.50' });
    assert.equal(held.status, 429);
    // ...but not from other stations: it is the pair that is limited, not the whole address.
    const other = await t.call('POST', '/auth/login', { body: { id: 'osaka', password: 'pw-12345678' }, ip: '203.0.113.50' });
    assert.equal(other.status, 200);
    // And the owner of 'sendai', from another address, is not affected at all.
    const owner = await t.call('POST', '/auth/login', { body: { id: 'sendai', password: 'pw-12345678' }, ip: '198.51.100.7' });
    assert.equal(owner.status, 200);
  } finally { await t.close(); }
});

test('rate limit: correct logins never use up a station\'s failure budget', async () => {
  const t = await boot();
  try {
    await t.seed('sendai');
    for (let i = 0; i < 150; i++) {                       // more than the station-wide capacity of 100
      const r = await t.call('POST', '/auth/login', { body: { id: 'sendai', password: 'pw-12345678' }, ip: `198.51.${Math.floor(i / 200)}.${(i % 200) + 1}` });
      assert.equal(r.status, 200, `good login ${i + 1}`);
    }
  } finally { await t.close(); }
});

test('rate limit: many addresses failing at once do limit the station, until it refills', async () => {
  const t = await boot({ limits: { loginId: { capacity: 20, refillPerSec: 0.5 } } });
  try {
    await t.seed('sendai');
    // Five addresses, four failures each (below every per-address limit) empty the station bucket of 20.
    for (let a = 1; a <= 5; a++) {
      for (let i = 0; i < 4; i++) {
        const r = await t.call('POST', '/auth/login', { body: { id: 'sendai', password: 'wrong-password' }, ip: `192.0.2.${a}` });
        assert.equal(r.status, 401);
      }
    }
    const fresh = { body: { id: 'sendai', password: 'pw-12345678' }, ip: '203.0.113.99' };
    assert.equal((await t.call('POST', '/auth/login', fresh)).status, 429, 'station-wide bucket is empty');
    t.advance(60 * 1000);                                  // 60 s at 0.5/s refills it
    assert.equal((await t.call('POST', '/auth/login', fresh)).status, 200, 'and it recovers');
  } finally { await t.close(); }
});

test('rate limit: upload is limited per station and answers 429 (the console retries)', async () => {
  const t = await boot({ limits: { upload: { capacity: 3, refillPerSec: 0.001 } } });
  try {
    await t.seed('sendai');
    const tok = await t.loginToken('sendai');
    for (let i = 1; i <= 3; i++) {
      assert.equal((await t.call('POST', '/upload-data/sendai', { token: tok, body: consoleEvent({ event: i, time: i }) })).status, 200);
    }
    const r = await t.call('POST', '/upload-data/sendai', { token: tok, body: consoleEvent({ event: 4, time: 4 }) });
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  } finally { await t.close(); }
});

// -------------------------------------------------------------- misc -----

test('healthz reports version, commit and schema', async () => {
  const t = await boot({ commit: 'abc1234' });
  try {
    const r = await t.call('GET', '/healthz');
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'ok');
    assert.equal(r.json.commit, 'abc1234');
    assert.equal(r.json.schema, 1);
  } finally { await t.close(); }
});
