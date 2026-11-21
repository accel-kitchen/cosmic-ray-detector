'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 1;

// Forward-only migrations keyed on PRAGMA user_version. Phase 3 adds email and
// consent columns as a new step; never edit a step that has shipped.
const MIGRATIONS = [
  // 0 -> 1
  `
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,                 -- station id, lower case
    password_hash TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('active','pending_email','legacy_unclaimed','disabled')),
    token_version INTEGER NOT NULL DEFAULT 0,       -- bump to revoke every issued token
    created_at    TEXT NOT NULL
  );

  -- One station per account. Only the ROUNDED grid centre of the position is
  -- stored: the raw coordinates the console sends are never written anywhere.
  CREATE TABLE stations (
    id              TEXT PRIMARY KEY REFERENCES users(id),
    lat_grid        REAL,
    lon_grid        REAL,
    private_comment TEXT,                           -- from /setup-id; never public
    setup_at       TEXT,
    last_seen_utc   TEXT,
    event_count     INTEGER NOT NULL DEFAULT 0
  );

  -- Duplicate guard for the one-event-per-POST API: a retry after a lost
  -- response must not append a second line. 'day' lets old keys be pruned.
  CREATE TABLE ingest_keys (
    station_id TEXT    NOT NULL,
    run_id     TEXT    NOT NULL,
    event      INTEGER NOT NULL,
    time_us    INTEGER NOT NULL,
    day        TEXT    NOT NULL,
    PRIMARY KEY (station_id, run_id, event, time_us)
  ) WITHOUT ROWID;
  CREATE INDEX ingest_keys_day ON ingest_keys(day);
  `,
];

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'db.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  try {
    let v = db.pragma('user_version', { simple: true });
    if (v > SCHEMA_VERSION) {
      throw new Error(`database schema ${v} is newer than this server (${SCHEMA_VERSION})`);
    }
    while (v < SCHEMA_VERSION) {
      const step = MIGRATIONS[v];
      db.transaction(() => {
        db.exec(step);
        db.pragma(`user_version = ${v + 1}`);
      })();
      v++;
    }
  } catch (e) {
    db.close();          // do not leave the file locked when refusing to start
    throw e;
  }
  return db;
}

module.exports = { openDb, SCHEMA_VERSION };
