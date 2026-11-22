'use strict';

// What an operator can do to a station, in ONE place: the admin web page (routes-admin.js) and the
// command line (scripts/admin.js) both call these, so the two cannot drift apart. Every change and its
// audit row are written in the same transaction: there is no change without a record.
//
// The audit table never holds an e-mail address or description text, only the actor (an admin name,
// or 'cli'), a station id and a fixed word.
//
// Deleting an account is NOT here on purpose: it is irreversible and stays a deliberate command on the
// server (scripts/admin.js delete <id> --yes).

const RESTORABLE = ['active', 'pending_email', 'legacy_unclaimed'];

function createOperator(db, now = Date.now) {
  const iso = () => new Date(now()).toISOString();
  const insAudit = db.prepare('INSERT INTO admin_audit (at, actor, action, target, detail) VALUES (?,?,?,?,?)');
  const getUser = db.prepare('SELECT * FROM users WHERE id = ?');
  const getStation = db.prepare('SELECT * FROM stations WHERE id = ?');

  const audit = (actor, action, target = null, detail = null) => insAudit.run(iso(), actor, action, target, detail);
  const miss = { ok: false, status: 404, code: 'not_found', message: 'No such station.' };

  // What an account goes back to when an operator enables it again. It must never skip e-mail
  // confirmation: a registration nobody confirmed is not made active by a disable/enable round trip.
  function restoreStatus(u) {
    if (RESTORABLE.includes(u.prev_status)) return u.prev_status;
    if (u.email_verified_at || u.created_via === 'seed') return 'active';
    return 'pending_email';
  }

  const ops = {
    audit, restoreStatus,

    listOn(actor, id) {
      return db.transaction(() => {
        const u = getUser.get(id);
        if (!u) return miss;
        const s = getStation.get(id);
        if (u.status !== 'active') return { ok: false, status: 409, code: 'not_active', message: `This account is ${u.status}: only an active account can be listed.` };
        if (!s || s.lat_grid == null || s.lon_grid == null) return { ok: false, status: 409, code: 'no_position', message: 'This station has no position yet (the Console sends it at login), so it would not show on the map.' };
        db.prepare('UPDATE stations SET listed = 1, admin_hold = 0 WHERE id = ?').run(id);
        audit(actor, 'list-on', id);
        return { ok: true };
      })();
    },

    // An operator taking a station off the map is a HOLD: the owner cannot switch it back on.
    listOff(actor, id) {
      return db.transaction(() => {
        if (!getUser.get(id)) return miss;
        db.prepare('INSERT OR IGNORE INTO stations (id) VALUES (?)').run(id);
        db.prepare('UPDATE stations SET listed = 0, admin_hold = 1 WHERE id = ?').run(id);
        audit(actor, 'list-off', id, 'hold');
        return { ok: true };
      })();
    },

    setDescriptionHidden(actor, id, hidden) {
      return db.transaction(() => {
        if (!getUser.get(id)) return miss;
        db.prepare('INSERT OR IGNORE INTO stations (id) VALUES (?)').run(id);
        db.prepare('UPDATE stations SET description_hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id);
        audit(actor, hidden ? 'hide-description' : 'show-description', id);
        return { ok: true };
      })();
    },

    disable(actor, id) {
      return db.transaction(() => {
        const u = getUser.get(id);
        if (!u) return miss;
        if (u.status === 'disabled') return { ok: true, unchanged: true };
        db.prepare('UPDATE users SET prev_status = ?, status = ?, token_version = token_version + 1 WHERE id = ?').run(u.status, 'disabled', id);
        audit(actor, 'disable', id, u.status);
        return { ok: true };
      })();
    },

    enable(actor, id) {
      return db.transaction(() => {
        const u = getUser.get(id);
        if (!u) return miss;
        if (u.status !== 'disabled') return { ok: true, unchanged: true };
        const to = restoreStatus(u);
        db.prepare('UPDATE users SET status = ?, prev_status = NULL, token_version = token_version + 1 WHERE id = ?').run(to, id);
        audit(actor, 'enable', id, to);
        return { ok: true, status: to };
      })();
    },
  };
  return ops;
}

module.exports = { createOperator };
