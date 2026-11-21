'use strict';
const express = require('express');
const jwt = require('jsonwebtoken');
const { openDb, SCHEMA_VERSION } = require('./db');
const { Limiter } = require('./ratelimit');
const { hashPassword, verifyPassword, setMaxConcurrent } = require('./password');
const { roundPosition } = require('./geo');
const { validateEvent } = require('./validate');
const { createEventStore } = require('./events');

// Station ids double as login names and directory names, so the pattern is the
// path-safety check as well: nothing outside [a-z0-9_-] ever reaches the disk.
const STATION_ID = /^[a-z0-9][a-z0-9_-]{2,31}$/;

// Failed logins are counted at three levels. The rule that keeps the station
// ids (which are public on the map) from being used to lock people out:
// ONE client address must never be able to empty the station-wide bucket.
// A single IP is held to loginIdIp (5 burst, 0.1/s sustained) and to loginIp,
// so it can take at most 5 tokens from the station bucket in a burst and
// 0.1/s afterwards. The station bucket refills faster than that (0.5/s) and is
// large (100), so it only runs dry when MANY addresses fail at once.
const DEFAULT_LIMITS = {
  loginIp:   { capacity: 10,   refillPerSec: 0.2 },  // every attempt, per client IP
  loginIdIp: { capacity: 5,    refillPerSec: 0.1 },  // failed attempts, per (station, client IP)
  loginId:   { capacity: 100,  refillPerSec: 0.5 },  // failed attempts, per station, all addresses together
  refresh:  { capacity: 30,   refillPerSec: 0.1 },
  setup:    { capacity: 20,   refillPerSec: 0.2 },
  upload:   { capacity: 1000, refillPerSec: 200 },   // the console sends 4 in parallel
};

