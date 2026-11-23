'use strict';
// Recompute the statistics behind the public graphs from the JSONL files.
//
//   node scripts/rebuild-stats.js [station-id]        (DATA_DIR from the environment)
//   With no station id: every station, one after the other, and then the fine ADC table is marked complete.
//   With one: only that station (the mark is not set).
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
const fs = require('fs');
const path = require('path');
const cfg = loadConfig(process.env, { quiet: true });
const db = openDb(cfg.dataDir);
if (only) {
  const n = rebuild(db, cfg.dataDir, only);
  console.log(`rebuilt statistics from ${n} events of ${only}`);
} else {
  // One station per transaction: a single transaction over millions of events would hold the database for longer
  // than a live upload waits (busy_timeout), while the service is running. When every station is done the fine ADC
  // table is complete, and the pages start to offer the narrow bars (meta 'adc_fine_built').
  const eventsDir = path.join(cfg.dataDir, 'events');
  const stations = fs.existsSync(eventsDir) ? fs.readdirSync(eventsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
  let total = 0;
  for (const s of stations) {
    const t0 = Date.now();
    const n = rebuild(db, cfg.dataDir, s);
    total += n;
    console.log(`  ${s}: ${n} events (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('adc_fine_built', ?)").run(new Date().toISOString());
  console.log(`rebuilt statistics from ${total} events of ${stations.length} station(s); the fine ADC table is complete`);
}
db.close();
