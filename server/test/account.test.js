'use strict';
// Phase 3: self-registration, email confirmation, password reset, and the owner's account.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { boot, consoleEvent, readOutbox, tokenIn, NOW } = require('./helpers');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { openDb } = require('../src/db');
const { createMailer } = require('../src/mailer');

const OPEN = { REGISTRATION_OPEN: '1', MAIL_TRANSPORT: 'outbox' };
const CV = 'draft-1';
const GOOD_PW = 'correct-horse-battery-9';
let ipCounter = 0;
const nextIp = () => `203.0.113.${(++ipCounter % 250) + 1}`;      // each call from its own "address": the sign-up limit is per address

const signup = (t, over = {}) => t.call('POST', '/auth/register', {
  ip: over.__ip || nextIp(),
  body: { id: 'sakura', email: 'Sakura@Example.org', password: GOOD_PW, consent: true, consent_version: CV, ...over, __ip: undefined },
});
const login = (t, id, password, ip) => t.call('POST', '/auth/login', { body: { id, password }, ip: ip || nextIp() });
const verify = (t, token) => t.call('POST', '/auth/verify-email', { body: { token }, ip: nextIp() });

async function registerAndVerify(t, id = 'sakura', email = 'sakura@example.org') {
  assert.equal((await signup(t, { id, email })).status, 200);
  const mail = readOutbox(t.dir).filter((m) => m.to === email).pop();
  assert.equal((await verify(t, tokenIn(mail))).status, 200);
  return (await login(t, id, GOOD_PW)).json.token;
}

// ------------------------------------------------------------------ configuration

test('registration is closed by default, and cannot be opened without a way to send mail', async () => {
  const t = await boot();
  try {
    const r = await signup(t);
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'closed');
    assert.equal(t.inst.db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
  } finally { await t.close(); }
  const base = { JWT_SECRET: 'x'.repeat(40), DATA_DIR: os.tmpdir() };
  assert.throws(() => loadConfig({ ...base, REGISTRATION_OPEN: '1' }, { quiet: true }), /MAIL_TRANSPORT/);
  assert.throws(() => loadConfig({ ...base, REGISTRATION_OPEN: '1', MAIL_TRANSPORT: 'outbox', NODE_ENV: 'production' }, { quiet: true }), /smtp/);
  assert.doesNotThrow(() => loadConfig({ ...base, REGISTRATION_OPEN: '1', MAIL_TRANSPORT: 'smtp', NODE_ENV: 'production' }, { quiet: true }));
  assert.throws(() => loadConfig({ ...base, MAP_TILE: 'bing' }, { quiet: true }), /MAP_TILE/);
  assert.equal(loadConfig(base, { quiet: true }).autoListOnVerify, false, 'a new station is NOT listed unless the operator says so');
});

// ------------------------------------------------------------------ sign up and confirm

test('sign up: pending until the mailed link is confirmed; the Console cannot log in before that', async () => {
  const t = await boot({}, OPEN);
  try {
    const r = await signup(t);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json).sort(), ['message_ja', 'success']);

    const mails = readOutbox(t.dir);
    assert.equal(mails.length, 1);
    const mail = mails[0];
    assert.equal(mail.to, 'sakura@example.org', 'the address is normalised');
    assert.match(mail.subject, /メールアドレスの確認/);
    assert.match(mail.text, new RegExp(`${t.cfg.publicUrl.replace(/\./g, '\\.')}/verify#token=`));
    assert.equal(mail.text.includes(GOOD_PW), false, 'a mail never carries the password');
    assert.equal(/\?token=|&token=/.test(mail.text), false, 'the token is in the #fragment, so it never reaches an access log');
    const token = tokenIn(mail);
    assert.equal(token.length, 43);

    const u = t.inst.db.prepare("SELECT * FROM users WHERE id = 'sakura'").get();
    assert.equal(u.status, 'pending_email');
    assert.equal(u.email, 'sakura@example.org');
    assert.equal(u.consent_version, CV);
    assert.ok(u.consent_at);
    assert.equal(u.created_via, 'register');
    assert.equal(t.inst.db.prepare("SELECT listed FROM stations WHERE id = 'sakura'").get().listed, 0);

    const pre = await login(t, 'sakura', GOOD_PW);                  // what the Console does
    assert.equal(pre.status, 403);
    assert.equal(pre.json.code, 'email_not_verified');

    // opening the page (a GET) never confirms anything
    const page = await fetch(t.base + '/verify#token=' + token);
    assert.equal(page.status, 200);
    assert.equal(t.inst.db.prepare("SELECT status FROM users WHERE id = 'sakura'").get().status, 'pending_email');

    const ok = await verify(t, token);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.id, 'sakura');
    const after = t.inst.db.prepare("SELECT * FROM users WHERE id = 'sakura'").get();
    assert.equal(after.status, 'active');
    assert.ok(after.email_verified_at);
    assert.equal(t.inst.db.prepare("SELECT listed FROM stations WHERE id = 'sakura'").get().listed, 0);

    const good = await login(t, 'sakura', GOOD_PW);
    assert.equal(good.status, 200);
    // and from here the Console works as before: setup, then data
    const tok = good.json.token;
    assert.equal((await t.call('POST', '/setup-id', { token: tok, body: { id: 'sakura', gps_latitude: '35.1', gps_longitude: '139.2' } })).status, 200);
    assert.equal((await t.call('POST', '/upload-data/sakura', { token: tok, body: consoleEvent() })).status, 200);

    const again = await verify(t, token);                          // single use
    assert.equal(again.status, 400);
    assert.equal(again.json.code, 'bad_token');
    // the raw token is nowhere in the database: only its hash
    t.inst.db.pragma('wal_checkpoint(TRUNCATE)');
    assert.equal(fs.readFileSync(path.join(t.dir, 'db.sqlite')).includes(Buffer.from(token)), false);
  } finally { await t.close(); }
});