async function createApp(cfg, { now = Date.now } = {}) {
  setMaxConcurrent(cfg.scryptConcurrency || 2);
  const db = openDb(cfg.dataDir);
  const store = createEventStore(db, cfg.dataDir);
  const lim = {};
  const L = { ...DEFAULT_LIMITS, ...(cfg.limits || {}) };
  for (const k of Object.keys(L)) lim[k] = new Limiter({ ...L[k], now });

  // Compared against when the station does not exist, so an unknown id costs
  // the same time as a wrong password.
  const dummyHash = await hashPassword('not-a-real-password', cfg.scryptN);

  const q = {
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    ensureStation: db.prepare('INSERT OR IGNORE INTO stations (id) VALUES (?)'),
    setup: db.prepare(`
      INSERT INTO stations (id, lat_grid, lon_grid, private_comment, setup_at)
      VALUES (@id, @lat, @lon, @comment, @at)
      ON CONFLICT(id) DO UPDATE SET
        lat_grid        = COALESCE(excluded.lat_grid, lat_grid),
        lon_grid        = COALESCE(excluded.lon_grid, lon_grid),
        private_comment = COALESCE(excluded.private_comment, private_comment),
        setup_at        = excluded.setup_at`),
  };

  const app = express();
  app.disable('x-powered-by');
  // Behind Apache every connection comes from 127.0.0.1. Trusting only the
  // loopback hop makes req.ip the right-most address that is NOT loopback,
  // i.e. the one Apache appended, so a client cannot forge its way out of a
  // rate limit with its own X-Forwarded-For.
  app.set('trust proxy', 'loopback');

  // --- CORS: must be first, so it covers every response (errors included) ----
  // The console runs on another origin (or file://, Origin: null). Credentials
  // are never used (Bearer header, no cookies), so '*' is valid and safe.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  if (!cfg.quiet) {
    app.use((req, res, next) => {
      const t0 = process.hrtime.bigint();
      res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        // Method, route pattern, status. No IPs, tokens or bodies.
        console.log(`${req.method} ${req.route ? req.route.path : req.path} ${res.statusCode} ${ms.toFixed(1)}ms`);
      });
      next();
    });
  }

  app.use(express.json({ limit: cfg.bodyLimit }));

  const tooMany = (res, r) => {
    res.set('Retry-After', String(r.retryAfterSec));
    return res.status(429).json({ error: 'Too many requests', retry_after_s: r.retryAfterSec });
  };

  const signToken = (user) => jwt.sign(
    { sub: user.id, ver: user.token_version },
    cfg.jwtSecret,
    { algorithm: 'HS256', expiresIn: cfg.tokenTtlSec });

  function requireAuth(req, res, next) {
    const m = /^Bearer (.+)$/i.exec(req.get('authorization') || '');
    if (!m) return res.status(401).json({ error: 'Missing token' });
    let p;
    try {
      p = jwt.verify(m[1], cfg.jwtSecret, { algorithms: ['HS256'] });
    } catch (e) {
      return res.status(401).json({ error: e.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token' });
    }
    const user = typeof p.sub === 'string' ? q.user.get(p.sub) : undefined;
    if (!user || user.token_version !== p.ver) return res.status(401).json({ error: 'Token revoked' });
    if (user.status !== 'active') return res.status(403).json({ error: 'This account is not active' });
    req.user = user;
    next();
  }

  function requireOwner(req, res, next) {
    const id = String(req.params.id || '').trim().toLowerCase();
    if (id !== req.user.id) return res.status(403).json({ error: 'This is not your station' });
    next();
  }

  // --- liveness ---------------------------------------------------------------
  app.get('/healthz', (req, res) => {
    res.json({ status: 'ok', version: cfg.version, commit: cfg.commit, schema: SCHEMA_VERSION });
  });

  // --- auth -------------------------------------------------------------------
  app.post('/auth/login', async (req, res) => {
    const ipTry = lim.loginIp.take(req.ip);
    if (!ipTry.ok) return tooMany(res, ipTry);

    const { id, password } = req.body || {};
    if (typeof id !== 'string' || typeof password !== 'string' || !id || !password || password.length > 256) {
      return res.status(400).json({ error: 'id and password are required' });
    }
    const sid = id.trim().toLowerCase();
    const validId = STATION_ID.test(sid);

    // Only FAILED attempts count against a station (see DEFAULT_LIMITS), so
    // correct logins never use the budget up.
    const pairKey = `${sid}|${req.ip}`;
    if (validId) {
      const pair = lim.loginIdIp.peek(pairKey);
      if (!pair.ok) return tooMany(res, pair);
      const station = lim.loginId.peek(sid);
      if (!station.ok) return tooMany(res, station);
    }

    const user = validId ? q.user.get(sid) : undefined;
    const ok = await verifyPassword(password, user ? user.password_hash : dummyHash);
    if (!user || !ok) {
      if (validId) {
        lim.loginIdIp.take(pairKey);
        lim.loginId.take(sid);
      }
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Account state is only revealed to someone who knows the password.
    if (user.status === 'legacy_unclaimed') {
      return res.status(403).json({ error: `Register an email address first: ${cfg.claimUrl}` });
    }
    if (user.status === 'pending_email') {
      return res.status(403).json({ error: 'Verify your email address first (check your inbox).' });
    }
    if (user.status !== 'active') return res.status(403).json({ error: 'This account is disabled' });

    res.json({ success: true, token: signToken(user), user: { id: user.id, role: 'user' } });
  });

  app.post('/auth/refresh', requireAuth, (req, res) => {
    const r = lim.refresh.take(req.user.id);
    if (!r.ok) return tooMany(res, r);
    res.json({ success: true, token: signToken(req.user) });
  });

  // --- station setup (called by the console at every login: must be idempotent) --
  app.post('/setup-id', requireAuth, (req, res) => {
    const r = lim.setup.take(req.user.id);
    if (!r.ok) return tooMany(res, r);

    const body = req.body || {};
    if (typeof body.id !== 'string' || body.id.trim().toLowerCase() !== req.user.id) {
      return res.status(403).json({ error: 'This is not your station' });
    }

    const pos = roundPosition(body.gps_latitude, body.gps_longitude);
    const gaveGps = body.gps_latitude != null || body.gps_longitude != null;
    q.setup.run({
      id: req.user.id,
      lat: pos ? pos.lat : null,
      lon: pos ? pos.lon : null,
      comment: typeof body.comment === 'string' && body.comment ? body.comment.slice(0, 500) : null,
      at: new Date(now()).toISOString(),
    });
    res.json({ success: true, id: req.user.id, position: pos, position_ignored: gaveGps && !pos });
  });

  // --- ingest (compat API: one event per request) -------------------------------
  app.post('/upload-data/:id', requireAuth, requireOwner, (req, res) => {
    const r = lim.upload.take(req.user.id);
    if (!r.ok) return tooMany(res, r);

    const v = validateEvent(req.body, now());
    if (!v.ok) return res.status(400).json({ error: v.error });

    q.ensureStation.run(req.user.id);
    const out = store.append(req.user.id, v.rec, new Date(now()).toISOString());
    // clock_suspect is only present when the console's clock was badly wrong
    // (the event was kept, in the badclock stream).
    res.json(v.rec.badclock
      ? { success: true, duplicate: out.duplicate, clock_suspect: true }
      : { success: true, duplicate: out.duplicate });
  });

  // --- fallbacks (JSON, and still behind the CORS middleware) --------------------
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
    if (!cfg.quiet) console.error('Unhandled error:', err && err.message);
    res.status(500).json({ error: 'Internal server error' });
  });

  // Old duplicate-guard keys are dropped at start and every six hours.
  store.pruneKeys();
  const timer = setInterval(() => store.pruneKeys(), 6 * 3600 * 1000);
  timer.unref();

  return {
    app, db, store,
    close() { clearInterval(timer); db.close(); },
  };
}

module.exports = { createApp, STATION_ID };
