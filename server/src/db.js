'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 4;

// Forward-only migrations keyed on PRAGMA user_version. Never edit a step that has
// shipped: add a new one. (Step 0 -> 1 shipped in server-v0.1.0.)
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

  // 1 -> 2: self-registration (Phase 3) and the public viewer (Phase 5).
  `
  -- Phase 3: accounts people register themselves.
  ALTER TABLE users ADD COLUMN email             TEXT;     -- normalised (lower case); NULL for seeded accounts; never public
  ALTER TABLE users ADD COLUMN email_verified_at TEXT;
  ALTER TABLE users ADD COLUMN consent_version   TEXT;     -- which terms text the person agreed to
  ALTER TABLE users ADD COLUMN consent_at        TEXT;
  ALTER TABLE users ADD COLUMN created_via       TEXT NOT NULL DEFAULT 'seed';   -- 'seed' | 'register'
  CREATE UNIQUE INDEX users_email ON users(email) WHERE email IS NOT NULL;

  -- Single-use links sent by mail. Only a hash of the token is stored.
  CREATE TABLE auth_tokens (
    id         INTEGER PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('verify','reset')),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at    TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX auth_tokens_user ON auth_tokens(user_id, kind);

  -- How many mails went out per recipient (a hash, not the address) and in total, per UTC day:
  -- the brake on using this server to send mail to other people.
  CREATE TABLE mail_counters (
    key TEXT NOT NULL,
    day TEXT NOT NULL,
    n   INTEGER NOT NULL,
    PRIMARY KEY (key, day)
  ) WITHOUT ROWID;

  -- Small facts about this database itself. 'stats_built' is set once the statistics have been built
  -- from the JSONL files, which the server does on the first start after the upgrade.
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID;

  -- A deleted station id cannot be taken over by someone else for a while.
  CREATE TABLE deleted_ids (
    id         TEXT PRIMARY KEY,
    deleted_at TEXT NOT NULL
  );

  -- Phase 5: what the public map and the graphs show.
  -- listed = 0 keeps a station off the public map. Seeded stations start unlisted; so do
  -- self-registered ones unless the operator turns AUTO_LIST_ON_VERIFY on.
  ALTER TABLE stations ADD COLUMN listed             INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE stations ADD COLUMN public_description TEXT;   -- written by the owner on the account page only

  -- Derived data: it can always be rebuilt from the JSONL files (scripts/rebuild-stats.js).
  -- One row per (run, UTC hour). The events-per-hour figure comes from the device's own event
  -- counter (max - min within the hour), not from how many rows arrived, because the console can
  -- thin events out (decimate) and uploads can be interrupted.
  CREATE TABLE stats_hourly (
    station_id  TEXT    NOT NULL,
    run_id      TEXT    NOT NULL,
    hour        TEXT    NOT NULL,        -- 'YYYY-MM-DDTHH' in UTC
    rows        INTEGER NOT NULL,        -- rows received (informational)
    min_event   INTEGER NOT NULL,
    max_event   INTEGER NOT NULL,
    min_time_us INTEGER NOT NULL,
    max_time_us INTEGER NOT NULL,
    temp_sum    REAL    NOT NULL DEFAULT 0,
    temp_n      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (station_id, run_id, hour)
  ) WITHOUT ROWID;
  CREATE INDEX stats_hourly_hour ON stats_hourly(station_id, hour);

  -- ADC histogram per UTC day, 64 bins of 64 counts (the last bin also takes anything above).
  CREATE TABLE stats_adc (
    station_id TEXT    NOT NULL,
    day        TEXT    NOT NULL,
    bin        INTEGER NOT NULL,
    n          INTEGER NOT NULL,
    PRIMARY KEY (station_id, day, bin)
  ) WITHOUT ROWID;
  `,

  // 2 -> 3: operator tools (a web page and the CLI share them).
  `
  -- Operators are NOT stations: they have their own table, never appear on the map, never upload, and
  -- their login (POST /admin/login) issues a token that the station routes refuse (and vice versa).
  CREATE TABLE admins (
    name          TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    token_version INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
  );

  -- Who did what, when. No foreign keys, so a row survives the deletion of the station it is about,
  -- and no e-mail address or description text is ever written here: only names, ids and fixed words.
  CREATE TABLE admin_audit (
    id     INTEGER PRIMARY KEY,
    at     TEXT NOT NULL,
    actor  TEXT NOT NULL,           -- an admin name, or 'cli' for a command run on the server
    action TEXT NOT NULL,
    target TEXT,                    -- a station id
    detail TEXT                     -- a short fixed word, never user text
  );
  CREATE INDEX admin_audit_at ON admin_audit(at);

  -- An operator took the station off the map: neither the owner's own switch nor the automatic
  -- listing at confirmation may put it back. Only an operator lists it again.
  ALTER TABLE stations ADD COLUMN admin_hold         INTEGER NOT NULL DEFAULT 0;
  -- An operator hid the owner's introduction text. An edit by the owner does not clear it.
  ALTER TABLE stations ADD COLUMN description_hidden INTEGER NOT NULL DEFAULT 0;

  -- The status an account had before an operator disabled it, so enabling it again does not
  -- skip e-mail confirmation (NULL for accounts disabled before this column existed).
  ALTER TABLE users ADD COLUMN prev_status TEXT;
  `,

  // 3 -> 4: the ADC histogram at a fine resolution, so the width of its bars can be chosen on the station page.
  // stats_adc keeps its 64-count bars (what an older release reads). This one is created EMPTY: filling it
  // from the files of millions of events takes longer than a start may (deploy.sh waits 20 s), so it is
  // filled by scripts/rebuild-stats.js, which then sets meta 'adc_fine_built'. Until then the pages use stats_adc.
  `
  CREATE TABLE stats_adc_fine (
    station_id TEXT    NOT NULL,
    day        TEXT    NOT NULL,
    bin        INTEGER NOT NULL,        -- floor(adc / 4), at most 1023 (the last bin also takes anything above 4095)
    n          INTEGER NOT NULL,
    PRIMARY KEY (station_id, day, bin)
  ) WITHOUT ROWID;
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

module.exports = { openDb, SCHEMA_VERSION, MIGRATIONS };
