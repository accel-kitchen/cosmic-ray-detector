/* The public map. Stations arrive from /public/stations: the centre of a 0.1-degree cell
 * (never the real position), a coarse activity label, and the owner's short introduction.
 * Every piece of text is put in with textContent: the introduction is written by users. */
(async function () {
  'use strict';
  const { el, api, config, ACTIVITY } = CRD;
  const cfg = await config();
  const r = await api('/public/stations');
  const stations = (r.json && r.json.stations) || [];
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  const map = L.map('map', { worldCopyJump: true, minZoom: 2 }).setView([36.0, 138.0], 5);

  if (cfg.tile) {
    // The attribution is built as an element and serialised, so the text cannot carry markup.
    const a = el('a', { href: cfg.tile.attribution_url, target: '_blank', rel: 'noopener' }, cfg.tile.attribution_text);
    L.tileLayer(cfg.tile.url, { minZoom: cfg.tile.min_zoom, maxZoom: cfg.tile.max_zoom, attribution: a.outerHTML }).addTo(map);
  } else {
    // No outside map service: draw a latitude/longitude grid so positions still mean something.
    const Grid = L.GridLayer.extend({
      createTile(c) {
        const size = this.getTileSize();
        const t = document.createElement('canvas');
        t.width = size.x; t.height = size.y;
        const ctx = t.getContext('2d');
        const z = c.z, ox = c.x * size.x, oy = c.y * size.y;
        const nw = map.unproject(L.point(ox, oy), z), se = map.unproject(L.point(ox + size.x, oy + size.y), z);
        const step = z <= 3 ? 10 : z <= 5 ? 5 : z <= 7 ? 1 : 0.5;
        ctx.strokeStyle = css('--line') || '#ccc'; ctx.fillStyle = css('--muted') || '#888'; ctx.font = '11px system-ui';
        for (let lat = Math.ceil(se.lat / step) * step; lat <= nw.lat; lat += step) {
          const y = map.project(L.latLng(lat, nw.lng), z).y - oy;
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size.x, y); ctx.stroke();
          ctx.fillText(lat + '°N', 3, y - 2);
        }
        for (let lng = Math.ceil(nw.lng / step) * step; lng <= se.lng; lng += step) {
          const x = map.project(L.latLng(nw.lat, lng), z).x - ox;
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, size.y); ctx.stroke();
          ctx.fillText(lng + '°E', x + 3, 11);
        }
        return t;
      },
    });
    new Grid({ minZoom: 2, maxZoom: 12 }).addTo(map);
    document.getElementById('mapnote').appendChild(el('p', { class: 'lead' },
      '地図の背景は表示していません（外部の地図サービスには接続しない設定です）。'));
  }

  const list = document.getElementById('list');
  const markers = new Map();
  const bounds = [];
  const colour = { today: css('--today') || '#2f7d46', week: css('--week') || '#c98a1a', idle: css('--idle') || '#9a9388' };

  for (const s of stations) {
    const [label, cls] = ACTIVITY[s.activity] || ACTIVITY.idle;
    // The 0.1-degree cell the position stands for, so the map shows an AREA, not a point.
    const cell = L.rectangle([[s.lat - 0.05, s.lon - 0.05], [s.lat + 0.05, s.lon + 0.05]],
      { color: colour[cls], weight: 1, fillOpacity: 0.12 }).addTo(map);
    const dot = L.circleMarker([s.lat, s.lon], { radius: 7, color: colour[cls], fillColor: colour[cls], fillOpacity: 0.9, weight: 2 }).addTo(map);
    const popup = el('div', {},
      el('strong', {}, s.id), el('br'),
      el('span', {}, label),
      s.legacy ? el('p', { class: 'lead' }, '旧サーバーから引き継いだ観測局です。持ち主の引き継ぎを待っています。') : null,
      s.description ? el('p', {}, s.description) : null,
      el('a', { href: '/station?id=' + encodeURIComponent(s.id) }, 'グラフを見る（ログインが必要）'));
    dot.bindPopup(popup);
    cell.bindPopup(popup);
    markers.set(s.id, dot);
    bounds.push([s.lat, s.lon]);

    const a = el('a', { href: '/station?id=' + encodeURIComponent(s.id) }, s.id);
    const show = el('a', { href: '#', 'aria-label': s.id + ' を地図で見る' }, '地図');
    show.addEventListener('click', (e) => { e.preventDefault(); map.setView([s.lat, s.lon], Math.max(map.getZoom(), 8)); dot.openPopup(); });
    list.appendChild(el('li', {}, el('span', { class: 'dot ' + cls }), a, ' ', show,
      s.legacy ? el('div', { class: 'lead' }, '旧サーバーの観測局（引き継ぎ待ち）') : null,
      s.description ? el('div', { class: 'lead' }, s.description.length > 60 ? s.description.slice(0, 60) + '…' : s.description) : null));
  }

  if (stations.length === 0) document.getElementById('empty').classList.remove('hidden');
  else map.fitBounds(bounds, { maxZoom: 9, padding: [40, 40] });
})();
