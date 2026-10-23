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
  coral: '#C8654E', coral2: '#A84A37',
  paper: '#FAF6EB', field: '#FFFDF7', signalInk: '#1F6B7C',
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
// State of the view rather than of the data. The threshold line can be dragged (ui.js owns the
// pointer handling); this keeps where the plot sits on the canvas for hit-testing, and the line
// being held. The vertical range is frozen for the length of a drag: with the axis fitting the
// traces it would otherwise move under the pointer every time a waveform arrives.
const scopeView = {
  plot: null,    // { padL, padT, pw, ph, yLo, yHi, thrY } of the last draw; thrY is null while the line is not grabbable
  drag: null,    // { thr, yLo, yHi } while the line is held
  hover: false,  // the pointer is over the line
  range: null,   // [yLo, yHi] of the last auto-fitted draw
};
// Time axis until the first waveform arrives: SCOPE_PRE 32 and SCOPE_POST 128 points, 12 µs each
const SCOPE_T0_DEFAULT = -384, SCOPE_T1_DEFAULT = 1536;

// ADC value under canvas row y for the range [lo, hi]; stays inside the plot and the ADC.
function scopeValueAtY(y, lo, hi) {
  const p = scopeView.plot;
  const a = lo + (1 - (y - p.padT) / p.ph) * (hi - lo);
  return Math.round(Math.min(Math.min(ADC_MAX, hi), Math.max(Math.max(0, lo), a)));
}

