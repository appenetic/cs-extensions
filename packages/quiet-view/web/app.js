// The quiet view: a glow in the ambient lights' colour over a dark screen and
// two light trails towards a vanishing point, with pulses running down them
// towards the driver at the pace of the car. The trails bend the way the car
// turns, and already before a turn the navigation announces; the side the car
// signals to pulses with the indicator. The speedometer, the arrival, the next
// turn and the route's progress sit quietly on top; a long press offers what to
// show. The background and the glow are painted once per colour, brightness and
// size; each frame adds the trails, drawn small and blurred and then scaled up,
// the breathing and the pulses. The service streams what the car shows
// (events), and answers /state while the stream is down.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const canvas = $('glow');
  const ctx = canvas.getContext('2d');
  const base = document.createElement('canvas');
  const trails = document.createElement('canvas');
  const menu = $('menu');
  // The trails' buffer is this much of the screen; blurred, it scales up cleanly.
  const TRAIL_SCALE = 0.25;
  const BRIGHT = { auto: 1, high: 1.3, low: 0.6 };

  let geo = null;
  // What is shown eases towards what the car shows: colour, brightness, bend
  // (-1 hard left to 1 hard right) and pace (0 standing to 1 motorway). phase
  // carries the pulses, so a new pace never makes them jump.
  let rgb = [255, 255, 255];
  let light = null;
  let glow = 1;
  let glowGoal = 1;
  let bend = 0;
  let target = 0;
  let pace = 0;
  let paceGoal = 0;
  let phase = 0;
  let painted = null;
  let trailsKey = null;
  let state = null;
  let lastState = 0;
  let lastFrame = 0;
  let options = { eta: true, speed: true, turns: true, pulses: true, bright: 'auto' };
  let source = null;
  let polling = null;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const rgba = (a, c = rgb) => `rgba(${c.map(Math.round).join(',')},${clamp(a * glow, 0, 1)})`;
  const whiter = (c, k) => c.map((v) => v + (255 - v) * k);

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

  // The speed as a pace: the square root keeps town speeds apart, the
  // motorway (120 km/h) reaches the top.
  function paceFor(kmh) {
    const v = Number.parseFloat(kmh);
    return Number.isFinite(v) && v > 0 ? Math.min(1, Math.sqrt(v / 120)) : 0;
  }

  // The brightness of the glow: the ambient lights' (0 to 100), more by day,
  // and the choice in the menu.
  function glowFor(v) {
    const level = typeof v.level === 'number' && v.level >= 0 ? v.level : 60;
    let f = 0.55 + 0.45 * (level / 100);
    if (v.day) f = Math.max(f, 0.95) * 1.15;
    return clamp(f * (BRIGHT[options.bright] || 1), 0.3, 1.5);
  }

  // Where the trails head: the turn the car drives, and a turn the navigation
  // announces within 300 m, as far as the car does not turn already.
  function targetFor(v) {
    const turning = bendFor(v.yaw);
    const t = v.turn && options.turns ? v.turn.side * v.turn.strength * v.turn.near : 0;
    return clamp(turning + t * (1 - Math.abs(turning)), -1, 1);
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
    painted = trailsKey = null;
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

  function paintBase(key) {
    const g = base.getContext('2d');
    const { w, h } = geo;
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = `rgb(${rgb.map((c) => Math.round(5 + c * 0.03 * Math.min(1, glow))).join(',')})`;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'lighter';
    glowAt(g, 1, 1);
    document.documentElement.style.setProperty('--light', `rgb(${rgb.map(Math.round).join(',')})`);
    painted = key;
  }

  // Each trail as a wide soft beam and a brighter core, in the small buffer;
  // the side the car signals to gets a whiter beam in the indicator's rhythm.
  function paintTrails(left, right, key) {
    const g = trails.getContext('2d');
    g.clearRect(0, 0, trails.width, trails.height);
    g.globalCompositeOperation = 'lighter';
    for (const side of [-1, 1]) {
      beam(g, side, 2.4, 0.34, geo.w * 0.02);
      beam(g, side, 0.45, 0.42, geo.w * 0.005);
      const blink = side < 0 ? left : right;
      if (blink > 0.01) beam(g, side, 1.1, 0.55 * blink, geo.w * 0.01, whiter(rgb, 0.45));
    }
    trailsKey = key;
  }

  function beam(g, side, spread, alpha, blur, color = rgb) {
    const s = TRAIL_SCALE;
    const far = trailPoint(side, 0);
    const near = trailPoint(side, 1);
    const grad = g.createLinearGradient(far.x * s, far.y * s, near.x * s, near.y * s);
    grad.addColorStop(0, rgba(0, color));
    grad.addColorStop(0.3, rgba(alpha * 0.2, color));
    grad.addColorStop(1, rgba(alpha, color));
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
    const fresh = (source && source.readyState === 1) || performance.now() - lastState < 3000;
    bend += ((fresh ? target : 0) - bend) * Math.min(1, dt / 0.7);
    // A pulse takes about 5 s from the horizon to the driver when standing and
    // 2 s on the motorway; the pace follows the speed over about 1.5 s.
    pace += ((fresh ? paceGoal : 0) - pace) * Math.min(1, dt / 1.5);
    phase = (phase + dt * (1 / 5 + (1 / 2 - 1 / 5) * pace)) % 1;
    // Colour and brightness fade over like the lights do.
    if (light && light.join() !== rgb.join()) {
      const k = Math.min(1, dt / 0.6);
      rgb = rgb.map((v, i) => (Math.abs(light[i] - v) < 1 ? light[i] : v + (light[i] - v) * k));
    }
    glow = Math.abs(glowGoal - glow) < 0.004 ? glowGoal : glow + (glowGoal - glow) * Math.min(1, dt / 0.8);
    const key = `${rgb.map(Math.round).join()}|${glow.toFixed(3)}`;
    if (key !== painted) paintBase(key);
    let left = 0;
    let right = 0;
    if (state && state.signal) {
      const period = state.blink || 700;
      const b = 0.5 - 0.5 * Math.cos((2 * Math.PI * (now % period)) / period);
      if (state.signal !== 'right') left = b;
      if (state.signal !== 'left') right = b;
    }
    const tkey = `${key}|${bend.toFixed(3)}|${left.toFixed(2)}|${right.toFixed(2)}`;
    if (tkey !== trailsKey) paintTrails(left, right, tkey);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(base, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(trails, 0, 0, geo.w, geo.h);
    glowAt(ctx, 1.05, 0.18 * (1 + Math.sin((s * Math.PI * 2) / 5)));
    if (options.pulses) {
      [-1, 1].forEach((side, k) => {
        for (let n = 0; n < 3; n++) pulse(side, ((phase + n / 3 + k / 6) % 1) ** 1.7);
      });
    }
    requestAnimationFrame(frame);
  }

  function render(v) {
    const arrival = options.eta && v.trip && v.eta;
    $('arrival').hidden = !arrival;
    $('eta').textContent = v.eta || '';
    const parts = [];
    if (v.min) parts.push(`noch ${v.min} min`);
    if (v.dist) parts.push(v.dist);
    $('rest').textContent = parts.join(' · ');
    const turnText = options.turns && v.turn ? v.turn.text : '';
    $('turn').hidden = !turnText;
    $('turn').textContent = turnText;
    $('center').hidden = !arrival && !turnText;
    const speed = options.speed && v.speed ? v.speed : '';
    $('speed').hidden = !speed;
    $('speedValue').textContent = speed;
    $('speedUnit').textContent = v.unit || '';
    const progress = options.eta && v.trip && typeof v.progress === 'number' && v.progress >= 0;
    $('progress').hidden = !progress;
    $('progressFill').style.width = `${Math.round((progress ? v.progress : 0) * 1000) / 10}%`;
  }

  function applyOptions(o) {
    options = { eta: !!o.eta, speed: !!o.speed, turns: !!o.turns, pulses: !!o.pulses, bright: o.bright in BRIGHT ? o.bright : 'auto' };
    if (state) {
      glowGoal = glowFor(state);
      target = targetFor(state);
      render(state);
    }
    if (!menu.hidden) renderMenu();
  }

  function show(v) {
    if (!v || typeof v !== 'object') return;
    state = v;
    lastState = performance.now();
    const c = parseColor(v.color);
    const first = c && !light;
    if (c) light = c;
    paceGoal = paceFor(v.kmh);
    // A choice still on its way to the service is not undone by an older view.
    applyOptions(v.options && !pending ? v.options : options);
    if (first) {
      // The first colour and brightness show at once, not as a fade.
      rgb = c;
      glow = glowGoal;
    }
  }

  // The data: a stream of views, and /state once a second while it is down.
  function connect() {
    if (typeof EventSource !== 'function') {
      startPolling();
      return;
    }
    source = new EventSource('events');
    source.onmessage = (e) => {
      try {
        show(JSON.parse(e.data));
      } catch {
        // A broken event waits for the next one.
      }
    };
    source.onopen = stopPolling;
    // EventSource reconnects by itself; until then /state fills in.
    source.onerror = startPolling;
  }

  function startPolling() {
    if (!polling) polling = setInterval(poll, 1000);
  }

  function stopPolling() {
    clearInterval(polling);
    polling = null;
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

  // The menu a long press opens. A choice takes effect at once and is kept by
  // the service; one it does not take goes back.
  let pending = 0;
  let swallowClick = false;

  function renderMenu() {
    for (const b of menu.querySelectorAll('[data-option]')) b.setAttribute('aria-pressed', String(!!options[b.dataset.option]));
    for (const b of menu.querySelectorAll('[data-bright]')) b.setAttribute('aria-pressed', String(options.bright === b.dataset.bright));
  }

  function openMenu() {
    swallowClick = true;
    menu.hidden = false;
    renderMenu();
  }

  async function choose(next) {
    const before = options;
    applyOptions(next);
    pending++;
    try {
      const res = await fetch('options', {
        method: 'POST',
        headers: { 'X-Quiet': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ eta: options.eta, speed: options.speed, turns: options.turns, pulses: options.pulses, bright: options.bright }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      applyOptions(before);
    } finally {
      pending--;
    }
  }

  menu.addEventListener('pointerdown', () => {
    swallowClick = false;
  });
  menu.addEventListener('click', (e) => {
    // The release of the long press that opened the menu is no choice.
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    const option = e.target.closest('[data-option]');
    const bright = e.target.closest('[data-bright]');
    if (option) choose({ ...options, [option.dataset.option]: !options[option.dataset.option] });
    else if (bright) choose({ ...options, bright: bright.dataset.bright });
    else if (e.target.closest('#done') || e.target === menu) menu.hidden = true;
  });

  // On the view itself: a firm swipe down closes the app, a long press opens
  // the menu, a short tap asks Chromium for full screen, in case QtCar gives a
  // full-screen page more of the display than the maximized window.
  let press = null;
  addEventListener('pointerdown', (e) => {
    if (!menu.hidden) return;
    const p = { x: e.clientX, y: e.clientY, at: performance.now(), long: false, moved: false };
    p.timer = setTimeout(() => {
      if (!p.moved) {
        p.long = true;
        openMenu();
      }
    }, 650);
    press = p;
  });
  addEventListener('pointermove', (e) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 15) press.moved = true;
  });
  addEventListener('pointerup', (e) => {
    const p = press;
    press = null;
    if (!p) return;
    clearTimeout(p.timer);
    if (p.long) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (dy > innerHeight * 0.22 && Math.abs(dx) < dy / 2) {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      askWindow('close');
      return;
    }
    if (!p.moved && performance.now() - p.at < 400 && !document.fullscreenElement && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  });
  addEventListener('pointercancel', () => {
    if (press) clearTimeout(press.timer);
    press = null;
  });

  addEventListener('resize', layout);
  layout();
  requestAnimationFrame(frame);
  askWindow('max');
  connect();
  poll();
  setTimeout(() => $('hint').classList.add('gone'), 6000);
})();
