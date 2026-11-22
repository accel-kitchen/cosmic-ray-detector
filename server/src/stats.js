'use strict';
const fs = require('fs');
const path = require('path');

// Derived statistics for the public viewer. The JSONL files are the source of truth; everything
// here can be thrown away and rebuilt from them (rebuildAll, scripts/rebuild-stats.js), and the
// tests pin that the incremental update and a full rebuild give the same numbers.
//
// What "events per hour" means. The number of ROWS that reached the server is not a count rate:
// the console can thin events out (its "send every Nth" setting, which the server is never told
// about) and uploads can be interrupted. The device numbers its events, so within one run and
// one UTC hour the events that happened are max(event) - min(event) + 1, whatever arrived in
// between. The rate is the events between the first and the last row divided by the device-clock
// time between them. Events from a badly wrong PC clock (the badclock stream) are not counted:
// their hour is not known.
//
// Known limits: a board that reboots inside one console connection starts its event counter over
// while the run id stays the same, which under-counts that hour; and the first and last events of
// an hour can be missing when thinning is on.

const BIN_WIDTH = 64;
const BINS = 64;

function prepare(db) {
  return {
    upsertHourly: db.prepare(`
      INSERT INTO stats_hourly (station_id, run_id, hour, rows, min_event, max_event, min_time_us, max_time_us, temp_sum, temp_n)
      VALUES (@station, @run, @hour, 1, @event, @event, @time_us, @time_us, @temp, @temp_n)
      ON CONFLICT (station_id, run_id, hour) DO UPDATE SET
        rows        = rows + 1,
        min_event   = MIN(min_event, excluded.min_event),
        max_event   = MAX(max_event, excluded.max_event),
        min_time_us = MIN(min_time_us, excluded.min_time_us),
        max_time_us = MAX(max_time_us, excluded.max_time_us),
        temp_sum    = temp_sum + excluded.temp_sum,
        temp_n      = temp_n + excluded.temp_n`),
    upsertAdc: db.prepare(`
      INSERT INTO stats_adc (station_id, day, bin, n) VALUES (@station, @day, @bin, 1)
      ON CONFLICT (station_id, day, bin) DO UPDATE SET n = n + 1`),
  };
}

// e: { t, event, time_us, adc, temp_c, run_id } as stored in the JSONL (t is the ISO UTC string).
function applyEvent(stmts, station, e) {
  const hour = e.t.slice(0, 13);                 // 'YYYY-MM-DDTHH'
  const day = e.t.slice(0, 10);
  const hasTemp = typeof e.temp_c === 'number' && Number.isFinite(e.temp_c);
  stmts.upsertHourly.run({
    station, run: e.run_id, hour, event: e.event, time_us: e.time_us,
    temp: hasTemp ? e.temp_c : 0, temp_n: hasTemp ? 1 : 0,
  });
  const bin = Math.min(BINS - 1, Math.max(0, Math.floor(e.adc / BIN_WIDTH)));
  stmts.upsertAdc.run({ station, day, bin });
}

// --- reading ------------------------------------------------------------------------------------

// One point per UTC hour (or, with `bucketLen` 10, per UTC day: the same sums over a longer key).
// sinceHour / untilHour are 'YYYY-MM-DDTHH' strings (a day 'YYYY-MM-DD' works too, as a prefix);
// untilHour is inclusive and optional.
function series(db, station, sinceKey, untilKey, bucketLen) {
  const rows = db.prepare(`
    SELECT substr(hour, 1, ?) AS k,
           SUM(max_event - min_event + 1)       AS count,
           SUM(max_event - min_event)           AS d_events,
           SUM(max_time_us - min_time_us)       AS d_us,
           SUM(temp_sum) AS temp_sum, SUM(temp_n) AS temp_n
      FROM stats_hourly
     WHERE station_id = ? AND hour >= ? AND (? IS NULL OR substr(hour, 1, length(?)) <= ?)
     GROUP BY k ORDER BY k`).all(bucketLen, station, sinceKey, untilKey, untilKey, untilKey);
  return rows.map((r) => ({
    key: r.k,
    count: r.count,
    // events per minute, from the events and the device-clock time between the first and last row;
    // null when the bucket holds a single row (no interval to measure)
    rate_per_min: r.d_us > 0 ? (r.d_events / (r.d_us / 1e6)) * 60 : null,
    temp_c: r.temp_n > 0 ? r.temp_sum / r.temp_n : null,
  }));
}

