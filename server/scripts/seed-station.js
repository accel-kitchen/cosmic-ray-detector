'use strict';
// Create (or reset) a station account for development and acceptance tests.
// This stands in for the registration flow until Phase 3.
//
//   node scripts/seed-station.js <station-id> [--password-env NAME] [--status active]
//
// The password is read from the environment variable NAME, or generated. A
// generated password is written to <DATA_DIR>/seed-<id>.txt (not printed, so it
// does not land in a terminal log or a chat transcript).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { hashPassword } = require('../src/password');
const { STATION_ID } = require('../src/app');

async function main() {
  const args = process.argv.slice(2);
  const id = (args[0] || '').toLowerCase();
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if (!STATION_ID.test(id)) {
    console.error('usage: seed-station.js <station-id: 3-32 chars of a-z 0-9 _ ->  [--password-env NAME] [--status active|pending_email|legacy_unclaimed|disabled]');
    process.exit(2);
  }
  const status = opt('--status') || 'active';

  const cfg = loadConfig(process.env, { quiet: true });
  const db = openDb(cfg.dataDir);

  let password = null;
  const envName = opt('--password-env');
  if (envName) {
    password = process.env[envName];
    if (!password || password.length < 8) { console.error(`${envName} must hold a password of 8+ characters`); process.exit(2); }
  }
  let written = null;
  if (!password) {
    password = crypto.randomBytes(12).toString('base64url');
    written = path.join(cfg.dataDir, `seed-${id}.txt`);
    fs.writeFileSync(written, `station: ${id}\npassword: ${password}\n`, { mode: 0o600 });
  }

  const hash = await hashPassword(password, cfg.scryptN);
  db.prepare(`
    INSERT INTO users (id, password_hash, status, created_at) VALUES (?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash, status=excluded.status,
                                  token_version=token_version+1`)
    .run(id, hash, status, new Date().toISOString());
  db.prepare('INSERT OR IGNORE INTO stations (id) VALUES (?)').run(id);

  console.log(`station "${id}" ready (status: ${status}).`);
  if (written) console.log(`generated password written to ${written}`);
  db.close();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
