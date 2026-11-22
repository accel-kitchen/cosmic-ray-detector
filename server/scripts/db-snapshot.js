'use strict';
// A consistent copy of the database, and putting one back. Used by deploy/deploy.sh around a release
// switch, because a new release may MIGRATE the database to a newer schema, and the previous release
// refuses to start on a schema newer than it knows. Rolling back the code alone would then leave
// nothing that can run: the database has to go back with it.
//
//   node scripts/db-snapshot.js snapshot <dataDir> <destFile>   online backup (the server may be running)
//   node scripts/db-snapshot.js restore  <dataDir> <srcFile>    replace db.sqlite (the service must be stopped)
//   node scripts/db-snapshot.js version  <file>                 print PRAGMA user_version
//
// Rolling the database back loses what was written to it after the snapshot: new sign-ups, tokens,
// duplicate keys, statistics. The measurements themselves are not lost (the JSONL files are the
// source of truth); run scripts/rebuild-stats.js afterwards to rebuild the statistics.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function check(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const ok = db.pragma('integrity_check', { simple: true });
    if (ok !== 'ok') throw new Error(`${file} failed its integrity check: ${ok}`);
    return db.pragma('user_version', { simple: true });
  } finally { db.close(); }
}

function version(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try { return db.pragma('user_version', { simple: true }); } finally { db.close(); }
}

async function snapshot(dataDir, dest) {
  const src = new Database(path.join(dataDir, 'db.sqlite'), { readonly: true, fileMustExist: true });
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) fs.rmSync(dest);
    await src.backup(dest);
  } finally { src.close(); }
  return check(dest);                                   // a snapshot that does not open is worse than none
}

function restore(dataDir, srcFile) {
  const v = check(srcFile);                              // refuse to put a bad file in place of a live database
  const live = path.join(dataDir, 'db.sqlite');
  for (const ext of ['-wal', '-shm']) fs.rmSync(live + ext, { force: true });   // stale journals would corrupt the restored file
  fs.copyFileSync(srcFile, live);
  return v;
}

module.exports = { snapshot, restore, version, check };

if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2);
  const usage = () => { console.error('usage: db-snapshot.js snapshot <dataDir> <destFile> | restore <dataDir> <srcFile> | version <file>'); process.exit(2); };
  (async () => {
    if (cmd === 'snapshot' && a && b) console.log(`snapshot ok (schema ${await snapshot(a, b)}): ${b}`);
    else if (cmd === 'restore' && a && b) console.log(`restored schema ${restore(a, b)} from ${b}`);
    else if (cmd === 'version' && a) console.log(String(version(a)));
    else usage();
  })().catch((e) => { console.error(`db-snapshot ${cmd} FAILED: ${e.message}`); process.exit(1); });
}
