'use strict';
// Bring the OLD server's measurements into this server (plan, section 5).
//
//   node scripts/import-legacy.js --from /opt/cosmicray-server                 dry run: reads, prints, writes nothing
//   node scripts/import-legacy.js --from /opt/cosmicray-server --commit        really imports
//   ... --station sendai --station waseda                                      only these stations (repeatable)
//
// What it does, per station directory found in <from>/cosmicray-data:
//   * reads every *.dat file (see src/legacy.js for the three row layouts and what is an estimate);
//   * writes the rows as events/<id>/<UTC day>.legacy.jsonl (a stream of its own, next to the live one);
//   * creates a RESERVED account: status "legacy_unclaimed", a password nobody can match, so the id cannot
//     be registered by someone else and nobody can log in to it. The old password hashes are NOT imported
//     and users.json is never opened;
//   * keeps only the rounded 0.1-degree position of the old config.json, and its comment as a private note;
//   * rebuilds that station's statistics from the files.
// The station is not listed on the map (listed = 0). Running it again gives the same result: the station's
// legacy files are written afresh every time. A station id that a live account already uses is skipped.
//
// The old directory is only read. Run it as the service user, e.g.
//   sudo -u cosmicray bash -c 'cd /opt/cosmicray-v3/current && /opt/node-v22.23.4/bin/node --env-file=/etc/cosmicray/env scripts/import-legacy.js --from /opt/cosmicray-server'
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { roundPosition } = require('../src/geo');
const stats = require('../src/stats');
const { parseDatFile, JST_OFFSET_MIN } = require('../src/legacy');
const { STATION_ID } = require('../src/app');

const NO_PASSWORD = '!legacy-reserved';        // not a scrypt hash: verifyPassword refuses it for any input

function parseArgs(argv) {
  const a = { from: null, commit: false, stations: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from') a.from = argv[++i];
    else if (argv[i] === '--commit') a.commit = true;
    else if (argv[i] === '--station') a.stations.push(String(argv[++i] || '').toLowerCase());
    else { console.error(`unknown argument: ${argv[i]}`); process.exit(2); }
  }
  if (!a.from) { console.error('usage: import-legacy.js --from <old server dir> [--station <id>]... [--commit]'); process.exit(2); }
  return a;
}

const fmt = (n) => n.toLocaleString('en-US');

// What one old station directory holds, parsed. onFile(name, parsed) is called per file in date order.
function readStation(dir, onFile) {
  const names = fs.readdirSync(dir).filter((f) => f.endsWith('.dat')).sort();
  const total = { files: names.length, rows: 0, layouts: { C7: 0, A: 0, B: 0 }, skipped: {}, examples: {}, first: null, last: null, runs: new Set(),
                  c7drift: { n: 0, max: 0, over600: 0 } };
  for (const name of names) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const p = parseDatFile(text, name);
    for (const [k, v] of Object.entries(p.layouts)) total.layouts[k] += v;
    for (const [k, v] of Object.entries(p.skipped)) {
      total.skipped[k] = (total.skipped[k] || 0) + v;
      if (!(k in total.examples)) total.examples[k] = `${name} ${p.examples[k]}`;
    }
    for (const r of p.records) {
      total.rows++;
      total.runs.add(r.run_id);
      if (total.first === null || r.t < total.first) total.first = r.t;
      if (total.last === null || r.t > total.last) total.last = r.t;
      if (r.lg.startsWith('C7:')) {                     // does the Japan-time date agree with the epoch column?
        const d = Math.abs(Date.parse(r.t) - r.time_us / 1000) / 1000;
        total.c7drift.n++; if (d > total.c7drift.max) total.c7drift.max = d; if (d > 600) total.c7drift.over600++;
      }
    }
    onFile(name, p);
  }
  return total;
}

