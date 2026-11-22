'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/password');

// The clock is frozen so token expiry, the accepted timestamp window and the
// rate-limit refill are deterministic.
const NOW = Date.parse('2026-11-21T12:00:00Z');

// The payload below mirrors eventToLegacyPayload() in console core.js.
function consoleEvent(over = {}) {
  return {
    event: 1,
    timestamp: '2026-11-21-21-10-11.123456',
    time: 1234567,
    adc: 800,
    vol: 644.5,
    deadtime: 3,
    temp: 22.5,
    timestamp_utc: '2026-11-21T12:10:11.123Z'.replace('12:10', '11:10'),   // 11:10:11.123Z, before NOW
    tz: 'Asia/Tokyo',
    tz_offset_min: 540,
    run_id: 'run-aaaa',
    device_label: 'det-A',
    ...over,
  };
}

async function boot(cfgOver = {}, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-test-'));
  const cfg = loadConfig(
    { JWT_SECRET: 'test-secret-' + 'x'.repeat(40), DATA_DIR: dir, SCRYPT_N: '1024', ...env },
    { quiet: true, ...cfgOver });
  // A clock the test can move forward (rate-limit refill, time-window checks).
  let clockMs = NOW;
  const advance = (ms) => { clockMs += ms; };
  const inst = await createApp(cfg, { now: () => clockMs });
  const server = await new Promise((resolve) => {
    const s = inst.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function seed(id, status = 'active', password = 'pw-12345678') {
    const h = await hashPassword(password, cfg.scryptN);
    inst.db.prepare('INSERT INTO users (id, password_hash, status, created_at) VALUES (?,?,?,?)')
      .run(id, h, status, '2026-01-01T00:00:00Z');
    return password;
  }

  // `ip` is sent as X-Forwarded-For. The test peer is the loopback, which the
  // server trusts, so this stands in for "Apache saw this client address".
  async function call(method, p, { body, token, headers, ip } = {}) {
    const h = { ...(headers || {}) };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (token) h.Authorization = `Bearer ${token}`;
    if (ip) h['X-Forwarded-For'] = ip;
    const res = await fetch(base + p, {
      method,
      headers: h,
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* no body */ }
    return { status: res.status, json, headers: res.headers };
  }

  async function loginToken(id, pw = 'pw-12345678', ip) {
    const r = await call('POST', '/auth/login', { body: { id, password: pw }, ip });
    if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json.token;
  }

  function close() {
    return new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        inst.close();
        fs.rmSync(dir, { recursive: true, force: true });
        resolve();
      });
    });
  }

  return { base, cfg, inst, dir, seed, call, loginToken, close, advance };
}

// The mails the "outbox" transport wrote, oldest first.
function readOutbox(dir) {
  const box = path.join(dir, 'outbox');
  if (!fs.existsSync(box)) return [];
  return fs.readdirSync(box).sort().map((f) => JSON.parse(fs.readFileSync(path.join(box, f), 'utf8')));
}

// The #token=... from the link in a mail.
function tokenIn(mail) {
  const m = /#token=([A-Za-z0-9_-]+)/.exec(mail.text);
  return m ? m[1] : null;
}

// All bytes under a directory, for "this string must not be on disk anywhere".
function readAllBytes(dir) {
  const parts = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f); else parts.push(fs.readFileSync(f));
    }
  })(dir);
  return Buffer.concat(parts);
}

module.exports = { boot, consoleEvent, readAllBytes, readOutbox, tokenIn, NOW };
