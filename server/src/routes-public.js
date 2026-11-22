'use strict';
const stats = require('./stats');

// What the public map and the graphs read (plan, section 4-3).
//
//   GET /public/stations            anyone     the stations an operator has put on the map
//   GET /stations/:id/summary       logged in  graphs: events per hour, temperature, ADC histogram
//   GET /config.json                anyone     what the pages need to know (map background, registration open?)
//
// What these NEVER return: the email address, the password hash, the comment and the device label
// the console sends at setup, exact coordinates (only the 0.1-degree cell centre exists on disk),
// and, to anyone but the owner, the exact time of the last data.
//
// The last-data time is coarse for everyone else on purpose: an exact time next to a position that
// is only known to ~10 km still tells a lot about when a young participant is at home.

const DAY = 24 * 3600 * 1000;

// 'today' | 'week' | 'idle'
function activity(lastSeenIso, nowMs) {
  if (!lastSeenIso) return 'idle';
  const age = nowMs - Date.parse(lastSeenIso);
  if (!Number.isFinite(age)) return 'idle';
  if (age < DAY) return 'today';
  if (age < 7 * DAY) return 'week';
  return 'idle';
}

const TILES = {
  none: null,
  gsi: {
    url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
    host: 'https://cyberjapandata.gsi.go.jp',
    attribution_text: '地理院タイル',
    attribution_url: 'https://maps.gsi.go.jp/development/ichiran.html',
    min_zoom: 5, max_zoom: 18,
  },
  osm: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    host: 'https://tile.openstreetmap.org',
    attribution_text: '© OpenStreetMap contributors',
    attribution_url: 'https://www.openstreetmap.org/copyright',
    min_zoom: 1, max_zoom: 19,
  },
};

function register(app, ctx) {
  const { cfg, db, now, requireAuth, lim, tooMany, STATION_ID } = ctx;

  const listed = db.prepare(`
    SELECT s.id, s.lat_grid, s.lon_grid, s.public_description, s.last_seen_utc
      FROM stations s JOIN users u ON u.id = s.id
     WHERE u.status = 'active' AND s.listed = 1
       AND s.lat_grid IS NOT NULL AND s.lon_grid IS NOT NULL
     ORDER BY s.id`);

  const oneStation = db.prepare(`
    SELECT s.id, s.listed, s.public_description, s.last_seen_utc, s.event_count, u.status
      FROM stations s JOIN users u ON u.id = s.id WHERE s.id = ?`);

  app.get('/config.json', (req, res) => {
    const t = TILES[cfg.mapTile];
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      registration_open: cfg.registrationOpen,
      consent_version: cfg.consentVersion,
      tile: t ? { url: t.url, attribution_text: t.attribution_text, attribution_url: t.attribution_url, min_zoom: t.min_zoom, max_zoom: t.max_zoom } : null,
    });
  });

  app.get('/public/stations', (req, res) => {
    const nowMs = now();
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      stations: listed.all().map((r) => ({
        id: r.id,
        lat: r.lat_grid,                 // the centre of a 0.1-degree cell, never the real position
        lon: r.lon_grid,
        activity: activity(r.last_seen_utc, nowMs),
        description: r.public_description || null,
      })),
    });
  });

  app.get('/stations/:id/summary', requireAuth, (req, res) => {
    const lr = lim.read.take(req.user.id);
    if (!lr.ok) return tooMany(res, lr);

    const id = String(req.params.id || '').trim().toLowerCase();
    if (!STATION_ID.test(id)) return res.status(404).json({ error: 'Not found' });
    const row = oneStation.get(id);
    const mine = req.user.id === id;
    // A station that is not on the map does not exist for other people (404, not 403).
    if (!row || (!mine && !(row.listed === 1 && row.status === 'active'))) {
      return res.status(404).json({ error: 'Not found' });
    }

    const days = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 7));
    const nowMs = now();
    const since = new Date(nowMs - days * DAY).toISOString();
    const hourly = stats.hourlySeries(db, id, since.slice(0, 13));
    const body = {
      id,
      days,
      mine,
      description: row.public_description || null,
      activity: activity(row.last_seen_utc, nowMs),
      hourly,
      adc: stats.adcHistogram(db, id, since.slice(0, 10)),
      totals: { events: hourly.reduce((a, h) => a + h.count, 0), hours_with_data: hourly.length },
    };
    if (mine) {                             // the owner sees their own exact figures
      body.last_seen_utc = row.last_seen_utc;
      body.listed = row.listed === 1;
      body.event_count = row.event_count;
    }
    res.set('Cache-Control', 'private, no-store');
    res.json(body);
  });
}

module.exports = { register, activity, TILES };
