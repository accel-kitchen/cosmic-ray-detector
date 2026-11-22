#!/usr/bin/env bash
# DRAFT: written but never run on the VPS. Read it once before the first use, and check the
# paths against the survey (deploy/SURVEY-PROMPT.md).
#
# Known rough edge: a release directory left behind by a FAILED deploy stays on disk and counts
# toward KEEP; delete it by hand if it piles up.
#
# The database is copied before the switch (scripts/db-snapshot.js) and restored on a failed
# rollback when the new release had migrated it. Anything the new release wrote to the database in
# the meantime is lost with it; the measurement files are never touched.
#
# Unpacks ONLY server/ into a new release directory, installs the dependencies, switches the
# "current" link, restarts the service and checks /healthz reports the commit just deployed.
# If that check fails, the previous release is put back. Run as root (sudo).
#
#   deploy.sh tarball <server-vX.Y.Z.tar.gz> <label>
#       The tarball is made on your own PC (nothing has to be pushed, the repo may be private):
#           git archive --format=tar.gz -o server-v0.1.0.tar.gz server-v0.1.0 server
#       then copied to the VPS with scp.
#
#   deploy.sh git <tag>
#       Needs REPO_URL (https URL; for a private repo, a read-only deploy key). Only the
#       server/ directory is unpacked, never the CAD or Gerber files.
set -euo pipefail

APP_ROOT=${APP_ROOT:-/opt/cosmicray-v3}
SERVICE=${SERVICE:-cosmicray-v3}
PORT=${PORT:-3100}
KEEP=${KEEP:-5}
# root's PATH has no node on this VPS (the survey found it only under nvm in /home). The service
# uses a copy in /opt (README step 3b), so use the same one here for npm ci and the load check.
NODE_DIR=${NODE_DIR:-/opt/node-v22.23.4}
# Where the database lives, who the service runs as, and where the pre-switch copies go.
DATA_DIR=${DATA_DIR:-/var/lib/cosmicray}
APP_USER=${APP_USER:-cosmicray}
SNAP_DIR=${SNAP_DIR:-/var/backups/cosmicray/pre-deploy}
SNAP_KEEP=${SNAP_KEEP:-10}

die() { echo "ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
if [ -x "$NODE_DIR/bin/node" ]; then export PATH="$NODE_DIR/bin:$PATH"; fi
command -v node >/dev/null || die "node not found: copy it to $NODE_DIR first (README step 3b), or set NODE_DIR"
command -v npm  >/dev/null || die "npm not found in PATH"
# An absolute path: runuser does not necessarily keep this script's PATH for the service user.
NODE_BIN=$(command -v node)
mode=${1:-}
ts=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$APP_ROOT/releases"

case "$mode" in
  tarball)
    file=${2:?usage: deploy.sh tarball <file.tar.gz> <label>}
    label=${3:?usage: deploy.sh tarball <file.tar.gz> <label>}
    [ -f "$file" ] || die "no such file: $file"
    rel="$APP_ROOT/releases/$label-$ts"
    mkdir "$rel"
    # git archive stores the commit id in the tar header; use it when git can read it.
    commit=$(gzip -dc "$file" | git get-tar-commit-id 2>/dev/null || true)
    commit=${commit:-$label}
    tar -xzf "$file" -C "$rel" --strip-components=1
    ;;
  git)
    tag=${2:?usage: deploy.sh git <tag>}
    : "${REPO_URL:?set REPO_URL}"
    mirror="$APP_ROOT/repo.git"
    if [ -d "$mirror" ]; then
      git --git-dir="$mirror" fetch --tags --force origin
    else
      git clone --mirror "$REPO_URL" "$mirror"
    fi
    commit=$(git --git-dir="$mirror" rev-parse "$tag^{commit}")
    rel="$APP_ROOT/releases/$tag-$ts"
    mkdir "$rel"
    git --git-dir="$mirror" archive "$tag" server | tar -x -C "$rel" --strip-components=1
    ;;
  *)
    die "usage: deploy.sh tarball <file.tar.gz> <label> | deploy.sh git <tag>"
    ;;
esac

[ -f "$rel/package.json" ] || die "no package.json in $rel: is this a server/ archive?"
commit=${commit:0:40}                       # /healthz reports at most 40 characters
echo "$commit" > "$rel/.commit"

echo "== installing dependencies (production only)"
( cd "$rel" && npm ci --omit=dev )

# Read-only for the service: code and node_modules belong to root.
chown -R root:root "$rel"
chmod -R go-w "$rel"
chmod -R a+rX "$rel"

