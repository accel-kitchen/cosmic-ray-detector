#!/usr/bin/env bash
# Runs deploy.sh against STAND-IN commands in a temporary directory: no real service, no network,
# nothing installed, nothing outside /tmp touched. It exists to exercise the control flow that
# protects a release switch: the database snapshot, the health check, the rollback, and putting the
# database back when the failed release had migrated it.
#
#   sudo bash test-deploy.sh                          (Linux, as root)
#   MSYS=winsymlinks:nativestrict bash test-deploy.sh (Git Bash on Windows: root-only commands are stood in for)
#
# What it can NOT show: that systemd, runuser, npm or the real SQLite do what the stand-ins pretend.
# The snapshot/restore logic itself is tested with the real database in test/dbsnapshot.test.js.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
mkdir -p "$W/bin" "$W/app" "$W/data" "$W/snap" "$W/log"
export W PATH="$W/bin:$PATH"
: > "$W/log/calls"

FAILS=0
ok() { if [ "$2" = 1 ]; then echo "  PASS  $1"; else echo "  FAIL  $1"; FAILS=$((FAILS + 1)); fi; }
t()  { if eval "$1"; then echo 1; else echo 0; fi; }

# --- stand-ins --------------------------------------------------------------------------------
cat > "$W/bin/sleep" <<'EOF'
#!/bin/bash
exit 0
EOF
cat > "$W/bin/journalctl" <<'EOF'
#!/bin/bash
exit 0
EOF
cat > "$W/bin/npm" <<'EOF'
#!/bin/bash
echo "npm $*" >> "$W/log/calls"
exit 0
EOF
# runuser -u USER -- CMD...  ->  just run CMD (the harness runs as root and APP_USER=root)
cat > "$W/bin/runuser" <<'EOF'
#!/bin/bash
shift 3
exec "$@"
EOF
# The "node" stand-in knows the three db-snapshot commands (a database here is a text file whose
# first line is "schema=N") and answers the module load check.
cat > "$W/bin/node" <<'EOF'
#!/bin/bash
echo "node $*" >> "$W/log/calls"
case "$1" in
  -e) echo "modules load ok"; exit 0 ;;
  scripts/db-snapshot.js)
    case "$2" in
      snapshot) [ -f "$W/snapfail" ] && { echo "snapshot FAILED (simulated)" >&2; exit 1; }
                cp "$3/db.sqlite" "$4" && echo "snapshot ok: $4" ;;
      restore)  cp "$4" "$3/db.sqlite" && echo "restored from $4" ;;
      version)  sed -n 's/^schema=//p' "$3" | head -1 ;;
    esac ;;
esac
EOF
# systemctl: "starting" the service does what a release really does at start. A release knows the
# schema it needs (its SCHEMA file; none = it does not touch the database). On a database OLDER than
# that it migrates it. On a NEWER one it REFUSES TO START (the real server does exactly this), which
# is the whole reason a rollback has to put the database back.
cat > "$W/bin/systemctl" <<'EOF'
#!/bin/bash
echo "systemctl $*" >> "$W/log/calls"
case "$1" in
  stop) : > "$W/running_commit" ;;
  restart|start)
    cur=$(readlink -f "$W/app/current")
    target=$(cat "$cur/SCHEMA" 2>/dev/null || echo 0)
    v=$(sed -n 's/^schema=//p' "$W/data/db.sqlite" 2>/dev/null | head -1); v=${v:-0}
    if [ "$target" != 0 ] && [ "$v" -gt "$target" ]; then
      : > "$W/running_commit"                       # refuses a newer database: nothing is running
    else
      cat "$cur/.commit" > "$W/running_commit"
      if [ "$target" != 0 ] && [ "$v" -lt "$target" ]; then printf 'schema=%s
' "$target" > "$W/data/db.sqlite"; fi
    fi ;;
esac
exit 0
EOF
# curl: /healthz answers with the running commit, or with a different one when the harness says "bad"
cat > "$W/bin/curl" <<'EOF'
#!/bin/bash
if [ "$(cat "$W/health_mode" 2>/dev/null)" = good ]; then
  printf '{"status":"ok","version":"x","commit":"%s","schema":2}' "$(cat "$W/running_commit" 2>/dev/null)"
else
  printf '{"status":"ok","version":"x","commit":"some-other-commit","schema":1}'
fi
EOF
# Not root (for example Git Bash on Windows)? Stand in for the three root-only commands deploy.sh uses.
# (On Windows also run with MSYS=winsymlinks:nativestrict, so that ln -s makes real links.)
if [ "$(id -u)" != 0 ]; then
  cat > "$W/bin/id" <<'EOF'
#!/bin/bash
[ "$1" = "-u" ] && { echo 0; exit 0; }
exec /usr/bin/id "$@"
EOF
  printf '#!/bin/bash
exit 0
' > "$W/bin/chown"
  printf '#!/bin/bash
