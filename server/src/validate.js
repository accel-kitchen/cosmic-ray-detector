'use strict';

// Validation of one /upload-data/:id event as the console sends it
// (eventToLegacyPayload in console core.js).
//
// A 400 tells the console "this event will never be accepted: drop it". So
// only STRUCTURALLY unusable events are refused. Anything that is merely odd
// (a wild temperature, an over-long label) is accepted or trimmed, because a
// refusal here destroys a real measurement for good.
//
// One known exception: a timestamp before 2015 or more than two days ahead is
// refused, so a console whose PC clock is badly wrong loses those events for
// good. Whether to keep them in a flagged "bad clock" file instead is an open
// question (plan, Q-N14).

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const EARLIEST_MS = Date.parse('2015-01-01T00:00:00Z');
const FUTURE_SLACK_MS = 2 * 24 * 3600 * 1000;   // tolerate a PC clock a little fast

const isInt = (v) => typeof v === 'number' && Number.isSafeInteger(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);

// Returns { ok: true, rec } or { ok: false, error }.
function validateEvent(body, nowMs = Date.now()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }

  if (!isInt(body.event) || body.event < 0) return { ok: false, error: 'event must be a non-negative integer' };
  if (!isInt(body.time) || body.time < 0) return { ok: false, error: 'time must be a non-negative integer' };
  if (!isNum(body.adc) || body.adc < 0 || body.adc > 65535) return { ok: false, error: 'adc must be a number in 0..65535' };
  if (!isNum(body.vol)) return { ok: false, error: 'vol must be a number' };
  if (!isNum(body.deadtime) || body.deadtime < 0) return { ok: false, error: 'deadtime must be a non-negative number' };

  if (typeof body.run_id !== 'string' || body.run_id.length < 1 || body.run_id.length > 64) {
    return { ok: false, error: 'run_id must be a string of 1..64 characters' };
  }

  if (typeof body.timestamp_utc !== 'string' || !ISO_UTC.test(body.timestamp_utc)) {
    return { ok: false, error: 'timestamp_utc must be an ISO-8601 UTC time (…Z)' };
  }
  const ms = Date.parse(body.timestamp_utc);
  if (!Number.isFinite(ms) || ms < EARLIEST_MS || ms > nowMs + FUTURE_SLACK_MS) {
    return { ok: false, error: 'timestamp_utc is outside the accepted range' };
  }

  // temp is null when the board has no environment sensor (JSON turns NaN into null).
  const temp = isNum(body.temp) ? body.temp : null;
  const off = isInt(body.tz_offset_min) && Math.abs(body.tz_offset_min) <= 14 * 60 ? body.tz_offset_min : null;

  const iso = new Date(ms).toISOString();        // normalised to millisecond precision
  return {
    ok: true,
    rec: {
      t: body.timestamp_utc,                     // as sent, keeps sub-millisecond digits
      day: iso.slice(0, 10),                     // UTC date: the file boundary
      event: body.event,
      time_us: body.time,
      adc: body.adc,
      vol_mv: body.vol,                          // computed from adc by the console, not measured
      deadtime_ms: body.deadtime,                // the console converts the device's microseconds to ms for this API
      temp_c: temp,
      run_id: body.run_id,
      device_label: clip(body.device_label, 64),
      tz: clip(body.tz, 64),
      tz_offset_min: off,
      ts_local: clip(body.timestamp, 40),        // the console's local-time string, kept for audit
    },
  };
}

module.exports = { validateEvent };
