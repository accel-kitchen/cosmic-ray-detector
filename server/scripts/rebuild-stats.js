'use strict';
// Recompute the statistics behind the public graphs from the JSONL files.
//
//   node scripts/rebuild-stats.js [station-id]        (DATA_DIR from the environment)
//
// Run it after a restore, after importing old data, or if the graphs ever look wrong. The files
// are the source of truth; the statistics are only a summary of them. The badclock streams are
// not counted (their hour is not known).
const { loadConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { rebuild } = require('../src/stats');
const { STATION_ID } = require('../src/app');

const only = (process.argv[2] || '').toLowerCase() || null;
if (only && !STATION_ID.test(only)) {
  console.error('usage: rebuild-stats.js [station-id]');
  process.exit(2);
}
const cfg = loadConfig(process.env, { quiet: true });
const db = openDb(cfg.dataDir);
const n = rebuild(db, cfg.dataDir, only);
console.log(`rebuilt statistics from ${n} events${only ? ` of ${only}` : ''}`);
db.close();
