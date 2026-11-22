'use strict';
// The operator tools: a separate login, a hold the owner cannot undo, hidden text, disable/enable that
// never skips e-mail confirmation, and an audit log with no personal text in it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const { boot } = require('./helpers');
const { hashPassword } = require('../src/password');
const { deleteAccount } = require('../src/accounts');

const OP_PW = 'a-long-operator-password';

async function addAdmin(t, name = 'ops-one', pw = OP_PW) {
  const h = await hashPassword(pw, t.cfg.scryptN);
  t.inst.db.prepare('INSERT INTO admins (name, password_hash, created_at) VALUES (?,?,?)').run(name, h, '2026-11-22T00:00:00Z');
  return pw;
}
async function adminToken(t, name = 'ops-one', pw = OP_PW, ip) {
  const r = await t.call('POST', '/admin-api/login', { body: { name, password: pw }, ip });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.token;
}
// An ordinary active station with a position and a written introduction, already on the map.
async function addStation(t, id, { listed = 1, email = null, description = 'hello from ' + id } = {}) {
  await t.seed(id);
  t.inst.db.prepare('UPDATE users SET email = ?, email_verified_at = ?, created_via = ? WHERE id = ?')
    .run(email, email ? '2026-11-22T00:01:00Z' : null, email ? 'register' : 'seed', id);
  t.inst.db.prepare('INSERT OR IGNORE INTO stations (id) VALUES (?)').run(id);
  t.inst.db.prepare('UPDATE stations SET lat_grid = 34.65, lon_grid = 135.55, listed = ?, public_description = ? WHERE id = ?')
    .run(listed, description, id);
}

test('operator login: one message for every failure, only real names reach the audit log, typed text never does', async () => {
  const t = await boot();
  try {
    await addAdmin(t);
    const bad = await t.call('POST', '/admin-api/login', { body: { name: 'ops-one', password: 'wrong-wrong-wrong' } });
    const none = await t.call('POST', '/admin-api/login', { body: { name: '<script>alert(1)</script>', password: 'wrong-wrong-wrong' } });
    assert.equal(bad.status, 401); assert.equal(none.status, 401);
    assert.deepEqual(bad.json, none.json, 'a wrong name looks exactly like a wrong password');
    await adminToken(t);
    const rows = t.inst.db.prepare('SELECT actor, action, detail FROM admin_audit ORDER BY id').all();
    assert.deepEqual(rows.map((r) => `${r.actor}:${r.action}:${r.detail}`),
      ['ops-one:admin-login-failed:wrong-password', '?:admin-login-failed:unknown', 'ops-one:admin-login:null']);
    assert.ok(!JSON.stringify(rows).includes('script'), 'what a stranger typed is not stored');
  } finally { await t.close(); }
});

test('operator login is limited per address, and a wrong name cannot lock the real operator out from elsewhere', async () => {
  const t = await boot();
  try {
    await addAdmin(t);
    let last;
    for (let i = 0; i < 8; i++) last = await t.call('POST', '/admin-api/login', { body: { name: 'ops-one', password: 'wrong-wrong-wrong' }, ip: '203.0.113.9' });
    assert.equal(last.status, 429);
    // another address is not affected by the first one's failures
    assert.equal((await t.call('POST', '/admin-api/login', { body: { name: 'ops-one', password: OP_PW }, ip: '198.51.100.7' })).status, 200);
  } finally { await t.close(); }
});

test('tokens do not cross: an operator token is refused by station routes and a station token by operator routes, even with the same name', async () => {
  const t = await boot();
  try {
    await addAdmin(t, 'osaka');                       // the operator's name equals a station id on purpose
    await addStation(t, 'osaka');
    const op = await adminToken(t, 'osaka');
    const st = await t.loginToken('osaka');
    for (const [m, p] of [['GET', '/me'], ['GET', '/stations/osaka/summary'], ['POST', '/auth/refresh'], ['PUT', '/me/profile']]) {
      const r = await t.call(m, p, { token: op, body: m === 'PUT' ? { description: 'x' } : undefined });
      assert.equal(r.status, 401, `${m} ${p} must refuse an operator token`);
      assert.equal(r.json.code, 'token_invalid');
    }
    for (const p of ['/admin-api/me', '/admin-api/stations', '/admin-api/stations/osaka', '/admin-api/audit']) {
      assert.equal((await t.call('GET', p, { token: st })).status, 401, `GET ${p} must refuse a station token`);
      assert.equal((await t.call('GET', p)).status, 401, `GET ${p} must refuse no token`);
    }
    assert.equal((await t.call('GET', '/admin-api/me', { token: op })).json.name, 'osaka');
  } finally { await t.close(); }
});

