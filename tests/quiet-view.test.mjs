import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The quiet view's page drives along a street, frame by frame on a clock of
// its own: the service's views ten times a second, a new fix once a second
// and a new pick of streets every 60 m, as the service makes them. A WebGL
// that only listens says in which frames the street ahead is lit (the third
// pass of the streets' program) and how far, and a canvas whether it was
// sized after a frame had drawn on it.
const app = fs.readFileSync('packages/quiet-view/web/app.js', 'utf8');

function gl(frame) {
  let id = 0;
  let used = null;
  const calls = {
    createShader: () => ({ id: ++id, text: '' }),
    shaderSource: (s, text) => { s.text = text; },
    getShaderParameter: () => true,
    createProgram: () => ({ id: ++id, texts: [], uniforms: {} }),
    attachShader: (p, s) => p.texts.push(s.text),
    getProgramParameter: () => true,
    getUniformLocation: (p, name) => ({ p, name }),
    useProgram: (p) => { used = p; },
    uniform1f: (at, v) => { if (at) at.p.uniforms[at.name] = v; },
    createBuffer: () => ({ id: ++id }),
    getExtension: (name) => (name === 'OES_standard_derivatives' ? {} : null),
    getParameter: () => '',
    drawArrays: (_mode, _first, count) => {
      frame.drawn = true;
      if (used && used.uniforms.uPass === 2 && used.texts.some((t) => t.includes('uniform float uPass'))) {
        // Six vertices a stretch of 2 m.
        frame.lit = (count / 6) * 2;
      }
    },
  };
  return new Proxy(calls, { get: (o, k) => (k in o ? o[k] : /^[A-Z0-9_]+$/.test(String(k)) ? 1 : () => {}) });
}

function element(frame) {
  const size = { width: 0, height: 0 };
  const sized = (key) => ({
    get: () => size[key],
    set: (v) => {
      size[key] = v;
      frame.sized++;
      if (frame.drawn) frame.late = true;
    },
  });
  return Object.defineProperties({
    hidden: true, textContent: '', dataset: {}, style: { setProperty() {} }, offsetWidth: 0,
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, addEventListener() {}, querySelectorAll: () => [], replaceWith() {},
    getContext: (type) => (type === 'webgl' ? gl(frame) : null),
  }, { width: sized('width'), height: sized('height') });
}

// A street north from the origin, as the service sends it (a tertiary road,
// both ways): lines of 150 m that share their ends, except at a tile's border
// (seam, metres north), where the next tile's line starts 0.2 m off.
function street(seam) {
  const rows = [];
  for (let y = -300; y < 2000; y += 150) {
    const start = y === seam ? 0.2 : 0;
    rows.push([4, 0, start, y, 0, y + 150]);
  }
  return rows;
}

async function drive({ rows, kmh, seconds, pickEvery, fps = 60 }) {
  let now = 0;
  const later = [];
  const frame = { lit: 0, sized: 0 };
  const els = new Map();
  let source = null;
  let draw = null;
  let bv = 1;
  let fix = null;
  const view = () => ({
    lang: 'de', color: '#8a3cff', level: 60, kmh, speed: String(kmh), unit: 'km/h', steer: 0, fsd: 'Standard',
    options: { eta: true, speed: true, turns: true, pulses: true, bright: 'auto', buildings: true, view: 'street' },
    pose: fix, bv,
  });
  const answer = (body) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) });
  const page = {
    document: {
      getElementById: (id) => els.get(id) || els.set(id, element(frame)).get(id),
      querySelectorAll: () => [],
      documentElement: element(frame),
    },
    addEventListener() {},
    requestAnimationFrame: (fn) => { draw = fn; },
    performance: { now: () => now },
    setTimeout: (fn, ms) => later.push({ at: now + ms, fn }),
    clearTimeout() {},
    setInterval() {},
    clearInterval() {},
    EventSource: class {
      constructor() {
        this.readyState = 1;
        source = this;
      }
    },
    // The service answers within 40 ms.
    fetch: (url) => new Promise((resolve) => {
      const body = url === 'buildings' ? { v: bv, o: 1, b: [], r: rows } : url === 'state' ? view() : {};
      later.push({ at: now + 40, fn: () => resolve(answer(body)) });
    }),
    innerWidth: 1920,
    innerHeight: 1200,
  };
  page.window = page;
  vm.runInContext(app, vm.createContext(page));
  const v = kmh / 3.6;
  const frames = [];
  let picked = 0;
  let fixes = 0;
  let views = 0;
  for (let i = 0; now < seconds * 1000; i++) {
    now = (i * 1000) / fps;
    const y = (v * now) / 1000;
    if (y - picked >= pickEvery) {
      picked = y;
      bv++;
    }
    if (now >= fixes * 1000) fix = { x: 0, y, h: 0, o: 1, n: ++fixes };
    if (now >= views * 100 && source && source.onmessage) {
      views++;
      source.onmessage({ data: JSON.stringify(view()) });
    }
    for (const t of later.filter((t) => !t.done && t.at <= now)) {
      t.done = true;
      t.fn();
    }
    for (let k = 0; k < 4; k++) await new Promise((r) => setImmediate(r));
    frame.lit = 0;
    frame.drawn = false;
    frame.late = false;
    const fn = draw;
    draw = null;
    if (fn) fn(now);
    frames.push({ t: now, y, lit: frame.lit, late: frame.late, sized: frame.sized });
  }
  // From 4 s on: the picture has woken and the light reaches its full length.
  return frames.filter((f) => f.t >= 4000);
}

test('the street ahead stays lit while new picks of streets come in', async () => {
  const frames = await drive({ rows: street(null), kmh: 100, seconds: 16, pickEvery: 60 });
  const dark = frames.filter((f) => !f.lit);
  assert.equal(dark.length, 0, `dark in ${dark.length} frames, the first at ${dark[0] && Math.round(dark[0].y)} m`);
});

test('the light runs on where a street leaves one tile for the next', async () => {
  // A seam 600 m north: the light ahead reaches past it all the way.
  const frames = await drive({ rows: street(600), kmh: 100, seconds: 24, pickEvery: 1e9 });
  const short = frames.filter((f) => f.lit < 390);
  assert.equal(short.length, 0, `under 390 m in ${short.length} frames, the first at ${short[0] && Math.round(short[0].y)} m`);
  assert.ok(frames.some((f) => f.y > 600), 'the drive passes the seam');
});

test('the canvas changes its resolution only before a frame draws on it', async () => {
  // At 33 frames a second the page lowers its resolution: a canvas sized after
  // the frame has drawn shows black until the next one.
  const frames = await drive({ rows: street(null), kmh: 50, seconds: 12, pickEvery: 1e9, fps: 33 });
  assert.ok(frames[frames.length - 1].sized > frames[0].sized, 'the resolution changed during the drive');
  const late = frames.filter((f) => f.late);
  assert.equal(late.length, 0, `sized after drawing in ${late.length} frames, the first at ${late[0] && Math.round(late[0].t)} ms`);
});