# install -d [-o x -g y -m z] DIR
for last; do :; done
mkdir -p "$last"
' > "$W/bin/install"
fi
chmod +x "$W"/bin/*

mk_release() {   # mk_release NAME SCHEMA   (SCHEMA 0 = the release does not touch the database)
  local d="$W/src-$1/server"
  mkdir -p "$d/scripts" "$d/src"
  echo '{"name":"stand-in"}' > "$d/package.json"; : > "$d/scripts/db-snapshot.js"; : > "$d/src/app.js"
  [ "$2" != 0 ] && echo "$2" > "$d/SCHEMA"
  tar -czf "$W/$1.tar.gz" -C "$W/src-$1" server
}

deploy() {   # deploy NAME  -> runs deploy.sh, output in $W/log/out.NAME, returns its exit status
  env APP_ROOT="$W/app" DATA_DIR="$W/data" SNAP_DIR="$W/snap" APP_USER=root NODE_DIR="$W" SERVICE=svc PORT=1 SNAP_KEEP=2 \
    bash "$HERE/deploy.sh" tarball "$W/$1.tar.gz" "$1" > "$W/log/out.$1" 2>&1
}
cur() { basename "$(readlink -f "$W/app/current" 2>/dev/null)" | sed 's/-[0-9T]*Z$//'; }
schema() { sed -n 's/^schema=//p' "$W/data/db.sqlite" | head -1; }
calls_since() { sed -n "$1,\$p" "$W/log/calls"; }
mark() { wc -l < "$W/log/calls"; }

echo "== 1. first install: there is no database yet, so there is nothing to copy"
mk_release rel1 0; echo good > "$W/health_mode"
deploy rel1; rc=$?
ok "succeeds"                                   "$(t "[ $rc = 0 ]")"
ok "current points at rel1"                     "$(t "[ \"\$(cur)\" = rel1 ]")"
ok "no snapshot was attempted"                  "$(t "! grep -q 'db-snapshot.js snapshot' $W/log/calls")"
ok ".commit was written for /healthz"           "$(t "[ -s $W/app/current/.commit ]")"

echo "== 2. upgrade that migrates the database, release is healthy"
printf 'schema=1\n' > "$W/data/db.sqlite"; mk_release rel2 2
deploy rel2; rc=$?
ok "succeeds"                                   "$(t "[ $rc = 0 ]")"
ok "current points at rel2"                     "$(t "[ \"\$(cur)\" = rel2 ]")"
ok "a snapshot of the OLD schema was taken"     "$(t "[ \"\$(ls $W/snap | wc -l)\" = 1 ] && grep -q '^schema=1' $W/snap/*")"
ok "the new release migrated the live database" "$(t "[ \"\$(schema)\" = 2 ]")"
ok "the output names the copy"                  "$(t "grep -q 'database copy from before the switch' $W/log/out.rel2")"

echo "== 3. upgrade that migrates, then FAILS its health check: code AND database go back"
mk_release rel3 3; echo bad > "$W/health_mode"
m=$(mark); deploy rel3; rc=$?
ok "deploy.sh exits non-zero"                   "$(t "[ $rc != 0 ]")"
ok "current is back on rel2"                    "$(t "[ \"\$(cur)\" = rel2 ]")"
ok "the database is back at schema 2 (not 3)"   "$(t "[ \"\$(schema)\" = 2 ]")"
ok "the PREVIOUS release came up again on it"   "$(t "[ \"\$(cat $W/running_commit)\" = rel2 ]")"
ok "the restore ran"                            "$(t "calls_since $m | grep -q 'db-snapshot.js restore'")"
ok "the service was STOPPED before the restore, then started again" \
   "$(t "calls_since $m | grep -n -E 'systemctl (stop|start)|db-snapshot.js restore' | awk -F: '{print \$2}' | tr '\n' ' ' | grep -q 'systemctl stop.*db-snapshot.js restore.*systemctl start'")"
ok "the output says what was lost"              "$(t "grep -q 'sign-ups, tokens' $W/log/out.rel3")"

echo "== 4. unhealthy release that did NOT migrate: no restore (the database was not touched)"
mk_release rel4 0
m=$(mark); deploy rel4; rc=$?
ok "deploy.sh exits non-zero"                   "$(t "[ $rc != 0 ]")"
ok "current is still rel2"                      "$(t "[ \"\$(cur)\" = rel2 ]")"
ok "the database was left alone (no restore)"   "$(t "! calls_since $m | grep -q 'db-snapshot.js restore'")"
ok "the previous release came up again"         "$(t "[ \"\$(cat $W/running_commit)\" = rel2 ]")"

echo "== 5. the snapshot cannot be taken: nothing is switched"
mk_release rel5 3; echo good > "$W/health_mode"; : > "$W/snapfail"
m=$(mark); deploy rel5; rc=$?
rm -f "$W/snapfail"
ok "deploy.sh exits non-zero"                   "$(t "[ $rc != 0 ]")"
ok "current is still rel2"                      "$(t "[ \"\$(cur)\" = rel2 ]")"
ok "the service was never restarted"            "$(t "! calls_since $m | grep -q 'systemctl restart'")"
ok "the message says nothing was switched"      "$(t "grep -q 'nothing was switched' $W/log/out.rel5")"

echo "== 6. old database copies are thinned out (SNAP_KEEP=2) after a good deploy"
mk_release rel6 0; echo good > "$W/health_mode"
deploy rel6; rc=$?
ok "succeeds"                                   "$(t "[ $rc = 0 ]")"
ok "only the 2 newest copies remain"            "$(t "[ \"\$(ls $W/snap | wc -l)\" = 2 ]")"
ok "the copy made for this deploy is among them" "$(t "ls $W/snap | grep -q rel6")"

echo
if [ "$FAILS" = 0 ]; then echo "RESULT: all deploy.sh paths behaved (against stand-ins)"; else echo "RESULT: $FAILS failure(s)"; echo "--- last calls:"; tail -15 "$W/log/calls"; exit 1; fi
