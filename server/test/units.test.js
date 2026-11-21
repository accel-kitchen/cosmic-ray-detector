'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { roundPosition } = require('../src/geo');
const { hashPassword, verifyPassword } = require('../src/password');
const { loadConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { Limiter } = require('../src/ratelimit');
const { boot } = require('./helpers');

test('geo: cell centres are exact at cell boundaries and across zero', () => {
  assert.deepEqual(roundPosition(38.2, 140.8), { lat: 38.25, lon: 140.85 });          // 38.2/0.1 is 381.999.. in floats
  // Positions are taken to micro-degrees (0.11 m), so 6-decimal inputs are the finest that mean anything.
  assert.deepEqual(roundPosition(38.199999, 140.799999), { lat: 38.15, lon: 140.75 });
  assert.deepEqual(roundPosition(38.299999, 140.899999), { lat: 38.25, lon: 140.85 });
  assert.deepEqual(roundPosition(38.3, 140.9), { lat: 38.35, lon: 140.95 });
  assert.deepEqual(roundPosition(0, 0), { lat: 0.05, lon: 0.05 });
  assert.deepEqual(roundPosition(-0.05, -0.05), { lat: -0.05, lon: -0.05 });
  assert.deepEqual(roundPosition(-0.000001, 179.99), { lat: -0.05, lon: 179.95 });
});

test('geo: the console sends text from its input boxes, so numeric strings are positions', () => {
  assert.deepEqual(roundPosition('38.2545678', '140.8399123'), { lat: 38.25, lon: 140.85 });
  assert.deepEqual(roundPosition(' 35.68 ', '-139.76'), { lat: 35.65, lon: -139.75 });
  assert.deepEqual(roundPosition('35', '139'), { lat: 35.05, lon: 139.05 });
});

test('geo: absent or invalid positions give null', () => {
  const bad = [[null, null], [undefined, 1], ['', ''], [' ', ' '], ['35abc', '139'], ['1e2', '0'], ['0x10', '0'],
               [NaN, 1], [91, 0], [0, 181], ['91', '0'], [Infinity, 0], [{}, []], [true, false]];
  for (const [a, b] of bad) assert.equal(roundPosition(a, b), null, `${JSON.stringify([a, b])}`);
});

test('password: round trip, wrong password, malformed stored value', async () => {
  const h = await hashPassword('correct horse', 1024);
  assert.match(h, /^scrypt\$1024\$8\$1\$/);
  assert.equal(await verifyPassword('correct horse', h), true);
  assert.equal(await verifyPassword('wrong horse', h), false);
  for (const bad of ['', 'plain', 'scrypt$x$8$1$AA$AA', 'bcrypt$10$1$1$AA$AA', null]) {
    assert.equal(await verifyPassword('correct horse', bad), false, String(bad));
  }
  // The parameters are in the hash: one made at a low cost still verifies after the default changes.
  assert.notEqual(await hashPassword('same', 1024), await hashPassword('same', 1024), 'salted');
});

test('password: many concurrent hashes and checks all finish (the concurrency cap does not stall)', async () => {
  const hashes = await Promise.all(Array.from({ length: 8 }, (_, i) => hashPassword(`pw-${i}-xxxxxxxx`, 1024)));
  const results = await Promise.all(hashes.map((h, i) => verifyPassword(`pw-${i}-xxxxxxxx`, h)));
  assert.deepEqual(results, Array(8).fill(true));
  assert.equal(await verifyPassword('pw-0-xxxxxxxx', hashes[1]), false);
});

test('password: the default work factor is the OWASP scrypt minimum (N=2^17, r=8, p=1)', async () => {
  assert.equal(loadConfig({ JWT_SECRET: 'x'.repeat(40) }, { quiet: true }).scryptN, 131072);
  const h = await hashPassword('correct horse', 131072);        // one real-cost hash: also proves maxmem is enough
  assert.match(h, /^scrypt\$131072\$8\$1\$/);
  assert.equal(await verifyPassword('correct horse', h), true);
});

test('password: the concurrency cap is configurable and validated', async () => {
  const { setMaxConcurrent } = require('../src/password');
  assert.throws(() => setMaxConcurrent(0), /positive integer/);
  assert.throws(() => setMaxConcurrent(1.5), /positive integer/);
  setMaxConcurrent(1);                                         // strictly one at a time: still finishes
  const hs = await Promise.all(Array.from({ length: 4 }, (_, i) => hashPassword(`pw-${i}-xxxxxxxx`, 1024)));
  assert.equal(hs.length, 4);
  setMaxConcurrent(2);
});

test('config: SCRYPT_CONCURRENCY is read, bad values fall back to 2; the commit comes from env, else the .commit file', () => {
  const base = { JWT_SECRET: 'x'.repeat(40) };
  assert.equal(loadConfig({ ...base }, { quiet: true }).scryptConcurrency, 2);
  assert.equal(loadConfig({ ...base, SCRYPT_CONCURRENCY: '4' }, { quiet: true }).scryptConcurrency, 4);
  assert.equal(loadConfig({ ...base, SCRYPT_CONCURRENCY: 'abc' }, { quiet: true }).scryptConcurrency, 2);
  assert.equal(loadConfig({ ...base, SCRYPT_CONCURRENCY: '0' }, { quiet: true }).scryptConcurrency, 2);

  assert.equal(loadConfig({ ...base, GIT_COMMIT: 'fromenv' }, { quiet: true }).commit, 'fromenv');
  const file = path.join(__dirname, '..', '.commit');
  const had = fs.existsSync(file) ? fs.readFileSync(file) : null;
  try {
    fs.writeFileSync(file, 'abc1234def\n');
    assert.equal(loadConfig({ ...base }, { quiet: true }).commit, 'abc1234def');
    assert.equal(loadConfig({ ...base, GIT_COMMIT: 'fromenv' }, { quiet: true }).commit, 'fromenv', 'env wins');
    fs.rmSync(file);
    assert.equal(loadConfig({ ...base }, { quiet: true }).commit, 'unknown');
  } finally {
    if (had) fs.writeFileSync(file, had); else fs.rmSync(file, { force: true });
  }
});

test('config: production refuses to start without JWT_SECRET', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /JWT_SECRET/);
  assert.doesNotThrow(() => loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40) }));
});