function hourlySeries(db, station, sinceHour, untilHour = null) {
  return series(db, station, sinceHour, untilHour, 13).map(({ key, ...r }) => ({ hour: key, ...r }));
}

function dailySeries(db, station, sinceDay, untilDay = null) {
  return series(db, station, sinceDay, untilDay, 10).map(({ key, ...r }) => ({ day: key, ...r }));
}

// Events per UTC day, only the days that have data (for the overview bar).
function dailyCounts(db, station, sinceDay) {
  return db.prepare(`SELECT substr(hour, 1, 10) AS day, SUM(max_event - min_event + 1) AS count
                       FROM stats_hourly WHERE station_id = ? AND hour >= ? GROUP BY day ORDER BY day`).all(station, sinceDay);
}

// How many different UTC hours hold data in the window (informational).
function hoursWithData(db, station, sinceDay, untilDay = null) {
  return db.prepare(`SELECT COUNT(DISTINCT hour) AS n FROM stats_hourly
                      WHERE station_id = ? AND hour >= ? AND (? IS NULL OR substr(hour, 1, 10) <= ?)`).get(station, sinceDay, untilDay, untilDay).n;
}

function adcHistogram(db, station, sinceDay, untilDay = null) {
  const bins = new Array(BINS).fill(0);
  for (const r of db.prepare('SELECT bin, SUM(n) AS n FROM stats_adc WHERE station_id = ? AND day >= ? AND (? IS NULL OR day <= ?) GROUP BY bin').all(station, sinceDay, untilDay, untilDay)) {
    bins[r.bin] = r.n;
  }
  return { bin_width: BIN_WIDTH, bins };
}

// --- rebuilding from the files -------------------------------------------------------------------

function* mainStreamFiles(eventsDir, station) {
  const dir = path.join(eventsDir, station);
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).sort()) {
    // <day>.jsonl (live uploads) and <day>.legacy.jsonl (imported from the old server), not <day>.badclock.jsonl
    if (/^\d{4}-\d{2}-\d{2}(\.legacy)?\.jsonl$/.test(f)) yield path.join(dir, f);
  }
}

// Empty the statistics (of one station, or all) and recompute them from the JSONL files.
function rebuild(db, dataDir, station = null) {
  const stmts = prepare(db);
  const eventsDir = path.join(dataDir, 'events');
  const stations = station ? [station]
    : (fs.existsSync(eventsDir) ? fs.readdirSync(eventsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []);
  let n = 0;
  db.transaction(() => {
    if (station) {
      db.prepare('DELETE FROM stats_hourly WHERE station_id = ?').run(station);
      db.prepare('DELETE FROM stats_adc WHERE station_id = ?').run(station);
    } else {
      db.exec('DELETE FROM stats_hourly; DELETE FROM stats_adc;');
    }
    for (const s of stations) {
      for (const file of mainStreamFiles(eventsDir, s)) {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          if (!line) continue;
          let e;
          try { e = JSON.parse(line); } catch (_) { continue; }          // a torn last line is skipped
          if (e.kind === 'header' || e.clock_suspect) continue;
          if (typeof e.t !== 'string' || !Number.isSafeInteger(e.event) || !Number.isSafeInteger(e.time_us)
              || typeof e.adc !== 'number' || typeof e.run_id !== 'string') continue;
          applyEvent(stmts, s, e);
          n++;
        }
      }
    }
  })();
  return n;
}

module.exports = { prepare, applyEvent, hourlySeries, dailySeries, dailyCounts, hoursWithData, adcHistogram, rebuild, BIN_WIDTH, BINS };
