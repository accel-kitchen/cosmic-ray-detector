'use strict';
// Operator commands, run on the server as the cosmicray user. The same changes can be made on the
// operator page (/admin); both go through src/operator.js and both leave a row in the audit log
// (the actor is 'cli' here).
//
//   Stations
//     node scripts/admin.js list
//     node scripts/admin.js show <id>
//     node scripts/admin.js list-on <id>        put the station on the public map (clears an operator hold)
//     node scripts/admin.js list-off <id>       take it off the map and HOLD it there: its owner cannot switch it back on
//     node scripts/admin.js hide-description <id> | show-description <id>
//     node scripts/admin.js disable <id>        stop it logging in and uploading (tokens are revoked)
//     node scripts/admin.js enable <id>         back to the status it had before (never skips e-mail confirmation)
//     node scripts/admin.js delete <id> --yes   remove the account and ALL its data (files, statistics). CLI only.
//     node scripts/admin.js prune-unverified    drop registrations never confirmed within UNVERIFIED_DAYS
//
//   Operator accounts for the /admin page (they are not stations)
//     node scripts/admin.js admin-create <name>          the password is asked for (hidden), or read from stdin, or from --password-env NAME
//     node scripts/admin.js admin-password <name>        change it (every token of that operator stops working)
//     node scripts/admin.js admin-disable <name> | admin-enable <name> | admin-list
//     node scripts/admin.js audit [N]                    the last N operator actions (default 50)
//
// The e-mail address is shown here and on the operator page (looking at one station is logged), and to the
// owner on their own account page. Nowhere else.
const { loadConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { deleteAccount, pruneUnverified } = require('../src/accounts');
const { hashPassword } = require('../src/password');
const { createOperator } = require('../src/operator');
const { STATION_ID } = require('../src/app');

const ADMIN_MIN_PASSWORD = 8;      // the operator's choice (2026-11-22): 8+ characters, letters and digits are fine. The login limits do the rest.
const [cmd, rawId, flag] = process.argv.slice(2);
const id = (rawId || '').toLowerCase();
const fail = (m) => { console.error(m); process.exit(2); };
const needId = () => { if (!STATION_ID.test(id)) fail(`${cmd} needs a station id (3-32 chars of a-z 0-9 _ -)`); };

// A password is never taken from the command line (it would stay in the shell history and in `ps`).
function readSecret(prompt) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {                         // piped: one line from stdin
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => { buf += d; });
      process.stdin.on('end', () => resolve(buf.split(/\r?\n/)[0]));
      return;
    }
    process.stderr.write(prompt);
    let s = '';
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.removeListener('data', onData);
          process.stderr.write('\n'); return resolve(s);
        }
        if (c === '\u0003') { process.stderr.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') s = s.slice(0, -1); else s += c;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function newPassword(name) {
  const envName = process.argv.indexOf('--password-env');
  let p;
  if (envName >= 0) {
    p = process.env[process.argv[envName + 1]];
  } else {
    p = await readSecret(`password for ${name} (${ADMIN_MIN_PASSWORD}+ characters): `);
    if (process.stdin.isTTY) {
      const again = await readSecret('again: ');
      if (again !== p) fail('the two entries differ');
    }
  }
  if (typeof p !== 'string' || [...p].length < ADMIN_MIN_PASSWORD) fail(`an operator password needs ${ADMIN_MIN_PASSWORD}+ characters`);
  if (p.length > 256) fail('the password is too long (256 at most)');
  if (p.toLowerCase().includes(name)) fail('the password must not contain the name');
  return p;
}

