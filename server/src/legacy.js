'use strict';
// Reading the OLD server's data (cosmicray-data/<station>/<YYYY-MM-DD>.dat) into records of the new
// event store. Pure functions only (no files, no database), so they can be tested with made-up text.
//
// What the old files hold. Tab-separated rows, no header. Several shapes were found on the old server
// (inspect-old-data.sh, 2026-11-22):
//
//   "C7"  7 fields  EVENT  DATE  TIME  ADC  SIPM  DEADTIME  TEMP         (the old server's writer)
//         DATE is "YYYY-MM-DD-HH-MM-SS.ffffff" in JAPAN time (checked on thousands of rows: it equals
//         the epoch in TIME plus exactly 9 h, within the seconds the device clock drifts).
//         TIME is a number in microseconds that tracks the clock; it plays the part of time_us.
//   "C7b" 7 fields  EVENT  DAY  DATE  ADC  SIPM  DEADTIME  TEMP         (an earlier version of that writer)
//         Column 2 is only the day ("2025-08-26"); the full time stands in column 3, where C7 has the epoch
//         number. DATE is Japan time as in C7. time_us follows the date (there is no device time).
//   "A"   4 fields  EVENT  DATE  X  Y        (older rows, written by a Python client; microsecond DATE)
//         ESTIMATED: Y is the ADC value (small numbers, like the ADC column of C7); X grows like a
//         time in milliseconds but matches no clock exactly, so it is kept as legacy.x and not used.
//         The time zone is assumed to be Japan time, as in C7 (not provable for these rows).
//   "B"   4 fields  ADC  DATE  SIPM  DEADTIME        (the oldest layout; millisecond DATE)
//         ESTIMATED from the old server's own reader, which names the four columns this way.
//         There is no event counter: events are numbered 1,2,3... within the file. One early client wrote its
//         DATE as an ISO time in UTC ("2025-08-15T07:15:08.853Z", files named alike): that is read as UTC.
//
// Every record says which layout it came from and where ("lg": "<layout>:<file day>:<line>"; A rows also keep
// the unused column as "lx"), so a reading that turns out wrong can be corrected later from the old files,
// which stay on the old server. What is the same for every row (Japan time, the source) is written once
// in the header line of each file, not on each of millions of rows. A run id ("legacy-<file day>-<n>") starts a new number whenever the event counter goes back
// (the board was restarted), so the hourly counts do not mix two runs.

const JST_OFFSET_MIN = 540;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})\.(\d{1,9})$/;

const isIntText = (s) => /^\d{1,17}$/.test(s);       // epoch microseconds have 16 digits (the range is checked later)
const num = (s) => {                         // "26.7" -> 26.7; "", "NaN", "null" -> null
  if (typeof s !== 'string' || s.trim() === '') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};

// "2026-06-16-08-32-52.951000" (Japan time) -> { iso: '2026-06-15T23:32:52.951000Z', us: <integer microseconds since the epoch> }
function parseLocalDate(s) {
  const m = DATE_RE.exec(String(s));
  if (!m) return null;
  const [, Y, Mo, D, h, mi, se, frac] = m;
  const f = (frac + '000000').slice(0, 6);                    // microseconds, zero-padded on the right
  const ms = Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +se) - JST_OFFSET_MIN * 60000;
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (d.getUTCFullYear() < 2015 || d.getUTCFullYear() > 2100) return null;
  // refuse dates JavaScript silently rolled over (2025-02-31 -> March 3)
  const chk = new Date(Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +se));
  if (chk.getUTCMonth() !== +Mo - 1 || chk.getUTCDate() !== +D || chk.getUTCHours() !== +h
      || chk.getUTCMinutes() !== +mi || chk.getUTCSeconds() !== +se) return null;
  const iso = d.toISOString().slice(0, 19) + '.' + f + 'Z';
  return { iso, us: ms * 1000 + Number(f), ms };
}

// "2025-08-15T07:15:08.853Z" (an ISO time, already UTC: written by one early client) -> the same shape as above.
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
function parseIsoUtc(s) {
  const m = ISO_RE.exec(String(s));
  if (!m) return null;
  const [, Y, Mo, D, h, mi, se, frac = ''] = m;
  const f = (frac + '000000').slice(0, 6);
  const ms = Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +se);
  const d = new Date(ms);
  if (!Number.isFinite(ms) || d.getUTCFullYear() < 2015 || d.getUTCFullYear() > 2100) return null;
  if (d.getUTCMonth() !== +Mo - 1 || d.getUTCDate() !== +D || d.getUTCHours() !== +h
      || d.getUTCMinutes() !== +mi || d.getUTCSeconds() !== +se) return null;
  return { iso: d.toISOString().slice(0, 19) + '.' + f + 'Z', us: ms * 1000 + Number(f), ms };
}
const parseAnyDate = (s) => parseLocalDate(s) || parseIsoUtc(s);

