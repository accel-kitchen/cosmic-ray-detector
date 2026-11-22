'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { openDb } = require('../src/db');
const { createEventStore } = require('../src/events');
const { validateEvent } = require('../src/validate');
const { runBackup } = require('../scripts/backup');
const { consoleEvent, NOW } = require('./helpers');

function seedData(dir) {
  const db = openDb(dir);
  db.prepare("INSERT INTO users (id,password_hash,status,created_at) VALUES ('sendai','h','active','t')").run();
  db.prepare("INSERT INTO stations (id) VALUES ('sendai')").run();
  const store = createEventStore(db, dir);
  const add = (n) => store.append('sendai', validateEvent(consoleEvent({ event: n, time: n }), NOW).rec);
  add(1); add(2);
  return { db, add };
}

test('backup: DB snapshot is consistent and readable; events are mirrored; reruns copy only what changed', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-bk-data-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-bk-dest-'));
  try {
    const { db, add } = seedData(data);          // the server's DB stays OPEN (WAL) during the backup

    const t0 = new Date('2026-11-21T01:00:00Z');
    const r1 = await runBackup(data, dest, { now: () => t0 });
    assert.equal(r1.eventFilesCopied, 1);
    const snap = new Database(r1.db, { readonly: true });
    assert.equal(snap.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
    assert.equal(snap.prepare('SELECT COUNT(*) n FROM ingest_keys').get().n, 2);
    snap.close();
    const src = path.join(data, 'events', 'sendai', '2026-11-21.jsonl');
    const mir = path.join(dest, 'events', 'sendai', '2026-11-21.jsonl');
    assert.equal(fs.readFileSync(mir, 'utf8'), fs.readFileSync(src, 'utf8'));

    const r2 = await runBackup(data, dest, { now: () => new Date('2026-11-22T01:00:00Z') });
    assert.equal(r2.eventFilesCopied, 0, 'nothing changed, nothing copied');

    add(3);                                      // an append-only file grows: copied again
    const r3 = await runBackup(data, dest, { now: () => new Date('2026-11-23T01:00:00Z') });
    assert.equal(r3.eventFilesCopied, 1);
    assert.equal(fs.readFileSync(mir, 'utf8'), fs.readFileSync(src, 'utf8'));
    db.close();
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('backup: only the newest N snapshots are kept', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-bk-data-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-bk-dest-'));
  try {
    const { db } = seedData(data);
    for (let d = 1; d <= 5; d++) {
      await runBackup(data, dest, { keep: 3, now: () => new Date(`2026-11-0${d}T01:00:00Z`) });
    }
    const left = fs.readdirSync(path.join(dest, 'db')).sort();
    assert.equal(left.length, 3);
    assert.match(left[0], /2026-11-03/);
    assert.match(left[2], /2026-11-05/);
    db.close();
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('backup: a deleted station leaves the mirror (moved aside first, dropped after 14 days)', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-bk-data-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-bk-dest-'));
  try {
    const { db } = seedData(data);
    const day = (n) => new Date(Date.UTC(2026, 10, n, 1));
    await runBackup(data, dest, { now: () => day(1) });
    assert.ok(fs.existsSync(path.join(dest, 'events', 'sendai')));

    fs.rmSync(path.join(data, 'events', 'sendai'), { recursive: true });       // what deleteAccount does
    const r = await runBackup(data, dest, { now: () => day(2) });
    assert.equal(r.stationsRetired, 1);
    assert.ok(!fs.existsSync(path.join(dest, 'events', 'sendai')), 'no longer in the live mirror');
    const aside = fs.readdirSync(path.join(dest, 'removed'));
    assert.equal(aside.length, 1);
    assert.ok(fs.existsSync(path.join(dest, 'removed', aside[0], 'sendai')), 'kept aside for a while, against a mistake');

    // Real time decides the age of the folder (mtime), so age it by hand instead of waiting.
    const old = new Date(Date.now() - 15 * 24 * 3600 * 1000);
    fs.utimesSync(path.join(dest, 'removed', aside[0]), old, old);
    const r2 = await runBackup(data, dest, { now: () => new Date() });
    assert.equal(r2.retiredDropped, 1);
    assert.equal(fs.readdirSync(path.join(dest, 'removed')).length, 0, 'gone for good');
    db.close();
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('backup: old pre-deploy copies are dropped, the newest one stays', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-bk-data-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-bk-dest-'));
  try {
    const { db } = seedData(data);
    const pre = path.join(dest, 'pre-deploy');
    fs.mkdirSync(pre);
    const mk = (name, ageDays) => {
      const p = path.join(pre, name); fs.writeFileSync(p, 'x');
      const t = new Date(Date.now() - ageDays * 24 * 3600 * 1000); fs.utimesSync(p, t, t);
    };
    mk('db-before-a.sqlite', 40); mk('db-before-b.sqlite', 20); mk('db-before-c.sqlite', 3);
    const r = await runBackup(data, dest, { now: () => new Date() });
    assert.equal(r.preDeployDropped, 2);
    assert.deepEqual(fs.readdirSync(pre), ['db-before-c.sqlite']);

    mk('db-before-c.sqlite', 90);                        // even alone and old, the newest copy stays
    assert.equal((await runBackup(data, dest, { now: () => new Date() })).preDeployDropped, 0);
    assert.deepEqual(fs.readdirSync(pre), ['db-before-c.sqlite']);
    db.close();
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('backup: refuses cleanly when there is no database', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-bk-empty-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-bk-dest-'));
  try {
    await assert.rejects(() => runBackup(data, dest), /unable to open|does not exist|SQLITE_CANTOPEN|Cannot open/i);
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});
