// The quiet view: a glow in the ambient lights' colour over a dark screen and a
// road at night, its two lane lines fine filaments of light that run into the
// haze, with streaks of light flowing down them towards the driver at the pace
// of the car. The lines mark the path the car would drive at the steering
// wheel's angle; the line on the signalled side brightens with the indicator. The speedometer, the arrival, the next
// turn and the route's progress sit quietly on top; on arriving, the road ends
// in a ring of light with the drive's summary. A long press offers what to
// show. A WebGL shader draws the picture in true perspective, with a filmic
// roll-off and a little grain so the dark gradients do not band; on a slow GPU
// it draws fewer pixels, and without WebGL a plainer canvas picture stands in.
// The service streams what the car shows (events), and answers /state while
// the stream is down.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const menu = $('menu');
  const BRIGHT = { auto: 1, high: 1.3, low: 0.6 };

  // What is shown eases towards what the car shows: colour, brightness, the
  // path's curvature (1/m, right positive) and pace (0 standing to 1
  // motorway). travel is the distance the streaks have run, so a new pace
  // never makes them jump.
  let rgb = [255, 255, 255];
  let light = null;
  let glow = 1;
  let glowGoal = 1;
  let curv = 0;
  let target = 0;
  let pace = 0;
  let paceGoal = 0;
  let travel = 0;
  // 0 on the road, 1 arrived; it eases in over a few seconds.
  let arrive = 0;
  let arriveGoal = 0;
  let state = null;
  let lastState = 0;
  let lastFrame = 0;
  let options = { eta: true, speed: true, turns: true, pulses: true, bright: 'auto' };
  let source = null;
  let polling = null;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function parseColor(hex) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    return m ? [1, 2, 3].map((i) => parseInt(m[i], 16)) : null;
  }

  // The steering wheel's angle (right positive) as the curvature of the path
  // the car would drive, in 1/m: the road wheels turn about a tenth as far as
  // the steering wheel, on a 2.89 m wheelbase. 2° bends the path a little over
  // 60 m, 180° turns it on a radius of about 9 m. Under 0.3°, the sensor's
  // jitter, it stays straight.
  function steerCurvature(angle) {
    const a = Math.min(400, Math.max(0, Math.abs(angle) - 0.3));
    return (Math.sign(angle) * Math.tan((a / 10) * Math.PI / 180)) / 2.89;
  }

  // The speed as a pace: the square root keeps town speeds apart, the
  // motorway (120 km/h) reaches the top.
  function paceFor(kmh) {
    const v = Number.parseFloat(kmh);
    return Number.isFinite(v) && v > 0 ? Math.min(1, Math.sqrt(v / 120)) : 0;
  }

  // The brightness of the picture: the ambient lights' (0 to 100), more by
  // day, and the choice in the menu.
  function glowFor(v) {
    const level = typeof v.level === 'number' && v.level >= 0 ? v.level : 60;
    let f = 0.55 + 0.45 * (level / 100);
    if (v.day) f = Math.max(f, 0.95) * 1.15;
    return clamp(f * (BRIGHT[options.bright] || 1), 0.3, 1.5);
  }

  // Where the path heads: the steering wheel alone. Without its angle (in Park
  // it can be invalid) the path straightens.
  function targetFor(v) {
    return typeof v.steer === 'number' ? steerCurvature(v.steer) : 0;
  }

  // ---- The picture ----

  // A camera 1.25 m above the middle of a 3.5 m lane, the horizon at 58 % of
  // the height; a pixel below the horizon sees the ground z metres ahead. The
  // lines mark the path the car would drive, like a backup camera's guides: a
  // circle through the car for the steering's curvature, its lines circles
  // 1.75 m inside and outside, so the lane keeps its width round the bend. The
  // path shows for about 60 m and no further than it turns back. Streaks of
  // light 24 m apart run down it. Line widths come from screen derivatives
  // where the GPU has them, so a line keeps its width whichever way it runs.
  const FRAGMENT = `
#ifdef GL_OES_standard_derivatives
#extension GL_OES_standard_derivatives : enable
#endif
precision highp float;
uniform vec2 uRes;
uniform vec3 uColor;
uniform float uGlow;
uniform float uCurv;
uniform float uTravel;
uniform float uStreaks;
uniform vec2 uBlink;
uniform float uBreath;
uniform float uSeed;
uniform float uArrive;
uniform float uTime;

float grain(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}

// Metres per pixel of a ground coordinate.
float perPixel(float v, float fallback) {
#ifdef GL_OES_standard_derivatives
  return max(fwidth(v), 1e-5);
#else
  return fallback;
#endif
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  float w = uRes.x;
  float h = uRes.y;
  vec3 col = uColor * 0.012;
  vec2 g = (px - vec2(0.5 * w, 0.30 * h)) / vec2(0.62 * w, 0.30 * h);
  col += uColor * exp(-dot(g, g) * 1.8) * (0.40 + 0.07 * uBreath + 0.10 * uArrive);
  float yH = 0.58 * h;
  float by = (px.y - yH) / (0.010 * h);
  float bx = (px.x - 0.5 * w) / (0.32 * w);
  col += uColor * exp(-by * by) * exp(-bx * bx) * 0.12;
  float dy = px.y - yH;
  float f = 0.78 * w;
  float z = f * 1.25 / max(dy, 0.25);
  float mpp = z / f;
  float x = (px.x - 0.5 * w) * mpp;
  // Where the pixel lies against the path: metres to its right, metres along it.
  float lateral = x;
  float along = z;
  float turn = 1.0;
  if (abs(uCurv) > 1e-4) {
    float r = 1.0 / abs(uCurv);
    float xs = x * sign(uCurv);
    float th = atan(z, r - xs);
    lateral = (r - length(vec2(xs - r, z))) * sign(uCurv);
    along = r * th;
    turn = 1.0 - smoothstep(2.0, 2.5, th);
  }
  float m = perPixel(lateral, mpp);
  float ma = perPixel(along, mpp);
  if (dy > 0.0) {
    float fog = exp(-z / 70.0);
    float path = (1.0 - smoothstep(45.0, 75.0, along)) * turn;
    float wpx = 0.04 / m;
    float coreW = max(1.1, wpx);
    // On arrival the path ends 26 m ahead, in a ring of light.
    float aEnd = mix(600.0, 26.0, uArrive);
    float ends = 1.0 - uArrive * smoothstep(aEnd - 8.0, aEnd + 1.0, along);
    for (int i = 0; i < 2; i++) {
      float side = i == 0 ? -1.0 : 1.0;
      float d = abs(lateral - side * 1.75) / m;
      float core = exp(-d * d / (coreW * coreW)) * min(1.0, wpx / 1.1 + 0.2);
      float s = fract((along + uTravel) / 24.0);
      float streak = uStreaks * (1.0 - uArrive) * smoothstep(0.0, 0.03, s) * pow(1.0 - smoothstep(0.03, 0.42, s), 1.5);
      float blink = i == 0 ? uBlink.x : uBlink.y;
      float gain = (1.0 + 1.5 * blink) * fog * ends * path;
      vec3 hot = mix(uColor, vec3(1.0), 0.55 + 0.25 * blink);
      // The streak lights the line and its near halo; the wide halo stays
      // even, or the streak's edge would draw a line across the screen.
      col += hot * core * (0.34 + 1.3 * streak) * gain;
      col += uColor * exp(-d / (0.008 * w)) * 0.30 * (0.34 + 0.9 * streak) * gain;
      col += uColor * exp(-d / (0.045 * w)) * 0.034 * gain;
    }
    if (uArrive > 0.0) {
      // The ring lies on the path, breathing slowly; a wave of light leaves it
      // every 3.2 s, and a pool of light fills it.
      vec2 pos = vec2(lateral, along - aEnd);
      float len = length(pos);
      float fw = max(max(m, ma), 0.02);
      float r = 2.8 + 0.12 * sin(uTime * 1.4);
      float e = abs(len - r);
      float ew = e / max(0.07, fw);
      float ring = exp(-ew * ew) * min(1.0, 0.07 / fw + 0.35);
      float halo = exp(-e / (fw * 14.0)) * 0.22;
      float phase = fract(uTime / 3.2);
      float wv = (len - r - phase * 7.0) / max(0.12, 1.5 * fw);
      float wave = exp(-wv * wv) * (1.0 - phase) * (1.0 - phase) * 0.5;
      float pr = len / r;
      float pool = exp(-pr * pr * 1.4) * 0.10;
      vec3 hot = mix(uColor, vec3(1.0), 0.6);
      // The haze at the pixel's own distance, and nothing far beyond the ring.
      float near = fog * (1.0 - smoothstep(aEnd + 6.0, aEnd + 30.0, along));
      col += (hot * ring + uColor * (halo + wave + pool)) * uArrive * near;
    }
  }
  vec2 q = px / uRes - 0.5;
  col *= 1.0 - 0.35 * smoothstep(0.35, 0.85, length(q * vec2(1.25, 1.0)));
  col = 1.0 - exp(-col * 1.6 * uGlow);
  col += (grain(px + uSeed) - 0.5) / 170.0;
  gl_FragColor = vec4(col, 1.0);
}`;

  function webglPicture(canvas) {
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: false, powerPreference: 'low-power' });
    if (!gl) return null;
    // Screen derivatives keep the lines' width; the shader does without them.
    gl.getExtension('OES_standard_derivatives');
    const shader = (type, text) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, text);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = shader(gl.VERTEX_SHADER, 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }');
    const fs = shader(gl.FRAGMENT_SHADER, FRAGMENT);
    if (!vs || !fs) return null;
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const at = gl.getAttribLocation(program, 'p');
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
    const u = {};
    for (const name of ['uRes', 'uColor', 'uGlow', 'uCurv', 'uTravel', 'uStreaks', 'uBlink', 'uBreath', 'uSeed', 'uArrive', 'uTime']) {
      u[name] = gl.getUniformLocation(program, name);
    }
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    return {
      // A renderer in software draws fewer pixels from the start.
      soft: /swiftshader|llvmpipe|software/i.test(name),
      resize(width, height) {
        gl.viewport(0, 0, width, height);
      },
      draw(p) {
        gl.uniform2f(u.uRes, canvas.width, canvas.height);
        gl.uniform3f(u.uColor, p.rgb[0] / 255, p.rgb[1] / 255, p.rgb[2] / 255);
        gl.uniform1f(u.uGlow, p.glow);
        gl.uniform1f(u.uCurv, p.curv);
        gl.uniform1f(u.uTravel, p.travel % 2400);
        gl.uniform1f(u.uStreaks, p.streaks ? 1 : 0);
        gl.uniform2f(u.uBlink, p.left, p.right);
        gl.uniform1f(u.uBreath, p.breath);
        gl.uniform1f(u.uSeed, (p.time * 37) % 101);
        gl.uniform1f(u.uArrive, p.arrive);
        gl.uniform1f(u.uTime, p.time % 3600);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
    };
  }

  // Without WebGL: the same scene in screen space, two soft beams for the lines.
  function canvasPicture(canvas) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const rgba = (p, a, c = p.rgb) => `rgba(${c.map(Math.round).join(',')},${clamp(a * p.glow, 0, 1)})`;
    const point = (p, side, t) => {
      const bend = clamp(p.curv * 75, -1, 1);
      const w = canvas.width;
      const h = canvas.height;
      return { x: w / 2 + side * (0.03 * w + 0.45 * w * t) + bend * 0.3 * w * (1 - t) ** 2, y: h * 0.58 + h * 0.42 * t,
        width: 0.006 * w + 0.05 * w * t };
    };
    return {
      soft: true,
      resize() {},
      draw(p) {
        const w = canvas.width;
        const h = canvas.height;
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = `rgb(${p.rgb.map((c) => Math.round(4 + c * 0.012)).join(',')})`;
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'lighter';
        const sky = ctx.createRadialGradient(w / 2, h * 0.3, 0, w / 2, h * 0.3, Math.max(w, h) * 0.4);
        sky.addColorStop(0, rgba(p, 0.42 + 0.06 * p.breath));
        sky.addColorStop(1, rgba(p, 0));
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, w, h);
        for (const side of [-1, 1]) {
          const blink = side < 0 ? p.left : p.right;
          const far = point(p, side, 0);
          const near = point(p, side, 1);
          const grad = ctx.createLinearGradient(far.x, far.y, near.x, near.y);
          grad.addColorStop(0, rgba(p, 0));
          grad.addColorStop(1, rgba(p, 0.5 * (1 + blink)));
          ctx.fillStyle = grad;
          ctx.beginPath();
          for (let i = 0; i <= 24; i++) {
            const pt = point(p, side, i / 24);
            ctx.lineTo(pt.x - pt.width / 2, pt.y);
          }
          for (let i = 24; i >= 0; i--) {
            const pt = point(p, side, i / 24);
            ctx.lineTo(pt.x + pt.width / 2, pt.y);
          }
          ctx.fill();
        }
        if (p.arrive > 0.01) {
          ctx.strokeStyle = rgba(p, 0.7 * p.arrive, p.rgb.map((c) => c + (255 - c) * 0.6));
          ctx.lineWidth = Math.max(1, w * 0.002);
          ctx.beginPath();
          ctx.ellipse(w / 2, h * 0.66, w * 0.09, h * 0.022, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      },
    };
  }

  let canvas = $('glow');
  let picture = webglPicture(canvas) || canvasPicture(canvas);
  canvas.addEventListener('webglcontextlost', (e) => {
    // The GPU went away: a fresh canvas with the plainer picture.
    e.preventDefault();
    const fresh = document.createElement('canvas');
    fresh.id = 'glow';
    canvas.replaceWith(fresh);
    canvas = fresh;
    picture = canvasPicture(canvas);
    layout();
  });

  // The share of the device's pixels drawn: lower on a renderer in software,
  // and lower again while frames take longer than about 26 ms.
  let quality = picture.soft ? 0.5 : 1;
  let measured = 0;
  let measureStart = 0;

  function layout() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.max(1, Math.round(innerWidth * dpr * quality));
    canvas.height = Math.max(1, Math.round(innerHeight * dpr * quality));
    picture.resize(canvas.width, canvas.height);
  }

  function frame(now) {
    const s = now / 1000;
    const dt = lastFrame ? Math.min(0.1, s - lastFrame) : 0;
    lastFrame = s;
    // Without fresh state the road straightens and the streaks slow down.
    const fresh = (source && source.readyState === 1) || performance.now() - lastState < 3000;
    // The steering angle comes 30 times a second, and the path follows it
    // exactly; the easing only bridges the frames between two readings. Without
    // the angle the path straightens slowly.
    const steering = state && typeof state.steer === 'number';
    curv += ((fresh ? target : 0) - curv) * Math.min(1, dt / (steering ? 0.03 : 0.6));
    // A streak takes about 6 s from the horizon to the driver when standing
    // and 2 s on the motorway; the pace follows the speed over about 1.5 s.
    pace += ((fresh ? paceGoal : 0) - pace) * Math.min(1, dt / 1.5);
    travel += dt * (4 + 9 * pace);
    arrive += (arriveGoal - arrive) * Math.min(1, dt / 2.2);
    // Colour and brightness fade over like the lights do.
    if (light && light.join() !== rgb.join()) {
      const k = Math.min(1, dt / 0.6);
      rgb = rgb.map((v, i) => (Math.abs(light[i] - v) < 1 ? light[i] : v + (light[i] - v) * k));
      document.documentElement.style.setProperty('--light', `rgb(${rgb.map(Math.round).join(',')})`);
    }
    glow = Math.abs(glowGoal - glow) < 0.004 ? glowGoal : glow + (glowGoal - glow) * Math.min(1, dt / 0.8);
    let left = 0;
    let right = 0;
    if (state && state.signal) {
      const period = state.blink || 700;
      const b = 0.5 - 0.5 * Math.cos((2 * Math.PI * (now % period)) / period);
      if (state.signal !== 'right') left = b;
      if (state.signal !== 'left') right = b;
    }
    picture.draw({ rgb, glow, curv, travel, streaks: options.pulses, left, right, arrive,
      breath: 0.5 + 0.5 * Math.sin((s * Math.PI * 2) / 5), time: s });
    if (++measured === 90) {
      if ((now - measureStart) / measured > 26 && quality > 0.35) {
        quality = Math.max(0.35, quality * 0.75);
        layout();
      }
      measured = 0;
      measureStart = now;
    }
    requestAnimationFrame(frame);
  }

  function render(v) {
    // Arrived: the drive's summary instead of arrival, turn and progress.
    const done = v.arrived && typeof v.arrived === 'object' ? v.arrived : null;
    const block = $('arrivedBlock');
    if (done && block.hidden) {
      // The summary rises in each time it appears.
      block.classList.remove('rise');
      void block.offsetWidth;
      block.classList.add('rise');
    }
    block.hidden = !done;
    if (done) {
      const what = done.dist && done.min ? `${done.dist} in ${done.min} min` : done.min ? `${done.min} min` : '';
      $('arrivedSum').textContent = [what, done.time].filter(Boolean).join(' · ');
    }
    const arrival = !done && options.eta && v.trip && v.eta;
    $('arrival').hidden = !arrival;
    $('eta').textContent = v.eta || '';
    const parts = [];
    if (v.min) parts.push(`noch ${v.min} min`);
    if (v.dist) parts.push(v.dist);
    $('rest').textContent = parts.join(' · ');
    const turnText = !done && options.turns && v.turn ? v.turn.text : '';
    $('turn').hidden = !turnText;
    $('turn').textContent = turnText;
    $('center').hidden = !done && !arrival && !turnText;
    const speed = options.speed && v.speed ? v.speed : '';
    $('speed').hidden = !speed;
    $('speedValue').textContent = speed;
    $('speedUnit').textContent = v.unit || '';
    const progress = !done && options.eta && v.trip && typeof v.progress === 'number' && v.progress >= 0;
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
    arriveGoal = v.arrived ? 1 : 0;
    // A choice still on its way to the service is not undone by an older view.
    applyOptions(v.options && !pending ? v.options : options);
    if (first) {
      // The first colour and brightness show at once, not as a fade.
      rgb = c;
      glow = glowGoal;
      document.documentElement.style.setProperty('--light', `rgb(${rgb.join(',')})`);
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