test('sign up: every kind of bad input is refused and creates nothing', async () => {
  const t = await boot({}, OPEN);
  try {
    const cases = [
      ['id too short', { id: 'ab' }, 400, 'bad_id'],
      ['id with a space', { id: 'has space' }, 400, 'bad_id'],
      ['id with capitals is lower-cased, but not with symbols', { id: 'Bad!Id' }, 400, 'bad_id'],
      ['id in Japanese', { id: '日本語のid' }, 400, 'bad_id'],
      ['path-like id', { id: '../etc' }, 400, 'bad_id'],
      ['id not a string', { id: 12345 }, 400, 'bad_id'],
      ['reserved id', { id: 'admin' }, 409, 'id_taken'],
      ['reserved id (a page name)', { id: 'account' }, 409, 'id_taken'],
      ['email missing', { email: undefined }, 400, 'bad_email'],
      ['email without a domain', { email: 'sakura' }, 400, 'bad_email'],
      ['email with a space', { email: 'sak ura@example.org' }, 400, 'bad_email'],
      ['email with two @', { email: 'a@b@example.org' }, 400, 'bad_email'],
      ['email with a header-injection newline', { email: 'a@example.org\nBcc: x@example.org' }, 400, 'bad_email'],
      ['no consent', { consent: undefined }, 400, 'consent_required'],
      ['consent false', { consent: false }, 400, 'consent_required'],
      ['consent as the string "true"', { consent: 'true' }, 400, 'consent_required'],
      ['consent to a different text', { consent_version: 'draft-0' }, 400, 'consent_required'],
      ['password too short', { password: 'short-pw' }, 400, 'weak_password'],
      ['password too common', { password: 'password123' }, 400, 'weak_password'],
      ['password contains the id', { id: 'sakura', password: 'my-sakura-password' }, 400, 'weak_password'],
      ['one repeated character', { password: 'aaaaaaaaaaaa' }, 400, 'weak_password'],
      ['password not a string', { password: 1234567890123 }, 400, 'weak_password'],
    ];
    for (const [name, over, status, code] of cases) {
      const r = await signup(t, over);
      assert.equal(r.status, status, name);
      assert.equal(r.json.code, code, name);
      assert.equal(typeof r.json.message_ja, 'string', `${name}: a message people can read`);
    }
    assert.equal(t.inst.db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
    assert.equal(readOutbox(t.dir).length, 0);
  } finally { await t.close(); }
});

test('sign up: a hidden field that only a bot fills in is answered as success and does nothing', async () => {
  const t = await boot({}, OPEN);
  try {
    const r = await signup(t, { website: 'http://spam.example' });
    assert.equal(r.status, 200);
    assert.equal(t.inst.db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
    assert.equal(readOutbox(t.dir).length, 0);
  } finally { await t.close(); }
});

test('sign up: an id that is taken (even by an unconfirmed sign-up) is refused; the address is never revealed', async () => {
  const t = await boot({}, OPEN);
  try {
    const first = await signup(t);
    assert.equal(first.status, 200);
    assert.equal((await signup(t, { email: 'other@example.org' })).status, 409, 'the id is held by the unconfirmed sign-up');
    assert.equal((await signup(t, { id: 'SAKURA', email: 'other@example.org' })).json.code, 'id_taken', 'case does not matter');

    // a new id with the SAME address answers exactly like a brand new sign-up ...
    const dup = await signup(t, { id: 'momiji', email: 'SAKURA@example.org' });
    assert.equal(dup.status, 200);
    assert.deepEqual(dup.json, first.json, 'same body: nothing tells the asker the address is known');
    // ... creates nothing, and the owner is told by mail instead
    assert.equal(t.inst.db.prepare("SELECT COUNT(*) n FROM users WHERE id = 'momiji'").get().n, 0);
    const mails = readOutbox(t.dir);
    assert.equal(mails.length, 2);
    assert.match(mails[1].subject, /すでに登録されています/);
    assert.equal(tokenIn(mails[1]), null, 'that mail has no confirmation link');
    assert.equal(mails[1].to, 'sakura@example.org');
  } finally { await t.close(); }
});

test('sign up: limited per client address', async () => {
  const t = await boot({}, OPEN);
  try {
    for (let i = 0; i < 5; i++) {
      assert.equal((await signup(t, { id: `user-${i}`, email: `u${i}@example.org`, __ip: '198.51.100.9' })).status, 200);
    }
    const r = await signup(t, { id: 'user-5', email: 'u5@example.org', __ip: '198.51.100.9' });
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.equal((await signup(t, { id: 'user-6', email: 'u6@example.org', __ip: '198.51.100.10' })).status, 200, 'another address is not affected');
  } finally { await t.close(); }
});

// ------------------------------------------------------------------ mail budgets

test('mail is rationed per recipient and in total; the answers never change', async () => {
  const t = await boot({}, { ...OPEN, MAIL_PER_ADDRESS_PER_DAY: '3', MAIL_GLOBAL_PER_DAY: '5' });
  try {
    await registerAndVerify(t, 'sakura', 'sakura@example.org');       // mails: 1 (confirmation)
    const sent = () => readOutbox(t.dir).length;
    const bodies = new Set();
    for (let i = 0; i < 6; i++) {                                     // someone keeps asking for resets for ONE address
      const r = await t.call('POST', '/auth/forgot', { body: { email: 'sakura@example.org' }, ip: nextIp() });
      assert.equal(r.status, 200);
      bodies.add(JSON.stringify(r.json));
    }
    assert.equal(bodies.size, 1, 'the same answer every time');
    assert.equal(readOutbox(t.dir).filter((m) => m.to === 'sakura@example.org').length, 3, 'at most 3 a day to one address');

    // the total budget (5) is shared by everyone
    for (const [id, email] of [['momiji', 'm@example.org'], ['kaede', 'k@example.org'], ['ume', 'u@example.org']]) {
      assert.equal((await signup(t, { id, email })).status, 200);
    }
    assert.equal(sent(), 5, 'never more than 5 in a day in total');
    // next day the budget is back
    t.advance(25 * 3600 * 1000);
    await t.call('POST', '/auth/forgot', { body: { email: 'sakura@example.org' }, ip: nextIp() });
    assert.equal(sent(), 6);
  } finally { await t.close(); }
});

// ------------------------------------------------------------------ tokens

test('confirmation link: expires after 24 hours; "send again" voids the old link and issues a new one', async () => {
  const t = await boot({}, OPEN);
  try {
    await signup(t);
    const old = tokenIn(readOutbox(t.dir)[0]);

    t.advance(25 * 3600 * 1000);
    assert.equal((await verify(t, old)).json.code, 'bad_token', 'expired');

    const re = await t.call('POST', '/auth/resend-verify', { body: { email: 'sakura@example.org' }, ip: nextIp() });
    assert.equal(re.status, 200);
    const fresh = tokenIn(readOutbox(t.dir)[1]);
    assert.notEqual(fresh, old);

    const re2 = await t.call('POST', '/auth/resend-verify', { body: { email: 'sakura@example.org' }, ip: nextIp() });
    const fresh2 = tokenIn(readOutbox(t.dir)[2]);
    assert.equal((await verify(t, fresh)).json.code, 'bad_token', 'the previous unused link was voided by the next one');
    assert.equal((await verify(t, fresh2)).status, 200);
    assert.deepEqual(re2.json, re.json);

    // for a confirmed account, or an unknown address, nothing is sent and the answer is the same
    const before = readOutbox(t.dir).length;
    const a = await t.call('POST', '/auth/resend-verify', { body: { email: 'sakura@example.org' }, ip: nextIp() });
    const b = await t.call('POST', '/auth/resend-verify', { body: { email: 'nobody@example.org' }, ip: nextIp() });
    assert.equal(readOutbox(t.dir).length, before);
    assert.deepEqual(a.json, b.json);
  } finally { await t.close(); }
});

test('links are not interchangeable and garbage is refused', async () => {
  const t = await boot({}, OPEN);
  try {
    await signup(t);
    const verifyToken = tokenIn(readOutbox(t.dir)[0]);
    const r = await t.call('POST', '/auth/reset', { body: { token: verifyToken, password: GOOD_PW }, ip: nextIp() });
    assert.equal(r.status, 400, 'a confirmation link cannot reset a password');
    assert.equal((await verify(t, verifyToken)).status, 200);

    await t.call('POST', '/auth/forgot', { body: { email: 'sakura@example.org' }, ip: nextIp() });
    const resetToken = tokenIn(readOutbox(t.dir).pop());
    assert.equal((await verify(t, resetToken)).status, 400, 'a reset link cannot confirm an address');

    for (const bad of [undefined, null, '', 'x', 'a'.repeat(43), 12345, {}, ['x'], 'a'.repeat(500)]) {
      assert.equal((await verify(t, bad)).status, 400, JSON.stringify(bad));
    }
  } finally { await t.close(); }
});

// ------------------------------------------------------------------ forgotten password

test('password reset: one link, one hour, one use; it signs every old login out', async () => {
  const t = await boot({}, OPEN);
  try {
    const oldToken = await registerAndVerify(t);
    assert.equal((await t.call('GET', '/me', { token: oldToken })).status, 200);

    const known = await t.call('POST', '/auth/forgot', { body: { email: ' SAKURA@example.org ' }, ip: nextIp() });
    const unknown = await t.call('POST', '/auth/forgot', { body: { email: 'nobody@example.org' }, ip: nextIp() });
    assert.deepEqual(known.json, unknown.json, 'asking about an unknown address looks exactly like asking about a known one');
    const mails = readOutbox(t.dir).filter((m) => /再設定/.test(m.subject));
    assert.equal(mails.length, 1, 'only the real address got a mail');
    assert.match(mails[0].text, /\/reset#token=/);
    const rt = tokenIn(mails[0]);

    const weak = await t.call('POST', '/auth/reset', { body: { token: rt, password: 'short' }, ip: nextIp() });
    assert.equal(weak.json.code, 'weak_password');
    // a rejected password does not use up the link
    const NEW_PW = 'another-long-passphrase-4';
    assert.equal((await t.call('POST', '/auth/reset', { body: { token: rt, password: NEW_PW }, ip: nextIp() })).status, 200);
    assert.equal((await t.call('POST', '/auth/reset', { body: { token: rt, password: NEW_PW }, ip: nextIp() })).json.code, 'bad_token', 'single use');

    assert.equal((await login(t, 'sakura', GOOD_PW)).status, 401, 'the old password is gone');
    assert.equal((await login(t, 'sakura', NEW_PW)).status, 200);
    const gone = await t.call('GET', '/me', { token: oldToken });
    assert.equal(gone.status, 401, 'a login from before the reset no longer works');
    assert.equal(gone.json.error, 'Token revoked');
  } finally { await t.close(); }
});

test('password reset: expires after one hour; a newer link voids the older one; it also confirms a pending account', async () => {
  const t = await boot({}, OPEN);
  try {
    await signup(t);                                                  // pending, never confirmed
    await t.call('POST', '/auth/forgot', { body: { email: 'sakura@example.org' }, ip: nextIp() });
    const first = tokenIn(readOutbox(t.dir).pop());
    await t.call('POST', '/auth/forgot', { body: { email: 'sakura@example.org' }, ip: nextIp() });
    const second = tokenIn(readOutbox(t.dir).pop());
    assert.equal((await t.call('POST', '/auth/reset', { body: { token: first, password: GOOD_PW }, ip: nextIp() })).status, 400, 'voided by the newer link');

    t.advance(61 * 60 * 1000);
    assert.equal((await t.call('POST', '/auth/reset', { body: { token: second, password: GOOD_PW }, ip: nextIp() })).status, 400, 'an hour is up');

    await t.call('POST', '/auth/forgot', { body: { email: 'sakura@example.org' }, ip: nextIp() });
    const third = tokenIn(readOutbox(t.dir).pop());
    assert.equal((await t.call('POST', '/auth/reset', { body: { token: third, password: 'fresh-long-passphrase-7' }, ip: nextIp() })).status, 200);
    const u = t.inst.db.prepare("SELECT status, email_verified_at FROM users WHERE id = 'sakura'").get();
    assert.equal(u.status, 'active', 'reaching the mailbox is the same proof as the confirmation link');
    assert.ok(u.email_verified_at);
  } finally { await t.close(); }
});

test('a disabled account is not sent a reset link', async () => {
  const t = await boot({}, OPEN);
  try {
    await registerAndVerify(t);
    t.inst.db.prepare("UPDATE users SET status = 'disabled' WHERE id = 'sakura'").run();
    const before = readOutbox(t.dir).length;
    assert.equal((await t.call('POST', '/auth/forgot', { body: { email: 'sakura@example.org' }, ip: nextIp() })).status, 200);
    assert.equal(readOutbox(t.dir).length, before);
  } finally { await t.close(); }
});

// ------------------------------------------------------------------ the owner's account

test('/me: only for the owner; the address shows there and nowhere else', async () => {
  const t = await boot({}, OPEN);
  try {
    assert.equal((await t.call('GET', '/me')).status, 401);
    await t.seed('legacy-a');
    const seeded = (await t.call('GET', '/me', { token: await t.loginToken('legacy-a') })).json;
    assert.equal(seeded.email, null);
    assert.equal(seeded.email_verified, false);

    const tok = await registerAndVerify(t);
    const me = (await t.call('GET', '/me', { token: tok })).json;
    assert.equal(me.id, 'sakura');
    assert.equal(me.email, 'sakura@example.org');
    assert.equal(me.email_verified, true);
    assert.equal(me.consent_version, CV);
    assert.equal(me.listed, false);
    assert.equal(me.listing_needs_approval, true);
    assert.equal('password_hash' in me, false);
    // not in the public list, not in anyone else's view of the station
    t.inst.db.prepare("UPDATE stations SET listed = 1, lat_grid = 35.05, lon_grid = 139.05 WHERE id = 'sakura'").run();
    const other = await t.loginToken('legacy-a');
    const seen = JSON.stringify([(await t.call('GET', '/public/stations')).json, (await t.call('GET', '/stations/sakura/summary', { token: other })).json]);
    assert.equal(/sakura@example\.org|example\.org/.test(seen), false);
  } finally { await t.close(); }
});

test('profile: the introduction is plain text; taking oneself off the map is free, getting on needs approval', async () => {
  const t = await boot({}, OPEN);
  try {
    const tok = await registerAndVerify(t);
    const put = (body) => t.call('PUT', '/me/profile', { token: tok, body });

    const xss = '<script>alert(1)</script>  <b>hi</b>\nsecond line\u0007';
    const r = await put({ description: xss });
    assert.equal(r.status, 200);
    assert.equal(r.json.public_description, '<script>alert(1)</script> <b>hi</b> second line', 'control characters and runs of spaces collapse; markup stays TEXT');
    assert.equal((await put({ description: 'x'.repeat(201) })).json.code, 'too_long');
    assert.equal((await put({ description: 'あ'.repeat(200) })).status, 200, 'the limit counts characters, not bytes');
    assert.equal((await put({ description: 42 })).json.code, 'bad_description');
    assert.equal((await put({ description: null })).json.public_description, null);
    assert.equal((await put({ description: '   ' })).json.public_description, null);

    const ask = await put({ listed: true });
    assert.equal(ask.status, 403);
    assert.equal(ask.json.code, 'needs_approval');
    assert.equal((await put({ listed: 'yes' })).json.code, 'bad_listed');
    t.inst.db.prepare("UPDATE stations SET listed = 1 WHERE id = 'sakura'").run();       // the operator listed it
    assert.equal((await put({ listed: false })).status, 200);
    assert.equal(t.inst.db.prepare("SELECT listed FROM stations WHERE id = 'sakura'").get().listed, 0);
  } finally { await t.close(); }
});

test('with AUTO_LIST_ON_VERIFY the station is listed on confirmation and the owner may list it again', async () => {
  const t = await boot({}, { ...OPEN, AUTO_LIST_ON_VERIFY: '1' });
  try {
    const tok = await registerAndVerify(t);
    assert.equal(t.inst.db.prepare("SELECT listed FROM stations WHERE id = 'sakura'").get().listed, 1);
    const me = (await t.call('GET', '/me', { token: tok })).json;
    assert.equal(me.listing_needs_approval, false);
    assert.equal((await t.call('PUT', '/me/profile', { token: tok, body: { listed: false } })).status, 200);
    assert.equal((await t.call('PUT', '/me/profile', { token: tok, body: { listed: true } })).status, 200);
    assert.equal(t.inst.db.prepare("SELECT listed FROM stations WHERE id = 'sakura'").get().listed, 1);
  } finally { await t.close(); }
});

test('change password: needs the current one, signs other logins out, keeps this one', async () => {
  const t = await boot({}, OPEN);
  try {
    const tok = await registerAndVerify(t);
    const NEW_PW = 'brand-new-passphrase-1';
    assert.equal((await t.call('POST', '/me/password', { token: tok, body: { password: 'wrong-password-1', new_password: NEW_PW } })).json.code, 'wrong_password');
    assert.equal((await t.call('POST', '/me/password', { token: tok, body: { password: GOOD_PW, new_password: 'short' } })).json.code, 'weak_password');
    const r = await t.call('POST', '/me/password', { token: tok, body: { password: GOOD_PW, new_password: NEW_PW } });
    assert.equal(r.status, 200);
    assert.equal((await t.call('GET', '/me', { token: tok })).status, 401, 'the old login is out');
    assert.equal((await t.call('GET', '/me', { token: r.json.token })).status, 200, 'the returned token carries on');
    assert.equal((await login(t, 'sakura', GOOD_PW)).status, 401);
    assert.equal((await login(t, 'sakura', NEW_PW)).status, 200);
  } finally { await t.close(); }
});

test('delete my account: needs the password, removes everything, and the id stays reserved for 90 days', async () => {
  const t = await boot({}, OPEN);
  try {
    const tok = await registerAndVerify(t);
    await t.call('POST', '/setup-id', { token: tok, body: { id: 'sakura', gps_latitude: '35.1', gps_longitude: '139.2' } });
    await t.call('POST', '/upload-data/sakura', { token: tok, body: consoleEvent() });
    await t.seed('osaka');
    await t.call('POST', '/upload-data/osaka', { token: await t.loginToken('osaka'), body: consoleEvent() });
    const dir = path.join(t.dir, 'events', 'sakura');
    assert.ok(fs.existsSync(dir));

    const wrong = await t.call('POST', '/me/delete', { token: tok, body: { password: 'not-the-password' } });
    assert.equal(wrong.status, 401);
    assert.ok(fs.existsSync(dir), 'nothing is removed on a wrong password');
    assert.equal((await t.call('GET', '/me', { token: tok })).status, 200);

    const gone = await t.call('POST', '/me/delete', { token: tok, body: { password: GOOD_PW } });
    assert.equal(gone.status, 200);
    assert.equal(fs.existsSync(dir), false);
    for (const [table, col] of [['users', 'id'], ['stations', 'id'], ['stats_hourly', 'station_id'], ['stats_adc', 'station_id'], ['ingest_keys', 'station_id'], ['auth_tokens', 'user_id']]) {
      assert.equal(t.inst.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${col} = 'sakura'`).get().n, 0, table);
    }
    assert.equal((await t.call('GET', '/me', { token: tok })).status, 401, 'the login stops working');
    assert.equal((await login(t, 'sakura', GOOD_PW)).status, 401);
    assert.ok(fs.existsSync(path.join(t.dir, 'events', 'osaka')), 'other stations are untouched');

    assert.equal((await signup(t, { id: 'sakura', email: 'new@example.org' })).json.code, 'id_taken', 'nobody can take the id over straight away');
    t.advance(91 * 24 * 3600 * 1000);
    assert.equal((await signup(t, { id: 'sakura', email: 'new@example.org' })).status, 200, 'after 90 days it is free again');
  } finally { await t.close(); }
});

test('download my own data: only my files, only valid names', async () => {
  const t = await boot({}, OPEN);
  try {
    const tok = await registerAndVerify(t);
    await t.call('POST', '/upload-data/sakura', { token: tok, body: consoleEvent({ event: 1, time: 1 }) });
    await t.call('POST', '/upload-data/sakura', { token: tok, body: consoleEvent({ event: 2, time: 2, timestamp_utc: '2001-01-01T00:00:00.000Z' }) });   // bad clock
    await t.seed('osaka');
    const o = await t.loginToken('osaka');
    await t.call('POST', '/upload-data/osaka', { token: o, body: consoleEvent({ event: 7, time: 7 }) });

    assert.equal((await t.call('GET', '/me/events')).status, 401);
    const list = (await t.call('GET', '/me/events', { token: tok })).json.files;
    assert.deepEqual(list.map((f) => f.name), ['2026-11-21.badclock.jsonl', '2026-11-21.jsonl']);
    assert.ok(list.every((f) => f.bytes > 0));

    const res = await fetch(`${t.base}/me/events/2026-11-21.jsonl`, { headers: { Authorization: `Bearer ${tok}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /ndjson/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="?sakura-2026-11-21\.jsonl"?/);
    const body = await res.text();
    assert.equal(body, fs.readFileSync(path.join(t.dir, 'events', 'sakura', '2026-11-21.jsonl'), 'utf8'));
    assert.equal(body.includes('"event":7'), false, "never another station's data");

    for (const name of ['..%2F..%2Fdb.sqlite', '2026-11-21.jsonl%00.txt', 'db.sqlite', '2026-1-1.jsonl', '..%2Fosaka%2F2026-11-21.jsonl']) {
      const r = await fetch(`${t.base}/me/events/${name}`, { headers: { Authorization: `Bearer ${tok}` } });
      assert.ok([400, 404].includes(r.status), name);
    }
    // osaka's file name is valid, but it is looked up in MY directory, so there is nothing to find
    const other = await fetch(`${t.base}/me/events/2026-11-21.jsonl`, { headers: { Authorization: `Bearer ${o}` } });
    assert.equal((await other.text()).includes('"event":1,'), false);
  } finally { await t.close(); }
});

// ------------------------------------------------------------------ mail transports and the sweep

test('mailer: smtp builds a plain-text message from the configured sender; outbox keeps a private file; none refuses', async () => {
  const sent = []; let opts;
  const cfg = loadConfig({ JWT_SECRET: 'x'.repeat(40), DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'crd-mail-')), MAIL_TRANSPORT: 'smtp',
                           SMTP_HOST: 'smtp.example.org', SMTP_PORT: '465', SMTP_SECURE: '1', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'CosmicRay <noreply@example.org>' }, { quiet: true });
  const m = createMailer(cfg, { createTransport: (o) => { opts = o; return { sendMail: async (msg) => { sent.push(msg); } }; } });
  await m.send({ to: 'a@example.org', subject: 's', text: 't' });
  assert.deepEqual(opts.auth, { user: 'u', pass: 'p' });
  assert.equal(opts.secure, true);
  assert.equal(opts.requireTLS, false);                 // already TLS from the first byte
  assert.equal(opts.host, 'smtp.example.org');
  // STARTTLS (port 587) must be REQUIRED for a remote server, and may be skipped only for this machine
  const starttls = (host) => { let o; createMailer({ ...cfg, mail: { ...cfg.mail, smtp: { ...cfg.mail.smtp, host, port: 587, secure: false } } },
    { createTransport: (x) => { o = x; return { sendMail: async () => {} }; } }); return o.requireTLS; };
  assert.equal(starttls('smtp.gmail.com'), true);
  assert.equal(starttls('localhost'), false);
  assert.deepEqual(sent[0], { from: 'CosmicRay <noreply@example.org>', to: 'a@example.org', subject: 's', text: 't' });
  assert.equal('html' in sent[0], false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-mail-'));
  const ob = createMailer({ ...cfg, dataDir: dir, mail: { ...cfg.mail, transport: 'outbox' } });
  await ob.send({ to: 'a@example.org', subject: 's', text: 't' });
  const files = fs.readdirSync(path.join(dir, 'outbox'));
  assert.equal(files.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'outbox', files[0]), 'utf8')).to, 'a@example.org');

  await assert.rejects(() => createMailer({ ...cfg, mail: { ...cfg.mail, transport: 'none' } }).send({}), /not configured/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a failing mail transport does not break sign-up or leak the failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-fail-'));
  const cfg = loadConfig({ JWT_SECRET: 'test-secret-' + 'x'.repeat(40), DATA_DIR: dir, SCRYPT_N: '1024', ...OPEN }, { quiet: true });
  const inst = await createApp(cfg, { now: () => NOW, mailer: { transport: 'broken', send: async () => { throw new Error('smtp down: user=secret@x password=hunter2'); } } });
  const server = await new Promise((r) => { const s = inst.app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'sakura', email: 'sakura@example.org', password: GOOD_PW, consent: true, consent_version: CV }),
    });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.equal(text.includes('hunter2') || text.includes('smtp'), false);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    inst.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('on start, registrations never confirmed within UNVERIFIED_DAYS are swept away, others stay', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-sweep-'));
  try {
    const db = openDb(dir);
    const ins = db.prepare("INSERT INTO users (id,password_hash,status,created_at,email) VALUES (?,?,?,?,?)");
    ins.run('stale-one', 'h', 'pending_email', new Date(NOW - 8 * 86400e3).toISOString(), 'stale@example.org');
    ins.run('fresh-one', 'h', 'pending_email', new Date(NOW - 1 * 86400e3).toISOString(), 'fresh@example.org');
    ins.run('real-one', 'h', 'active', new Date(NOW - 80 * 86400e3).toISOString(), 'real@example.org');
    db.prepare("INSERT INTO stations (id) VALUES ('stale-one')").run();
    db.prepare("INSERT INTO auth_tokens (user_id,kind,token_hash,expires_at,created_at) VALUES ('stale-one','verify','hh','2030-01-01','2026-01-01')").run();
    db.prepare("INSERT INTO deleted_ids (id, deleted_at) VALUES ('old-gone', ?)").run(new Date(NOW - 100 * 86400e3).toISOString());
    db.prepare("INSERT INTO deleted_ids (id, deleted_at) VALUES ('new-gone', ?)").run(new Date(NOW - 10 * 86400e3).toISOString());
    db.close();

    const cfg = loadConfig({ JWT_SECRET: 'test-secret-' + 'x'.repeat(40), DATA_DIR: dir, SCRYPT_N: '1024' }, { quiet: true });
    const inst = await createApp(cfg, { now: () => NOW });
    const ids = inst.db.prepare('SELECT id FROM users ORDER BY id').all().map((r) => r.id);
    assert.deepEqual(ids, ['fresh-one', 'real-one']);
    assert.equal(inst.db.prepare("SELECT COUNT(*) n FROM auth_tokens WHERE user_id = 'stale-one'").get().n, 0);
    assert.deepEqual(inst.db.prepare('SELECT id FROM deleted_ids').all().map((r) => r.id), ['new-gone'], 'a reservation older than 90 days lapses');
    inst.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ the pages

test('the Phase 3 pages exist, say they are drafts where the text is not final, and never confirm by themselves', () => {
  const pub = path.join(__dirname, '..', 'public');
  for (const f of ['register', 'verify', 'forgot', 'reset', 'account', 'terms', 'privacy', 'station', 'index']) {
    assert.ok(fs.existsSync(path.join(pub, f + '.html')), f);
  }
  for (const f of ['terms', 'privacy']) {
    const html = fs.readFileSync(path.join(pub, f + '.html'), 'utf8');
    assert.match(html, /class="draft"/, `${f}: marked as a draft until the person responsible has approved it`);
  }
  const reg = fs.readFileSync(path.join(pub, 'register.html'), 'utf8');
  assert.match(reg, /name="website"/, 'the hidden field');
  assert.match(reg, /href="\/terms"/);
  assert.match(reg, /href="\/privacy"/);
  assert.equal(/type="checkbox"[^>]*checked/i.test(reg), false, 'consent is never pre-ticked');

  const v = fs.readFileSync(path.join(pub, 'js', 'verify.js'), 'utf8');
  const call = v.indexOf('/auth/verify-email');
  assert.ok(call > v.indexOf("addEventListener('click'"), 'the confirmation is sent only from a button click, never on page load');
  assert.match(v, /history\.replaceState/, 'the token is removed from the address bar and history');
});

test('a refused token and a wrong password are different 401s, so a page can tell them apart', async () => {
  const t = await boot({}, OPEN);
  try {
    const tok = await registerAndVerify(t);
    for (const token of [undefined, 'garbage', tok + 'x']) {
      const r = await t.call('GET', '/me', { token });
      assert.equal(r.status, 401);
      assert.equal(r.json.code, 'token_invalid', 'ends the session on the page');
    }
    const wrong = await t.call('POST', '/me/delete', { token: tok, body: { password: 'not-the-password' } });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.code, 'wrong_password', 'must NOT end the session on the page');
    const wrong2 = await t.call('POST', '/me/password', { token: tok, body: { password: 'not-the-password', new_password: 'whatever-long-enough-1' } });
    assert.equal(wrong2.json.code, 'wrong_password');
    // the Console still reads the same human-readable "error" text as before
    const c = await login(t, 'sakura', 'bad-password-123');
    assert.deepEqual(c.json, { error: 'Invalid credentials' });
  } finally { await t.close(); }
});

test('the shared page script ends the session only for a refused token', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'common.js'), 'utf8');
  assert.match(src, /code === 'token_invalid'\) store\.clear\(\)/);
  assert.equal(/status === 401 && auth\) store\.clear/.test(src), false);
});

