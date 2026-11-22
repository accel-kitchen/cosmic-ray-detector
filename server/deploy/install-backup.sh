#!/usr/bin/env bash
# Installs the nightly backup (README step 9) and checks that a backup can be read back.
# Run as root on the VPS, from the directory that holds the deploy files:
#
#   cd /tmp/deploy && sudo bash ./install-backup.sh
#   sudo BACKUP_DIR=/mnt/other-disk/cosmicray bash ./install-backup.sh      (another disk)
#
# Safe to run again: it only (re)creates the directory, the two unit files and the timer.
# It never touches /var/lib/cosmicray (the live data): the backup service opens the database read-only.
#
# NOTE: with the default BACKUP_DIR the copy is on the SAME disk as the live data. That protects
# against a mistaken delete, a bad release and a corrupt database, but NOT against losing the disk.
# For that, point BACKUP_DIR at another disk, or copy BACKUP_DIR to another machine (see README step 9).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
BACKUP_DIR=${BACKUP_DIR:-/var/backups/cosmicray}
APP_USER=${APP_USER:-cosmicray}
DATA_DIR=${DATA_DIR:-/var/lib/cosmicray}
NODE_DIR=${NODE_DIR:-/opt/node-v22.23.4}
APP_ROOT=${APP_ROOT:-/opt/cosmicray-v3}
UNIT_DIR=${UNIT_DIR:-/etc/systemd/system}

die() { echo "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root (sudo)"
[ -f "$HERE/cosmicray-v3-backup.service" ] || die "run it from the deploy directory (cosmicray-v3-backup.service not found)"
[ -f "$DATA_DIR/db.sqlite" ] || die "no database at $DATA_DIR/db.sqlite: is this the right machine?"
[ -x "$NODE_DIR/bin/node" ] || die "no node at $NODE_DIR/bin/node"
case "$BACKUP_DIR" in /*) ;; *) die "BACKUP_DIR must be an absolute path";; esac
case "$BACKUP_DIR" in "$DATA_DIR"|"$DATA_DIR"/*) die "BACKUP_DIR must not be inside DATA_DIR";; esac

echo "== backup directory: $BACKUP_DIR (owner $APP_USER, mode 0700)"
install -d -o "$APP_USER" -g "$APP_USER" -m 0700 "$BACKUP_DIR"
# deploy.sh keeps its pre-deploy copies in a subdirectory of the default location; keep them readable by the service user
[ -d "$BACKUP_DIR/pre-deploy" ] && chown -R "$APP_USER:$APP_USER" "$BACKUP_DIR/pre-deploy" || true

echo "== installing the units (paths: $BACKUP_DIR, $DATA_DIR, $NODE_DIR)"
# The service file names /var/backups/cosmicray and /var/lib/cosmicray; rewrite them if they differ.
sed -e "s#/var/backups/cosmicray#$BACKUP_DIR#g" \
    -e "s#/var/lib/cosmicray#$DATA_DIR#g" \
    -e "s#/opt/node-v22.23.4#$NODE_DIR#g" \
    -e "s#/opt/cosmicray-v3#$APP_ROOT#g" \
    -e '/^# DRAFT/d' "$HERE/cosmicray-v3-backup.service" > "$UNIT_DIR/cosmicray-v3-backup.service"
sed -e '/^# DRAFT/d' "$HERE/cosmicray-v3-backup.timer" > "$UNIT_DIR/cosmicray-v3-backup.timer"
systemctl daemon-reload
systemctl enable --now cosmicray-v3-backup.timer

echo "== running the backup once, now"
if ! systemctl start cosmicray-v3-backup.service; then
  journalctl -u cosmicray-v3-backup -n 20 --no-pager >&2 || true
  die "the backup service failed (log above)"
fi
journalctl -u cosmicray-v3-backup -n 3 --no-pager | grep -E "backup (ok|FAILED)" || true

echo "== can the newest copy be read back? (a backup that cannot be restored is not a backup)"
newest=$(ls -1t "$BACKUP_DIR"/db/db-*.sqlite 2>/dev/null | head -1 || true)
[ -n "$newest" ] || die "no database copy found in $BACKUP_DIR/db"
cur=$(readlink -f "$APP_ROOT/current")
ver=$(cd "$cur" && runuser -u "$APP_USER" -- "$NODE_DIR/bin/node" scripts/db-snapshot.js version "$newest") \
  || die "the newest copy ($newest) does not open"
live=$(cd "$cur" && runuser -u "$APP_USER" -- "$NODE_DIR/bin/node" scripts/db-snapshot.js version "$DATA_DIR/db.sqlite")
[ "$ver" = "$live" ] || die "schema of the copy ($ver) differs from the live database ($live)"
echo "   copy opens, integrity ok, schema $ver"
src_n=$(find "$DATA_DIR/events" -type f 2>/dev/null | wc -l)
dst_n=$(find "$BACKUP_DIR/events" -type f 2>/dev/null | wc -l)
src_b=$(find "$DATA_DIR/events" -type f -printf '%s\n' 2>/dev/null | awk '{s+=$1} END{print s+0}')
dst_b=$(find "$BACKUP_DIR/events" -type f -printf '%s\n' 2>/dev/null | awk '{s+=$1} END{print s+0}')
echo "   event files: live $src_n ($src_b bytes), backup $dst_n ($dst_b bytes)"
[ "$src_n" = "$dst_n" ] || echo "   NOTE: the counts differ (a station may have written while the backup ran; run this again to compare)"

echo
systemctl list-timers cosmicray-v3-backup.timer --no-pager | head -3
echo "installed. The nightly run is at about 03:30. Keep: 14 database copies; events/ is a mirror."
echo "Deleting a participant's data must also remove it from $BACKUP_DIR/events (plan Q-N12)."
