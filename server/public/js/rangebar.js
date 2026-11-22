/* The "pick a period" bar of the station page: one column per stretch of days from the station's first day
 * with data up to today. Days with data are coloured (darker = more events), days without are pale.
 * Drag across the bar to choose a period; a click chooses one day. The period on show is outlined.
 * Pointer events cover mouse, pen and touch. Nothing here talks to the network: the page hands in the data.
 *
 *   const bar = CRD.rangeBar(canvas, { onSelect(from, to), onInfo(text) });
 *   bar.load({ today, days: [[ 'YYYY-MM-DD', events ], ...] });
 *   bar.setWindow(from, to);
 */
(function () {
  'use strict';
  const DAY = 86400e3;
  const css = (n, fb) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb;
  const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
  const label = (ms) => new Date(ms).toLocaleDateString('ja-JP', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' });

  function rangeBar(canvas, { onSelect, onInfo } = {}) {
    let t0 = 0, n = 0, counts = null, max = 0;
    let win = null;                              // { from, to } shown now
    let drag = null;                             // { a, b }: day indexes while the pointer is down

    const idxOfDay = (d) => Math.min(n - 1, Math.max(0, Math.round((Date.parse(d) - t0) / DAY)));
    const dayAt = (i) => dayOf(t0 + i * DAY);

    function load(ov) {
      if (!ov || !ov.days || !ov.days.length) { n = 0; counts = null; draw(); return false; }
      t0 = Date.parse(ov.days[0][0]);
      n = Math.round((Date.parse(ov.today) - t0) / DAY) + 1;
      counts = new Float64Array(n);
      max = 0;
      for (const [d, c] of ov.days) {
        const i = Math.round((Date.parse(d) - t0) / DAY);
        if (i >= 0 && i < n) { counts[i] = c; if (c > max) max = c; }
      }
      draw();
      return true;
    }

    function setWindow(from, to) { win = from && to ? { from, to } : null; draw(); }

    function draw() {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth || 600, h = canvas.clientHeight || 64;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!n) return;
      const pad = 6, bw = w - 2 * pad, top = 6, bh = h - 28;
      const signal = css('--signal', '#2E8BA0'), soft = css('--line', '#ddd'), accent = css('--accent', '#9A435C'), muted = css('--muted', '#777');
      const x = (i) => pad + (i * bw) / n;

      // one pixel column at a time: it stands for one day, or for the many days that fall into that pixel
      ctx.fillStyle = soft; ctx.globalAlpha = 0.55; ctx.fillRect(pad, top, bw, bh);
      ctx.fillStyle = signal;
      for (let px = 0; px < bw; px++) {
        const lo = Math.floor((px * n) / bw);
        const hi = Math.max(lo + 1, Math.floor(((px + 1) * n) / bw));
        let m = 0;
        for (let i = lo; i < hi && i < n; i++) if (counts[i] > m) m = counts[i];
        if (m <= 0) continue;
        ctx.globalAlpha = 0.3 + 0.7 * (Math.log1p(m) / Math.log1p(max));
        ctx.fillRect(pad + px, top, 1.5, bh);
      }
      ctx.globalAlpha = 1;

      // the period on show, and the one being dragged
      if (win) {
        const a = idxOfDay(win.from), b = idxOfDay(win.to);
        ctx.strokeStyle = accent; ctx.lineWidth = 2;
        ctx.strokeRect(x(a) - 0.5, top - 1, Math.max(3, x(b + 1) - x(a)) + 1, bh + 2);
      }
      if (drag) {
        const a = Math.min(drag.a, drag.b), b = Math.max(drag.a, drag.b);
        ctx.fillStyle = accent; ctx.globalAlpha = 0.25;
        ctx.fillRect(x(a), top, Math.max(2, x(b + 1) - x(a)), bh);
        ctx.globalAlpha = 1;
      }

      // axis: the first day, today, and the 1 January of each year when there is room
      ctx.fillStyle = muted; ctx.strokeStyle = muted; ctx.lineWidth = 1; ctx.font = '12px system-ui, sans-serif';
      const yb = top + bh + 14;
      ctx.textAlign = 'left'; ctx.fillText(label(t0), pad, yb);
      ctx.textAlign = 'right'; ctx.fillText(label(t0 + (n - 1) * DAY), w - pad, yb);
      if (n > 400) {
        const y0 = new Date(t0).getUTCFullYear();
        for (let y = y0 + 1; ; y++) {
          const ms = Date.UTC(y, 0, 1), i = Math.round((ms - t0) / DAY);
          if (i >= n) break;
          const px = x(i);
          if (px < pad + 90 || px > w - pad - 90) continue;
          ctx.beginPath(); ctx.moveTo(px, top + bh); ctx.lineTo(px, top + bh + 4); ctx.stroke();
          ctx.textAlign = 'center'; ctx.fillText(String(y), px, yb);
        }
      }
    }

    // pointer position -> day index
    function indexAt(e) {
      const r = canvas.getBoundingClientRect();
      const pad = 6, bw = r.width - 2 * pad;
      return Math.min(n - 1, Math.max(0, Math.floor(((e.clientX - r.left - pad) / bw) * n)));
    }
    function info(a, b) {
      if (!onInfo) return;
      const lo = Math.min(a, b), hi = Math.max(a, b);
      let sum = 0, withData = 0;
      for (let i = lo; i <= hi; i++) if (counts[i] > 0) { sum += counts[i]; withData++; }
      onInfo(lo === hi ? `${dayAt(lo)}（UTC）: ${sum.toLocaleString('ja-JP')} 件`
                       : `${dayAt(lo)} 〜 ${dayAt(hi)}（UTC）: ${hi - lo + 1} 日のうち ${withData} 日にデータ、${sum.toLocaleString('ja-JP')} 件`);
    }

    canvas.addEventListener('pointerdown', (e) => {
      if (!n || e.button > 0) return;
      canvas.setPointerCapture(e.pointerId);
      const i = indexAt(e);
      drag = { a: i, b: i };
      info(i, i); draw();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!n) return;
      const i = indexAt(e);
      if (drag) { drag.b = i; info(drag.a, drag.b); draw(); } else info(i, i);
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!drag) return;
      const lo = Math.min(drag.a, drag.b), hi = Math.max(drag.a, drag.b);
      drag = null;
      draw();
      if (onSelect) onSelect(dayAt(lo), dayAt(hi));
    });
    canvas.addEventListener('pointercancel', () => { drag = null; draw(); });
    canvas.addEventListener('pointerleave', () => { if (!drag && onInfo) onInfo(null); });

    return { load, setWindow, redraw: draw };
  }

  window.CRD = window.CRD || {};
  window.CRD.rangeBar = rangeBar;
})();