function readConfig(dir) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    const pos = roundPosition(c.gps_latitude, c.gps_longitude);
    return {
      pos,                                                               // rounded; the raw numbers are dropped here
      comment: typeof c.comment === 'string' ? c.comment.slice(0, 500) : null,
      setup: typeof c.created_at === 'string' ? c.created_at.slice(0, 40) : null,
    };
  } catch (_) { return { pos: null, comment: null, setup: null }; }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataRoot = path.join(args.from, 'cosmicray-data');
  if (!fs.existsSync(dataRoot)) { console.error(`no cosmicray-data directory in ${args.from}`); process.exit(1); }

  const cfg = loadConfig(process.env, { quiet: true });
  const db = args.commit ? openDb(cfg.dataDir) : null;
  let checkDb = db;                                   // a dry run looks at an existing database, read only
  if (!checkDb) { try { checkDb = openDbReadOnly(cfg.dataDir); } catch (_) { checkDb = null; } }
  const eventsRoot = path.join(cfg.dataDir, 'events');
  const nowIso = new Date().toISOString();

  const found = fs.readdirSync(dataRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const wanted = args.stations.length ? found.filter((s) => args.stations.includes(s)) : found;
  for (const s of args.stations) if (!found.includes(s)) console.log(`(no such station in the old data: ${s})`);

  console.log(args.commit ? 'IMPORT (writes to the database and the event files)' : 'DRY RUN (nothing is written; add --commit to import)');
  console.log(`old data: ${dataRoot}   new data: ${cfg.dataDir}\n`);

  let failures = 0;
  for (const id of wanted) {
    const dir = path.join(dataRoot, id);
    if (!STATION_ID.test(id)) { console.log(`${id}: skipped (not a valid station id here)`); failures++; continue; }

    // The dry run also checks the database when it can, so it can warn before a real run.
    let existing = null;
    try { existing = checkDb ? checkDb.prepare('SELECT status FROM users WHERE id=?').get(id) : null; } catch (_) { /* no users table yet */ }
    if (existing && existing.status !== 'legacy_unclaimed') {
      console.log(`${id}: SKIPPED, a live account (${existing.status}) already uses this id`); failures++; continue;
    }

    const conf = readConfig(dir);
    const perDay = new Map();                      // only used when committing: lines of ONE source file, by UTC day
    let written = 0;
    const outDir = path.join(eventsRoot, id);
    if (args.commit) {
      fs.mkdirSync(outDir, { recursive: true });
      for (const f of fs.readdirSync(outDir)) if (/\.legacy\.jsonl$/.test(f)) fs.unlinkSync(path.join(outDir, f));
    }
    const created = new Set();
    const total = readStation(dir, (name, p) => {
      if (!args.commit || !p.records.length) return;
      perDay.clear();
      for (const r of p.records) {
        const day = r.t.slice(0, 10);
        if (!perDay.has(day)) perDay.set(day, []);
        perDay.get(day).push(JSON.stringify(r));
      }
      for (const [day, lines] of perDay) {
        const file = path.join(outDir, `${day}.legacy.jsonl`);
        let chunk = lines.join('\n') + '\n';
        if (!created.has(day)) {
          const header = { kind: 'header', format_version: 1, station: id, day, created: nowIso, stream: 'legacy', source: 'legacy-import',
                           tz: 'Asia/Tokyo', tz_offset_min: JST_OFFSET_MIN,
                           note: 'Imported from the old server. t is the old Japan-time date converted to UTC. Layouts A and B are estimated (see src/legacy.js).' };
          chunk = JSON.stringify(header) + '\n' + chunk;
          created.add(day);
        }
        fs.appendFileSync(file, chunk);
        written += lines.length;
      }
    });

    const sk = Object.entries(total.skipped).map(([k, v]) => `${k}=${fmt(v)}`).join(', ') || 'none';
    console.log(`${id}`);
    console.log(`   files ${total.files}, rows read ${fmt(total.rows + Object.values(total.skipped).reduce((a, b) => a + b, 0))}, usable ${fmt(total.rows)}  (C7 ${fmt(total.layouts.C7)}, A ${fmt(total.layouts.A)}, B ${fmt(total.layouts.B)})`);
    console.log(`   skipped: ${sk}`);
    for (const [k, v] of Object.entries(total.examples)) console.log(`      e.g. ${k}: ${v.slice(0, 120)}`);
    console.log(`   time range (UTC): ${total.first || '-'}  ..  ${total.last || '-'}   runs: ${fmt(total.runs.size)}   position: ${conf.pos ? 'yes (rounded to 0.1 deg)' : 'none'}   note: ${conf.comment ? 'yes' : 'none'}`);
    if (total.c7drift.n) console.log(`   C7 check, date vs. epoch column: largest gap ${total.c7drift.max.toFixed(1)} s, rows over 10 min: ${fmt(total.c7drift.over600)} of ${fmt(total.c7drift.n)}`);

    if (!args.commit) continue;
    if (total.rows === 0) { console.log('   nothing to import for this station'); continue; }
    if (written !== total.rows) { console.log(`   ERROR: wrote ${written} rows, parsed ${total.rows}`); failures++; continue; }

    db.transaction(() => {
      db.prepare("INSERT OR IGNORE INTO users (id, password_hash, status, created_at, created_via) VALUES (?, ?, 'legacy_unclaimed', ?, 'legacy')")
        .run(id, NO_PASSWORD, nowIso);
      db.prepare('INSERT OR IGNORE INTO stations (id) VALUES (?)').run(id);
      db.prepare(`UPDATE stations SET lat_grid = COALESCE(?, lat_grid), lon_grid = COALESCE(?, lon_grid),
                    private_comment = COALESCE(?, private_comment), setup_at = COALESCE(?, setup_at),
                    last_seen_utc = ?, event_count = ?
                  WHERE id = ?`)
        .run(conf.pos ? conf.pos.lat : null, conf.pos ? conf.pos.lon : null, conf.comment, conf.setup, total.last.slice(0, 23) + 'Z', total.rows, id);
    })();
    stats.rebuild(db, cfg.dataDir, id);

    // Count what is on disk now, and compare.
    let onDisk = 0;
    for (const f of fs.readdirSync(outDir)) {
      if (!/\.legacy\.jsonl$/.test(f)) continue;
      for (const line of fs.readFileSync(path.join(outDir, f), 'utf8').split('\n')) if (line && !line.startsWith('{"kind":"header"')) onDisk++;
    }
    const ok = onDisk === total.rows;
    if (!ok) failures++;
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`legacy_import:${id}`, JSON.stringify({
      at: nowIso, rows: total.rows, layouts: total.layouts, skipped: total.skipped, first: total.first, last: total.last, files: total.files,
    }));
    console.log(`   written: ${fmt(onDisk)} rows in ${fs.readdirSync(outDir).filter((f) => /\.legacy\.jsonl$/.test(f)).length} day files   ${ok ? 'OK, matches the parsed count' : 'MISMATCH with ' + fmt(total.rows)}`);
  }
  console.log(args.commit ? '\nDone.' : '\nDry run finished. Nothing was written.');
  if (checkDb && checkDb !== db) checkDb.close();
  if (db) db.close();
  process.exit(failures ? 1 : 0);
}

// A dry run should not create a database; it opens one only if it exists (read only).
function openDbReadOnly(dataDir) {
  const p = path.join(dataDir, 'db.sqlite');
  if (!fs.existsSync(p)) return null;
  const Database = require('better-sqlite3');
  return new Database(p, { readonly: true, fileMustExist: true });
}

main();
