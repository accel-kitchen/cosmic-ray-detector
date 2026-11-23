/* Small canvas charts: a line chart (with gaps where there is no data) and a bar chart.
 * Written here instead of pulling in a charting library: nothing third-party runs on these pages,
 * and a station's data never reaches any outside code. Colours come from the page's CSS variables,
 * so the charts follow the page theme.
 *
 * The vertical scale ("scale" option):
 *   'auto'    a few points far above (or below) the rest would squash everything else flat, so they are cut off
 *             at the edge of the chart, drawn as a hollow triangle, and counted in a note ("▲ 範囲外 3 点（最大 50万）");
 *             when no point stands out, it is the same as 'linear'
 *   'linear'  everything, from the lowest to the highest value
 *   'log'     a logarithmic axis (values of 0 or less have no place on it and are left out)
 * An axis never starts anywhere but at 0, except a chart that asks for yMin 'auto' (temperature). */
(function () {
  'use strict';

  function css(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function setup(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 600, h = canvas.clientHeight || 220;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '12px system-ui, sans-serif';
    return { ctx, w, h };
  }

  // A tidy upper limit for an axis.
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const m = v / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
  }

  // 500000 -> "50万", 1500000 -> "150万", 12000 -> "1.2万", 250000000 -> "2.5億"; small numbers as they are.
  function fmtNum(v) {
    const t = (x) => String(Math.round(x * 10) / 10);
    const a = Math.abs(v);
    if (a >= 1e8) return t(v / 1e8) + '億';
    if (a >= 1e4) return t(v / 1e4) + '万';
    return a >= 10 ? String(Math.round(v)) : t(v);
  }

  // The value that has `frac` of the sorted values at or below it.
  const quantile = (sorted, frac) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(frac * (sorted.length - 1))))];

  // Work out the vertical range. Returns { lo, hi, log, cut: { n, max } | null, hasData }.
  function range(ys, { scale, yMin }) {
    if (scale === 'log') {
      const pos = ys.filter((y) => y > 0);
      if (!pos.length) return { lo: 1, hi: 10, log: true, cut: null, empty: true };
      const lo = Math.pow(10, Math.floor(Math.log10(Math.min(...pos))));
      let hi = Math.pow(10, Math.ceil(Math.log10(Math.max(...pos))));
      if (hi <= lo) hi = lo * 10;
      return { lo, hi, log: true, cut: null };
    }
    const sorted = ys.slice().sort((a, b) => a - b);
    const max = sorted[sorted.length - 1], min = sorted[0];
    const out = (lo, hi, cut) => ({ lo, hi, log: false, cut });
    if (yMin === 'auto') {
      // a chart that does not start at zero (temperature): fence the values off by the spread of the middle 90 %
      const p5 = quantile(sorted, 0.05), p95 = quantile(sorted, 0.95), spread = Math.max(1, p95 - p5);
      const loF = p5 - 3 * spread, hiF = p95 + 3 * spread;
      if (scale === 'auto' && sorted.length >= 20 && (min < loF || max > hiF)) {
        const inside = sorted.filter((y) => y >= loF && y <= hiF);
        const lo = Math.min(...inside) - 1;
        const hi = niceMax(Math.max(...inside) - lo) + lo;
        const farHigh = max - Math.max(...inside), farLow = Math.min(...inside) - min;
        return out(lo, hi, { n: sorted.length - inside.length, extreme: farHigh >= farLow ? max : min, below: farLow > farHigh });
      }
      const lo = min - 1;
      return out(lo, niceMax(max - lo) + lo, null);
    }
    // an axis from zero: cut off what is far above the rest
    if (scale === 'auto' && sorted.length >= 20) {
      const cap = niceMax(quantile(sorted, 0.95) * 1.5);
      if (max > cap * 2) return out(0, cap, { n: sorted.filter((y) => y > cap).length, extreme: max, below: false });
    }
    return out(0, niceMax(max), null);
  }

  function frame(ctx, w, h, r, yLabel) {
    const ink = css('--muted', '#777'), line = css('--line', '#ddd');
    const ticks = [];
    if (r.log) {
      const d0 = Math.round(Math.log10(r.lo)), d1 = Math.round(Math.log10(r.hi));
      const step = d1 - d0 > 8 ? 2 : 1;
      for (let d = d0; d <= d1; d += step) ticks.push(Math.pow(10, d));
    } else {
      for (let i = 0; i <= 4; i++) ticks.push(r.lo + (r.hi - r.lo) * (i / 4));
    }
    // the left margin is as wide as the widest label (numbers like "50万" or 1000000 are long)
    ctx.font = '12px system-ui, sans-serif';
    const widest = Math.max(...ticks.map((v) => ctx.measureText(fmtNum(v)).width));
    const pad = { l: Math.max(46, Math.ceil(widest) + 14), r: 10, t: 14, b: 24 };
    const Y = (y) => {
      const f = r.log ? (Math.log10(Math.max(y, r.lo)) - Math.log10(r.lo)) / (Math.log10(r.hi) - Math.log10(r.lo))
                      : (y - r.lo) / Math.max(1e-9, r.hi - r.lo);
      return pad.t + (1 - Math.min(1, Math.max(0, f))) * (h - pad.t - pad.b);
    };
    ctx.strokeStyle = line; ctx.fillStyle = ink; ctx.lineWidth = 1; ctx.textAlign = 'right';
    for (const v of ticks) {
      const y = Y(v);
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillText(fmtNum(v), pad.l - 6, y + 4);
    }
    if (yLabel) { ctx.textAlign = 'left'; ctx.fillText(yLabel + (r.log ? '（対数）' : ''), pad.l, pad.t - 4); }
    return { pad, Y };
  }

  function noData(ctx, w, h) {
    ctx.fillStyle = css('--muted', '#777'); ctx.textAlign = 'center';
    ctx.fillText('この期間のデータはありません', w / 2, h / 2);
  }

  function cutNote(ctx, w, pad, cut) {
    if (!cut) return;
    ctx.fillStyle = css('--warn', '#9A3B2C'); ctx.textAlign = 'right';
    ctx.fillText(`${cut.below ? '▼' : '▲'} 範囲外 ${cut.n} 点（${cut.below ? '最小' : '最大'} ${fmtNum(cut.extreme)}）`, w - pad.r, pad.t - 4);
  }

  // points: [{ t: epoch ms, y: number | null }]; a null y breaks the line.
  function drawLine(canvas, points, { yLabel = '', color = null, yMin = 0, xFormat, scale = 'auto' } = {}) {
    const { ctx, w, h } = setup(canvas);
    const usable = (p) => p.y != null && Number.isFinite(p.y) && !(scale === 'log' && p.y <= 0);
    const have = points.filter(usable);
    if (have.length === 0) { noData(ctx, w, h); return; }
    const r = range(have.map((p) => p.y), { scale, yMin });
    const { pad, Y } = frame(ctx, w, h, r, yLabel);
    const t0 = points[0].t, t1 = points[points.length - 1].t || t0 + 1;
    const X = (t) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (w - pad.l - pad.r);
    const out = (y) => !r.log && r.cut && (y > r.hi || y < r.lo);          // a point beyond the edge of the chart
    ctx.strokeStyle = color || css('--signal', '#2E8BA0'); ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath();
    let pen = false;
    for (const p of points) {
      if (!usable(p)) { pen = false; continue; }
      if (out(p.y)) { pen = false; continue; }                             // the line stops at a cut-off point instead of running along the edge
      if (pen) ctx.lineTo(X(p.t), Y(p.y)); else ctx.moveTo(X(p.t), Y(p.y));
      pen = true;
    }
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;                         // a dot per point: a lone sample has no line
    for (const p of have) { if (out(p.y)) continue; ctx.beginPath(); ctx.arc(X(p.t), Y(p.y), 2.5, 0, Math.PI * 2); ctx.fill(); }
    if (r.cut) {                                             // hollow triangles at the edge, pointing the way the value went
      const warn = css('--warn', '#9A3B2C');
      ctx.strokeStyle = warn; ctx.lineWidth = 1.5;
      for (const p of have) {
        if (!out(p.y)) continue;
        const up = p.y > r.hi, x = X(p.t), y = up ? pad.t + 1 : h - pad.b - 1, d = up ? 1 : -1;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 4, y + 7 * d); ctx.lineTo(x + 4, y + 7 * d); ctx.closePath(); ctx.stroke();
      }
      cutNote(ctx, w, pad, r.cut);
    }
    ctx.fillStyle = css('--muted', '#777'); ctx.textAlign = 'center';
    const fmt = xFormat || ((t) => new Date(t).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit' }));
    [0, 0.5, 1].forEach((f, i) => {
      ctx.textAlign = i === 0 ? 'left' : i === 2 ? 'right' : 'center';
      ctx.fillText(fmt(t0 + (t1 - t0) * f), pad.l + (w - pad.l - pad.r) * f, h - 6);
    });
  }

  // values: number[]; labelFor(i) names the bar at index i (used for the first, middle and last).
  // A histogram's tall bar is real, so 'auto' draws it in full; only 'log' changes the axis.
  function drawBars(canvas, values, { yLabel = '', color = null, labelFor, scale = 'auto' } = {}) {
    const { ctx, w, h } = setup(canvas);
    const max = Math.max(0, ...values);
    if (max === 0) { noData(ctx, w, h); return; }
    const log = scale === 'log';
    const r = log ? { lo: 0.5, hi: Math.pow(10, Math.ceil(Math.log10(max))), log: true, cut: null }
                  : { lo: 0, hi: niceMax(max), log: false, cut: null };
    if (log && r.hi <= 1) r.hi = 10;
    const { pad, Y } = frame(ctx, w, h, r, yLabel);
    const bw = (w - pad.l - pad.r) / values.length;
    ctx.fillStyle = color || css('--signal', '#2E8BA0');
    values.forEach((v, i) => {
      if (!(v > 0)) return;
      const y = Y(v), base = Y(r.lo);
      ctx.fillRect(pad.l + i * bw + 0.5, y, Math.max(1, bw - 1), Math.max(1, base - y));
    });
    if (labelFor) {
      ctx.fillStyle = css('--muted', '#777');
      [0, Math.floor(values.length / 2), values.length - 1].forEach((i, k) => {
        ctx.textAlign = k === 0 ? 'left' : k === 2 ? 'right' : 'center';
        ctx.fillText(labelFor(i), pad.l + (i + 0.5) * bw + (k === 0 ? -bw / 2 : k === 2 ? bw / 2 : 0), h - 6);
      });
    }
  }

  window.CRD = window.CRD || {};
  window.CRD.drawLine = drawLine;
  window.CRD.drawBars = drawBars;
  window.CRD.fmtNum = fmtNum;
})();
