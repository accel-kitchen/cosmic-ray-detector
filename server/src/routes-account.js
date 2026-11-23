'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { deleteAccount } = require('./accounts');

// Self-registration and the account page (plan, section 4-2).
//
//   POST /auth/register        sign up (closed unless REGISTRATION_OPEN is set)
//   POST /auth/verify-email    confirm the address with the mailed token (a button on the page: a mere GET never confirms)
//   POST /auth/resend-verify   send the confirmation mail again
//   POST /auth/forgot          mail a password-reset link
//   POST /auth/reset           choose a new password with that token
//   POST /auth/claim           a reserved station of the old server: terms + password, with the link an operator mailed
//   GET  /me                   the owner's own account
//   PUT  /me/profile           public introduction, and taking the station off the map
//   POST /me/password          change the password
//   POST /me/delete            delete the account and ALL its data
//   GET  /me/events[/:file]    download one's own measurement files
//
// Rules this file keeps:
//  - Whether an email address is registered is never revealed: sign-up with a known address, "forgot"
//    for an unknown one and "resend" all answer the same as the normal case.
//  - Tokens are random, mailed once, stored only as a SHA-256 hash, single-use, and expire (24 h to
//    confirm, 1 h to reset). The mailed link keeps the token in the #fragment so it never reaches
//    an access log.
//  - Mail is rationed per recipient and in total each day, so this server cannot be used to send
//    mail at other people.

const RESERVED = new Set([
  'admin', 'administrator', 'root', 'system', 'support', 'staff', 'info', 'help', 'api', 'www', 'mail',
  'noreply', 'no-reply', 'test', 'demo', 'null', 'undefined', 'official', 'moderator', 'security',
  'cosmicray', 'cosmic-ray', 'accel-kitchen', 'accelkitchen', 'kasoku-kitchen', 'webmaster', 'postmaster',
  'register', 'login', 'logout', 'account', 'verify', 'reset', 'forgot', 'station', 'stations', 'public',
]);

// The shortest password a participant may choose (the owner's decision, 2026-11-22: 8, down from 10).
// The page texts (register, reset, account) say the same number; the login limits do the rest.
const PASSWORD_MIN = 8;

// Not a full list: it stops the obvious ones. Length and the checks below do the real work.
// With the minimum at 8, the usual 8- and 9-character choices are in here too.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'passw0rd', 'pass1234', '12345678', '123456789', '11111111', '00000000', '87654321',
  'qwertyui', 'qwerty123', 'abcd1234', 'abc12345', 'abcdefgh', 'asdfghjk', '1q2w3e4r', 'iloveyou', 'iloveyou1',
  'admin123', 'letmein1', 'welcome1', 'minecraft', 'pokemon1', 'sakura123', 'cosmicray', 'cosmic123',
  'password12', 'password123', 'password1234', 'passw0rd123', '1234567890', '12345678910', '0123456789',
  'qwertyuiop', 'qwerty12345', 'qwerty123456', 'iloveyou123', 'abcdefghij', 'abc1234567', 'asdfghjkl1',
  'letmein1234', 'welcome1234', 'admin12345', 'changeme123', 'cosmicray1', 'cosmicray12', 'cosmicray123',
  'sakurasaku', 'password00', '1q2w3e4r5t', 'zaq12wsxcde', 'minecraft123', 'pokemon1234',
]);

