'use strict';
const jwt = require('jsonwebtoken');
const { createOperator } = require('./operator');

// The operator's web API (the page is public/admin.html). Everything lives under /admin-api/.
//
//   POST /admin-api/login                    name + password  ->  a short-lived token (typ: 'admin')
//   GET  /admin-api/me                       who am I (checks the token)
//   GET  /admin-api/stations?q=&limit=&offset=   the list: NO e-mail addresses
//   GET  /admin-api/stations/:id             one station, including its e-mail address (written to the audit log)
//   POST /admin-api/stations/:id/list        { listed: bool }   on the map / off the map (a hold)
//   POST /admin-api/stations/:id/description { hidden: bool }   hide / show the owner's introduction text
//   POST /admin-api/stations/:id/status      { active: bool }   disable / enable the account
//   GET  /admin-api/audit?limit=             who did what, newest first
//
// There is deliberately no delete here: removing an account and its measurements cannot be undone, so it
// stays a command on the server (scripts/admin.js delete <id> --yes).
//
// Operators are not stations (their own table). An operator token is refused by every station route and a
// station token by every route here, whatever the two names are. The operator's state is read from the
// database on every request, so disabling an operator, or changing their password, takes effect at once.

function register(app, ctx) {
  const { cfg, db, now, lim, tooMany, verifyPassword, dummyHash, STATION_ID } = ctx;
  const op = createOperator(db, now);
  const iso = () => new Date(now()).toISOString();

  const q = {
    admin: db.prepare('SELECT * FROM admins WHERE name = ?'),
    detail: db.prepare(`
      SELECT u.id, u.status, u.prev_status, u.created_via, u.created_at, u.email, u.email_verified_at,
             u.consent_version, u.consent_at,
             s.lat_grid, s.lon_grid, s.listed, s.admin_hold, s.description_hidden, s.public_description,
             s.event_count, s.last_seen_utc, s.setup_at
        FROM users u LEFT JOIN stations s ON s.id = u.id WHERE u.id = ?`),
    audit: db.prepare('SELECT id, at, actor, action, target, detail FROM admin_audit ORDER BY id DESC LIMIT ?'),
  };

  const fail = (res, status, code, ja, en) => res.status(status).json({ error: en || code.replace(/_/g, ' '), code, message_ja: ja });
  const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('X-Robots-Tag', 'noindex'); next(); };

  app.use('/admin-api', noStore);

  // --- login -------------------------------------------------------------------------------
  app.post('/admin-api/login', async (req, res) => {
    const ipTry = lim.adminLoginIp.take(req.ip);
    if (!ipTry.ok) return tooMany(res, ipTry);

    const { name, password } = req.body || {};
    if (typeof name !== 'string' || typeof password !== 'string' || !name || !password || password.length > 256) {
      return fail(res, 400, 'bad_request', '名前とパスワードを入れてください。');
    }
    const n = name.trim().toLowerCase();
    const valid = STATION_ID.test(n);
    const pairKey = `${n}|${req.ip}`;
    if (valid) {
      const pair = lim.adminLoginPair.peek(pairKey);
      if (!pair.ok) return tooMany(res, pair);
      const byName = lim.adminLoginName.peek(n);
      if (!byName.ok) return tooMany(res, byName);
    }

    const row = valid ? q.admin.get(n) : undefined;
    // A wrong name costs the same time as a wrong password.
    const ok = await verifyPassword(password, row ? row.password_hash : dummyHash);
    if (!row || !ok || row.status !== 'active') {
      if (valid) { lim.adminLoginPair.take(pairKey); lim.adminLoginName.take(n); }
      // Only a name that exists is written down: a typed-in string never reaches the log.
      op.audit(row ? row.name : '?', 'admin-login-failed', null, !row ? 'unknown' : (row.status !== 'active' ? 'disabled' : 'wrong-password'));
      return fail(res, 401, 'invalid_credentials', '名前かパスワードが違います。', 'Invalid credentials');
    }
    op.audit(row.name, 'admin-login');
    const token = jwt.sign({ sub: row.name, typ: 'admin', ver: row.token_version }, cfg.jwtSecret,
      { algorithm: 'HS256', expiresIn: cfg.adminTokenTtlSec });
    res.json({ success: true, token, name: row.name, expires_in: cfg.adminTokenTtlSec });
  });

  // --- the check every other route goes through -----------------------------------------------
  function requireAdmin(req, res, next) {
    const m = /^Bearer (.+)$/i.exec(req.get('authorization') || '');
    if (!m) return fail(res, 401, 'token_invalid', 'ログインしてください。');
    let p;
    try { p = jwt.verify(m[1], cfg.jwtSecret, { algorithms: ['HS256'] }); }
    catch (e) { return fail(res, 401, 'token_invalid', 'ログインの有効期限が切れました。もう一度ログインしてください。'); }
    const row = p.typ === 'admin' && typeof p.sub === 'string' ? q.admin.get(p.sub) : undefined;
    if (!row || row.token_version !== p.ver || row.status !== 'active') {
      return fail(res, 401, 'token_invalid', 'ログインしてください。');
    }
    const r = lim.admin.take(row.name);
    if (!r.ok) return tooMany(res, r);
    req.admin = row;
    next();
  }

  const stationId = (req) => {
    const id = String(req.params.id || '').trim().toLowerCase();
    return STATION_ID.test(id) ? id : null;
  };
  const reply = (res, r, extra) => (r.ok ? res.json({ success: true, ...(extra || {}) })
    : fail(res, r.status, r.code, r.message));

  app.get('/admin-api/me', requireAdmin, (req, res) => res.json({ name: req.admin.name }));

  // --- the list: no e-mail addresses --------------------------------------------------------
  app.get('/admin-api/stations', requireAdmin, (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    // A search term is only ever matched against ids, which are [a-z0-9_-]; anything else is dropped,
    // so there is nothing to escape in the LIKE pattern.
    const term = String(req.query.q || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
    const rows = db.prepare(`
      SELECT u.id, u.status, u.created_via AS via, u.created_at, u.email IS NOT NULL AS has_email,
             u.email_verified_at IS NOT NULL AS verified,
             COALESCE(s.listed, 0) AS listed, COALESCE(s.admin_hold, 0) AS admin_hold,
             COALESCE(s.description_hidden, 0) AS description_hidden,
             (s.public_description IS NOT NULL) AS has_description,
             (s.lat_grid IS NOT NULL) AS has_position,
             COALESCE(s.event_count, 0) AS events, s.last_seen_utc
        FROM users u LEFT JOIN stations s ON s.id = u.id
       WHERE u.id LIKE ? ORDER BY u.created_at DESC, u.id LIMIT ? OFFSET ?`)
      .all(`%${term}%`, limit, offset);
    const total = db.prepare('SELECT COUNT(*) AS n FROM users u WHERE u.id LIKE ?').get(`%${term}%`).n;
    res.json({
      total, limit, offset,
      stations: rows.map((r) => ({
        ...r, has_email: !!r.has_email, verified: !!r.verified, listed: r.listed === 1, admin_hold: r.admin_hold === 1,
        description_hidden: r.description_hidden === 1, has_description: !!r.has_description, has_position: !!r.has_position,
      })),
    });
  });

  // --- one station: this is where the e-mail address is shown, so looking is recorded ---------------
  app.get('/admin-api/stations/:id', requireAdmin, (req, res) => {
    const id = stationId(req);
    const r = id ? q.detail.get(id) : undefined;
    if (!r) return fail(res, 404, 'not_found', '見つかりません。');
    op.audit(req.admin.name, 'view-detail', id);
    res.json({
      id: r.id, status: r.status, previous_status: r.prev_status, via: r.created_via, created_at: r.created_at,
      email: r.email || null, email_verified_at: r.email_verified_at || null,
      consent_version: r.consent_version || null, consent_at: r.consent_at || null,
      position: r.lat_grid == null ? null : { lat: r.lat_grid, lon: r.lon_grid },     // the 0.1-degree cell centre only
      listed: r.listed === 1, admin_hold: r.admin_hold === 1, description_hidden: r.description_hidden === 1,
      public_description: r.public_description || null,
      events: r.event_count || 0, last_seen_utc: r.last_seen_utc || null, setup_at: r.setup_at || null,
    });
  });

  // --- the changes: each is one call into operator.js, which also writes the audit row --------------
  const boolBody = (req, key) => (req.body && typeof req.body[key] === 'boolean' ? req.body[key] : null);

  app.post('/admin-api/stations/:id/list', requireAdmin, (req, res) => {
    const id = stationId(req); const v = boolBody(req, 'listed');
    if (!id) return fail(res, 404, 'not_found', '見つかりません。');
    if (v === null) return fail(res, 400, 'bad_request', '指定が正しくありません。');
    reply(res, v ? op.listOn(req.admin.name, id) : op.listOff(req.admin.name, id));
  });

  app.post('/admin-api/stations/:id/description', requireAdmin, (req, res) => {
    const id = stationId(req); const v = boolBody(req, 'hidden');
    if (!id) return fail(res, 404, 'not_found', '見つかりません。');
    if (v === null) return fail(res, 400, 'bad_request', '指定が正しくありません。');
    reply(res, op.setDescriptionHidden(req.admin.name, id, v));
  });

  app.post('/admin-api/stations/:id/status', requireAdmin, (req, res) => {
    const id = stationId(req); const v = boolBody(req, 'active');
    if (!id) return fail(res, 404, 'not_found', '見つかりません。');
    if (v === null) return fail(res, 400, 'bad_request', '指定が正しくありません。');
    const r = v ? op.enable(req.admin.name, id) : op.disable(req.admin.name, id);
    reply(res, r, r.ok ? { status: v ? r.status || 'active' : 'disabled' } : undefined);
  });

  app.get('/admin-api/audit', requireAdmin, (req, res) => {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    res.json({ entries: q.audit.all(limit) });
  });
}

module.exports = { register };
