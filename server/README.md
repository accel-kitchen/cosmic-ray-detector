# cosmicray-v3 server (Phase 1: console-compatible upload API)

Measurement upload server for the CosmicRay Recorder console. Phase 1 implements the
four endpoints the console already speaks, so pointing the console's "Server" box at it is
all that is needed. Design and roadmap: [`arduino/upload-server-plan.html`](../arduino/upload-server-plan.html).

Not in Phase 1: self-registration and email (Phase 3), migration of old data (4), viewer and
map (5), the v2 batch API (6). Accounts are created with the seed script below.

## Run

```powershell
cd server
npm ci
$env:DATA_DIR = "$PWD\data"          # db.sqlite and events/ live here
$env:JWT_SECRET = "<long random string>"   # required when NODE_ENV=production
$env:PORT = "3100"                   # default 3100; binds 127.0.0.1 unless HOST is set
node src/index.js
```

| Variable | Default | Meaning |
|---|---|---|
| `DATA_DIR` | `server/data` | database and per-station JSONL files |
| `JWT_SECRET` | random per boot (dev only) | required when `NODE_ENV=production`; keep it out of git |
| `HOST` / `PORT` | `127.0.0.1` / `3100` | keep the loopback in production; Apache is the only way in |
| `TOKEN_TTL_S` | `86400` | token lifetime |
| `SCRYPT_N` | `131072` (2^17) | password work factor, r=8, p=1: the [OWASP minimum](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) when Argon2id is unavailable. ~128 MiB per hash, at most 2 at once. Each hash stores its own parameters, so it can be raised later |
| `SCRYPT_CONCURRENCY` | `2` | how many password hashes may run at once; the rest queue. Size it from the VPS's free memory |
| `CLAIM_URL` | `https://cosmicray.accel-kitchen.com/claim` | shown to legacy accounts that must register an email |
| `GIT_COMMIT` | `unknown` | reported by `/healthz`; set it at deploy time |

## Create a station (stands in for registration until Phase 3)

```powershell
$env:DATA_DIR = "$PWD\data"
node scripts/seed-station.js my-station            # password generated into data\seed-my-station.txt (not printed)
$env:MY_PW = "..."; node scripts/seed-station.js my-station --password-env MY_PW
```

Station ids are 3-32 characters of `a-z 0-9 _ -` (also the directory name, so this is the path-safety check).

## Put it on the VPS

A draft runbook, systemd units, Apache config, `deploy.sh`, `smoke.sh` and the read-only survey to
run first are in [`deploy/`](deploy/README.md). None of it has been run on the VPS yet.

```powershell
node scripts/backup.js <destDir> [--keep N]     # nightly backup: SQLite snapshot + events mirror
```

## Test

```powershell
npm test      # node:test; no network, no fixed ports, temp directories only
```

`test/contract.test.js` pins what the console depends on: 400 = drop the event, 401/403 =
log in again, 429/5xx = retry; CORS headers on every response including errors; rounding of
positions; the UTC day boundary; duplicate handling; per-IP and per-station rate limits.

## API (as the console uses it)

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /auth/login` `{id, password}` | – | `{token}`. 401 for any bad credential (same body for unknown id). 403 with a reason for accounts that are not active. 429 when limited |
| `POST /auth/refresh` | Bearer | needs a still-valid token |
| `POST /setup-id` `{id, comment, gps_latitude, gps_longitude}` | Bearer | idempotent. Coordinates (the console sends them as text) are rounded to a 0.1° cell centre on arrival; **the raw values are never stored**. The comment is private |
| `POST /upload-data/:id` | Bearer, owner | one event per request. 400 only for structurally unusable events |
| `GET /healthz` | – | version, commit, schema |

Storage: `events/<station>/<UTC-day>.jsonl` (first line is a header record; the source of truth)
and `db.sqlite` (accounts, stations, a duplicate guard keyed on `station, run_id, event, time_us`).
Field names carry their unit (`time_us`, `deadtime_ms`, `vol_mv`).

## Known limits of this phase

- Behind Apache the client address comes from `X-Forwarded-For` (`trust proxy` = loopback). That
  can only be checked on the VPS through Apache, not on localhost.
- The compat API carries `deadtime` in milliseconds and a computed `vol`; microsecond deadtime
  and the other v2 fields arrive with the v2 batch API (Phase 6).
- An event whose `timestamp_utc` is before 2015 or more than two days ahead of the server clock is
  KEPT, not refused: it goes to `<received day>.badclock.jsonl`, flagged `clock_suspect`, with the time it
  claimed untouched (plan, Q-N14). Only an unreadable date is a 400.
- Failed logins are counted per client address, per (station, address) and per station (plan, Q-N13).
  One address can never empty the station-wide bucket, so it cannot lock a station out for others; only
  many addresses failing at once can, briefly. While that lasts even a correct password gets a 429.
- Old bcrypt password hashes (from `users.json`) are not verified yet; that arrives with the migration
  (Phase 4).
- Tested on Node 24 locally; the VPS has Node 22.