test('the list has no e-mail address; opening one station shows it and is recorded', async () => {
  const t = await boot();
  try {
    await addAdmin(t);
    await addStation(t, 'osaka', { email: 'private-person@example.org' });
    await addStation(t, 'kyoto');
    const tok = await adminToken(t);
    const list = await t.call('GET', '/admin-api/stations', { token: tok });
    assert.equal(list.status, 200);
    assert.equal(list.json.total, 2);
    assert.ok(!JSON.stringify(list.json).includes('private-person'), 'no address in the list');
    assert.equal(list.json.stations.find((s) => s.id === 'osaka').has_email, true);
    assert.equal((await t.call('GET', '/admin-api/stations?q=kyo', { token: tok })).json.total, 1);
    assert.equal((await t.call('GET', "/admin-api/stations?q=%25%27%3B--", { token: tok })).status, 200, 'a hostile search term is just dropped');

    const one = await t.call('GET', '/admin-api/stations/osaka', { token: tok });
    assert.equal(one.json.email, 'private-person@example.org');
    assert.equal(one.json.position.lat, 34.65);
    assert.equal((await t.call('GET', '/admin-api/stations/nobody', { token: tok })).status, 404);
    const audit = (await t.call('GET', '/admin-api/audit', { token: tok })).json.entries;
    assert.ok(audit.some((e) => e.action === 'view-detail' && e.target === 'osaka' && e.actor === 'ops-one'));
    assert.ok(!JSON.stringify(audit).includes('private-person'), 'the audit log never holds an address');
    assert.ok(!JSON.stringify(audit).includes('hello from'), 'nor introduction text');
  } finally { await t.close(); }
});

test('taking a station off the map is a HOLD: the owner and the automatic listing cannot undo it; an operator can', async () => {
  const t = await boot({}, { AUTO_LIST_ON_VERIFY: '1' });
  try {
    await addAdmin(t);
    await addStation(t, 'osaka');
    const tok = await adminToken(t);
    const owner = await t.loginToken('osaka');
    assert.equal((await t.call('GET', '/public/stations')).json.stations.length, 1);

    assert.equal((await t.call('POST', '/admin-api/stations/osaka/list', { token: tok, body: { listed: false } })).status, 200);
    assert.equal((await t.call('GET', '/public/stations')).json.stations.length, 0);
    const me = (await t.call('GET', '/me', { token: owner })).json;
    assert.equal(me.held_by_operator, true);
    assert.equal(me.listed, false);

    const again = await t.call('PUT', '/me/profile', { token: owner, body: { listed: true } });
    assert.equal(again.status, 403);
    assert.equal(again.json.code, 'held_by_operator');
    assert.equal((await t.call('GET', '/public/stations')).json.stations.length, 0);
    // another logged-in participant cannot see the held station's graphs either
    await addStation(t, 'kyoto');
    const other = await t.loginToken('kyoto');
    assert.equal((await t.call('GET', '/stations/osaka/summary', { token: other })).status, 404);
    assert.equal((await t.call('GET', '/stations/osaka/summary', { token: owner })).status, 200, 'the owner still sees their own');

    assert.equal((await t.call('POST', '/admin-api/stations/osaka/list', { token: tok, body: { listed: true } })).status, 200);
    assert.equal((await t.call('GET', '/public/stations')).json.stations.some((s) => s.id === 'osaka'), true);
    assert.equal((await t.call('GET', '/me', { token: owner })).json.held_by_operator, false);
  } finally { await t.close(); }
});

test('listing needs an active account with a position; a bad body is refused', async () => {
  const t = await boot();
  try {
    await addAdmin(t);
    await t.seed('nopos');
    await t.seed('frozen', 'disabled');
    t.inst.db.prepare('INSERT INTO stations (id, lat_grid, lon_grid) VALUES (?,?,?)').run('frozen', 1, 1);
    const tok = await adminToken(t);
    const a = await t.call('POST', '/admin-api/stations/nopos/list', { token: tok, body: { listed: true } });
    assert.equal(a.status, 409); assert.equal(a.json.code, 'no_position');
    const b = await t.call('POST', '/admin-api/stations/frozen/list', { token: tok, body: { listed: true } });
    assert.equal(b.status, 409); assert.equal(b.json.code, 'not_active');
    assert.equal((await t.call('POST', '/admin-api/stations/nopos/list', { token: tok, body: { listed: 'yes' } })).status, 400);
    assert.equal((await t.call('POST', '/admin-api/stations/nobody/list', { token: tok, body: { listed: true } })).status, 404);
    assert.equal((await t.call('POST', '/admin-api/stations/..%2Fx/list', { token: tok, body: { listed: true } })).status, 404);
  } finally { await t.close(); }
});