test('db: reopening keeps the data; a newer schema is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-db-'));
  try {
    let db = openDb(dir);
    assert.equal(db.pragma('user_version', { simple: true }), 1);
    db.prepare("INSERT INTO users (id,password_hash,status,created_at) VALUES ('abc','h','active','t')").run();
    db.close();
    db = openDb(dir);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
    db.pragma('user_version = 99');
    db.close();
    assert.throws(() => openDb(dir), /newer than this server/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('limiter: refills over time and peek does not consume', () => {
  let t = 0;
  const l = new Limiter({ capacity: 2, refillPerSec: 1, now: () => t });
  assert.equal(l.peek('k').ok, true);
  assert.equal(l.take('k').ok, true);
  assert.equal(l.take('k').ok, true);
  assert.equal(l.take('k').ok, false);
  assert.equal(l.take('k').retryAfterSec, 1);
  t = 1000;
  assert.equal(l.take('k').ok, true);
  assert.equal(l.take('other').ok, true, 'keys are independent');
});

test('seed script: creates a working account without printing the password', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-seed-'));
  try {
    const env = { ...process.env, DATA_DIR: dir, SCRYPT_N: '1024', JWT_SECRET: 'test-secret-' + 'x'.repeat(40) };
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'seed-station.js'), 'seeded-1'], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const file = path.join(dir, 'seed-seeded-1.txt');
    const password = /password: (\S+)/.exec(fs.readFileSync(file, 'utf8'))[1];
    assert.equal(r.stdout.includes(password), false, 'password must not be printed');
    assert.equal(r.stderr.includes(password), false);

    // The seeded account logs in against a server that uses the same data directory.
    const { createApp } = require('../src/app');
    const cfg = loadConfig(env, { quiet: true });
    const inst = await createApp(cfg);
    const server = await new Promise((res) => { const s = inst.app.listen(0, '127.0.0.1', () => res(s)); });
    try {
      const resp = await fetch(`http://127.0.0.1:${server.address().port}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'seeded-1', password }),
      });
      assert.equal(resp.status, 200);
    } finally {
      server.closeAllConnections();
      await new Promise((res) => server.close(res));
      inst.close();
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('boot helper smoke: the app starts and closes cleanly', async () => {
  const t = await boot();
  await t.close();
});
