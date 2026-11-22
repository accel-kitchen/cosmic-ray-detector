'use strict';
const fs = require('fs');
const path = require('path');
const stats = require('./stats');

const FORMAT_VERSION = 1;

// Append-only per-station, per-UTC-day JSONL: the source of truth for
// measurements. The first line of each file is a header record.
//
// Everything below is synchronous on purpose. Node runs one request handler at
// a time and better-sqlite3 is synchronous, so "check duplicate -> append ->
// record key" cannot interleave with another request in this process.
function createEventStore(db, dataDir) {
  const eventsDir = path.join(dataDir, 'events');

  const hasKey = db.prepare(
    'SELECT 1 FROM ingest_keys WHERE station_id=? AND run_id=? AND event=? AND time_us=?');
  const addKey = db.prepare(
    'INSERT INTO ingest_keys (station_id, run_id, event, time_us, day) VALUES (?,?,?,?,?)');
  const touch = db.prepare(
    'UPDATE stations SET last_seen_utc=?, event_count=event_count+1 WHERE id=?');
  const prune = db.prepare('DELETE FROM ingest_keys WHERE day < ?');
  const statStmts = stats.prepare(db);

  // Events from a console with a badly wrong clock go to their own stream,
  // <day>.badclock.jsonl, so the main files stay clean and the odd ones are easy to find.
  function fileFor(station, day, badclock = false) {
    return path.join(eventsDir, station, `${day}${badclock ? '.badclock' : ''}.jsonl`);
  }

  // station must already be a validated id ([a-z0-9_-]), so it is path-safe.
  function append(station, rec, nowIso = new Date().toISOString()) {
    if (hasKey.get(station, rec.run_id, rec.event, rec.time_us)) {
      return { duplicate: true };
    }

    const file = fileFor(station, rec.day, rec.badclock);
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const { day, badclock, ...body } = rec;
    const stored = badclock ? { ...body, clock_suspect: true, rx: nowIso } : { ...body, rx: nowIso };
    const line = JSON.stringify(stored) + '\n';
    let chunk = line;
    if (!fs.existsSync(file)) {
      const header = { kind: 'header', format_version: FORMAT_VERSION, station, day, created: nowIso,
                       stream: badclock ? 'badclock' : 'main' };
      chunk = JSON.stringify(header) + '\n' + line;
    }
    // File first, key second: a crash in between leaves a line without a key,
    // so a retry duplicates one event instead of losing one.
    fs.appendFileSync(file, chunk);

    db.transaction(() => {
      addKey.run(station, rec.run_id, rec.event, rec.time_us, rec.day);
      touch.run(nowIso, station);
      // Badly-clocked events have no trustworthy hour: they stay out of the statistics.
      if (!badclock) stats.applyEvent(statStmts, station, rec);
    })();
    return { duplicate: false };
  }

  // Forget duplicate-guard keys older than `days` (by event day). Retries
  // arrive within minutes, so a month is far more than enough.
  function pruneKeys(days = 31, nowMs = Date.now()) {
    const cutoff = new Date(nowMs - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
    return prune.run(cutoff).changes;
  }

  return { append, pruneKeys, fileFor };
}

module.exports = { createEventStore, FORMAT_VERSION };
