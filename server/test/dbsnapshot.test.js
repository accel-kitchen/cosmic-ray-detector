'use strict';
// Rolling a release back must be able to put the database back too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { openDb, MIGRATIONS, SCHEMA_VERSION } = require('../src/db');
const snap = require('../scripts/db-snapshot');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crd-snap-'));
const cli = (...a) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'db-snapshot.js'), ...a], { encoding: 'utf8' });

test('snapshot of a RUNNING database is consistent, and restoring it undoes later changes', async () => {
  const data = tmp(), dest = path.join(tmp(), 'sub', 'before.sqlite');
  try {
    const live = openDb(data);                                         // open (WAL), as the running server would be
    const ins = live.prepare("INSERT INTO users (id,password_hash,status,created_at) VALUES (?, 'h', 'active', 't')");
    ins.run('one-aa'); ins.run('two-bb');

    assert.equal(await snap.snapshot(data, dest), SCHEMA_VERSION);
    ins.run('three-cc');                                               // written after the snapshot
    assert.equal(live.prepare('SELECT COUNT(*) n FROM users').get().n, 3);
    live.close();

    assert.equal(snap.restore(data, dest), SCHEMA_VERSION);
    const back = openDb(data);
    assert.deepEqual(back.prepare('SELECT id FROM users ORDER BY id').all().map((r) => r.id), ['one-aa', 'two-bb']);
    back.close();
    assert.equal(fs.existsSync(path.join(data, 'db.sqlite-wal')) && fs.statSync(path.join(data, 'db.sqlite-wal')).size > 0, false, 'no stale journal after a restore');
  } finally { fs.rmSync(data, { recursive: true, force: true }); fs.rmSync(path.dirname(path.dirname(dest)), { recursive: true, force: true }); }
});

test('the rollback case: a new release migrates the database, the old schema is brought back by the snapshot', async () => {
  const data = tmp(), file = path.join(tmp(), 'v1.sqlite');
  try {
    // the database the shipped release (schema 1) wrote
    const v1 = new Database(path.join(data, 'db.sqlite'));
    v1.pragma('journal_mode = WAL');
    v1.exec(MIGRATIONS[0]);
    v1.pragma('user_version = 1');
    v1.prepare("INSERT INTO users (id,password_hash,status,created_at) VALUES ('sendai','h','active','t')").run();
    v1.close();

    assert.equal(await snap.snapshot(data, file), 1);                 // taken before the switch
    openDb(data).close();                                              // the new release starts and migrates
    assert.equal(snap.version(path.join(data, 'db.sqlite')), SCHEMA_VERSION);
    assert.ok(SCHEMA_VERSION > 1);

    // the health check failed: stop, put the old schema back
    assert.equal(snap.restore(data, file), 1);
    assert.equal(snap.version(path.join(data, 'db.sqlite')), 1, 'the old release can start again');
    const db = new Database(path.join(data, 'db.sqlite'), { readonly: true });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE id='sendai'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'stats_hourly'").get().n, 0, 'the new tables are gone with the new schema');
    db.close();
  } finally { fs.rmSync(data, { recursive: true, force: true }); fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

test('a damaged snapshot is refused, and the live database is left untouched', async () => {
  const data = tmp(), bad = path.join(tmp(), 'bad.sqlite');
  try {
    openDb(data).close();
    const before = fs.readFileSync(path.join(data, 'db.sqlite'));
    fs.writeFileSync(bad, 'this is not a database at all, and long enough to look like a file'.repeat(40));
    assert.throws(() => snap.restore(data, bad));
    assert.deepEqual(fs.readFileSync(path.join(data, 'db.sqlite')), before);
    assert.throws(() => snap.restore(data, path.join(data, 'missing.sqlite')));
  } finally { fs.rmSync(data, { recursive: true, force: true }); fs.rmSync(path.dirname(bad), { recursive: true, force: true }); }
});

test('snapshot refuses when there is no database, and the command line reports it', async () => {
  const data = tmp();
  try {
    await assert.rejects(() => snap.snapshot(data, path.join(data, 'x.sqlite')));
    const r = cli('snapshot', data, path.join(data, 'x.sqlite'));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /FAILED/);
    assert.equal(cli('nonsense').status, 2);
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

test('command line: snapshot, version and restore work end to end', () => {
  const data = tmp(), out = path.join(tmp(), 'snap.sqlite');
  try {
    openDb(data).close();
    const s = cli('snapshot', data, out);
    assert.equal(s.status, 0, s.stderr);
    assert.match(s.stdout, new RegExp(`schema ${SCHEMA_VERSION}`));
    assert.equal(cli('version', out).stdout.trim(), String(SCHEMA_VERSION));
    const r = cli('restore', data, out);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /restored schema/);
  } finally { fs.rmSync(data, { recursive: true, force: true }); fs.rmSync(path.dirname(out), { recursive: true, force: true }); }
});
