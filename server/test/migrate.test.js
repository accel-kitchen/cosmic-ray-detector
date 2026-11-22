'use strict';
// A database written by the shipped server (schema 1, server-v0.1.0) must open in the new
// server, keep every row, and gain the new columns with safe defaults. The v1 file is built
// from the real step-0 migration, so this test cannot drift from what was deployed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { openDb, MIGRATIONS, SCHEMA_VERSION } = require('../src/db');

function makeV1(dir) {
  const db = new Database(path.join(dir, 'db.sqlite'));
  db.pragma('journal_mode = WAL');
  db.exec(MIGRATIONS[0]);
  db.pragma('user_version = 1');
  db.prepare("INSERT INTO users (id,password_hash,status,token_version,created_at) VALUES ('sendai','scrypt$1$8$1$AA$AA','active',3,'2026-11-21T00:00:00Z')").run();
  db.prepare("INSERT INTO users (id,password_hash,status,created_at) VALUES ('waseda','h2','legacy_unclaimed','2026-11-21T00:00:00Z')").run();
  db.prepare("INSERT INTO stations (id,lat_grid,lon_grid,private_comment,setup_at,last_seen_utc,event_count) VALUES ('sendai',38.25,140.85,'my note','2026-11-21T01:00:00Z','2026-11-21T02:00:00Z',123)").run();
  db.prepare("INSERT INTO ingest_keys (station_id,run_id,event,time_us,day) VALUES ('sendai','r1',1,100,'2026-11-21')").run();
  db.close();
}

test('migration 1 -> 2 keeps a deployed database intact and adds the new columns with safe defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-mig-'));
  try {
    makeV1(dir);
    const db = openDb(dir);
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);

    const u = db.prepare("SELECT * FROM users WHERE id='sendai'").get();
    assert.equal(u.status, 'active');
    assert.equal(u.token_version, 3, 'existing tokens stay valid');
    assert.equal(u.email, null);
    assert.equal(u.created_via, 'seed');
    assert.equal(db.prepare("SELECT status FROM users WHERE id='waseda'").get().status, 'legacy_unclaimed');

    const s = db.prepare("SELECT * FROM stations WHERE id='sendai'").get();
    assert.equal(s.lat_grid, 38.25);
    assert.equal(s.private_comment, 'my note');
    assert.equal(s.event_count, 123);
    assert.equal(s.listed, 0, 'a station that existed before is NOT put on the public map by the upgrade');
    assert.equal(s.public_description, null);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM ingest_keys').get().n, 1);
    for (const t of ['auth_tokens', 'mail_counters', 'deleted_ids', 'stats_hourly', 'stats_adc', 'meta']) {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM ' + t).get().n, 0, t);
    }
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('migration is idempotent: opening an already-migrated database changes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-mig-'));
  try {
    makeV1(dir);
    openDb(dir).close();
    const db = openDb(dir);
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 2);
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the email column is unique when set, and many accounts may have none', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-mig-'));
  try {
    const db = openDb(dir);
    const ins = db.prepare("INSERT INTO users (id,password_hash,status,created_at,email) VALUES (?,?,?,?,?)");
    ins.run('a-one', 'h', 'active', 't', null);
    ins.run('a-two', 'h', 'active', 't', null);                 // two NULLs are fine
    ins.run('a-three', 'h', 'active', 't', 'x@example.org');
    assert.throws(() => ins.run('a-four', 'h', 'active', 't', 'x@example.org'), /UNIQUE/);
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('migration 2 -> 3 (operator tools) keeps a deployed 0.2.x database and adds safe defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-mig-'));
  try {
    const raw = new Database(path.join(dir, 'db.sqlite'));
    raw.pragma('journal_mode = WAL');
    raw.exec(MIGRATIONS[0]); raw.exec(MIGRATIONS[1]);
    raw.pragma('user_version = 2');
    raw.prepare("INSERT INTO users (id,password_hash,status,created_at,email,email_verified_at,created_via) VALUES ('osaka','h','active','2026-11-22T00:00:00Z','o@example.org','2026-11-22T00:01:00Z','register')").run();
    raw.prepare("INSERT INTO users (id,password_hash,status,created_at) VALUES ('frozen','h','disabled','2026-11-22T00:00:00Z')").run();
    raw.prepare("INSERT INTO stations (id,lat_grid,lon_grid,listed,public_description,event_count) VALUES ('osaka',34.65,135.55,1,'hello',7)").run();
    raw.close();

    const db = openDb(dir);
    assert.equal(db.pragma('user_version', { simple: true }), 3);
    const s = db.prepare("SELECT * FROM stations WHERE id='osaka'").get();
    assert.equal(s.listed, 1, 'what was on the map stays on the map');
    assert.equal(s.admin_hold, 0);
    assert.equal(s.description_hidden, 0);
    assert.equal(s.public_description, 'hello');
    assert.equal(db.prepare("SELECT prev_status FROM users WHERE id='frozen'").get().prev_status, null);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM admins').get().n, 0, 'nobody becomes an operator by upgrading');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM admin_audit').get().n, 0);
    // the audit table has no foreign key, so a row outlives the station it names
    assert.equal(db.prepare("PRAGMA foreign_key_list('admin_audit')").all().length, 0);
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
