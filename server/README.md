# cosmicray-v3 server (console-compatible upload API, self-registration, public map and graphs)

Measurement upload server for the CosmicRay Recorder console. It speaks the four endpoints the
console already uses (so pointing the console's "Server" box at it is all that is needed), lets
participants register themselves (closed by default), and serves a public map of stations and
graphs for logged-in participants. Design, decisions and open questions:
[`arduino/upload-server-plan.html`](../arduino/upload-server-plan.html).

Not yet: migration of the old server's data (Phase 4), the v2 batch API (Phase 6).

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
| `PUBLIC_URL` | `https://cosmicray.accel-kitchen.com` | where the links in mails point |
| `REGISTRATION_OPEN` | off | self-registration is **closed** unless `1`; needs a `MAIL_TRANSPORT` (and `smtp` in production) |
| `AUTO_LIST_ON_VERIFY` | off | off: an operator puts a confirmed station on the public map (`scripts/admin.js list-on`); on: it goes on by itself |
| `MAP_TILE` | `none` | map background: `none` sends nothing to a third party; `gsi` / `osm` pass the viewer's address to that provider |
| `CONSENT_VERSION` | `draft-1` | the terms text people agree to; recorded with each sign-up. Keep "draft" in it until the text is approved |
| `UNVERIFIED_DAYS` | `7` | registrations never confirmed within this time are removed |
| `MAIL_TRANSPORT` | `none` | `smtp`, `outbox` (writes files; development and tests only) or `none` |
| `MAIL_FROM`, `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` | | the SMTP route; `SMTP_PASS` is a secret |
| `MAIL_PER_ADDRESS_PER_DAY`, `MAIL_GLOBAL_PER_DAY` | `5`, `300` | the most mails per recipient and in total per UTC day |
| `GIT_COMMIT` | `unknown` | reported by `/healthz`; set it at deploy time |

## Create a station by hand (the operator's way; participants use the sign-up page)

```powershell
$env:DATA_DIR = "$PWD\data"
node scripts/seed-station.js my-station            # password generated into data\seed-my-station.txt (not printed)
$env:MY_PW = "..."; node scripts/seed-station.js my-station --password-env MY_PW
```

Station ids are 3-32 characters of `a-z 0-9 _ -` (also the directory name, so this is the path-safety check).

## Operator page (`/admin`)

A web page for the operator: list the stations, open one (this is where the e-mail address is shown, and looking is logged),
put a station on / take it off the map, hide an introduction text, disable / enable an account, and read the audit log.
**No delete on the page**: removing an account and its measurements cannot be undone, so it stays `scripts/admin.js delete <id> --yes`.

- Operators are **not stations**: their own table (`admins`), created only with `scripts/admin.js admin-create <name>` on the server
  (the password is asked for with the keyboard echo off, or read from stdin or `--password-env`; never from the command line; 8+ characters).
- Sign in at `/admin-api/login` (the page does it). The token carries `typ: "admin"`; every station route refuses it and the operator routes refuse a station token.
  It lasts 2 hours (`ADMIN_TOKEN_TTL_S`). Operator state is read from the database on every request, so disabling an operator or changing the password ends their sessions at once.
- Password only (no second factor) was the owner's choice. What limits the damage: strict per-address and per-name login limits, a short token, no web delete,
  and the audit log. Use a long, unique password.
- "Off the map" is a **hold**: the owner and the automatic listing cannot put the station back; only an operator can. Hiding the introduction text also survives the owner editing it.
- The audit log (`admin_audit`) holds who (an operator name or `cli`), when, what and which station id. Never an e-mail address or description text.

## Operator commands

```powershell
node scripts/admin.js list                      # who is registered, what is on the public map
node scripts/admin.js list-on <id>              # put a station on the public map (needs an active account and a position; clears a hold)
node scripts/admin.js list-off <id>             # off the map AND held there: the owner cannot switch it back on
node scripts/admin.js hide-description <id>     # hide the owner's introduction text from other people (show-description undoes it)
node scripts/admin.js disable <id> | enable <id>   # enable restores the earlier status: it never skips e-mail confirmation
node scripts/admin.js delete <id> --yes         # the account and ALL its data (CLI only: there is no delete on the web page)
node scripts/admin.js prune-unverified
node scripts/admin.js admin-create <name>       # an operator account for the /admin page (password asked for, hidden; 8+ characters)
node scripts/admin.js admin-password <name> | admin-disable <name> | admin-enable <name> | admin-list
node scripts/admin.js audit [N]                 # the last N operator actions (page and command line alike)
node scripts/rebuild-stats.js [id]              # rebuild the graph statistics from the JSONL files
node scripts/backup.js <destDir> [--keep N]     # SQLite snapshot + events mirror
node scripts/db-snapshot.js snapshot|restore|version ...   # used by deploy.sh around a release switch
```

## Put it on the VPS

The runbook, systemd units, Apache config, `deploy.sh`, `smoke.sh` and the read-only survey are in
[`deploy/`](deploy/README.md). Version 0.1.0 is deployed; 0.2.0 (schema 2) has not been put there yet,
and the runbook says what to do first (backups) and how a rollback restores the database.

## Test

```powershell
npm test      # node:test; no network, no fixed ports, temp directories only
```

`test/contract.test.js` pins what the console depends on: 400 = drop the event, 401/403 =
log in again, 429/5xx = retry; CORS headers on every response including errors; rounding of
positions; the UTC day boundary; duplicate handling; per-IP and per-station rate limits.

## API

The first five are what the console uses.

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /auth/login` `{id, password}` | – | `{token}`. 401 for any bad credential (same body for unknown id). 403 with a reason for accounts that are not active. 429 when limited |
| `POST /auth/refresh` | Bearer | needs a still-valid token |
| `POST /setup-id` `{id, comment, gps_latitude, gps_longitude}` | Bearer | idempotent. Coordinates (the console sends them as text) are rounded to a 0.1° cell centre on arrival; **the raw values are never stored**. The comment is private |
| `POST /upload-data/:id` | Bearer, owner | one event per request. 400 only for structurally unusable events |
| `GET /healthz` | – | version, commit, schema |
| `GET /public/stations` | – | stations an operator has listed: id, the 0.1° cell centre, a coarse activity (`today`/`week`/`idle`), the owner's introduction. Nothing private |
| `GET /stations/:id/summary?days=N` or `?from=YYYY-MM-DD&to=YYYY-MM-DD` | Bearer | graphs: events, rate, temperature, ADC histogram. Up to 31 days: one point per UTC hour (`hourly`); longer (up to 3660 days): one per UTC day (`daily`); `bucket` says which. Listed stations, or one's own. Others never see the exact last-data time |
| `GET /config.json` | – | whether registration is open, the map-tile setting |
| `POST /auth/register`, `/auth/verify-email`, `/auth/resend-verify`, `/auth/forgot`, `/auth/reset` | – | self-registration and password reset. Same answers whether or not an address is known; single-use tokens, stored hashed, in the mailed link's `#fragment`; mail rationed per recipient and in total |
| `GET /me`, `PUT /me/profile`, `POST /me/password`, `POST /me/delete`, `GET /me/events[/:file]` | Bearer | the owner's account: introduction, leaving the map, password, deleting everything, downloading one's own files |

Pages (same server, strict CSP, no inline script, nothing third-party; Leaflet is vendored): `/` map,
`/station?id=`, `/register`, `/verify`, `/forgot`, `/reset`, `/account`, `/terms`, `/privacy`. The terms and
privacy pages are marked as drafts until the person responsible approves them.

Storage: `events/<station>/<UTC-day>.jsonl` (first line is a header record; the source of truth)
and `db.sqlite` (accounts, stations, a duplicate guard keyed on `station, run_id, event, time_us`, mail
budgets, single-use tokens, and the derived statistics, which are rebuilt from the files when needed).
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
- Events per hour come from the device's event counter (max - min within the run and hour), not from
  the number of rows received, so the console's "send every Nth event" does not skew them. A board that
  reboots inside one console connection starts its counter over and under-counts that hour.
- Mail has never been sent through a real SMTP server from this code (only an in-process transport and
  an injected one are tested). The map has never been shown with tiles from a provider.
- Tested on Node 24 locally and on Node 22.23.4 on the VPS (0.1.0).
