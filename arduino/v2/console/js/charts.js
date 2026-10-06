// CosmicRay Recorder v2 console - graphs
//
// canvas に直接描く（外部ライブラリなし）。色と文字は console.css に合わせてある。
// 描くだけで、集計はしない: ヒストグラムは core の hist、レートは state.rateHistory、
// オシロは scope.traces をそのまま読む。

'use strict';

const CH = {
  ink: '#2A2730', ink2: '#4F4956', ink3: '#6E6776', ink4: '#A39CA8',
  grid: 'rgba(42,39,48,0.09)', gridMinor: 'rgba(42,39,48,0.045)', axis: 'rgba(42,39,48,0.40)',
  bar: 'rgba(42,39,48,0.80)', area: 'rgba(42,39,48,0.06)',
  signal: '#5CD6EA', signal2: '#2E8BA0',
  coral: '#C8654E',
  night: '#171630', nightPlot: '#1C1B3A', nightInk: '#E9E6F0', nightInk2: '#A9A3BC',
  ui: '"Noto Sans JP", "Yu Gothic UI", "Hiragino Sans", "Meiryo", sans-serif',
  mono: '"IBM Plex Mono", Consolas, Menlo, monospace',
};

// A log axis cannot render an empty bin, so the axis floor is pinned to 0.5:
// that keeps 1-count bins visible (half a decade tall) instead of flat.
const HIST_LOG_MIN = 0.5;
const HIT_FLASH_MS = 1400;

function niceNum(v) {
  if (!(v > 0)) return 1;
  const exp = Math.floor(Math.log10(v));
  const f = v / Math.pow(10, exp);
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * Math.pow(10, exp);
}

function formatYTick(v) {
  if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k';
  if (v >= 10)   return Math.round(v).toString();
  if (Number.isInteger(v)) return String(v);
  return String(+v.toFixed(2));
}

function formatLogTick(v) {
  return v >= 1000 ? formatYTick(v) : String(v);
}

// Backing store = displayed size x devicePixelRatio, so lines stay sharp.
function prepCanvas(c) {
  const rect = c.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h, ok: rect.width > 0 && rect.height > 0 };
}

// Y scale shared by the histogram and its highlight layer.
function histScale(maxY, logY, yBase, plotH) {
  if (logY) {
    const decades = Math.max(1, Math.ceil(Math.log10(Math.max(maxY, 1))));
    const lo = Math.log10(HIST_LOG_MIN);
    const span = decades - lo;
    const ticks = [];
    for (let e = 0; e <= decades; e++) {
      const base = Math.pow(10, e);
      ticks.push({ v: base, label: formatLogTick(base) });
      if (decades <= 3 && e < decades) {
        for (let m = 2; m <= 9; m++) ticks.push({ v: m * base, label: '' });
      }
    }
    return { pos: v => v > HIST_LOG_MIN ? yBase - plotH * (Math.log10(v) - lo) / span : yBase, ticks };
  }
  const niceMax = maxY > 0 ? niceNum(maxY) : 1;
  const ticks = [];
  for (let i = 0; i <= 5; i++) {
    const v = niceMax * i / 5;
    ticks.push({ v, label: formatYTick(v) });
  }
  return { pos: v => yBase - (v / niceMax) * plotH, ticks };
}

