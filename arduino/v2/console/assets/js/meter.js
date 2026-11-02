// CosmicRay Recorder v2 console - meter tab
//
// ガイガーカウンターのメーターのように、カウントレート [回/秒] を針で見せる。
// 線量（µSv/h）ではなく「数えた回数の勢い」。針は「直近 W 秒に数えた回数 ÷ W」を指す。
// 針はバネと減衰で動かし（行き過ぎて戻る）、1 回数えるごとに小さく跳ねる。
// 目盛りは 1 / 3 / 10 / 30 / 100 回/秒 の 5 段（オートかお好みで固定）。
//
// core.js の state / rateSummary と、ui.js の $ / qsa / lsGet / lsSet / syncHeights / redrawCharts を読むだけ。

(function () {
  'use strict';

  const RANGES = [
    { full: 1,   major: 0.2, minor: 0.05 },
    { full: 3,   major: 0.5, minor: 0.1 },
    { full: 10,  major: 2,   minor: 0.5 },
    { full: 30,  major: 5,   minor: 1 },
    { full: 100, major: 20,  minor: 5 },
  ];
  const WINDOWS = [3, 10, 30, 60];
  const SWEEP = 54 * Math.PI / 180;          // 針の振れ幅: 中央から左右にこの角度
  const SAMPLE_MS = 100;                      // 針の目標値を取り直す間隔
  const TEXT_MS = 250;                        // 数字・バッジの更新間隔
  const LEARN_US = 60e6;                      // 「基準を測っています」の長さ（基板の時計）
  const LEARN_EVENTS = 20;

  // ui.js / charts.js と同じ紙とインクの配色
  const C = {
    ink: '#2A2730', ink2: '#4F4956', ink3: '#6E6776', ink4: '#A39CA8',
    field: '#FFFDF7', paper2: '#F2EBD9',
    signal: '#5CD6EA', signal2: '#2E8BA0',
    amber: '#E0A63A', amberGlow: '#F6CE7A',
    coral: '#C8654E', coral2: '#A84A37',
  };
  const ZONES = [
    { to: 0.60, color: C.signal2, glow: C.signal,    name: 'calm' },
    { to: 0.85, color: C.amber,   glow: C.amberGlow, name: 'warm' },
    { to: 1.00, color: C.coral,   glow: '#F0A28F',   name: 'hot' },
  ];
  const zoneOf = f => (f < ZONES[0].to ? 'calm' : f < ZONES[1].to ? 'warm' : 'hot');

  const m = {
    tab: 'count',
    win: 10,
    rangeMode: 'auto',        // 'auto' | index into RANGES
    ri: 0,                    // range in use
    lowSince: 0,
    since: 0,                 // when this connection began (ms)
    wasConn: false,
    conn: false,
    rate: 0,                  // averaged rate [cps]
    count: 0,                 // events inside the averaging window
    eff: 3,                   // seconds actually averaged
    peak: 0,
    state: 'idle',
    x: 0, xv: 0,              // needle position (fraction of full scale) and speed
    twitch: 0,                // small jump per count
    lastN: 0,
    zone: 'calm',
    text: '--',
    rangeFlash: 0,
    dirty: true,
    raf: 0, last: 0, tSample: 0, tText: 0,
    cw: 0, ch: 0, dpr: 1,
  };
  let canvas, ctx, lastLang = null;

  // ---------- Reading the rate ----------
  function sample(now) {
    const conn = !!(state.isConnected && !state.reconnecting);
    if (conn && !m.wasConn) { m.since = now; m.peak = 0; m.lowSince = 0; }
    m.wasConn = conn;
    m.conn = conn;
    if (!conn) { m.rate = 0; m.count = 0; m.state = 'idle'; return; }

    const elapsed = (now - m.since) / 1000;
    const W = m.win;
    m.eff = Math.max(Math.min(W, elapsed), Math.min(W, 3));
    const cutoff = Math.max(now - m.eff * 1000, m.since);
    const ev = state.events;
    let c = 0;
    for (let i = ev.length - 1; i >= 0 && ev[i].pc_timestamp >= cutoff; i--) c++;
    m.count = c;
    m.rate = c / m.eff;

    if (elapsed >= W && m.rate > m.peak) m.peak = m.rate;

    // Range: up at once when the needle nears the end, down after a calm moment.
    if (m.rangeMode === 'auto') {
      const before = m.ri;
      while (m.ri < RANGES.length - 1 && m.rate > RANGES[m.ri].full * 0.92) m.ri++;
      if (m.ri === before && m.ri > 0 && m.rate < RANGES[m.ri - 1].full * 0.7) {
        if (!m.lowSince) m.lowSince = now;
        else if (now - m.lowSince > 2000) { m.ri--; m.lowSince = 0; }
      } else {
        m.lowSince = 0;
      }
    } else {
      m.ri = m.rangeMode;
    }

    // Badge: this window against the overall average, in units of the expected scatter.
    const sum = rateSummary();
    const learning = sum.elapsedUs < LEARN_US || state.stats.n < LEARN_EVENTS;
    if (learning) {
      m.state = c === 0 && state.stats.n === 0 ? 'waiting' : 'learning';
    } else {
      const expected = sum.rate * m.eff;
      const z = (c - expected) / Math.sqrt(Math.max(expected, 1));
      m.state = z >= 5 ? 'high' : z >= 3 ? 'up' : (z <= -3 && expected >= 5) ? 'low' : 'normal';
    }
    m.avgAll = sum.rate;
  }

  function fmtRate(v) {
    return v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : v.toFixed(0);
  }

  function renderText() {
    const panel = $('meterPanel');
    const full = RANGES[m.ri].full;
    const f = m.rate / full;
    const st = m.state === 'waiting' ? 'learning' : m.state;
    panel.dataset.state = st;
    m.zone = zoneOf(Math.min(f, 1));
    panel.dataset.zone = m.zone;

    const shown = m.conn ? fmtRate(m.rate) : '--';
    if (shown !== m.text) { m.text = shown; m.dirty = true; }
    $('meterChip').textContent = !m.conn ? t('meter.idle')
      : m.state === 'waiting' ? t('meter.waiting') : t('meter.' + m.state);
    const ratioOk = m.conn && (st === 'normal' || st === 'up' || st === 'high' || st === 'low') && m.avgAll > 0;
    $('meterRatio').textContent = ratioOk ? t('meter.ratio', { x: (m.rate / m.avgAll).toFixed(1) }) : '';

    $('meterAvg').textContent = m.conn && m.avgAll !== undefined ? m.avgAll.toFixed(3) : '--';
    $('meterPeak').textContent = m.peak > 0 ? fmtRate(m.peak) : '--';
    $('meterCount').textContent = m.conn ? String(m.count) : '--';
    $('meterCountLabel').textContent = t('meter.countIn', { n: m.win });

    qsa('#meterRange button').forEach(b => {
      const auto = b.dataset.range === 'auto';
      b.classList.toggle('active', auto ? m.rangeMode === 'auto' : m.rangeMode === +b.dataset.range);
      b.classList.toggle('cur', !auto && m.ri === +b.dataset.range);
    });
    qsa('#meterWin button').forEach(b => b.classList.toggle('active', +b.dataset.win === m.win));
  }

  function relabel() {
    qsa('#meterWin button').forEach(b => { b.textContent = t('meter.sec', { n: b.dataset.win }); });
    lastLang = currentLang;
  }

  // ---------- Needle physics ----------
  function physics(dt) {
    const full = RANGES[m.ri].full;
    const target = m.conn ? Math.min(m.rate / full, 1.045) : 0;
    const k = reducedMotion ? 120 : 62;
    const c = 2 * (reducedMotion ? 1 : 0.46) * Math.sqrt(k);
    const steps = Math.max(1, Math.ceil(dt / 0.008));
    const h = dt / steps;
    const prevX = m.x;
    for (let i = 0; i < steps; i++) {
      m.xv += (k * (target - m.x) - c * m.xv) * h;
      m.x += m.xv * h;
      if (m.x > 1.045) { m.x = 1.045; m.xv = -Math.abs(m.xv) * 0.35; }
      if (m.x < -0.02) { m.x = -0.02; m.xv = Math.abs(m.xv) * 0.35; }
    }
    if (!reducedMotion && m.conn && target >= 1.04) m.x += (Math.random() - 0.5) * 0.006;   // pegged: it trembles

    // one small jump per count, smaller when counts come thick and fast
    const n = state.stats.n;
    const d = n - m.lastN;
    m.lastN = n;
    if (d > 0 && m.conn && !reducedMotion) {
      m.twitch = Math.min(0.04, m.twitch + Math.min(d, 4) * 0.014 / (1 + 0.15 * m.rate));
    }
    m.twitch *= Math.exp(-dt * 9);
    if (m.twitch < 1e-4) m.twitch = 0;

    if (m.rangeFlash > 0) m.rangeFlash = Math.max(0, m.rangeFlash - dt / 0.9);
    return Math.abs(m.x - prevX) > 1e-5 || Math.abs(m.xv) > 1e-3 || m.twitch > 0 || m.rangeFlash > 0 || (target >= 1.04 && m.conn);
  }

  // ---------- Drawing ----------
  const angleOf = f => -SWEEP + 2 * SWEEP * f;            // 0 = straight up
  const arcAng = a => a - Math.PI / 2;                     // canvas arc angle
  const polar = (px, py, r, a) => [px + r * Math.sin(a), py - r * Math.cos(a)];

  function draw() {
    if (!ctx || !m.cw || !m.ch) return;
    const W = m.cw, H = m.ch, dpr = m.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, C.field); bg.addColorStop(1, C.paper2);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const px = W / 2, py = H * 0.92;
    const R = Math.max(80, Math.min((W / 2 - 48) / Math.sin(SWEEP), py - 64));
    const band = Math.max(9, R * 0.045);
    const rg = RANGES[m.ri];
    const f = Math.max(0, Math.min(1, m.x));
    const fShown = m.x + m.twitch;

    // Zone band: dim track, lit up to the needle
    ctx.lineCap = 'butt';
    ctx.lineWidth = band;
    let from = 0;
    for (const z of ZONES) {
      ctx.beginPath();
      ctx.strokeStyle = z.color; ctx.globalAlpha = 0.26;
      ctx.arc(px, py, R - band / 2, arcAng(angleOf(from)), arcAng(angleOf(z.to)));
      ctx.stroke();
      const litTo = Math.min(z.to, f);
      if (litTo > from) {
        ctx.beginPath();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = z.color;
        ctx.shadowColor = z.glow; ctx.shadowBlur = 14 * dpr;
        ctx.arc(px, py, R - band / 2, arcAng(angleOf(from)), arcAng(angleOf(litTo)));
        ctx.stroke();
        ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
      }
      from = z.to;
    }
    ctx.globalAlpha = 1;

    // Ticks and numbers
    const nMinor = Math.round(rg.full / rg.minor);
    const every = Math.round(rg.major / rg.minor);
    const tickOut = R - band - 4;
    const majLen = Math.max(12, R * 0.07), minLen = majLen * 0.5;
    const fs = Math.max(11, Math.min(15, R * 0.036));
    ctx.font = `500 ${fs}px "IBM Plex Mono", Consolas, monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= nMinor; i++) {
      const a = angleOf(i / nMinor);
      const major = i % every === 0;
      const [x0, y0] = polar(px, py, tickOut, a);
      const [x1, y1] = polar(px, py, tickOut - (major ? majLen : minLen), a);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
      ctx.strokeStyle = major ? C.ink2 : C.ink4; ctx.lineWidth = major ? 2 : 1;
      ctx.stroke();
      if (major) {
        const v = i * rg.minor;
        const [tx, ty] = polar(px, py, tickOut - majLen - fs * 1.15, a);
        ctx.fillStyle = C.ink2;
        ctx.fillText(Number.isInteger(v) ? String(v) : v.toFixed(1), tx, ty);
      }
    }

    // The value, big in the middle of the face: heavy digits in the zone colour, a small unit under them
    const vfs = Math.max(34, R * 0.34);
    const vy = py - R * 0.50;
    const vcol = !m.conn ? C.ink4 : m.zone === 'hot' ? C.coral2 : m.zone === 'warm' ? '#A9751A' : '#1F6B7C';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `500 ${vfs}px "IBM Plex Mono", Consolas, monospace`;
    ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(1.5, vfs * 0.035);
    ctx.fillStyle = vcol; ctx.strokeStyle = vcol;
    ctx.strokeText(m.text, px, vy);       // thickens the strokes
    ctx.fillText(m.text, px, vy);
    ctx.fillStyle = C.ink3;
    ctx.font = `700 ${Math.max(13, R * 0.075)}px "Noto Sans JP", sans-serif`;
    ctx.fillText(t('unit.cps'), px, vy + vfs * 0.68);
    ctx.font = `500 ${Math.max(11, R * 0.032)}px "IBM Plex Mono", Consolas, monospace`;
    ctx.fillStyle = m.rangeFlash > 0 ? C.coral2 : C.ink3;
    ctx.textAlign = 'left';
    ctx.fillText(t('meter.fullScale', { n: rg.full }), 20, H - 20);
    ctx.textAlign = 'right';
    ctx.fillStyle = C.ink4;
    ctx.fillText('OHASHI · COSMIC RAY', W - 20, H - 20);
    if (m.conn && m.rate > rg.full && !(m.rangeMode === 'auto' && m.ri < RANGES.length - 1)) {
      ctx.fillStyle = C.coral2;
      ctx.globalAlpha = 0.55 + 0.45 * Math.sin(performance.now() / 120);
      ctx.font = `700 ${Math.max(14, R * 0.06)}px "IBM Plex Mono", Consolas, monospace`;
      ctx.fillText(t('meter.over'), W - 20, 28);
      ctx.globalAlpha = 1;
    }

    // Peak marker (outside the band)
    if (m.peak > 0) {
      const a = angleOf(Math.min(m.peak / rg.full, 1));
      ctx.save(); ctx.translate(px, py); ctx.rotate(a);
      ctx.beginPath(); ctx.moveTo(0, -(R + 2)); ctx.lineTo(-5, -(R + 12)); ctx.lineTo(5, -(R + 12)); ctx.closePath();
      ctx.fillStyle = C.ink3; ctx.fill();
      ctx.restore();
    }

    // Needle, with a soft shadow
    const a = angleOf(Math.max(-0.04, Math.min(1.06, fShown)));
    ctx.save(); ctx.translate(px, py); ctx.rotate(a);
    const L = R - band * 0.25, tail = R * 0.13;
    ctx.shadowColor = 'rgba(42, 39, 48, .30)'; ctx.shadowBlur = 7 * dpr;
    ctx.shadowOffsetX = 4 * dpr; ctx.shadowOffsetY = 5 * dpr;
    ctx.beginPath();
    ctx.moveTo(-4, 0); ctx.lineTo(-0.8, -L); ctx.lineTo(0.8, -L); ctx.lineTo(4, 0); ctx.lineTo(2.6, tail); ctx.lineTo(-2.6, tail);
    ctx.closePath();
    ctx.fillStyle = '#B8503A'; ctx.fill();
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
    ctx.beginPath(); ctx.moveTo(-1.2, -2); ctx.lineTo(-0.3, -L + 3);
    ctx.strokeStyle = 'rgba(255, 220, 205, .75)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();

    // Pivot cap
    const cap = Math.max(12, R * 0.05);
    const cg = ctx.createRadialGradient(px - cap * 0.3, py - cap * 0.3, 1, px, py, cap);
    cg.addColorStop(0, '#6E6776'); cg.addColorStop(1, C.ink);
    ctx.beginPath(); ctx.arc(px, py, cap, 0, Math.PI * 2);
    ctx.fillStyle = cg; ctx.fill();
    ctx.beginPath(); ctx.arc(px, py, cap * 0.32, 0, Math.PI * 2);
    ctx.fillStyle = C.ink4; ctx.fill();
  }

  // ---------- Loop ----------
  function active() {
    return m.tab === 'meter' && document.body.dataset.view === 'measure' && !document.hidden;
  }

  function frame(ts) {
    m.raf = 0;
    if (!active()) return;
    const dt = Math.min(0.05, (ts - m.last) / 1000 || 0.016);
    m.last = ts;

    const now = Date.now();
    if (ts - m.tSample >= SAMPLE_MS) {
      const before = m.ri;
      sample(now);
      if (m.ri !== before) m.rangeFlash = 1;
      m.tSample = ts;
    }
    if (ts - m.tText >= TEXT_MS) {
      if (lastLang !== currentLang) relabel();
      renderText();
      m.tText = ts;
    }
    const moving = physics(dt);
    if (moving || m.dirty) { draw(); m.dirty = false; }
    m.raf = requestAnimationFrame(frame);
  }

  function start() {
    if (m.raf || !active()) return;
    m.last = performance.now();
    m.lastN = state.stats.n;
    m.tSample = 0; m.tText = 0;
    m.dirty = true;
    m.raf = requestAnimationFrame(frame);
  }

  function sizeCanvas() {
    const box = $('meterDial');
    const w = box.clientWidth, h = box.clientHeight;
    if (!w || !h) return;
    m.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    m.cw = w; m.ch = h;
    canvas.width = Math.round(w * m.dpr);
    canvas.height = Math.round(h * m.dpr);
    m.dirty = true;
    if (!m.raf) draw();
  }

  // ---------- Tabs and controls ----------
  function setTab(tab) {
    m.tab = tab;
    qsa('#vtabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.vtab === tab ? 'true' : 'false'));
    $('firstScreen').hidden = tab !== 'count';
    $('dataSection').hidden = tab !== 'count';
    $('meterPanel').hidden = tab !== 'meter';
    if (tab === 'meter') {
      relabel();
      requestAnimationFrame(() => { sizeCanvas(); sample(Date.now()); renderText(); start(); });
    } else {
      requestAnimationFrame(() => { syncHeights(); redrawCharts(); });
    }
  }

  function init() {
    canvas = $('meterCanvas');
    ctx = canvas.getContext('2d');

    const w = parseInt(lsGet('meterWin'), 10);
    if (WINDOWS.includes(w)) m.win = w;
    const r = lsGet('meterRange');
    if (r !== null && r !== 'auto' && RANGES[+r]) { m.rangeMode = +r; m.ri = +r; }

    qsa('#vtabs button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.vtab)));
    qsa('#meterWin button').forEach(b => b.addEventListener('click', () => {
      m.win = +b.dataset.win; lsSet('meterWin', String(m.win));
      m.peak = 0; m.since = Math.min(m.since, Date.now());
      sample(Date.now()); renderText(); m.dirty = true;
    }));
    qsa('#meterRange button').forEach(b => b.addEventListener('click', () => {
      m.rangeMode = b.dataset.range === 'auto' ? 'auto' : +b.dataset.range;
      lsSet('meterRange', String(m.rangeMode));
      if (m.rangeMode !== 'auto' && m.ri !== m.rangeMode) m.rangeFlash = 1;
      sample(Date.now()); renderText(); m.dirty = true;
    }));
    $('meterPeakReset').addEventListener('click', () => { m.peak = 0; renderText(); m.dirty = true; });

    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(sizeCanvas).observe($('meterDial'));
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { m.dirty = true; });
    document.addEventListener('visibilitychange', start);
    Bus.on('conn', () => { m.peak = 0; start(); });
    Bus.on('cleared', () => { m.peak = 0; m.since = Date.now(); m.x = m.xv = m.twitch = 0; m.lastN = state.stats.n; m.dirty = true; });
    // The view switches (connect / disconnect / scope) are not announced one by one.
    setInterval(start, 500);

    relabel();
    setTab('count');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
