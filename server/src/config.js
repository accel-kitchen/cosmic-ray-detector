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

  const flag = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());
  const mapTile = String(env.MAP_TILE || 'none').toLowerCase();
  if (!['none', 'gsi', 'osm'].includes(mapTile)) throw new Error('MAP_TILE must be none, gsi or osm');
  const mailTransport = String(env.MAIL_TRANSPORT || 'none').toLowerCase();
  if (!['none', 'smtp', 'outbox'].includes(mailTransport)) throw new Error('MAIL_TRANSPORT must be none, smtp or outbox');
  const registrationOpen = flag(env.REGISTRATION_OPEN);
  // Opening registration needs a real way to deliver the confirmation mail. The "outbox"
  // transport only writes files (development and tests), so production must not use it.
  if (registrationOpen && mailTransport === 'none') {
    throw new Error('REGISTRATION_OPEN needs a MAIL_TRANSPORT (smtp, or outbox for development)');
  }
  if (registrationOpen && production && mailTransport !== 'smtp') {
    throw new Error('REGISTRATION_OPEN needs MAIL_TRANSPORT=smtp in production');
  }
  // A draft text must not be the one people agree to. Name the approved version (CONSENT_VERSION) first.
  if (registrationOpen && production && /^draft/i.test(env.CONSENT_VERSION || 'draft-1')) {
    throw new Error('REGISTRATION_OPEN in production needs an approved CONSENT_VERSION (not "draft...")');
  }

  const cfg = {
    production,
    // Where the links in mails point, and what the pages call themselves.
    publicUrl: (env.PUBLIC_URL || 'https://cosmicray.accel-kitchen.com').replace(/\/+$/, ''),
    // CLOSED by default. Open it only after the terms text is final (plan, Q-N2) and a real
    // mail has been delivered to the addresses participants use.
    registrationOpen,
    // A newly verified station stays off the public map until an operator lists it, unless this is on.
    autoListOnVerify: flag(env.AUTO_LIST_ON_VERIFY),
    // Map background: "none" sends nothing to a third party (the default); "gsi" = Geospatial
    // Information Authority of Japan tiles; "osm" = OpenStreetMap tiles. Both pass the viewer's
    // address to that provider; see the plan, Q-N8, for each provider's terms.
    mapTile,
    // The terms text people agree to. A draft text must say so in its version name.
    consentVersion: env.CONSENT_VERSION || 'draft-1',
    unverifiedDays: Math.max(1, Number(env.UNVERIFIED_DAYS || 7)),
    mail: {
      transport: mailTransport,
      from: env.MAIL_FROM || 'CosmicRay <noreply@accel-kitchen.com>',
      smtp: {
        host: env.SMTP_HOST || 'localhost',
        port: Number(env.SMTP_PORT || 587),
        secure: flag(env.SMTP_SECURE),               // true = TLS from the start (port 465)
        user: env.SMTP_USER || '',
        pass: env.SMTP_PASS || '',                   // a secret: lives only in /etc/cosmicray/env
      },
      perAddressPerDay: Math.max(1, Number(env.MAIL_PER_ADDRESS_PER_DAY || 5)),
      globalPerDay: Math.max(1, Number(env.MAIL_GLOBAL_PER_DAY || 300)),
    },
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 3100),
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
    jwtSecret,
    tokenTtlSec: Number(env.TOKEN_TTL_S || 24 * 3600),
    adminTokenTtlSec: Number(env.ADMIN_TOKEN_TTL_S || 2 * 3600),     // an operator signs in again after 2 hours
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
    version: '0.3.4',
    // Largest accepted request body. Console events are ~300 bytes.
    bodyLimit: env.BODY_LIMIT || '32kb',
    ...overrides,
  };
  return cfg;
}

module.exports = { loadConfig };
