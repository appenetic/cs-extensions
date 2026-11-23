// The quiet view: a glow in the ambient light's colour over a dark screen and
// two light trails towards a vanishing point, with pulses running down them
// towards the driver. The still part is painted once per colour and size; each
// frame adds only what moves. /state brings the colour and the arrival.
(() => {
  'use strict';

  const canvas = document.getElementById('glow');
  const ctx = canvas.getContext('2d');
  const base = document.createElement('canvas');
  const trip = document.getElementById('trip');
  const eta = document.getElementById('eta');
  const rest = document.getElementById('rest');
  const hint = document.getElementById('hint');
  let rgb = [255, 255, 255];
  let geo = null;

  const rgba = (a, c = rgb) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  function parseColor(hex) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    return m ? [1, 2, 3].map((i) => parseInt(m[i], 16)) : null;
  }

  // The trails run from the bottom corners to the vanishing point.
  function trailPoint(side, p) {
    const { w, h, vx, vy } = geo;
    const x = vx + side * (0.03 * w + 0.45 * w * p);
    return { x, y: vy + (h - vy) * p, width: 0.012 * w + 0.16 * w * p };
  }

  function layout() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = base.width = Math.round(innerWidth * dpr);
    canvas.height = base.height = Math.round(innerHeight * dpr);
    const w = canvas.width;
    const h = canvas.height;
    geo = { w, h, vx: w / 2, vy: h * 0.58, gx: w / 2, gy: h * 0.3, gr: Math.max(w, h) * 0.32 };
    paintBase();
  }

  function glowAt(g, scale, alpha) {
    const { gx, gy, gr } = geo;
    g.save();
    g.translate(gx, gy);
    g.scale(1.7, 1);
    const r = gr * scale;
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, r);
    grad.addColorStop(0, rgba(0.55 * alpha));
    grad.addColorStop(0.4, rgba(0.26 * alpha));
    grad.addColorStop(0.75, rgba(0.07 * alpha));
    grad.addColorStop(1, rgba(0));
    g.fillStyle = grad;
    g.beginPath();
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  function paintBase() {
    const g = base.getContext('2d');
    const { w, h, vx, vy } = geo;
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = rgba(1, rgb.map((c) => Math.round(5 + c * 0.03)));
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'lighter';
    glowAt(g, 1, 1);
    // Each trail as a wide soft beam and a brighter core. The base is painted
    // once per colour and size, so the blur costs nothing per frame.
    for (const side of [-1, 1]) {
      beam(g, side, 2.4, 0.34, w * 0.02);
      beam(g, side, 0.45, 0.42, w * 0.005);
    }
  }

  function beam(g, side, spread, alpha, blur) {
    const { h, vx, vy } = geo;
    const bottom = trailPoint(side, 1);
    const grad = g.createLinearGradient(vx, vy, bottom.x, h);
    grad.addColorStop(0, rgba(0));
    grad.addColorStop(0.3, rgba(alpha * 0.2));
    grad.addColorStop(1, rgba(alpha));
    g.save();
    g.filter = `blur(${Math.round(blur)}px)`;
    g.fillStyle = grad;
    g.beginPath();
    for (let i = 0; i <= 24; i++) {
      const pt = trailPoint(side, i / 24);
      g.lineTo(pt.x - (pt.width * spread) / 2, pt.y);
    }
    for (let i = 24; i >= 0; i--) {
      const pt = trailPoint(side, i / 24);
      g.lineTo(pt.x + (pt.width * spread) / 2, pt.y);
    }
    g.closePath();
    g.fill();
    g.restore();
  }

  // A pulse: a soft ellipse along the trail, bigger and brighter near the driver.
  function pulse(side, p) {
    const pt = trailPoint(side, p);
    const next = trailPoint(side, Math.min(1, p + 0.01));
    const angle = Math.atan2(next.y - pt.y, next.x - pt.x);
    const length = geo.h * (0.03 + 0.16 * p);
    ctx.save();
    ctx.translate(pt.x, pt.y);
    ctx.rotate(angle);
    const r = pt.width * 0.7;
    ctx.scale(length / r, 1);
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    grad.addColorStop(0, rgba(0.15 + 0.55 * p));
    grad.addColorStop(0.5, rgba(0.08 + 0.2 * p));
    grad.addColorStop(1, rgba(0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function frame(now) {
    const s = now / 1000;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(base, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    glowAt(ctx, 1.05, 0.18 * (1 + Math.sin((s * Math.PI * 2) / 5)));
    [-1, 1].forEach((side, k) => {
      for (let n = 0; n < 3; n++) {
        const t = (s / 2.4 + n / 3 + k / 6) % 1;
        pulse(side, t ** 1.7);
      }
    });
    requestAnimationFrame(frame);
  }

  function show(state) {
    const c = parseColor(state.color);
    if (c && c.join() !== rgb.join()) {
      rgb = c;
      paintBase();
    }
    trip.hidden = !(state.trip && state.eta);
    eta.textContent = state.eta || '';
    const parts = [];
    if (state.min) parts.push(`noch ${state.min} min`);
    if (state.km) parts.push(`${state.km} km`);
    rest.textContent = parts.join(' · ');
  }

  async function poll() {
    try {
      const res = await fetch('state', { cache: 'no-store' });
      if (res.ok) show(await res.json());
    } catch {
      // The service restarts; the next poll catches up.
    }
  }

  // The service asks QtCar for the window: maximized when the page opens,
  // closed after a firm swipe down. The header keeps other origins out.
  function askWindow(action) {
    return fetch(`window/${action}`, { method: 'POST', headers: { 'X-Quiet': '1' } }).catch(() => {});
  }

  // A tap also asks Chromium for full screen, in case QtCar gives a full-screen
  // page more of the display than the maximized window.
  let start = null;
  addEventListener('pointerdown', (e) => {
    start = { x: e.clientX, y: e.clientY };
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  });
  addEventListener('pointerup', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    start = null;
    if (dy > innerHeight * 0.22 && Math.abs(dx) < dy / 2) {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      askWindow('close');
    }
  });
  addEventListener('pointercancel', () => {
    start = null;
  });

  addEventListener('resize', layout);
  layout();
  requestAnimationFrame(frame);
  askWindow('max');
  poll();
  setInterval(poll, 2000);
  setTimeout(() => hint.classList.add('gone'), 6000);
})();
