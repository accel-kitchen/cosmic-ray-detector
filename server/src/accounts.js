'use strict';
const fs = require('fs');
const path = require('path');

// Removing a station and everything about it. Used by "delete my account" (Phase 3), by the
// operator CLI, and by the sweep of never-confirmed registrations.
//
// Gone: the account, the station row, the single-use links, the duplicate guard, the statistics,
// and the JSONL files (the measurements). Not covered here: copies in the backups
// (scripts/backup.js mirrors events/ and snapshots the database): see the plan, Q-N12 and Q-N16.
function deleteAccount(db, dataDir, id, { nowIso = new Date().toISOString(), tombstone = true } = {}) {
  db.transaction(() => {
    db.prepare('DELETE FROM stats_hourly WHERE station_id = ?').run(id);
    db.prepare('DELETE FROM stats_adc WHERE station_id = ?').run(id);
    db.prepare('DELETE FROM stats_adc_fine WHERE station_id = ?').run(id);
    db.prepare('DELETE FROM ingest_keys WHERE station_id = ?').run(id);
    db.prepare('DELETE FROM stations WHERE id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);          // auth_tokens go with it (ON DELETE CASCADE)
    if (tombstone) {
      // The id cannot be taken over by someone else straight away.
      db.prepare('INSERT OR REPLACE INTO deleted_ids (id, deleted_at) VALUES (?, ?)').run(id, nowIso);
    }
  })();
  // After the commit: if this fails the rows are already gone and the files can be removed again.
  // The id was validated ([a-z0-9_-]) by every caller, so this cannot leave the events directory.
  const dir = path.join(dataDir, 'events', id);
  const existed = fs.existsSync(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return { filesRemoved: existed };
}

// Registrations that were never confirmed free their id again after a while (otherwise anyone
// could squat on ids). No tombstone: nothing of value was ever stored.
function pruneUnverified(db, dataDir, { nowMs = Date.now(), days = 7 } = {}) {
  const cutoff = new Date(nowMs - days * 24 * 3600 * 1000).toISOString();
  const old = db.prepare(`SELECT id FROM users WHERE status = 'pending_email' AND created_at < ?`).all(cutoff);
  for (const u of old) deleteAccount(db, dataDir, u.id, { tombstone: false });
  return old.length;
}

module.exports = { deleteAccount, pruneUnverified };
