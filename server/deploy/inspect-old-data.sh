#!/usr/bin/env bash
# Read-only look at the OLD server's data, before anything is imported from it.
#
#   sudo bash inspect-old-data.sh [/opt/cosmicray-server]
#
# It changes nothing. What it prints is safe to paste into a chat: no password hash, no e-mail
# address, no coordinates and no free text from the old files. It shows the SHAPE of the data:
# which stations and files exist, how many columns the measurement rows have, a few sample rows
# (time and numbers only), and which keys the config and user files carry.
set -u
ROOT="${1:-/opt/cosmicray-server}"
NODE="${NODE:-/opt/node-v22.23.4/bin/node}"
DATA="$ROOT/cosmicray-data"

[ -d "$DATA" ] || { echo "no data directory at $DATA"; exit 1; }
[ -x "$NODE" ] || NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "no node found (set NODE=/path/to/node)"; exit 1; }

hr() { printf '\n== %s\n' "$1"; }
# ONLY=users prints just the users.json part (the rest reads 190 MB and takes a while).
want() { [ "${ONLY:-all}" = all ] || [ "${ONLY}" = "$1" ]; }

if want data; then
hr "stations: files, sizes, date range (from the file names)"
for d in "$DATA"/*/; do
  s="$(basename "$d")"
  n_all=$(find "$d" -type f | wc -l)
  n_dat=$(find "$d" -type f -name '*.dat' | wc -l)
  size=$(du -sh "$d" | cut -f1)
  first=$(find "$d" -type f -name '*.dat' -printf '%f\n' | sort | head -1)
  last=$(find "$d" -type f -name '*.dat' -printf '%f\n' | sort | tail -1)
  echo "$s: $n_all files ($n_dat .dat), $size, first=$first last=$last"
  echo "   other files: $(find "$d" -type f ! -name '*.dat' -printf '%P  ' | head -c 400)"
  echo "   sub-directories: $(find "$d" -mindepth 1 -type d -printf '%P  ' | head -c 300)"
done

hr "columns per row, per station (how many tab-separated fields)"
for d in "$DATA"/*/; do
  s="$(basename "$d")"
  echo "$s:"
  find "$d" -type f -name '*.dat' -print0 | xargs -0 -r cat | awk -F'\t' '{ c[NF]++ } END { for (k in c) printf "   %s fields: %d rows\n", k, c[k] }' | sort
done

hr "sample rows (tabs shown as <TAB>): first 3 rows of the oldest file, last 3 of the newest"
for d in "$DATA"/*/; do
  s="$(basename "$d")"
  oldest=$(find "$d" -type f -name '*.dat' | sort | head -1)
  newest=$(find "$d" -type f -name '*.dat' | sort | tail -1)
  [ -n "$oldest" ] || continue
  echo "$s  oldest: $(basename "$oldest")"
  head -n 3 "$oldest" | sed 's/\t/ <TAB> /g; s/^/   /'
  echo "$s  newest: $(basename "$newest")"
  tail -n 3 "$newest" | sed 's/\t/ <TAB> /g; s/^/   /'
done

hr "other files per station: keys and value types only (values are never printed)"
"$NODE" - "$DATA" <<'EOF'
const fs = require('fs'), path = require('path');
const data = process.argv[2];
function shape(v, depth) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === 'object') return depth > 0 ? '{' + Object.keys(v).map((k) => k + ': ' + shape(v[k], depth - 1)).join(', ') + '}' : 'object';
  if (typeof v === 'string') return `string(${v.length})`;
  return typeof v;
}
for (const s of fs.readdirSync(data)) {
  const dir = path.join(data, s);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.dat')) continue;
    const p = path.join(dir, f);
    if (!fs.statSync(p).isFile()) continue;
    if (!/\.json$/.test(f)) { console.log(`${s}/${f}: ${fs.statSync(p).size} bytes (not JSON)`); continue; }
    try { console.log(`${s}/${f}: ${shape(JSON.parse(fs.readFileSync(p, 'utf8')), 2)}`); }
    catch (e) { console.log(`${s}/${f}: unreadable JSON (${e.message.slice(0, 60)})`); }
  }
}
EOF

fi

hr "users.json: ids, roles, key names and the hash scheme only (no hashes, no e-mail, no other values)"
if [ -f "$ROOT/users.json" ]; then
"$NODE" - "$ROOT/users.json" <<'EOF'
const fs = require('fs');
let j;
try { j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); } catch (e) { console.log('unreadable: ' + e.message.slice(0, 80)); process.exit(0); }
// The old server keeps {"users": [ {...}, {...} ]}: look inside that list when it is there.
if (j && !Array.isArray(j) && Array.isArray(j.users)) { console.log(`top level: object with "users" (an array of ${j.users.length}); other top-level keys: [${Object.keys(j).filter((k) => k !== 'users').join(',')}]`); j = j.users; }
const rows = Array.isArray(j) ? j : (j && typeof j === 'object' ? Object.entries(j).map(([k, v]) => ({ __key: k, ...(v && typeof v === 'object' ? v : { value: v }) })) : []);
console.log(`entries: ${rows.length}`);
for (const r of rows) {
  const keys = Object.keys(r);
  const idv = r.id || r.username || r.name || r.__key || '(no id)';
  const hashKey = keys.find((k) => /pass|hash/i.test(k));
  const scheme = hashKey && typeof r[hashKey] === 'string' ? r[hashKey].slice(0, 7) : '(none)';
  console.log(`  ${idv}: role=${r.role === undefined ? '(none)' : r.role} keys=[${keys.join(',')}] hash-prefix=${scheme}`);
}
EOF
else echo "no users.json at $ROOT"; fi

hr "done (nothing was changed)"
