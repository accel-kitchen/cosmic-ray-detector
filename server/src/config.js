'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// deploy.sh writes the commit it unpacked into <app>/.commit, so /healthz can
// say which code is running without anyone editing a service file.
function readCommitFile() {
  try {
    return fs.readFileSync(path.join(__dirname, '..', '.commit'), 'utf8').trim().slice(0, 40) || 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

// All settings come from the environment so the same code runs on localhost,
// in tests and on the VPS without edits. Nothing here is ever logged (the
// secret in particular).
function loadConfig(env = process.env, overrides = {}) {
  const production = env.NODE_ENV === 'production';

  let jwtSecret = env.JWT_SECRET;
  if (!jwtSecret) {
    if (production) {
      throw new Error('JWT_SECRET is required when NODE_ENV=production');
    }
    // Per-boot random secret: every token dies on restart. Fine for development.
    jwtSecret = crypto.randomBytes(48).toString('hex');
    if (!overrides.quiet) console.warn('WARNING: JWT_SECRET unset; using a random per-boot secret (dev only).');
  }

  const cfg = {
    production,
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 3100),
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
    jwtSecret,
    tokenTtlSec: Number(env.TOKEN_TTL_S || 24 * 3600),
    // scrypt work factor. 2^17 with r=8, p=1 is the OWASP minimum when Argon2id
    // is not available (it needs ~128 MiB per hash; see password.js for the cap
    // on concurrent hashes). New hashes carry their own parameters, so this can
    // be raised later without invalidating existing passwords.
    scryptN: Number(env.SCRYPT_N || 131072),
    // How many password hashes may run at once (each needs ~128 MiB at the
    // default N). Set from the VPS's memory; the rest wait in a queue.
    scryptConcurrency: Math.max(1, Math.floor(Number(env.SCRYPT_CONCURRENCY || 2)) || 2),
    claimUrl: env.CLAIM_URL || 'https://cosmicray.accel-kitchen.com/claim',
    commit: env.GIT_COMMIT || readCommitFile(),
    version: '0.1.0',
    // Largest accepted request body. Console events are ~300 bytes.
    bodyLimit: env.BODY_LIMIT || '32kb',
    ...overrides,
  };
  return cfg;
}

module.exports = { loadConfig };