function drawYGrid(ctx, ticks, pos, padL, plotW) {
  ctx.font = `13px ${CH.ui}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (const tick of ticks) {
    const y = Math.round(pos(tick.v)) + 0.5;
    ctx.strokeStyle = tick.label ? CH.grid : CH.gridMinor;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
    if (tick.label) { ctx.fillStyle = CH.ink3; ctx.fillText(tick.label, padL - 7, y); }
  }
}

function drawAxisTitles(ctx, w, h, padL, padT, plotW, plotH, xTitle, yTitle, color) {
  ctx.fillStyle = color || CH.ink2;
  ctx.font = `500 13px ${CH.ui}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  if (xTitle) ctx.fillText(xTitle, padL + plotW / 2, h - 2);
  if (yTitle) {
    ctx.save();
    ctx.translate(13, padT + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = 'middle';
    ctx.fillText(yTitle, 0, 0);
    ctx.restore();
  }
}

function drawEmpty(ctx, text, x, y, color) {
  ctx.fillStyle = color || CH.ink4;
  ctx.font = `14px ${CH.ui}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

// ---------- Histogram ----------
// The geometry of the last draw is kept so the highlight layer can light up the
// bins that were just hit without redrawing the whole chart.
let histGeom = null;

function drawHistogram(canvas) {
  const { ctx, w, h, ok } = prepCanvas(canvas);
  if (!ok) return;
  const padL = 60, padR = 14, padT = 12, padB = 48;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  if (plotW <= 0 || plotH <= 0) return;

  const counts = hist.counts;
  const n = counts.length;
  let maxY = 0;
  for (let i = 0; i < n; i++) if (counts[i] > maxY) maxY = counts[i];

  const yBase = padT + plotH;
  const sc = histScale(maxY, settings.histLog, yBase, plotH);
  drawYGrid(ctx, sc.ticks, sc.pos, padL, plotW);

  const range = n * hist.binWidth;   // 4096 for every offered bin width
  const xOf = adc => padL + (adc / range) * plotW;
  const bw = plotW / Math.max(1, n);

  ctx.fillStyle = CH.bar;
  const gap = bw > 4 ? 1 : 0;
  for (let i = 0; i < n; i++) {
    const v = counts[i];
    if (!v) continue;
    const top = sc.pos(v);
    const bh = yBase - top;
    if (bh <= 0) continue;
    ctx.fillRect(padL + i * bw, top, Math.max(1, bw - gap), bh);
  }

  // x axis: ADC ticks every 512 (or 1024 when narrow)
  ctx.strokeStyle = CH.axis;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, yBase + 0.5); ctx.lineTo(padL + plotW, yBase + 0.5); ctx.stroke();
  ctx.fillStyle = CH.ink3;
  ctx.font = `13px ${CH.ui}`;
  ctx.textBaseline = 'top';
  const step = plotW >= 520 ? 512 : 1024;
  for (let v = 0; v <= range; v += step) {
    const x = Math.round(xOf(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, yBase); ctx.lineTo(x, yBase + 4); ctx.stroke();
    ctx.textAlign = v === 0 ? 'left' : (v >= range ? 'right' : 'center');
    ctx.fillText(String(v), x, yBase + 7);
  }

  if (maxY === 0) drawEmpty(ctx, t('chart.emptyHist'), padL + plotW / 2, padT + plotH / 2);
  drawAxisTitles(ctx, w, h, padL, padT, plotW, plotH, t('chart.xAdc'), t('chart.yCount'));

  histGeom = { padL, plotW, padT, plotH, yBase, n, bw, pos: sc.pos };
}

// Bins that received an event in the last HIT_FLASH_MS glow in the signal
// colour and fade out. Returns true while anything is still glowing.
function drawHitOverlay(canvas, now) {
  const { ctx, ok } = prepCanvas(canvas);
  if (!ok || !histGeom || histGeom.n !== hist.counts.length) return false;
  const g = histGeom;
  let active = false;
  for (let i = 0; i < g.n; i++) {
    const age = now - hist.hitMs[i];
    if (!(hist.hitMs[i] > 0) || age >= HIT_FLASH_MS) continue;
    active = true;
    const a = 1 - age / HIT_FLASH_MS;
    const x = g.padL + i * g.bw;
    const wBar = Math.max(2, g.bw - (g.bw > 4 ? 1 : 0));
    const top = Math.max(g.padT, g.pos(Math.max(hist.counts[i], HIST_LOG_MIN * 2)));
    ctx.globalAlpha = 0.85 * a;
    ctx.fillStyle = CH.signal;
    ctx.fillRect(x, top, wBar, g.yBase - top);
    ctx.globalAlpha = a;
    ctx.fillStyle = CH.signal2;
    ctx.fillRect(x, top - 1, wBar, 2);
    // a tick under the axis marks where the event landed, even for short bars
    ctx.fillRect(x, g.yBase + 1, wBar, 3);
  }
  ctx.globalAlpha = 1;
  return active;
}

// ---------- Count rate ----------
function drawRate(canvas) {
  const { ctx, w, h, ok } = prepCanvas(canvas);
  if (!ok) return;
  const padL = 56, padR = 14, padT = 12, padB = 48;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  if (plotW <= 0 || plotH <= 0) return;

  const hist_ = state.rateHistory;
  const n = hist_.length;
  let maxY = 0;
  for (let i = 0; i < n; i++) if (hist_[i].rate > maxY) maxY = hist_[i].rate;
  const yBase = padT + plotH;
  const niceMax = maxY > 0 ? niceNum(maxY * 1.1) : 1;
  const yOf = v => yBase - (v / niceMax) * plotH;
  const ticks = [];
  for (let i = 0; i <= 4; i++) { const v = niceMax * i / 4; ticks.push({ v, label: formatYTick(v) }); }
  drawYGrid(ctx, ticks, yOf, padL, plotW);

  ctx.strokeStyle = CH.axis;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, yBase + 0.5); ctx.lineTo(padL + plotW, yBase + 0.5); ctx.stroke();

  if (n === 0) {
    drawEmpty(ctx, t('chart.emptyRate'), padL + plotW / 2, padT + plotH / 2);
  } else {
    // Real time axis: uneven gaps (manual refresh, scope dwell) show as gaps.
    const xMin = hist_[0].t;
    const xSpan = Math.max(1, hist_[n - 1].t - xMin);
    const xOf = i => padL + (n > 1 ? (hist_[i].t - xMin) / xSpan * plotW : plotW / 2);

    ctx.fillStyle = CH.area;
    ctx.beginPath();
    ctx.moveTo(xOf(0), yBase);
    for (let i = 0; i < n; i++) ctx.lineTo(xOf(i), yOf(hist_[i].rate));
    ctx.lineTo(xOf(n - 1), yBase);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = CH.ink;
    ctx.lineWidth = 1.75;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = xOf(i), y = yOf(hist_[i].rate);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    if (n <= 120) {
      ctx.fillStyle = CH.ink;
      for (let i = 0; i < n - 1; i++) {
        ctx.beginPath(); ctx.arc(xOf(i), yOf(hist_[i].rate), 2.2, 0, Math.PI * 2); ctx.fill();
      }
    }
    // newest point: the live value
    const lx = xOf(n - 1), ly = yOf(hist_[n - 1].rate);
    ctx.fillStyle = CH.signal;
    ctx.strokeStyle = CH.signal2;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(lx, ly, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

    ctx.fillStyle = CH.ink3;
    ctx.font = `13px ${CH.ui}`;
    ctx.textBaseline = 'top';
    const fmt = ms => new Date(ms).toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const nt = n > 1 ? (plotW >= 360 ? 4 : 3) : 1;
    for (let k = 0; k < nt; k++) {
      const ms = n > 1 ? xMin + xSpan * k / (nt - 1) : xMin;
      const x = n > 1 ? padL + plotW * k / (nt - 1) : padL + plotW / 2;
      ctx.textAlign = (n > 1 && k === 0) ? 'left' : (n > 1 && k === nt - 1) ? 'right' : 'center';
      ctx.fillText(fmt(ms), x, yBase + 7);
    }
  }
  drawAxisTitles(ctx, w, h, padL, padT, plotW, plotH, t('chart.xTime'), t('chart.yRate'));
}

// ---------- Oscilloscope ----------
function drawScope(canvas) {
  const { ctx, w: W, h: H, ok } = prepCanvas(canvas);
  if (!ok) return;   // view hidden; drawn again when it opens
  const padL = 64, padR = 16, padT = 12, padB = 46;
  const pw = W - padL - padR, ph = H - padT - padB;
  if (pw <= 0 || ph <= 0) return;

  ctx.fillStyle = CH.nightPlot;
  ctx.fillRect(padL, padT, pw, ph);

  const traces = scope.traces;
  if (!traces.length) {
    drawEmpty(ctx, state.isConnected ? t('scope.waiting') : t('scope.notConnected'),
              padL + pw / 2, padT + ph / 2, CH.nightInk2);
    drawAxisTitles(ctx, W, H, padL, padT, pw, ph, t('scope.xTitle'), t('scope.yTitle'), CH.nightInk2);
    return;
  }

  const ref = traces[traces.length - 1];
  const t0 = -ref.npre * ref.dtUs;
  const t1 = (ref.ntot - 1 - ref.npre) * ref.dtUs;

  let yLo, yHi;
  if (settings.scopeAutoY) {
    yLo = Infinity; yHi = -Infinity;
    for (const tr of traces) {
      for (let i = 0; i < tr.ntot; i++) {
        if (tr.v[i] < yLo) yLo = tr.v[i];
        if (tr.v[i] > yHi) yHi = tr.v[i];
      }
    }
    const pad = Math.max(4, (yHi - yLo) * 0.08);
    yLo -= pad; yHi += pad;
  } else {
    yLo = 0; yHi = ADC_MAX;
  }
  if (!(yHi > yLo)) yHi = yLo + 1;

  const xOf = us => padL + (us - t0) / (t1 - t0) * pw;
  const yOf = a  => padT + (1 - (a - yLo) / (yHi - yLo)) * ph;

  ctx.strokeStyle = 'rgba(233,230,240,0.07)';
  ctx.lineWidth = 1;
  for (let k = 1; k < 8; k++) {
    const x = Math.round(padL + pw * k / 8) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ph); ctx.stroke();
  }
  for (let k = 1; k < 5; k++) {
    const y = Math.round(padT + ph * k / 5) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + pw, y); ctx.stroke();
  }

  // signal threshold (the value in the threshold box, as before)
  const thr = parseInt(settings.threshSignal);
  if (isFinite(thr) && thr >= yLo && thr <= yHi) {
    ctx.strokeStyle = 'rgba(200,101,78,0.9)';
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(padL, yOf(thr)); ctx.lineTo(padL + pw, yOf(thr)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#F4B4A3';
    ctx.font = `12px ${CH.ui}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(t('scope.thresh') + ' ' + thr, padL + 6, yOf(thr) - 3);
  }

  // trigger point
  ctx.strokeStyle = 'rgba(233,230,240,0.35)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(xOf(0), padT); ctx.lineTo(xOf(0), padT + ph); ctx.stroke();
  ctx.setLineDash([]);

  for (let k = 0; k < traces.length; k++) {
    const tr = traces[k];
    const newest = (k === traces.length - 1);
    const age = traces.length > 1 ? k / (traces.length - 1) : 1;
    ctx.strokeStyle = newest ? CH.signal : `rgba(92,214,234,${(0.06 + 0.26 * age).toFixed(3)})`;
    ctx.lineWidth = newest ? 2 : 1;
    ctx.beginPath();
    for (let i = 0; i < tr.ntot; i++) {
      const x = xOf((i - tr.npre) * tr.dtUs), y = yOf(tr.v[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  ctx.fillStyle = CH.nightInk2;
  ctx.font = `13px ${CH.ui}`;
  ctx.textBaseline = 'top';
  for (let k = 0; k <= 8; k++) {
    ctx.textAlign = k === 0 ? 'left' : k === 8 ? 'right' : 'center';
    ctx.fillText((t0 + (t1 - t0) * k / 8).toFixed(0), padL + pw * k / 8, padT + ph + 7);
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let k = 0; k <= 5; k++) {
    ctx.fillText((yLo + (yHi - yLo) * (1 - k / 5)).toFixed(0), padL - 7, padT + ph * k / 5);
  }
  drawAxisTitles(ctx, W, H, padL, padT, pw, ph, t('scope.xTitle'), t('scope.yTitle'), CH.nightInk2);
}