async function main() {
  const cfg = loadConfig(process.env, { quiet: true });
  const db = openDb(cfg.dataDir);
  const op = createOperator(db);
  const user = (x) => db.prepare('SELECT * FROM users WHERE id = ?').get(x);
  const done = (r, okMsg) => { if (!r.ok) { db.close(); fail(r.message); } console.log(r.unchanged ? `${id}: no change` : okMsg); };

  switch (cmd) {
    case 'list': {
      const rows = db.prepare(`
        SELECT u.id, u.status, u.created_via AS via, u.email IS NOT NULL AS has_email,
               u.email_verified_at IS NOT NULL AS verified, COALESCE(s.listed,0) AS listed, COALESCE(s.admin_hold,0) AS hold,
               COALESCE(s.description_hidden,0) AS hidden_text,
               s.lat_grid, s.lon_grid, COALESCE(s.event_count,0) AS events, s.last_seen_utc
          FROM users u LEFT JOIN stations s ON s.id = u.id ORDER BY u.id`).all();
      console.table(rows.map((r) => ({ ...r, listed: !!r.listed, hold: !!r.hold, hidden_text: !!r.hidden_text, has_email: !!r.has_email, verified: !!r.verified })));
      break;
    }
    case 'show': {
      needId();
      const u = user(id);
      if (!u) fail(`no such station: ${id}`);
      const s = db.prepare('SELECT * FROM stations WHERE id = ?').get(id);
      const { password_hash, ...safe } = u;                       // never print the hash
      op.audit('cli', 'view-detail', id);
      console.log(JSON.stringify({ account: safe, station: s || null }, null, 2));
      break;
    }
    case 'list-on': needId(); done(op.listOn('cli', id), `${id}: now on the public map (any operator hold is cleared)`); break;
    case 'list-off': needId(); done(op.listOff('cli', id), `${id}: off the map, and held there (its owner cannot switch it back on)`); break;
    case 'hide-description': needId(); done(op.setDescriptionHidden('cli', id, true), `${id}: introduction text hidden from other people`); break;
    case 'show-description': needId(); done(op.setDescriptionHidden('cli', id, false), `${id}: introduction text shown again`); break;
    case 'disable': needId(); done(op.disable('cli', id), `${id}: disabled (existing tokens revoked)`); break;
    case 'enable': { needId(); const r = op.enable('cli', id); done(r, `${id}: enabled again as ${r.status} (existing tokens revoked)`); break; }
    case 'delete': {
      needId();
      if (!user(id)) fail(`no such station: ${id}`);
      if (flag !== '--yes') fail(`this removes ${id} and all its measurements for good. Run again with --yes.\n(Copies in the backups are not touched: plan, Q-N12.)`);
      const r = deleteAccount(db, cfg.dataDir, id);
      op.audit('cli', 'delete', id);
      console.log(`${id}: deleted${r.filesRemoved ? ' (files removed)' : ''}`);
      break;
    }
    case 'prune-unverified': {
      console.log(`removed ${pruneUnverified(db, cfg.dataDir, { days: cfg.unverifiedDays })} unconfirmed registration(s)`);
      break;
    }

    case 'admin-create': case 'admin-password': {
      if (!STATION_ID.test(id)) fail(`${cmd} needs an operator name (3-32 chars of a-z 0-9 _ -)`);
      const exists = db.prepare('SELECT 1 FROM admins WHERE name = ?').get(id);
      if (cmd === 'admin-create' && exists) fail(`${id} already exists: use admin-password to change it`);
      if (cmd === 'admin-password' && !exists) fail(`no such operator: ${id}`);
      const hash = await hashPassword(await newPassword(id), cfg.scryptN);
      if (cmd === 'admin-create') {
        db.prepare('INSERT INTO admins (name, password_hash, created_at) VALUES (?,?,?)').run(id, hash, new Date().toISOString());
        op.audit('cli', 'admin-create', id);
        console.log(`operator "${id}" created. Sign in at ${cfg.publicUrl}/admin`);
      } else {
        db.prepare('UPDATE admins SET password_hash = ?, token_version = token_version + 1 WHERE name = ?').run(hash, id);
        op.audit('cli', 'admin-password', id);
        console.log(`operator "${id}": password changed (its sessions are signed out)`);
      }
      break;
    }
    case 'admin-disable': case 'admin-enable': {
      if (!STATION_ID.test(id)) fail(`${cmd} needs an operator name`);
      const r = db.prepare('UPDATE admins SET status = ?, token_version = token_version + 1 WHERE name = ?')
        .run(cmd === 'admin-disable' ? 'disabled' : 'active', id);
      if (!r.changes) fail(`no such operator: ${id}`);
      op.audit('cli', cmd, id);
      console.log(`operator "${id}": ${cmd === 'admin-disable' ? 'disabled' : 'enabled'}`);
      break;
    }
    case 'admin-list': {
      console.table(db.prepare('SELECT name, status, created_at FROM admins ORDER BY name').all());
      break;
    }
    case 'audit': {
      const n = Math.min(1000, Math.max(1, parseInt(rawId, 10) || 50));
      console.table(db.prepare('SELECT at, actor, action, target, detail FROM admin_audit ORDER BY id DESC LIMIT ?').all(n));
      break;
    }
    default:
      fail('commands: list | show <id> | list-on <id> | list-off <id> | hide-description <id> | show-description <id> | disable <id> | enable <id> | delete <id> --yes | prune-unverified\n' +
           '          admin-create <name> | admin-password <name> | admin-disable <name> | admin-enable <name> | admin-list | audit [N]');
  }
  db.close();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
