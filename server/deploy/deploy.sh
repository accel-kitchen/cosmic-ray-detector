#!/usr/bin/env bash
# DRAFT: written but never run on the VPS. Read it once before the first use, and check the
# paths against the survey (deploy/SURVEY-PROMPT.md).
#
# Known rough edge: a release directory left behind by a FAILED deploy stays on disk and counts
# toward KEEP; delete it by hand if it piles up.
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

die() { echo "ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
if [ -x "$NODE_DIR/bin/node" ]; then export PATH="$NODE_DIR/bin:$PATH"; fi
command -v node >/dev/null || die "node not found: copy it to $NODE_DIR first (README step 3b), or set NODE_DIR"
command -v npm  >/dev/null || die "npm not found in PATH"
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
    switch_to "$prev"
    systemctl restart "$SERVICE" || true
  else
    echo "there is no previous release to roll back to" >&2
  fi
  exit 1
fi

echo "deployed commit $commit ($rel)"
echo "$body"

# Keep the newest $KEEP releases (the current one is always among them).
ls -1dt "$APP_ROOT"/releases/* | tail -n +"$((KEEP + 1))" | xargs -r rm -rf