test('the answer does not wait for the mail: a known address cannot be told from an unknown one by timing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-slow-'));
  const cfg = loadConfig({ JWT_SECRET: 'test-secret-' + 'x'.repeat(40), DATA_DIR: dir, SCRYPT_N: '1024', ...OPEN }, { quiet: true });
  let started = 0;
  const never = { transport: 'never', send: () => { started++; return new Promise(() => {}); } };   // a mail server that never answers
  const inst = await createApp(cfg, { now: () => NOW, mailer: never });
  const server = await new Promise((r) => { const s = inst.app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, ip) => Promise.race([
    fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify(body) }).then((r) => r.status),
    new Promise((r) => setTimeout(() => r('TIMED OUT'), 4000)),
  ]);
  try {
    const reg = { id: 'sakura', email: 'sakura@example.org', password: GOOD_PW, consent: true, consent_version: CV };
    assert.equal(await post('/auth/register', reg, '198.51.100.1'), 200, 'a new sign-up answers although the mail is stuck');
    assert.equal(await post('/auth/register', { ...reg, id: 'momiji' }, '198.51.100.2'), 200, 'a known address, too');
    assert.equal(await post('/auth/forgot', { email: 'sakura@example.org' }, '198.51.100.3'), 200);
    assert.equal(await post('/auth/forgot', { email: 'nobody@example.org' }, '198.51.100.4'), 200);
    assert.equal(await post('/auth/resend-verify', { email: 'sakura@example.org' }, '198.51.100.5'), 200);
    assert.ok(started >= 3, 'the sends were started, just not waited for');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    inst.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/healthz reports the version in package.json, so a deployed release can be told from the tag', async () => {
  const t = await boot();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.equal((await t.call('GET', '/healthz')).json.version, pkg.version);
  } finally { await t.close(); }
});
