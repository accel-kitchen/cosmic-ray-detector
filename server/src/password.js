'use strict';
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const KEYLEN = 32;
const R = 8;
const P = 1;

// At N = 2^17 one hash needs ~128 MiB. Cap how many run at once so a burst of
// logins cannot exhaust the VPS's memory; the rest queue (the login rate limit
// already bounds how long that queue can get).
let maxConcurrent = 2;
function setMaxConcurrent(n) {
  if (!Number.isInteger(n) || n < 1) throw new Error('maxConcurrent must be a positive integer');
  maxConcurrent = n;
}
let active = 0;
const waiters = [];
async function acquire() {
  if (active < maxConcurrent) { active++; return; }
  await new Promise((resolve) => waiters.push(resolve));   // the slot is handed over
}
function release() {
  const next = waiters.shift();
  if (next) next(); else active--;
}
async function limited(fn) {
  await acquire();
  try { return await fn(); } finally { release(); }
}

// Stored form: scrypt$N$r$p$<salt b64>$<hash b64>. The parameters travel with
// the hash, so the work factor can be raised later without a migration.
async function hashPassword(password, N) {
  const salt = crypto.randomBytes(16);
  const key = await limited(() => scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 256 * N * R }));
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  try {
    const salt = Buffer.from(parts[4], 'base64');
    const want = Buffer.from(parts[5], 'base64');
    const got = await limited(() => scrypt(password, salt, want.length, { N, r, p, maxmem: 256 * N * r }));
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch (_) {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword, setMaxConcurrent };