echo "== checking the modules load (does not listen)"
( cd "$rel" && node -e "require('./src/app'); console.log('modules load ok')" ) || die "the new release does not load; nothing was switched"

# A new release may MIGRATE the database to a schema the previous release cannot open (it refuses to
# start on a newer one). So a copy is taken first, and put back if the new release fails its health
# check; rolling the code back alone would leave nothing that can run. The copy is made as the service
# user, so that no file in $DATA_DIR ever becomes root-owned.
snapshot=""
if [ -f "$DATA_DIR/db.sqlite" ]; then
  command -v runuser >/dev/null || die "runuser not found (util-linux)"
  install -d -o "$APP_USER" -g "$APP_USER" -m 0700 "$SNAP_DIR"
  snapshot="$SNAP_DIR/db-before-$(basename "$rel").sqlite"
  echo "== snapshot of the database before switching"
  ( cd "$rel" && runuser -u "$APP_USER" -- "$NODE_BIN" scripts/db-snapshot.js snapshot "$DATA_DIR" "$snapshot" )     || die "could not take the database snapshot; nothing was switched"
fi

prev=$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)

switch_to() {   # atomic: build the new link beside the old one, then rename over it
  ln -sfn "$1" "$APP_ROOT/current.new"
  mv -T "$APP_ROOT/current.new" "$APP_ROOT/current"
}

echo "== switching to $rel and restarting $SERVICE"
switch_to "$rel"
systemctl restart "$SERVICE"

ok=0
for _ in $(seq 1 20); do
  body=$(curl -fsS "http://127.0.0.1:$PORT/healthz" 2>/dev/null || true)
  if printf '%s' "$body" | grep -q "\"commit\":\"$commit\""; then ok=1; break; fi
  sleep 1
done

if [ "$ok" -ne 1 ]; then
  echo "ERROR: /healthz did not report commit $commit within 20 s" >&2
  journalctl -u "$SERVICE" -n 30 --no-pager >&2 || true
  if [ -n "$prev" ] && [ -d "$prev" ]; then
    echo "rolling back to $prev" >&2
    systemctl stop "$SERVICE" || true
    if [ -n "$snapshot" ] && [ -f "$snapshot" ]; then
      dbv() { ( cd "$rel" && runuser -u "$APP_USER" -- "$NODE_BIN" scripts/db-snapshot.js version "$1" 2>/dev/null ) || echo 0; }
      live_v=$(dbv "$DATA_DIR/db.sqlite"); snap_v=$(dbv "$snapshot")
      if [ "$live_v" -gt "$snap_v" ]; then
        echo "the failed release migrated the database (schema $snap_v -> $live_v): putting the snapshot back" >&2
        ( cd "$rel" && runuser -u "$APP_USER" -- "$NODE_BIN" scripts/db-snapshot.js restore "$DATA_DIR" "$snapshot" ) >&2           || echo "WARNING: restoring the snapshot FAILED: the previous release may not start. Snapshot: $snapshot" >&2
        echo "Whatever the new release wrote to the database (sign-ups, tokens) is not in the restored copy." >&2
        echo "The measurement files were never touched." >&2
      fi
    fi
    switch_to "$prev"
    systemctl start "$SERVICE" || true
  else
    echo "there is no previous release to roll back to" >&2
  fi
  exit 1
fi

echo "deployed commit $commit ($rel)"
echo "$body"
[ -z "$snapshot" ] || echo "database copy from before the switch: $snapshot"

# Keep the newest $KEEP releases (the current one is always among them) and $SNAP_KEEP database copies.
ls -1dt "$APP_ROOT"/releases/* | tail -n +"$((KEEP + 1))" | xargs -r rm -rf
if [ -d "$SNAP_DIR" ]; then
  find "$SNAP_DIR" -maxdepth 1 -name 'db-before-*.sqlite' -printf '%T@ %p
' | sort -rn     | tail -n +"$((SNAP_KEEP + 1))" | cut -d' ' -f2- | xargs -r rm -f
  # These copies hold e-mail addresses. A copy is only useful right after its own deploy, so nothing
  # older than SNAP_DAYS stays (the newest one always does), and a deleted account is gone from here too.
  find "$SNAP_DIR" -maxdepth 1 -name 'db-before-*.sqlite' -mtime +"${SNAP_DAYS:-14}" -printf '%T@ %p
' | sort -rn | tail -n +2 | cut -d' ' -f2- | xargs -r rm -f
fi