const DAY = 24 * 3600 * 1000;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function normEmail(v) {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  if (e.length < 6 || e.length > 254 || /[\s\u0000-\u001f<>"',;()\\]/.test(e)) return null;
  const m = /^([^@]{1,64})@([^@]+\.[^@]{2,})$/.exec(e);
  return m ? e : null;
}

// Returns a problem code, or null when the password is acceptable.
function passwordProblem(pw, id, email) {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) return 'too_short';
  if (pw.length > 256) return 'too_long';
  const lower = pw.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return 'too_common';
  if (id && id.length >= 4 && lower.includes(id)) return 'contains_id';
  if (email && lower === email) return 'is_email';
  if (/^(.)\1+$/.test(pw)) return 'all_same';
  return null;
}

const PASSWORD_JA = {
  too_short: `パスワードは ${PASSWORD_MIN} 文字以上にしてください。`,
  too_long: 'パスワードが長すぎます（256 文字まで）。',
  too_common: 'よく使われるパスワードです。別のものにしてください。',
  contains_id: 'パスワードに局 ID を含めないでください。',
  is_email: 'パスワードにメールアドレスは使えません。',
  all_same: '同じ文字だけのパスワードは使えません。',
};

function register(app, ctx) {
  const { cfg, db, now, lim, tooMany, requireAuth, signToken, hashPassword, verifyPassword, mailer, STATION_ID } = ctx;
  const nowIso = () => new Date(now()).toISOString();

  const q = {
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    tombstone: db.prepare('SELECT 1 FROM deleted_ids WHERE id = ? AND deleted_at > ?'),
    insertUser: db.prepare(`INSERT INTO users (id, password_hash, status, created_at, email, consent_version, consent_at, created_via)
                            VALUES (@id, @hash, 'pending_email', @at, @email, @consent, @at, 'register')`),
    insertStation: db.prepare('INSERT OR IGNORE INTO stations (id) VALUES (?)'),
    insertToken: db.prepare('INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at, created_at) VALUES (?,?,?,?,?)'),
    tokenByHash: db.prepare('SELECT * FROM auth_tokens WHERE token_hash = ?'),
    useToken: db.prepare('UPDATE auth_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL'),
    voidTokens: db.prepare('UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND kind = ? AND used_at IS NULL'),
    activate: db.prepare(`UPDATE users SET status = 'active', email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ? AND status = 'pending_email'`),
    autoList: db.prepare('UPDATE stations SET listed = 1 WHERE id = ? AND admin_hold = 0'),
    setPassword: db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?'),
    claim: db.prepare(`UPDATE users SET password_hash = ?, status = 'active', email_verified_at = ?, consent_version = ?, consent_at = ?,
                              token_version = token_version + 1 WHERE id = ? AND status = 'legacy_unclaimed'`),
    station: db.prepare('SELECT * FROM stations WHERE id = ?'),
    setProfile: db.prepare('UPDATE stations SET public_description = ? WHERE id = ?'),
    setListed: db.prepare('UPDATE stations SET listed = ? WHERE id = ?'),
    count: db.prepare('SELECT n FROM mail_counters WHERE key = ? AND day = ?'),
    bump: db.prepare(`INSERT INTO mail_counters (key, day, n) VALUES (?, ?, 1)
                      ON CONFLICT (key, day) DO UPDATE SET n = n + 1`),
  };

  const fail = (res, status, code, ja, en) => res.status(status).json({ error: en || code.replace(/_/g, ' '), code, message_ja: ja });
  const generic = (res, ja) => res.json({ success: true, message_ja: ja });

  // Mail goes out only within the daily budget (per recipient and in total). Returns true when sent.
  async function sendLimited(to, subject, text) {
    const day = nowIso().slice(0, 10);
    const addrKey = 'addr:' + sha256(to);
    // Both budgets are looked at first and only used up together. Counting an attempt that one budget
    // refuses against the other would let a single address, asked about over and over, drain the
    // shared budget for everybody.
    const used = (key) => { const r = q.count.get(key, day); return r ? r.n : 0; };
    if (used('global') >= cfg.mail.globalPerDay || used(addrKey) >= cfg.mail.perAddressPerDay) return false;
    q.bump.run('global', day);
    q.bump.run(addrKey, day);
    try {
      await mailer.send({ to, subject, text });
      return true;
    } catch (e) {
      if (!cfg.quiet) console.error('mail send failed:', e.message);   // never the address or the token
      return false;
    }
  }

  function newToken(userId, kind, ttlMs) {
    const token = crypto.randomBytes(32).toString('base64url');
    q.insertToken.run(userId, kind, sha256(token), new Date(now() + ttlMs).toISOString(), nowIso());
    return token;
  }

  // The token record if it is usable (right kind, not used, not expired), else null.
  function usableToken(token, kind) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const row = q.tokenByHash.get(sha256(token));
    if (!row || row.kind !== kind || row.used_at || row.expires_at < nowIso()) return null;
    return row;
  }

  function activate(userId) {
    q.activate.run(nowIso(), userId);
    q.insertStation.run(userId);
    if (cfg.autoListOnVerify) q.autoList.run(userId);
  }

  // Mail is sent WITHOUT making the person wait for it. Waiting only in the branches that really send
  // would let anyone tell a known address from an unknown one by how long the answer takes (an SMTP
  // round trip is seconds). sendLimited does its bookkeeping and starts the send at once, and
  // swallows a failure itself, so there is nothing to wait for and nothing to leak.
  const fire = (promise) => { promise.catch((e) => { if (!cfg.quiet) console.error('mail step failed:', e.message); }); };

  const mailVerify = (to, id, token) => sendLimited(to, '【CosmicRay】メールアドレスの確認',
    `CosmicRay 観測ネットワークに、局 ID「${id}」の登録がありました。\n` +
    `次のリンクを開き、ページのボタンを押して、メールアドレスの確認を完了してください（24 時間有効）。\n\n` +
    `${cfg.publicUrl}/verify#token=${token}\n\n` +
    `心当たりがない場合は、このメールを無視してください。何も登録されません。\n` +
    `（このメールへの返信は届きません。）\n`);

  const mailReset = (to, id, token) => sendLimited(to, '【CosmicRay】パスワードの再設定',
    `局 ID「${id}」のパスワードの再設定が依頼されました。\n` +
    `次のリンクを開き、新しいパスワードを決めてください（1 時間有効、1 回だけ使えます）。\n\n` +
    `${cfg.publicUrl}/reset#token=${token}\n\n` +
    `心当たりがない場合は、このメールを無視してください。パスワードは変わりません。\n` +
    `（このメールへの返信は届きません。）\n`);

  const mailAlready = (to) => sendLimited(to, '【CosmicRay】このメールアドレスはすでに登録されています',
    `このメールアドレスで、CosmicRay 観測ネットワークの登録が試みられましたが、すでに登録されています。\n` +
    `パスワードを忘れた場合は、次のページから再設定できます。\n\n${cfg.publicUrl}/forgot\n\n` +
    `心当たりがない場合は、このメールを無視してください。\n`);

  // ---------------------------------------------------------------- sign up

  app.post('/auth/register', async (req, res) => {
    const b = req.body || {};
    // A field people cannot see: bots fill it in. Answer as if all went well.
    if (typeof b.website === 'string' && b.website !== '') return generic(res, '確認メールを送りました。');

    if (!cfg.registrationOpen) return fail(res, 403, 'closed', '現在、新しい登録は受け付けていません。', 'registration is closed');
    const r = lim.register.take(req.ip);
    if (!r.ok) return tooMany(res, r);

    const id = typeof b.id === 'string' ? b.id.trim().toLowerCase() : '';
    const email = normEmail(b.email);
    if (!STATION_ID.test(id)) return fail(res, 400, 'bad_id', '局 ID は、半角の英小文字・数字・「-」「_」で 3〜32 文字にしてください。');
    if (RESERVED.has(id)) return fail(res, 409, 'id_taken', 'この局 ID は使えません。別の ID を選んでください。');
    if (!email) return fail(res, 400, 'bad_email', 'メールアドレスの形が正しくありません。');
    if (b.consent !== true || b.consent_version !== cfg.consentVersion) {
      return fail(res, 400, 'consent_required', '利用規約とプライバシーについてに同意してください。ページを開き直して、もう一度お試しください。');
    }
    const problem = passwordProblem(b.password, id, email);
    if (problem) return fail(res, 400, 'weak_password', PASSWORD_JA[problem], 'weak password');

    // Hash first, whatever happens next, so a known address does not answer faster than a new one.
    const hash = await hashPassword(b.password, cfg.scryptN);

    const tombstoneAfter = new Date(now() - 90 * DAY).toISOString();
    if (q.user.get(id) || q.tombstone.get(id, tombstoneAfter)) {
      return fail(res, 409, 'id_taken', 'この局 ID はすでに使われています。別の ID を選んでください。');
    }
    const known = q.userByEmail.get(email);
    if (known) {
      fire(mailAlready(email));                                   // the owner is told; the asker learns nothing
      return generic(res, '確認メールを送りました。届かないときは、迷惑メールのフォルダも見てください。');
    }
    let token;
    try {
      db.transaction(() => {
        q.insertUser.run({ id, hash, at: nowIso(), email, consent: cfg.consentVersion });
        q.insertStation.run(id);
        token = newToken(id, 'verify', DAY);
      })();
    } catch (e) {
      if (/UNIQUE|constraint/i.test(String(e.message))) {         // someone took the id or address a moment ago
        return fail(res, 409, 'id_taken', 'この局 ID はすでに使われています。別の ID を選んでください。');
      }
      throw e;
    }
    fire(mailVerify(email, id, token));
    return generic(res, '確認メールを送りました。届かないときは、迷惑メールのフォルダも見てください。');
  });

  app.post('/auth/verify-email', (req, res) => {
    const r = lim.token.take(req.ip);
    if (!r.ok) return tooMany(res, r);
    const row = usableToken((req.body || {}).token, 'verify');
    if (!row) return fail(res, 400, 'bad_token', 'このリンクは無効か、期限切れです。確認メールをもう一度送ってください。');
    db.transaction(() => { q.useToken.run(nowIso(), row.id); activate(row.user_id); })();
    return res.json({ success: true, id: row.user_id });
  });

  app.post('/auth/resend-verify', async (req, res) => {
    const r = lim.resend.take(req.ip);
    if (!r.ok) return tooMany(res, r);
    const email = normEmail((req.body || {}).email);
    const ja = '登録されている場合は、確認メールをもう一度送りました。届かないときは、迷惑メールのフォルダも見てください。';
    if (!email) return generic(res, ja);
    const u = q.userByEmail.get(email);
    if (u && u.status === 'pending_email') {
      let token;
      db.transaction(() => { q.voidTokens.run(nowIso(), u.id, 'verify'); token = newToken(u.id, 'verify', DAY); })();
      fire(mailVerify(email, u.id, token));
    }
    return generic(res, ja);
  });

  // ---------------------------------------------------------------- forgotten password

  app.post('/auth/forgot', async (req, res) => {
    const r = lim.forgot.take(req.ip);
    if (!r.ok) return tooMany(res, r);
    const email = normEmail((req.body || {}).email);
    const ja = '登録されている場合は、再設定のメールを送りました。届かないときは、迷惑メールのフォルダも見てください。';
    if (!email) return generic(res, ja);
    const u = q.userByEmail.get(email);
    if (u && (u.status === 'active' || u.status === 'pending_email')) {
      let token;
      db.transaction(() => { q.voidTokens.run(nowIso(), u.id, 'reset'); token = newToken(u.id, 'reset', 3600 * 1000); })();
      fire(mailReset(email, u.id, token));
    }
    return generic(res, ja);
  });

  app.post('/auth/reset', async (req, res) => {
    const r = lim.token.take(req.ip);
    if (!r.ok) return tooMany(res, r);
    const b = req.body || {};
    const row = usableToken(b.token, 'reset');
    if (!row) return fail(res, 400, 'bad_token', 'このリンクは無効か、期限切れです。再設定のメールをもう一度送ってください。');
    const u = q.user.get(row.user_id);
    // A link made for handing over an old station belongs to /auth/claim (it asks for the terms), not here.
    if (!u || u.status === 'legacy_unclaimed') return fail(res, 400, 'bad_token', 'このリンクは無効か、期限切れです。再設定のメールをもう一度送ってください。');
    const problem = passwordProblem(b.password, row.user_id, u && u.email);
    if (problem) return fail(res, 400, 'weak_password', PASSWORD_JA[problem], 'weak password');   // the link stays usable
    const hash = await hashPassword(b.password, cfg.scryptN);
    db.transaction(() => {
      q.useToken.run(nowIso(), row.id);
      q.voidTokens.run(nowIso(), row.user_id, 'reset');
      q.setPassword.run(hash, row.user_id);            // also revokes every login token issued before
      activate(row.user_id);                            // the link proves the mailbox is theirs
    })();
    return res.json({ success: true });
  });

  // The owner of a station that came over from the old server (status legacy_unclaimed) takes it over. The link
  // was made by an operator for an address he chose (scripts/admin.js claim); using it proves the mailbox,
  // and this is where the terms are agreed, as at registration.
  app.post('/auth/claim', async (req, res) => {
    const r = lim.token.take(req.ip);
    if (!r.ok) return tooMany(res, r);
    const b = req.body || {};
    const bad = () => fail(res, 400, 'bad_token', 'このリンクは無効か、期限切れです。運営に、もう一度リンクを送るよう頼んでください。');
    const row = usableToken(b.token, 'reset');
    if (!row) return bad();
    const u = q.user.get(row.user_id);
    if (!u || u.status !== 'legacy_unclaimed') return bad();
    if (b.consent !== true || b.consent_version !== cfg.consentVersion) {
      return fail(res, 400, 'consent_required', '利用規約とプライバシーについてに同意してください。ページを開き直して、もう一度お試しください。');
    }
    const problem = passwordProblem(b.password, row.user_id, u.email);
    if (problem) return fail(res, 400, 'weak_password', PASSWORD_JA[problem], 'weak password');   // the link stays usable
    const hash = await hashPassword(b.password, cfg.scryptN);
    const done = db.transaction(() => {
      const at = nowIso();
      const c = q.claim.run(hash, at, cfg.consentVersion, at, row.user_id);     // only while it is still unclaimed
      if (!c.changes) return false;
      q.useToken.run(at, row.id);
      q.voidTokens.run(at, row.user_id, 'reset');
      q.insertStation.run(row.user_id);
      return true;
    })();
    if (!done) return bad();
    return res.json({ success: true, id: row.user_id });
  });

  // ---------------------------------------------------------------- the owner's account

  const meLimit = (req, res, next) => {
    const r = lim.me.take(req.user.id);
    return r.ok ? next() : tooMany(res, r);
  };

  app.get('/me', requireAuth, meLimit, (req, res) => {
    const u = req.user;
    const s = q.station.get(u.id) || {};
    res.set('Cache-Control', 'private, no-store');
    res.json({
      id: u.id,
      email: u.email || null,                 // the owner's own address: shown here and nowhere else
      email_verified: !!u.email_verified_at,
      status: u.status,
      created_at: u.created_at,
      consent_version: u.consent_version || null,
      consent_at: u.consent_at || null,
      listed: s.listed === 1,
      listing_needs_approval: !cfg.autoListOnVerify,
      held_by_operator: s.admin_hold === 1,            // an operator took it off the map: only an operator can list it again
      description_hidden: s.description_hidden === 1,  // an operator hid the introduction text from other people
      public_description: s.public_description || null,
      station: { lat: s.lat_grid ?? null, lon: s.lon_grid ?? null, event_count: s.event_count || 0, last_seen_utc: s.last_seen_utc || null },
    });
  });

  app.put('/me/profile', requireAuth, meLimit, (req, res) => {
    const b = req.body || {};
    const out = {};
    if ('description' in b) {
      if (b.description !== null && typeof b.description !== 'string') return fail(res, 400, 'bad_description', '紹介文の形が正しくありません。');
      // Plain text, one line. It is shown with textContent everywhere, never as HTML.
      const text = (b.description || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
      if ([...text].length > 200) return fail(res, 400, 'too_long', '紹介文は 200 文字までです。');
      q.setProfile.run(text || null, req.user.id);
      out.public_description = text || null;
    }
    if ('listed' in b) {
      if (typeof b.listed !== 'boolean') return fail(res, 400, 'bad_listed', '掲載の指定が正しくありません。');
      if (b.listed && !cfg.autoListOnVerify) {
        return fail(res, 403, 'needs_approval', '地図への掲載は、運営の確認が必要です。運営にご連絡ください。', 'listing needs approval');
      }
      q.insertStation.run(req.user.id);
      if (b.listed && (q.station.get(req.user.id) || {}).admin_hold === 1) {
        return fail(res, 403, 'held_by_operator', '運営が、この局を地図から外しています。運営にご連絡ください。', 'held by an operator');
      }
      q.setListed.run(b.listed ? 1 : 0, req.user.id);          // taking oneself OFF the map is always allowed
      out.listed = b.listed;
    }
    res.json({ success: true, ...out });
  });

  app.post('/me/password', requireAuth, async (req, res) => {
    const r = lim.secret.take(req.user.id);
    if (!r.ok) return tooMany(res, r);
    const b = req.body || {};
    if (typeof b.password !== 'string' || !(await verifyPassword(b.password, req.user.password_hash))) {
      return fail(res, 401, 'wrong_password', '今のパスワードが違います。', 'wrong password');
    }
    const problem = passwordProblem(b.new_password, req.user.id, req.user.email);
    if (problem) return fail(res, 400, 'weak_password', PASSWORD_JA[problem], 'weak password');
    q.setPassword.run(await hashPassword(b.new_password, cfg.scryptN), req.user.id);
    const fresh = { ...req.user, token_version: req.user.token_version + 1 };
    res.json({ success: true, token: signToken(fresh) });      // this session carries on; every other one is signed out
  });

  app.post('/me/delete', requireAuth, async (req, res) => {
    const r = lim.secret.take(req.user.id);
    if (!r.ok) return tooMany(res, r);
    const b = req.body || {};
    if (typeof b.password !== 'string' || !(await verifyPassword(b.password, req.user.password_hash))) {
      return fail(res, 401, 'wrong_password', 'パスワードが違います。', 'wrong password');
    }
    deleteAccount(db, cfg.dataDir, req.user.id, { nowIso: nowIso() });
    res.json({ success: true });
  });

  // The owner's own measurement files (the .jsonl source of truth), for downloading.
  const FILE = /^\d{4}-\d{2}-\d{2}(\.badclock|\.legacy)?\.jsonl$/;
  app.get('/me/events', requireAuth, meLimit, (req, res) => {
    const dir = path.join(cfg.dataDir, 'events', req.user.id);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => FILE.test(f)).sort()
        .map((name) => ({ name, bytes: fs.statSync(path.join(dir, name)).size }));
    } catch (_) { /* no data yet */ }
    res.set('Cache-Control', 'private, no-store');
    res.json({ files });
  });

  app.get('/me/events/:file', requireAuth, meLimit, (req, res) => {
    // The directory comes from the logged-in user, never from the URL; the file name must match a strict pattern.
    if (!FILE.test(req.params.file)) return fail(res, 400, 'bad_file', 'ファイル名が正しくありません。');
    const full = path.join(cfg.dataDir, 'events', req.user.id, req.params.file);
    if (!fs.existsSync(full)) return fail(res, 404, 'not_found', '見つかりません。', 'not found');
    res.set('Cache-Control', 'private, no-store');
    res.attachment(`${req.user.id}-${req.params.file}`);      // sets the type from the extension ...
    res.type('application/x-ndjson');                          // ... so set the real one afterwards
    fs.createReadStream(full).pipe(res);
  });
}

module.exports = { register, normEmail, passwordProblem, RESERVED };
