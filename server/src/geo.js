'use strict';

// The public map shows each station at the CENTRE of a 0.1-degree cell
// (about 9-11 km in Japan). Rounding happens the moment a position arrives,
// so the exact coordinates never reach the database, a log or a file.
//
// Integer micro-degrees are used so cell boundaries are exact: with floats,
// 38.2 / 0.1 is 381.99999999999994 and would land one cell too low.
const STEP_MICRO = 100000;          // 0.1 degree
const HALF_MICRO = STEP_MICRO / 2;

function cellCentre(deg) {
  const micro = Math.round(deg * 1e6);
  const idx = Math.floor(micro / STEP_MICRO);
  return (idx * STEP_MICRO + HALF_MICRO) / 1e6;
}

// The console sends the text of its input boxes, so "38.2545" (a string) is
// the normal case; numbers are accepted too. Anything else is not a position.
const DECIMAL = /^\s*-?\d+(\.\d+)?\s*$/;
function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && DECIMAL.test(v)) return Number(v);
  return NaN;
}

// Returns { lat, lon } (rounded) or null when the input is absent or invalid.
// Invalid positions are ignored rather than rejected: the console calls
// /setup-id on every login, and treats a refusal as a failed login.
function roundPosition(latIn, lonIn) {
  const lat = toNumber(latIn);
  const lon = toNumber(lonIn);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat: cellCentre(lat), lon: cellCentre(lon) };
}

module.exports = { roundPosition, cellCentre };
