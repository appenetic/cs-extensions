// The quiet view: a glow in the ambient lights' colour over a dark screen and a
// road at night, its two lane lines fine filaments of light that run into the
// haze, with streaks of light flowing down them towards the driver at the pace
// of the car. The road curves the way the car turns; the line on the signalled
// side brightens with the indicator. The speedometer, the arrival, the next
// turn and the route's progress sit quietly on top; a long press offers what to
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

  // What is shown eases towards what the car shows: colour, brightness, bend
  // (-1 hard left to 1 hard right) and pace (0 standing to 1 motorway). travel
  // is the distance the streaks have run, so a new pace never makes them jump.
  let rgb = [255, 255, 255];
  let light = null;
  let glow = 1;
  let glowGoal = 1;
  let bend = 0;
  let target = 0;
  let pace = 0;
  let paceGoal = 0;
  let travel = 0;
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

  // The brightness of the picture: the ambient lights' (0 to 100), more by
  // day, and the choice in the menu.
  function glowFor(v) {
    const level = typeof v.level === 'number' && v.level >= 0 ? v.level : 60;
    let f = 0.55 + 0.45 * (level / 100);
    if (v.day) f = Math.max(f, 0.95) * 1.15;
    return clamp(f * (BRIGHT[options.bright] || 1), 0.3, 1.5);
  }

  // Where the road heads: the turn the car drives, and a turn the navigation
  // announces with its side within 300 m, as far as the car does not turn yet.
  function targetFor(v) {
    const turning = bendFor(v.yaw);
    const t = v.turn && options.turns ? v.turn.side * v.turn.strength * v.turn.near : 0;
    return clamp(turning + t * (1 - Math.abs(turning)), -1, 1);
  }

  // ---- The picture ----

  // A camera 1.25 m above the middle of a 3.5 m lane, the horizon at 58 % of
  // the height. A pixel below the horizon sees the road z metres ahead; the
  // lane's lines run at 1.75 m either side of a centre that curves as
  // bend / 75 m. Streaks of light 24 m apart run down the lines.
  const FRAGMENT = `
precision highp float;
uniform vec2 uRes;
uniform vec3 uColor;
uniform float uGlow;
uniform float uBend;
uniform float uTravel;
uniform float uStreaks;
uniform vec2 uBlink;
uniform float uBreath;
uniform float uSeed;

float grain(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  float w = uRes.x;
  float h = uRes.y;
  vec3 col = uColor * 0.012;
  vec2 g = (px - vec2(0.5 * w, 0.30 * h)) / vec2(0.62 * w, 0.30 * h);
  col += uColor * exp(-dot(g, g) * 1.8) * (0.40 + 0.07 * uBreath);
  float yH = 0.58 * h;
  float band = exp(-pow((px.y - yH) / (0.010 * h), 2.0)) * exp(-pow((px.x - 0.5 * w) / (0.32 * w), 2.0));
  col += uColor * band * 0.12;
  float dy = px.y - yH;
  if (dy > 0.0) {
    float f = 0.78 * w;
    float z = f * 1.25 / max(dy, 0.25);
    float mpp = z / f;
    float x = (px.x - 0.5 * w) * mpp;
    float centre = 0.5 * (uBend / 75.0) * z * z;
    float fog = exp(-z / 70.0);
    float wpx = 0.04 / mpp;
    float coreW = max(1.1, wpx);
    for (int i = 0; i < 2; i++) {
      float side = i == 0 ? -1.0 : 1.0;
      float d = abs(x - centre - side * 1.75) / mpp;
      float core = exp(-d * d / (coreW * coreW)) * min(1.0, wpx / 1.1 + 0.2);
      float s = fract((z + uTravel) / 24.0);
      float streak = uStreaks * smoothstep(0.0, 0.03, s) * pow(1.0 - smoothstep(0.03, 0.42, s), 1.5);
      float blink = i == 0 ? uBlink.x : uBlink.y;
      float gain = (1.0 + 1.5 * blink) * fog;
      vec3 hot = mix(uColor, vec3(1.0), 0.55 + 0.25 * blink);
      // The streak lights the line and its near halo; the wide halo stays
      // even, or the streak's edge would draw a line across the screen.
      col += hot * core * (0.34 + 1.3 * streak) * gain;
      col += uColor * exp(-d / (0.008 * w)) * 0.30 * (0.34 + 0.9 * streak) * gain;
      col += uColor * exp(-d / (0.045 * w)) * 0.034 * gain;
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
    for (const name of ['uRes', 'uColor', 'uGlow', 'uBend', 'uTravel', 'uStreaks', 'uBlink', 'uBreath', 'uSeed']) {
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
        gl.uniform1f(u.uBend, p.bend);
        gl.uniform1f(u.uTravel, p.travel % 2400);
        gl.uniform1f(u.uStreaks, p.streaks ? 1 : 0);
        gl.uniform2f(u.uBlink, p.left, p.right);
        gl.uniform1f(u.uBreath, p.breath);
        gl.uniform1f(u.uSeed, (p.time * 37) % 101);
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
      const w = canvas.width;
      const h = canvas.height;
      return { x: w / 2 + side * (0.03 * w + 0.45 * w * t) + p.bend * 0.3 * w * (1 - t) ** 2, y: h * 0.58 + h * 0.42 * t,
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
    bend += ((fresh ? target : 0) - bend) * Math.min(1, dt / 0.7);
    // A streak takes about 6 s from the horizon to the driver when standing
    // and 2 s on the motorway; the pace follows the speed over about 1.5 s.
    pace += ((fresh ? paceGoal : 0) - pace) * Math.min(1, dt / 1.5);
    travel += dt * (4 + 9 * pace);
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
    picture.draw({ rgb, glow, bend, travel, streaks: options.pulses, left, right,
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
