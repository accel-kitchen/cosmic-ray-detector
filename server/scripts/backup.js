'use strict';
// Back up the server's data. Meant for a nightly systemd timer (deploy/).
//
//   node scripts/backup.js <destDir> [--keep N]      (DATA_DIR from the environment)
//
// - db.sqlite is copied with SQLite's own online backup (better-sqlite3), which
//   gives a consistent snapshot while the server is running; the `sqlite3`
//   command-line tool is NOT needed. One snapshot per run, the newest N kept.
// - events/ is a mirror: the files are append-only, so a file is copied again
//   when its size changed. A copy taken mid-write can end in a partial last
//   line; the next run replaces it.
//
// Where destDir lives (another disk, another machine) is the operator's choice.
// Deleting a participant's data must also remove it from destDir: see the plan, Q-N12. A deleted
// station leaves events/ at the next run, waits 14 days in removed/, then is gone; the DB copies
// rotate out after `--keep` runs (14 nights).
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function mirror(src, dst) {
  let copied = 0;
  if (!fs.existsSync(src)) return copied;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) { copied += mirror(s, d); continue; }
    if (!e.isFile()) continue;
    const have = fs.existsSync(d) ? fs.statSync(d).size : -1;
    if (have !== fs.statSync(s).size) { fs.copyFileSync(s, d); copied++; }
  }
  return copied;
}

// A station whose directory is gone from the data (the account was deleted) must go from the mirror too,
// or "delete my account" would leave the measurements in the backup for ever. It is MOVED to removed/<stamp>/
// first and dropped after `removedKeepDays`: if the data directory ever looks empty by mistake, the
// backup is not wiped by the very next nightly run.
function retire(srcEvents, dstEvents, removedDir, stamp, nowMs, removedKeepDays) {
  let moved = 0;
  if (fs.existsSync(dstEvents)) {
    for (const e of fs.readdirSync(dstEvents, { withFileTypes: true })) {
      if (!e.isDirectory() || fs.existsSync(path.join(srcEvents, e.name))) continue;
      const to = path.join(removedDir, stamp);
      fs.mkdirSync(to, { recursive: true });
      fs.renameSync(path.join(dstEvents, e.name), path.join(to, e.name));
      moved++;
    }
  }
  let dropped = 0;
  if (fs.existsSync(removedDir)) {
    for (const e of fs.readdirSync(removedDir, { withFileTypes: true })) {
      const p = path.join(removedDir, e.name);
      if (nowMs - fs.statSync(p).mtimeMs > removedKeepDays * 24 * 3600 * 1000) { fs.rmSync(p, { recursive: true, force: true }); dropped++; }
    }
  }
  return { moved, dropped };
}

// deploy.sh keeps a database copy from before each switch in <dest>/pre-deploy. They hold e-mail
// addresses too, and a copy is only useful right after its own deploy: nothing older than
// `days` stays (the newest always does), so a deleted account leaves these as well.
function prunePreDeploy(dir, nowMs, days) {
  if (!fs.existsSync(dir)) return 0;
  const files = fs.readdirSync(dir).filter((f) => /^db-before-.*\.sqlite$/.test(f))
    .map((f) => ({ p: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  let n = 0;
  for (const f of files.slice(1)) if (nowMs - f.t > days * 24 * 3600 * 1000) { fs.rmSync(f.p); n++; }
  return n;
}

async function runBackup(dataDir, destDir, { keep = 14, removedKeepDays = 14, now = () => new Date() } = {}) {
  const dbDir = path.join(destDir, 'db');
  fs.mkdirSync(dbDir, { recursive: true });

  const stamp = now().toISOString().replace(/[:.]/g, '-');          // 2026-11-21T00-43-42-341Z
  const dbOut = path.join(dbDir, `db-${stamp}.sqlite`);
  const src = new Database(path.join(dataDir, 'db.sqlite'), { readonly: true, fileMustExist: true });
  try { await src.backup(dbOut); } finally { src.close(); }

  const srcEvents = path.join(dataDir, 'events');
  const dstEvents = path.join(destDir, 'events');
  const copied = mirror(srcEvents, dstEvents);
  const gone = retire(srcEvents, dstEvents, path.join(destDir, 'removed'), stamp, now().getTime(), removedKeepDays);

  const preDeployDropped = prunePreDeploy(path.join(destDir, 'pre-deploy'), now().getTime(), removedKeepDays);

  const snaps = fs.readdirSync(dbDir).filter((f) => /^db-.*\.sqlite$/.test(f)).sort();
  const drop = snaps.slice(0, Math.max(0, snaps.length - keep));
  for (const f of drop) fs.rmSync(path.join(dbDir, f));

  return { db: dbOut, eventFilesCopied: copied, snapshotsKept: snaps.length - drop.length, stationsRetired: gone.moved, retiredDropped: gone.dropped, preDeployDropped };
}

module.exports = { runBackup, mirror };

if (require.main === module) {
  const { loadConfig } = require('../src/config');
  const args = process.argv.slice(2);
  const dest = args[0];
  const k = args.indexOf('--keep');
  const keep = k >= 0 ? Number(args[k + 1]) : 14;
  if (!dest || !Number.isInteger(keep) || keep < 1) {
    console.error('usage: backup.js <destDir> [--keep N]');
    process.exit(2);
  }
  const cfg = loadConfig(process.env, { quiet: true });
  runBackup(cfg.dataDir, path.resolve(dest), { keep })
    .then((r) => console.log(`backup ok: ${r.db}; event files copied: ${r.eventFilesCopied}; snapshots kept: ${r.snapshotsKept}; deleted stations set aside: ${r.stationsRetired}, dropped: ${r.retiredDropped}`))
    .catch((e) => { console.error('backup FAILED:', e.message); process.exit(1); });
}