// Decide how the 4-field rows of ONE file are to be read: "B" when the third column mostly carries a
// decimal point (a SiPM voltage like 26.69), otherwise "A" (an integer in that place).
function layoutOfFourFieldRows(rows4) {
  if (!rows4.length) return 'A';
  let dec = 0;
  for (const f of rows4) if (/\./.test(f[2])) dec++;
  return dec * 2 > rows4.length ? 'B' : 'A';
}

// Turn the text of one old .dat file into records.
//   text      the file's content
//   fileName  e.g. "2026-06-16.dat" (kept in legacy.f and used in the run id)
// Returns { records: [...], skipped: { reason: count }, examples: { reason: 'first bad line (cut)' }, layouts: { C7, A, B } }
function parseDatFile(text, fileName) {
  const day = (/^(\d{4}-\d{2}-\d{2})/.exec(fileName) || [])[1] || 'unknown';
  const lines = text.split('\n');
  const rows = [];                                   // { fields, line }
  const skipped = {}; const examples = {};
  const skip = (reason, line, raw) => {
    skipped[reason] = (skipped[reason] || 0) + 1;
    if (!(reason in examples)) examples[reason] = `line ${line}: ${String(raw).slice(0, 80)}`;
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
    if (raw === '') continue;
    const fields = raw.split('\t');
    if (fields.length !== 4 && fields.length !== 7) { skip(`${fields.length}_fields`, i + 1, raw); continue; }
    rows.push({ fields, line: i + 1, raw });
  }
  const fourLayout = layoutOfFourFieldRows(rows.filter((r) => r.fields.length === 4).map((r) => r.fields));

  const records = [];
  const layouts = { C7: 0, C7b: 0, A: 0, B: 0 };
  let runNo = 1, prevKind = null, prevEvent = -1, seqB = 0;
  for (const { fields: f, line, raw } of rows) {
    // C7b: an earlier version of the old writer: column 2 is only the day ("2025-08-26"), and the full
    // time stands in column 3 where later versions put the epoch number.
    const kind = f.length === 7 ? (/^\d{4}-\d{2}-\d{2}$/.test(f[1]) ? 'C7b' : 'C7') : fourLayout;
    const date = parseAnyDate(kind === 'C7b' ? f[2] : f[1]);
    if (!date) { skip('bad_time', line, raw); continue; }

    let event, timeUs, adc, vol = null, dead = null, temp = null, x;
    if (kind === 'C7') {
      if (!isIntText(f[0]) || !isIntText(f[2])) { skip('bad_number', line, raw); continue; }
      event = Number(f[0]); timeUs = Number(f[2]);
      adc = num(f[3]); vol = num(f[4]); dead = num(f[5]); temp = num(f[6]);
    } else if (kind === 'C7b') {
      if (!isIntText(f[0])) { skip('bad_number', line, raw); continue; }
      event = Number(f[0]); timeUs = date.us;
      adc = num(f[3]); vol = num(f[4]); dead = num(f[5]); temp = num(f[6]);
    } else if (kind === 'A') {
      if (!isIntText(f[0])) { skip('bad_number', line, raw); continue; }
      event = Number(f[0]); timeUs = date.us; adc = num(f[3]); x = f[2];
    } else {
      adc = num(f[0]); vol = num(f[2]); dead = num(f[3]);
      event = null; timeUs = date.us;
    }
    if (adc === null || adc < 0 || adc > 65535) { skip('bad_adc', line, raw); continue; }
    if (dead !== null && dead < 0) dead = null;
    if (!Number.isSafeInteger(timeUs) || timeUs < 0) { skip('bad_number', line, raw); continue; }

    if (kind !== prevKind) { if (prevKind !== null) runNo++; prevKind = kind; prevEvent = -1; seqB = 0; }
    if (kind === 'B') { seqB++; event = seqB; }
    else if (event < prevEvent) runNo++;                     // the event counter went back: a restart
    prevEvent = event;

    const rec = {
      t: date.iso, event, time_us: timeUs, adc, vol_mv: vol, deadtime_ms: dead, temp_c: temp,
      run_id: `legacy-${day}-${runNo}`,
      // where the row came from: layout, source file day, line (kept short: millions of rows)
      lg: `${kind}:${day}:${line}`,
      ...(x !== undefined ? { lx: x } : {}),
    };
    layouts[kind]++;
    records.push(rec);
  }
  return { records, skipped, examples, layouts };
}

module.exports = { parseDatFile, parseLocalDate, parseIsoUtc, layoutOfFourFieldRows, JST_OFFSET_MIN };
