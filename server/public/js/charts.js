/* Small canvas charts: a line chart (with gaps where there is no data) and a bar chart.
 * Written here instead of pulling in a charting library: nothing third-party runs on these pages,
 * and a station's data never reaches any outside code. Colours come from the page's CSS variables,
 * so light and dark follow the page. */
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

  function frame(ctx, w, h, lo, hi, yLabel) {
    const ink = css('--muted', '#777'), line = css('--line', '#ddd');
    const pad = { l: 46, r: 10, t: 10, b: 24 };
    ctx.strokeStyle = line; ctx.fillStyle = ink; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + ((h - pad.t - pad.b) * i) / 4;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      const val = lo + (hi - lo) * (1 - i / 4);          // the axis may not start at zero (temperature)
      ctx.textAlign = 'right';
      ctx.fillText(val >= 10 ? String(Math.round(val)) : String(Math.round(val * 10) / 10), pad.l - 6, y + 4);
    }
    if (yLabel) { ctx.textAlign = 'left'; ctx.fillText(yLabel, pad.l, pad.t - 1 + 0); }
    return pad;
  }

  function noData(ctx, w, h) {
    ctx.fillStyle = css('--muted', '#777'); ctx.textAlign = 'center';
    ctx.fillText('この期間のデータはありません', w / 2, h / 2);
  }

  // points: [{ t: epoch ms, y: number | null }]; a null y breaks the line.
  function drawLine(canvas, points, { yLabel = '', color = null, yMin = 0, xFormat } = {}) {
    const { ctx, w, h } = setup(canvas);
    const have = points.filter((p) => p.y != null && Number.isFinite(p.y));
    if (have.length === 0) { noData(ctx, w, h); return; }
    const ys = have.map((p) => p.y);
    const lo = yMin === 'auto' ? Math.min(...ys) - 1 : yMin;
    const hi = niceMax(Math.max(...ys) - (yMin === 'auto' ? lo : 0)) + (yMin === 'auto' ? lo : 0);
    const pad = frame(ctx, w, h, lo, hi, yLabel);
    const t0 = points[0].t, t1 = points[points.length - 1].t || t0 + 1;
    const X = (t) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (w - pad.l - pad.r);
    const Y = (y) => pad.t + (1 - (y - lo) / Math.max(1e-9, hi - lo)) * (h - pad.t - pad.b);
    ctx.strokeStyle = color || css('--accent', '#0b7a8a'); ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath();
    let pen = false;
    for (const p of points) {
      if (p.y == null || !Number.isFinite(p.y)) { pen = false; continue; }
      if (pen) ctx.lineTo(X(p.t), Y(p.y)); else ctx.moveTo(X(p.t), Y(p.y));
      pen = true;
    }
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;                         // a dot per point: a lone sample has no line
    for (const p of have) { ctx.beginPath(); ctx.arc(X(p.t), Y(p.y), 2.5, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = css('--muted', '#777'); ctx.textAlign = 'center';
    const fmt = xFormat || ((t) => new Date(t).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit' }));
    [0, 0.5, 1].forEach((f, i) => {
      ctx.textAlign = i === 0 ? 'left' : i === 2 ? 'right' : 'center';
      ctx.fillText(fmt(t0 + (t1 - t0) * f), pad.l + (w - pad.l - pad.r) * f, h - 6);
    });
  }

  // values: number[]; labelFor(i) names the bar at index i (used for the first, middle and last).
  function drawBars(canvas, values, { yLabel = '', color = null, labelFor } = {}) {
    const { ctx, w, h } = setup(canvas);
    const max = Math.max(0, ...values);
    if (max === 0) { noData(ctx, w, h); return; }
    const hi = niceMax(max);
    const pad = frame(ctx, w, h, 0, hi, yLabel);
    const bw = (w - pad.l - pad.r) / values.length;
    ctx.fillStyle = color || css('--accent', '#0b7a8a');
    values.forEach((v, i) => {
      const bh = (v / hi) * (h - pad.t - pad.b);
      ctx.fillRect(pad.l + i * bw + 0.5, h - pad.b - bh, Math.max(1, bw - 1), bh);
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
})();
