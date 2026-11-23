// The quiet view: a glow in the ambient light's colour over a dark screen and
// two light trails towards a vanishing point, with pulses running down them
// towards the driver. The trails bend the way the car turns. The background and
// the glow are painted once per colour and size; each frame adds the trails,
// drawn small and blurred and then scaled up, the breathing and the pulses.
// /state brings the colour, the arrival and the turn rate.
(() => {
  'use strict';

  const canvas = document.getElementById('glow');
  const ctx = canvas.getContext('2d');
  const base = document.createElement('canvas');
  const trails = document.createElement('canvas');
  const trip = document.getElementById('trip');
  const eta = document.getElementById('eta');
  const rest = document.getElementById('rest');
  const hint = document.getElementById('hint');
  // The trails' buffer is this much of the screen; blurred, it scales up cleanly.
  const TRAIL_SCALE = 0.25;
  // The colour shown, and the one the ambient lights have now; it fades over
  // like the lights do.
  let rgb = [255, 255, 255];
  let light = null;
  let geo = null;
  // bend runs from -1 (hard left) to 1 (hard right) and eases towards target.
  let bend = 0;
  let target = 0;
  let trailsBend = null;
  // pace runs from 0 (standing) to 1 (motorway) and eases slowly towards
  // paceGoal; phase carries the pulses, so a new pace never makes them jump.
  let pace = 0;
  let paceGoal = 0;
  let phase = 0;
  let lastState = 0;
  let lastFrame = 0;

  const rgba = (a, c = rgb) => `rgba(${c.map(Math.round).join(',')},${a})`;

  function parseColor(hex) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    return m ? [1, 2, 3].map((i) => parseInt(m[i], 16)) : null;
  }

  // Degrees per second the heading turns, right positive, as a bend: gentle
  // curves already show, a turn at a junction (about 25 °/s) bends fully. Below
  // 0.4 °/s it is the GPS wandering, and the road stays straight.
  function bendFor(yaw) {
    const v = Number.parseFloat(yaw);
    if (!Number.isFinite(v)) return 0;
    const a = Math.max(0, Math.abs(v) - 0.4);
    return Math.sign(v) * Math.min(1, Math.sqrt(a / 25));
  }

  // The speed as a pace: the square root keeps town speeds apart and lets the
  // motorway (about 75, VAPI_vehicleSpeed) reach the top.
  function paceFor(speed) {
    const v = Number.parseFloat(speed);
    if (!Number.isFinite(v) || v <= 0) return 0;
    return Math.min(1, Math.sqrt(v / 75));
  }

  // A point of a trail, p from 0 at the vanishing point to 1 at the bottom edge.
  // A bend moves the far end sideways, the near end stays, like a road ahead
  // that curves.
  function trailPoint(side, p) {
    const { w, h, vx, vy } = geo;
    const x = vx + side * (0.03 * w + 0.45 * w * p) + bend * 0.3 * w * (1 - p) ** 2;
    return { x, y: vy + (h - vy) * p, width: 0.012 * w + 0.16 * w * p };
  }

  function layout() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = base.width = Math.round(innerWidth * dpr);
    canvas.height = base.height = Math.round(innerHeight * dpr);
    trails.width = Math.max(1, Math.round(canvas.width * TRAIL_SCALE));
    trails.height = Math.max(1, Math.round(canvas.height * TRAIL_SCALE));
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
    const { w, h } = geo;
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = rgba(1, rgb.map((c) => Math.round(5 + c * 0.03)));
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'lighter';
    glowAt(g, 1, 1);
    trailsBend = null;
  }

  // Each trail as a wide soft beam and a brighter core, in the small buffer.
  function paintTrails() {
    const g = trails.getContext('2d');
    g.clearRect(0, 0, trails.width, trails.height);
    g.globalCompositeOperation = 'lighter';
    for (const side of [-1, 1]) {
      beam(g, side, 2.4, 0.34, geo.w * 0.02);
      beam(g, side, 0.45, 0.42, geo.w * 0.005);
    }
    trailsBend = bend;
  }

  function beam(g, side, spread, alpha, blur) {
    const s = TRAIL_SCALE;
    const far = trailPoint(side, 0);
    const near = trailPoint(side, 1);
    const grad = g.createLinearGradient(far.x * s, far.y * s, near.x * s, near.y * s);
    grad.addColorStop(0, rgba(0));
    grad.addColorStop(0.3, rgba(alpha * 0.2));
    grad.addColorStop(1, rgba(alpha));
    g.save();
    g.filter = `blur(${Math.max(0.5, blur * s).toFixed(1)}px)`;
    g.fillStyle = grad;
    g.beginPath();
    for (let i = 0; i <= 24; i++) {
      const pt = trailPoint(side, i / 24);
      g.lineTo((pt.x - (pt.width * spread) / 2) * s, pt.y * s);
    }
    for (let i = 24; i >= 0; i--) {
      const pt = trailPoint(side, i / 24);
      g.lineTo((pt.x + (pt.width * spread) / 2) * s, pt.y * s);
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
    const dt = lastFrame ? Math.min(0.1, s - lastFrame) : 0;
    lastFrame = s;
    // Without fresh state the trails straighten out and the pulses slow down.
    const fresh = performance.now() - lastState < 3000;
    const goal = fresh ? target : 0;
    bend += (goal - bend) * Math.min(1, dt / 0.7);
    // A pulse takes about 5 s from the horizon to the driver when standing and
    // 2 s on the motorway; the pace follows the speed over about 1.5 s.
    pace += ((fresh ? paceGoal : 0) - pace) * Math.min(1, dt / 1.5);
    phase = (phase + dt * (1 / 5 + (1 / 2 - 1 / 5) * pace)) % 1;
    if (light && light.join() !== rgb.join()) {
      const k = Math.min(1, dt / 0.6);
      rgb = rgb.map((v, i) => (Math.abs(light[i] - v) < 1 ? light[i] : v + (light[i] - v) * k));
      paintBase();
    }
    if (trailsBend === null || Math.abs(bend - trailsBend) > 0.002) paintTrails();
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(base, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(trails, 0, 0, geo.w, geo.h);
    glowAt(ctx, 1.05, 0.18 * (1 + Math.sin((s * Math.PI * 2) / 5)));
    [-1, 1].forEach((side, k) => {
      for (let n = 0; n < 3; n++) {
        const t = (phase + n / 3 + k / 6) % 1;
        pulse(side, t ** 1.7);
      }
    });
    requestAnimationFrame(frame);
  }

  function show(state) {
    const c = parseColor(state.color);
    if (c && !light) {
      // The first colour shows at once, not as a fade from white.
      rgb = c;
      paintBase();
    }
    if (c) light = c;
    target = bendFor(state.yaw);
    paceGoal = paceFor(state.speed);
    lastState = performance.now();
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
  // The turn rate changes quickly; the service samples the heading twice a second.
  setInterval(poll, 500);
  setTimeout(() => hint.classList.add('gone'), 6000);
})();