test('hiding the introduction text hides it from other people, and the owner editing it does not bring it back', async () => {
  const t = await boot();
  try {
    await addAdmin(t);
    await addStation(t, 'osaka', { description: 'rude text' });
    await addStation(t, 'kyoto');
    const tok = await adminToken(t);
    const owner = await t.loginToken('osaka');
    const other = await t.loginToken('kyoto');
    assert.equal((await t.call('GET', '/public/stations')).json.stations.find((s) => s.id === 'osaka').description, 'rude text');

    await t.call('POST', '/admin-api/stations/osaka/description', { token: tok, body: { hidden: true } });
    assert.equal((await t.call('GET', '/public/stations')).json.stations.find((s) => s.id === 'osaka').description, null);
    assert.equal((await t.call('GET', '/stations/osaka/summary', { token: other })).json.description, null);
    const mine = (await t.call('GET', '/stations/osaka/summary', { token: owner })).json;
    assert.equal(mine.description, 'rude text');
    assert.equal(mine.description_hidden, true, 'the owner is told');
    assert.equal((await t.call('GET', '/me', { token: owner })).json.description_hidden, true);

    await t.call('PUT', '/me/profile', { token: owner, body: { description: 'another rude text' } });
    assert.equal((await t.call('GET', '/public/stations')).json.stations.find((s) => s.id === 'osaka').description, null, 'an edit does not clear the hide');

    await t.call('POST', '/admin-api/stations/osaka/description', { token: tok, body: { hidden: false } });
    assert.equal((await t.call('GET', '/public/stations')).json.stations.find((s) => s.id === 'osaka').description, 'another rude text');
  } finally { await t.close(); }
});

test('disable revokes tokens at once; enable restores the earlier status and never skips e-mail confirmation', async () => {
  const t = await boot();
  try {
    await addAdmin(t);
    await addStation(t, 'osaka', { email: 'o@example.org' });
    await t.seed('unconfirmed', 'pending_email');
    t.inst.db.prepare("UPDATE users SET created_via = 'register', email = 'u@example.org' WHERE id = 'unconfirmed'").run();
    const tok = await adminToken(t);
    const owner = await t.loginToken('osaka');

    assert.equal((await t.call('POST', '/admin-api/stations/osaka/status', { token: tok, body: { active: false } })).status, 200);
    assert.equal((await t.call('GET', '/me', { token: owner })).status, 401, 'the token stopped working');
    assert.equal((await t.call('POST', '/auth/login', { body: { id: 'osaka', password: 'pw-12345678' } })).json.code, 'disabled');
    const en = await t.call('POST', '/admin-api/stations/osaka/status', { token: tok, body: { active: true } });
    assert.equal(en.json.status, 'active');
    assert.equal((await t.call('POST', '/auth/login', { body: { id: 'osaka', password: 'pw-12345678' } })).status, 200);

    // the one that matters: a registration nobody confirmed must still need confirming afterwards
    await t.call('POST', '/admin-api/stations/unconfirmed/status', { token: tok, body: { active: false } });
    const back = await t.call('POST', '/admin-api/stations/unconfirmed/status', { token: tok, body: { active: true } });
    assert.equal(back.json.status, 'pending_email');
    assert.equal(t.inst.db.prepare("SELECT status FROM users WHERE id='unconfirmed'").get().status, 'pending_email');
    assert.equal((await t.call('POST', '/auth/login', { body: { id: 'unconfirmed', password: 'pw-12345678' } })).json.code, 'email_not_verified');

    // enabling an account that is not disabled changes nothing
    const noop = await t.call('POST', '/admin-api/stations/osaka/status', { token: tok, body: { active: true } });
    assert.equal(noop.status, 200);
  } finally { await t.close(); }
});

test('an account disabled before the upgrade (no remembered status) is restored from what the row says', async () => {
  const t = await boot();
  try {
    await addAdmin(t);
    await t.seed('old-seed', 'disabled');                        // seeded: no e-mail, never needed one
    await t.seed('old-reg', 'disabled');
    t.inst.db.prepare("UPDATE users SET created_via='register', email='r@example.org' WHERE id='old-reg'").run();
    const tok = await adminToken(t);
    assert.equal((await t.call('POST', '/admin-api/stations/old-seed/status', { token: tok, body: { active: true } })).json.status, 'active');
    assert.equal((await t.call('POST', '/admin-api/stations/old-reg/status', { token: tok, body: { active: true } })).json.status, 'pending_email');
  } finally { await t.close(); }
});

