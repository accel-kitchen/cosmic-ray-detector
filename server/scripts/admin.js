'use strict';
// Operator commands: who is registered, what is on the public map, and removing accounts.
// There is no admin web page on purpose: these run on the server, as the cosmicray user.
//
//   node scripts/admin.js list
//   node scripts/admin.js show <id>
//   node scripts/admin.js list-on <id>        put the station on the public map (needs a position and an active account)
//   node scripts/admin.js list-off <id>       take it off the map
//   node scripts/admin.js disable <id>        stop it logging in and uploading (tokens are revoked)
//   node scripts/admin.js enable <id>
//   node scripts/admin.js delete <id> --yes   remove the account and ALL its data (files, statistics)
//   node scripts/admin.js prune-unverified    drop registrations never confirmed within UNVERIFIED_DAYS
//
// The email address is shown to the operator only here: it is the one place it is ever displayed
// besides the owner's own account page.
const { loadConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { deleteAccount, pruneUnverified } = require('../src/accounts');
const { STATION_ID } = require('../src/app');

const [cmd, rawId, flag] = process.argv.slice(2);
const id = (rawId || '').toLowerCase();
const fail = (m) => { console.error(m); process.exit(2); };
const needId = () => { if (!STATION_ID.test(id)) fail(`${cmd} needs a station id (3-32 chars of a-z 0-9 _ -)`); };

const cfg = loadConfig(process.env, { quiet: true });
const db = openDb(cfg.dataDir);
const user = (x) => db.prepare('SELECT * FROM users WHERE id = ?').get(x);

switch (cmd) {
  case 'list': {
    const rows = db.prepare(`
      SELECT u.id, u.status, u.created_via AS via, u.email IS NOT NULL AS has_email,
             u.email_verified_at IS NOT NULL AS verified, COALESCE(s.listed,0) AS listed,
             s.lat_grid, s.lon_grid, COALESCE(s.event_count,0) AS events, s.last_seen_utc
        FROM users u LEFT JOIN stations s ON s.id = u.id ORDER BY u.id`).all();
    console.table(rows.map((r) => ({ ...r, listed: !!r.listed, has_email: !!r.has_email, verified: !!r.verified })));
    break;
  }
  case 'show': {
    needId();
    const u = user(id);
    if (!u) fail(`no such station: ${id}`);
    const s = db.prepare('SELECT * FROM stations WHERE id = ?').get(id);
    const { password_hash, ...safe } = u;                       // never print the hash
    console.log(JSON.stringify({ account: safe, station: s || null }, null, 2));
    break;
  }
  case 'list-on': case 'list-off': {
    needId();
    const u = user(id);
    if (!u) fail(`no such station: ${id}`);
    if (cmd === 'list-on') {
      const s = db.prepare('SELECT lat_grid FROM stations WHERE id = ?').get(id);
      if (u.status !== 'active') fail(`${id} is ${u.status}: only active accounts can be listed`);
      if (!s || s.lat_grid == null) fail(`${id} has no position yet (the console sends it at login), so it would not show on the map`);
    }
    db.prepare('UPDATE stations SET listed = ? WHERE id = ?').run(cmd === 'list-on' ? 1 : 0, id);
    console.log(`${id}: ${cmd === 'list-on' ? 'now on' : 'off'} the public map`);
    break;
  }
  case 'disable': case 'enable': {
    needId();
    if (!user(id)) fail(`no such station: ${id}`);
    db.prepare('UPDATE users SET status = ?, token_version = token_version + 1 WHERE id = ?')
      .run(cmd === 'disable' ? 'disabled' : 'active', id);
    console.log(`${id}: ${cmd}d (existing tokens revoked)`);
    break;
  }
  case 'delete': {
    needId();
    if (!user(id)) fail(`no such station: ${id}`);
    if (flag !== '--yes') fail(`this removes ${id} and all its measurements for good. Run again with --yes.\n(Copies in the backups are not touched: plan, Q-N12.)`);
    const r = deleteAccount(db, cfg.dataDir, id);
    console.log(`${id}: deleted${r.filesRemoved ? ' (files removed)' : ''}`);
    break;
  }
  case 'prune-unverified': {
    console.log(`removed ${pruneUnverified(db, cfg.dataDir, { days: cfg.unverifiedDays })} unconfirmed registration(s)`);
    break;
  }
  default:
    fail('commands: list | show <id> | list-on <id> | list-off <id> | disable <id> | enable <id> | delete <id> --yes | prune-unverified');
}
db.close();
