#!/usr/bin/env bash
# DRAFT: checks the PUBLIC server after a deploy. Needs only curl; run it from any machine.
# Wrong-password probes only: no real credentials are used or needed.
#
#   ./smoke.sh                                  # https://cosmicray.accel-kitchen.com
#   ./smoke.sh http://127.0.0.1:3100 --local    # against a server on this machine (skips the
#                                               # checks that only mean something through Apache)
#
# This is a first line of defence, NOT the acceptance test. The acceptance test is a real browser
# (plan, section 7): open the real Console and log in, send events, and see the file grow.
# On the old server curl looked fine while browsers failed.
set -u
BASE=${1:-https://cosmicray.accel-kitchen.com}
LOCAL=0; [ "${2:-}" = "--local" ] && LOCAL=1
CONSOLE_ORIGIN=${CONSOLE_ORIGIN:-https://accel-kitchen.com}
FAILS=0

pass() { echo "  PASS  $*"; }
fail() { echo "  FAIL  $*"; FAILS=$((FAILS + 1)); }
hdr()  { tr -d '\r' | grep -i "^$1:" ; }   # read headers on stdin

echo "== $BASE"

echo "1. /healthz"
out=$(curl -sS -m 10 -D - "$BASE/healthz" 2>&1) || { fail "no answer: $out"; echo "RESULT: $FAILS failure(s)"; exit 1; }
code=$(printf '%s' "$out" | head -1 | awk '{print $2}')
body=$(printf '%s' "$out" | tr -d '\r' | sed -n '/^$/,$p' | tail -n +2)
if [ "$code" = 200 ] && printf '%s' "$body" | grep -q '"status":"ok"'; then pass "200 $body"; else fail "code=$code body=$(printf '%s' "$body" | head -c 120 | tr '\n' ' ')"; fi

echo "2. CORS preflight (an origin the Console really uses, and Origin: null as sent from file://)"
for origin in "$CONSOLE_ORIGIN" "null"; do
  h=$(curl -sS -m 10 -D - -o /dev/null -X OPTIONS "$BASE/auth/login" \
        -H "Origin: $origin" -H "Access-Control-Request-Method: POST" \
        -H "Access-Control-Request-Headers: content-type,authorization")
  c=$(printf '%s' "$h" | head -1 | awk '{print $2}')
  n=$(printf '%s' "$h" | hdr access-control-allow-origin | wc -l | tr -d ' ')
  v=$(printf '%s' "$h" | hdr access-control-allow-origin | head -1 | awk '{print $2}' | tr -d '\r')
  a=$(printf '%s' "$h" | hdr access-control-allow-headers | tr 'A-Z' 'a-z')
  if [ "$c" = 204 ] && [ "$n" = 1 ] && [ "$v" = "*" ] && printf '%s' "$a" | grep -q authorization; then
    pass "Origin: $origin -> 204, one Access-Control-Allow-Origin: *, Authorization allowed"
  else
    fail "Origin: $origin -> code=$c, ACAO headers=$n, value='$v' (want 204, exactly one, '*')"
  fi
done

echo "3. An error response is still readable cross-origin (wrong password -> 401 with CORS)"
h=$(curl -sS -m 10 -D - -o /dev/null -X POST "$BASE/auth/login" -H "Origin: $CONSOLE_ORIGIN" \
      -H "Content-Type: application/json" -d '{"id":"smoke-nobody","password":"not-a-real-password"}')
c=$(printf '%s' "$h" | head -1 | awk '{print $2}')
n=$(printf '%s' "$h" | hdr access-control-allow-origin | wc -l | tr -d ' ')
if [ "$c" = 401 ] && [ "$n" = 1 ]; then pass "401 with one Access-Control-Allow-Origin"; else fail "code=$c ACAO headers=$n (want 401, 1)"; fi

echo "4. Unknown path answers JSON 404 with CORS (the whole host reaches the app)"
h=$(curl -sS -m 10 -D - -o /dev/null "$BASE/no/such/path" -H "Origin: $CONSOLE_ORIGIN")
c=$(printf '%s' "$h" | head -1 | awk '{print $2}')
n=$(printf '%s' "$h" | hdr access-control-allow-origin | wc -l | tr -d ' ')
ct=$(printf '%s' "$h" | hdr content-type)
if [ "$c" = 404 ] && [ "$n" = 1 ] && printf '%s' "$ct" | grep -qi json; then pass "404 JSON with CORS"; else fail "code=$c ACAO=$n content-type=$ct"; fi

if [ "$LOCAL" = 1 ]; then
  echo "5./6. skipped (--local): the forged-header check and the http redirect only mean something through Apache"
else
  echo "5. A forged X-Forwarded-For must NOT give a fresh rate-limit bucket"
  echo "     (up to 30 wrong-password attempts, each claiming a different client address, stopping at the"
  echo "      first 429. The limit is 10 per real address, refilled at 0.2/s, so a 429 must appear. Thirty,"
  echo "      not twelve, because every attempt costs the server a password hash: on a slow VPS the"
  echo "      bucket refills while we are still sending. This blocks YOUR address for about a minute.)"
  got429=0; sent=0
  for i in $(seq 1 30); do
    sent=$i
    c=$(curl -sS -m 20 -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/login" \
          -H "Content-Type: application/json" -H "X-Forwarded-For: 203.0.113.$i" \
          -d "{\"id\":\"smoke-nobody-$i\",\"password\":\"not-a-real-password\"}")
    if [ "$c" = 429 ]; then got429=1; break; fi
  done
  if [ "$got429" = 1 ]; then pass "429 after $sent attempts: the forged header was ignored"
  else fail "no 429 in $sent attempts: the app is trusting a client-supplied X-Forwarded-For (or the server is so slow the bucket kept refilling: check the response time)"; fi

  case "$BASE" in
    https://*)
      echo "6. Plain http redirects to https"
      hostpart=${BASE#https://}
      c=$(curl -sS -m 10 -o /dev/null -w "%{http_code} %{redirect_url}" "http://$hostpart/healthz")
      if printf '%s' "$c" | grep -q "^301 https://"; then pass "$c"; else fail "got: $c"; fi
      ;;
    *) echo "6. skipped: the URL is not https://" ;;
  esac
fi

echo
if [ "$FAILS" -eq 0 ]; then echo "RESULT: all checks passed (now do the real-browser test)"; else echo "RESULT: $FAILS failure(s)"; exit 1; fi
