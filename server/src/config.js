'use strict';
const path = require('path');
const crypto = require('crypto');

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
    claimUrl: env.CLAIM_URL || 'https://cosmicray.accel-kitchen.com/claim',
    commit: env.GIT_COMMIT || 'unknown',
    version: '0.1.0',
    // Largest accepted request body. Console events are ~300 bytes.
    bodyLimit: env.BODY_LIMIT || '32kb',
    ...overrides,
  };
  return cfg;
}

module.exports = { loadConfig };