test('operator sessions end at once when the operator is disabled or the password changes; the audit survives a deletion', async () => {
  const t = await boot();
  try {
    await addAdmin(t);
    await addStation(t, 'osaka');
    const tok = await adminToken(t);
    await t.call('POST', '/admin-api/stations/osaka/description', { token: tok, body: { hidden: true } });

    deleteAccount(t.inst.db, t.dir, 'osaka');
    const entries = (await t.call('GET', '/admin-api/audit', { token: tok })).json.entries;
    assert.ok(entries.some((e) => e.action === 'hide-description' && e.target === 'osaka'), 'the record outlives the station');

    t.inst.db.prepare('UPDATE admins SET token_version = token_version + 1 WHERE name = ?').run('ops-one');
    assert.equal((await t.call('GET', '/admin-api/me', { token: tok })).status, 401);
    const tok2 = await adminToken(t);
    t.inst.db.prepare("UPDATE admins SET status = 'disabled' WHERE name = ?").run('ops-one');
    assert.equal((await t.call('GET', '/admin-api/me', { token: tok2 })).status, 401);
    assert.equal((await t.call('POST', '/admin-api/login', { body: { name: 'ops-one', password: OP_PW }, ip: '198.51.100.20' })).status, 401);
  } finally { await t.close(); }
});

test('operator responses are never cached, and their token lifetime is the short one', async () => {
  const t = await boot();
  try {
    await addAdmin(t);
    const login = await t.call('POST', '/admin-api/login', { body: { name: 'ops-one', password: OP_PW } });
    assert.equal(login.headers.get('cache-control'), 'no-store');
    assert.equal(login.json.expires_in, 7200);
    const me = await t.call('GET', '/admin-api/me', { token: login.json.token });
    assert.equal(me.headers.get('cache-control'), 'no-store');
    const page = await fetch(t.base + '/admin');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-robots-tag'), 'noindex');
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  } finally { await t.close(); }

  // the token really ends: a 1-second lifetime (the JWT library judges expiry by the real clock)
  const s = await boot({}, { ADMIN_TOKEN_TTL_S: '1' });
  try {
    await addAdmin(s);
    const tok = await adminToken(s);
    assert.equal((await s.call('GET', '/admin-api/me', { token: tok })).status, 200);
    await new Promise((r) => setTimeout(r, 2100));
    const gone = await s.call('GET', '/admin-api/me', { token: tok });
    assert.equal(gone.status, 401);
    assert.equal(gone.json.code, 'token_invalid');
  } finally { await s.close(); }
});

test('the admin command: creates an operator (password from the environment, never argv), refuses a short one', async () => {
  const t = await boot();
  try {
    const run = (args, env) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'admin.js'), ...args], {
      env: { ...process.env, JWT_SECRET: t.cfg.jwtSecret, DATA_DIR: t.dir, SCRYPT_N: '1024', ...env }, encoding: 'utf8', input: '' });
    const short = run(['admin-create', 'ops-two', '--password-env', 'PW'], { PW: 'short' });
    assert.notEqual(short.status, 0);
    assert.match(short.stderr, /14\+ characters/);
    const withName = run(['admin-create', 'ops-two', '--password-env', 'PW'], { PW: 'xx-ops-two-xx-long-enough' });
    assert.notEqual(withName.status, 0);
    const ok = run(['admin-create', 'ops-two', '--password-env', 'PW'], { PW: 'this-is-long-enough-1' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(!ok.stdout.includes('this-is-long-enough-1'), 'the password is never printed');
    assert.equal((await t.call('POST', '/admin-api/login', { body: { name: 'ops-two', password: 'this-is-long-enough-1' } })).status, 200);
    assert.notEqual(run(['admin-create', 'ops-two', '--password-env', 'PW'], { PW: 'this-is-long-enough-1' }).status, 0, 'no second create');

    // changing the password signs the old sessions out
    const tok = await adminToken(t, 'ops-two', 'this-is-long-enough-1');
    assert.equal(run(['admin-password', 'ops-two', '--password-env', 'PW'], { PW: 'a-brand-new-long-password' }).status, 0);
    assert.equal((await t.call('GET', '/admin-api/me', { token: tok })).status, 401);

    // the CLI uses the same code as the page: it leaves audit rows and a hold the owner cannot undo
    await addStation(t, 'osaka');
    assert.equal(run(['list-off', 'osaka'], {}).status, 0);
    assert.equal(t.inst.db.prepare("SELECT admin_hold h FROM stations WHERE id='osaka'").get().h, 1);
    assert.ok(t.inst.db.prepare("SELECT 1 FROM admin_audit WHERE actor='cli' AND action='list-off' AND target='osaka'").get());
  } finally { await t.close(); }
});