function drawScope(canvas) {
  const { ctx, w: W, h: H, ok } = prepCanvas(canvas);
  if (!ok) return;   // view hidden; drawn again when it opens
  const padL = 64, padR = 16, padT = 12, padB = 46;
  const pw = W - padL - padR, ph = H - padT - padB;
  scopeView.plot = null;
  if (pw <= 0 || ph <= 0) return;

  ctx.fillStyle = CH.field;
  ctx.fillRect(padL, padT, pw, ph);
  ctx.strokeStyle = CH.axis;
  ctx.lineWidth = 1;
  ctx.strokeRect(padL + 0.5, padT + 0.5, pw - 1, ph - 1);

  // The axes and the threshold line are drawn before the first waveform too: with the
  // threshold set too high none ever arrives, and the line is the way to bring it down.
  const traces = scope.traces;
  const ref = traces[traces.length - 1];
  const t0 = ref ? -ref.npre * ref.dtUs : SCOPE_T0_DEFAULT;
  const t1 = ref ? (ref.ntot - 1 - ref.npre) * ref.dtUs : SCOPE_T1_DEFAULT;

  // the value being dragged wins over the one in the threshold box
  const thr = scopeView.drag ? scopeView.drag.thr : parseInt(settings.threshSignal);
  if (isFinite(thr)) canvas.setAttribute('aria-valuenow', String(thr));

  let yLo, yHi;
  if (scopeView.drag) {
    yLo = scopeView.drag.yLo; yHi = scopeView.drag.yHi;
  } else if (settings.scopeAutoY) {
    yLo = 0; yHi = 400;
    if (traces.length) {
      yLo = Infinity; yHi = -Infinity;
      for (const tr of traces) {
        for (let i = 0; i < tr.ntot; i++) {
          if (tr.v[i] < yLo) yLo = tr.v[i];
          if (tr.v[i] > yHi) yHi = tr.v[i];
        }
      }
      const pad = Math.max(4, (yHi - yLo) * 0.08);
      yLo -= pad; yHi += pad;
    } else if (scopeView.range) {
      // no waveform (yet): keep the range the line was last shown in, so that it does not jump on release
      [yLo, yHi] = scopeView.range;
    }
    // the axis fits the threshold line as well: out of the plot it could not be grabbed
    if (isFinite(thr) && (thr < yLo || thr > yHi)) {
      const tp = Math.max(4, (yHi - yLo) * 0.08);
      yLo = Math.min(yLo, thr - tp); yHi = Math.max(yHi, thr + tp);
    }
    scopeView.range = [yLo, yHi];
  } else {
    yLo = 0; yHi = ADC_MAX;
  }
  if (!(yHi > yLo)) yHi = yLo + 1;

  const xOf = us => padL + (us - t0) / (t1 - t0) * pw;
  const yOf = a  => padT + (1 - (a - yLo) / (yHi - yLo)) * ph;

  ctx.strokeStyle = CH.grid;
  ctx.lineWidth = 1;
  for (let k = 1; k < 8; k++) {
    const x = Math.round(padL + pw * k / 8) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ph); ctx.stroke();
  }
  for (let k = 1; k < 5; k++) {
    const y = Math.round(padT + ph * k / 5) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + pw, y); ctx.stroke();
  }

  // signal threshold: drag it (ui.js). The grip and the hint show only when it can be dragged.
  let thrY = null;
  if (isFinite(thr) && (scopeView.drag || (thr >= yLo && thr <= yHi))) {
    const y = Math.min(padT + ph, Math.max(padT, yOf(thr)));
    const live = !!scopeView.drag, hot = live || scopeView.hover;
    const grab = state.isConnected;
    thrY = grab ? y : null;
    ctx.strokeStyle = hot ? CH.coral2 : 'rgba(200,101,78,0.9)';
    ctx.lineWidth = hot ? 2 : 1;
    ctx.setLineDash(live ? [] : [5, 4]);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + pw, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;

    const up = y - padT >= 24;   // the label sits above the line, below it when the line is at the top
    ctx.fillStyle = CH.coral2;
    ctx.font = `${live ? '600 14px' : '12px'} ${CH.ui}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = up ? 'bottom' : 'top';
    const label = t('scope.thresh') + ' ' + thr;
    ctx.fillText(label, padL + 6, up ? y - 4 : y + 4);
    if (grab && !live && pw >= 360) {
      const lw = ctx.measureText(label).width;
      ctx.fillStyle = CH.ink3;
      ctx.font = `12px ${CH.ui}`;
      ctx.fillText(t('scope.threshDrag'), padL + 6 + lw + 10, up ? y - 4 : y + 4);
    }

    if (grab) {
      const gw = 34, gh = 18, gx = padL + pw - gw - 6, cx = gx + gw / 2;
      ctx.fillStyle = hot ? CH.coral2 : 'rgba(200,101,78,0.95)';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(gx, y - gh / 2, gw, gh, 9); else ctx.rect(gx, y - gh / 2, gw, gh);
      ctx.fill();
      ctx.fillStyle = CH.paper;
      ctx.beginPath();
      ctx.moveTo(cx, y - 6); ctx.lineTo(cx - 5, y - 1.5); ctx.lineTo(cx + 5, y - 1.5);
      ctx.moveTo(cx, y + 6); ctx.lineTo(cx - 5, y + 1.5); ctx.lineTo(cx + 5, y + 1.5);
      ctx.fill();
    }
  }
  scopeView.plot = { padL, padT, pw, ph, yLo, yHi, thrY };

  // Free-run has no trigger point and nothing to re-arm.
  const free = settings.scopeTrig === 'FREE';

  // re-arm level = threshold - offset. Always drawn in triggered mode; it is computed from the
  // threshold as it is now (also the value being dragged), so the two lines move together.
  const rearmOffset = parseInt(settings.scopeRearm);
  const rearm = isFinite(thr) && rearmOffset >= 0 ? Math.max(0, thr - rearmOffset) : NaN;
  if (!free && isFinite(rearm) && rearm >= yLo && rearm <= yHi) {
    const y = yOf(rearm);
    ctx.strokeStyle = 'rgba(46,139,160,0.85)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + pw, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = CH.signalInk;
    ctx.font = `12px ${CH.ui}`;
    ctx.textAlign = 'right';
    // the threshold label is above its line (or below it at the very top): this one goes under its own line
    ctx.textBaseline = 'top';
    ctx.fillText(t('scope.rearmLine') + ' ' + rearm, padL + pw - 46, y + 3);
  }

  // trigger point
  if (!free) {
    ctx.strokeStyle = CH.axis;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(xOf(0), padT); ctx.lineTo(xOf(0), padT + ph); ctx.stroke();
    ctx.setLineDash([]);
  }

  for (let k = 0; k < traces.length; k++) {
    const tr = traces[k];
    const newest = (k === traces.length - 1);
    const age = traces.length > 1 ? k / (traces.length - 1) : 1;
    ctx.strokeStyle = newest ? CH.signal2 : `rgba(46,139,160,${(0.07 + 0.30 * age).toFixed(3)})`;
    ctx.lineWidth = newest ? 2 : 1;
    ctx.beginPath();
    for (let i = 0; i < tr.ntot; i++) {
      const x = xOf((i - tr.npre) * tr.dtUs), y = yOf(tr.v[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  ctx.fillStyle = CH.ink3;
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
  drawAxisTitles(ctx, W, H, padL, padT, pw, ph, t(free ? 'scope.xTitleFree' : 'scope.xTitle'), t('scope.yTitle'), CH.ink3);

  if (!traces.length) {
    // on the half of the plot the threshold line is not in
    const mid = padT + ph / 2, ty = thrY == null ? mid : thrY;
    drawEmpty(ctx, state.isConnected ? t(free ? 'scope.waitingFree' : 'scope.waiting') : t('scope.notConnected'),
              padL + pw / 2, ty < mid ? padT + ph * 0.72 : padT + ph * 0.28, CH.ink3);
  }
}
