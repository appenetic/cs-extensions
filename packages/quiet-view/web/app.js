// The quiet view: the streets around the car from the map, the car's own
// street lit ahead of it in the ambient lights' colour, the way it goes on,
// and the buildings around it with their real heights, under a glow in that
// colour. Long, faint waves of light run down the street ahead at the car's
// pace; on the side the car signals to it brightens with the blinker. The
// speedometer with the next turn's arrow beside it, the Self-Driving profile
// under it, and the arrival with the route's progress under it, sit quietly on
// top and fade as they come and go; on arriving, a ring of light lies on the
// street ahead with the drive's summary. The picture wakes from black when the
// page opens; a new colour fades over the whole picture. A long press offers
// what to show and how high the eye looks over the street. WebGL draws the
// picture in true perspective, with a filmic roll-off and a little grain so
// the dark gradients do not band; on a slow GPU it draws fewer pixels, and
// without WebGL a plainer canvas picture stands in. The service streams what
// the car shows (events), and answers /state while the stream is down.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const menu = $('menu');
  const BRIGHT = { auto: 1, high: 1.3, low: 0.6 };
  // The eye's height over the street for each choice, in metres.
  const VIEWS = { street: 1.6, raised: 4, high: 9 };

  // The light's colour as shown (rgb), the car's (light), and a fade from the
  // one shown when the car's changes (fadeFrom, fade from 0 to 1).
  let rgb = [255, 255, 255];
  let light = null;
  let fadeFrom = rgb;
  let fade = 1;
  let painted = '';
  let glow = 1;
  let glowGoal = 1;
  // The streaks' pace (m/s) follows the speed; travel is the distance they
  // have run, so a new pace never makes them jump.
  let pace = 0;
  let paceGoal = 0;
  let travel = 0;
  // 0 on the road, 1 arrived; it eases in over a few seconds.
  let arrive = 0;
  let arriveGoal = 0;
  // Seconds since the first data: the picture wakes from black over 1.6 s and
  // the street ahead lights up from the car outwards.
  let awake = 0;
  // The eye's height; it moves over to a new choice.
  let eye = VIEWS.street;
  // How much of Mad Max's chevrons shows, and how far they have run.
  let mad = 0;
  let rush = 0;
  let state = null;
  let lastState = 0;
  let lastFrame = 0;
  let options = { eta: true, speed: true, turns: true, pulses: true, bright: 'auto', buildings: true, view: 'street' };
  let source = null;
  let polling = null;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const smooth = (a, b, v) => {
    const t = clamp((v - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };

  function parseColor(hex) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    return m ? [1, 2, 3].map((i) => parseInt(m[i], 16)) : null;
  }

  // The curvature of the path the car would drive at the steering wheel's
  // angle (right positive), in 1/m: the road wheels turn about a tenth as far
  // as the steering wheel, on a 2.89 m wheelbase. Under 0.3°, the sensor's
  // jitter, it stays straight.
  function steerCurvature(angle) {
    const a = Math.min(400, Math.max(0, Math.abs(angle) - 0.3));
    return (Math.sign(angle) * Math.tan((a / 10) * Math.PI / 180)) / 2.89;
  }

  // The streaks' pace in m/s: as fast as the road when slow (1.3 m/s at
  // 5 km/h), held back towards 13 m/s above, so the motorway stays calm
  // (8.5 m/s at 50 km/h, 12 m/s at 120 km/h). Standing, they stand.
  function paceFor(kmh) {
    const v = Number.parseFloat(kmh);
    return Number.isFinite(v) && v > 0 ? 13 * (1 - Math.exp(-v / 3.6 / 13)) : 0;
  }

  // The brightness of the picture: the ambient lights' (0 to 100), more by
  // day, and the choice in the menu.
  function glowFor(v) {
    const level = typeof v.level === 'number' && v.level >= 0 ? v.level : 60;
    let f = 0.55 + 0.45 * (level / 100);
    if (v.day) f = Math.max(f, 0.95) * 1.15;
    return clamp(f * (BRIGHT[options.bright] || 1), 0.3, 1.5);
  }

  // A colour fades over through OKLab, so the colours on the way stay clean
  // instead of turning muddy as plain red, green and blue would.
  const linear = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const encoded = (c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  function toLab(rgbIn) {
    const [r, g, b] = rgbIn.map(linear);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  }
  function fromLab([L, a, b]) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map((c) => clamp(encoded(Math.max(0, c)), 0, 255));
  }
  function blend(a, b, t) {
    const A = toLab(a);
    const B = toLab(b);
    return fromLab(A.map((v, i) => v + (B[i] - v) * t));
  }

  // ---- The picture ----

  // The sky, as every part of the picture sees it before the roll-off: dark,
  // the light's colour glowing above the horizon behind the arrival, and a
  // band of haze along the horizon where the city meets it. What lies far off
  // fades into the sky behind it, or below the horizon into the haze along
  // it, so the city melts into the light instead of into black. Every part
  // ends in the same vignette and filmic roll-off. Pixels count from the top.
  // C is the light's colour; the page fades it over to a new one.
  const SKY = `
uniform vec2 uRes;
uniform vec3 uColor;
uniform float uGlow;
uniform float uBreath;
uniform float uArrive;
vec3 skyAt(vec2 px, vec3 C) {
  vec3 col = C * 0.014 + vec3(0.006, 0.007, 0.009);
  vec2 g = (px - vec2(0.5 * uRes.x, 0.34 * uRes.y)) / vec2(0.64 * uRes.x, 0.30 * uRes.y);
  col += C * exp(-dot(g, g) * 1.8) * (0.20 + 0.04 * uBreath + 0.10 * uArrive);
  float band = (px.y - 0.58 * uRes.y) / (0.018 * uRes.y);
  col += (C * 0.07 + vec3(0.02, 0.022, 0.026)) * exp(-band * band);
  return col;
}
vec3 hazed(vec3 col, vec2 px, vec3 C, float d, float reach) {
  return mix(col, skyAt(vec2(px.x, min(px.y, 0.58 * uRes.y)), C), 1.0 - exp(-d / reach));
}
vec3 finish(vec3 col, vec2 px) {
  vec2 q = px / uRes - 0.5;
  col *= 1.0 - 0.35 * smoothstep(0.35, 0.85, length(q * vec2(1.25, 1.0)));
  return 1.0 - exp(-col * 1.6 * uGlow);
}`;

  // A camera uEye metres above the middle of the street, looking along it, the
  // horizon at 58 % of the height and the focal length 0.78 of the width. A
  // point on the ground or a wall, metres east and north in the service's
  // frame and up, lands on the screen; depth runs from 1 m to 3 km.
  const CAMERA = `
uniform vec2 uCam;
uniform vec2 uDir;
uniform vec4 uView;
uniform float uEye;
vec4 project(vec3 p) {
  vec2 d = p.xy - uCam;
  float ahead = dot(d, uDir);
  float right = d.x * uDir.y - d.y * uDir.x;
  return vec4(right * 2.0 * uView.x / uView.y,
    (1.0 - 2.0 * uView.w / uView.z) * ahead + (p.z - uEye) * 2.0 * uView.x / uView.z,
    ahead * 3001.0 / 2999.0 - 6000.0 / 2999.0, ahead);
}`;

  // The sky and the bare ground under the streets, a little lighter towards the
  // horizon where it meets the haze. On arrival a ring of light lies on the
  // street ahead, breathing slowly, a wave of light leaving it every 3.2 s and
  // a pool of light filling it; it is drawn again over the streets (uRing).
  const GROUND = `
#ifdef GL_OES_standard_derivatives
#extension GL_OES_standard_derivatives : enable
#endif
precision highp float;
` + SKY + `
uniform float uEye;
uniform float uSeed;
uniform float uTime;
// How far ahead the ring lies, in metres; above 0 only the ring is drawn.
uniform float uRing;
float grain(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}
void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec3 C = uColor;
  float dy = px.y - 0.58 * uRes.y;
  float f = 0.78 * uRes.x;
  float z = f * uEye / max(dy, 0.25);
  if (uRing > 0.0) {
    if (dy <= 0.0) discard;
    vec2 pos = vec2((px.x - 0.5 * uRes.x) * z / f, z - uRing);
    float len = length(pos);
#ifdef GL_OES_standard_derivatives
    float fw = max(fwidth(len), 0.02);
#else
    float fw = max(z / f, 0.02);
#endif
    float r = 2.8 + 0.12 * sin(uTime * 1.4);
    float e = abs(len - r);
    float ew = e / max(0.07, fw);
    float ring = exp(-ew * ew) * min(1.0, 0.07 / fw + 0.35);
    float halo = exp(-e / (fw * 14.0)) * exp(-e * e / 18.0) * 0.22;
    float phase = fract(uTime / 3.2);
    float front = len - r - phase * 7.0;
    float wv = front / max(0.12, 1.5 * fw);
    float wave = exp(-wv * wv) * exp(-front * front / 2.0) * (1.0 - phase) * (1.0 - phase) * 0.5;
    float pr = len / r;
    float pool = exp(-pr * pr * 1.4) * 0.10;
    vec3 lit = (mix(C, vec3(1.0), 0.6) * ring + C * (halo + wave + pool)) * uArrive * exp(-z / 160.0);
    gl_FragColor = vec4(finish(lit, px), 0.0);
    return;
  }
  vec3 col = skyAt(px, C);
  if (dy > 0.0) col = hazed(C * 0.006 + vec3(0.007, 0.008, 0.010), px, C, z, 260.0);
  col = finish(col, px);
  col += (grain(px + uSeed) - 0.5) / 170.0;
  gl_FragColor = vec4(col, 1.0);
}`;

  // The streets from the map, flat on the ground: each a strip as wide as its
  // kind, its edges fine lines of the light, a pixel and a half wide however
  // far off (uLinePx), drawn first for all of them and covered by the
  // streets themselves after, so where streets meet their lines merge into
  // one outline. Then the route ahead lights up, the street the car drives on
  // and where it goes on: lit all through and evenly across its width, its
  // edges soft, a fine line along them; long, faint waves of light run down
  // it towards the car at its pace; on the side the car signals to it
  // brightens with the blinker. In Mad Max (uMad) soft chevrons of light glide
  // up it ahead of the car, a little faster than it drives (uRush, metres
  // they have run). Right before the car it is lit a little less,
  // so its course ahead shows more than the ground under the camera; it fades
  // out towards uReach metres and into the haze. aPos is a
  // corner's middle and the way out to the street's edge, aInfo the metres to
  // its edge, the metres along, its rank (0 for a main road, 1 for a service
  // road) and its side (-1 left, 1 right).
  const ROAD_VERTEX = CAMERA + `
attribute vec4 aPos;
attribute vec4 aInfo;
uniform float uLinePx;
varying float vSide;
varying float vEdge;
varying float vAhead;
varying float vRank;
varying float vAlong;
void main() {
  float ahead = dot(aPos.xy - uCam, uDir);
  float line = uLinePx * max(ahead, 1.0) / uView.x;
  vec2 p = aPos.xy + aPos.zw * (aInfo.x + line);
  gl_Position = project(vec3(p, 0.0));
  vEdge = (aInfo.x + line) / aInfo.x;
  vSide = aInfo.w * vEdge;
  vAhead = ahead;
  vRank = aInfo.z;
  vAlong = aInfo.y;
}`;

  const ROAD_FRAGMENT = `
#ifdef GL_OES_standard_derivatives
#extension GL_OES_standard_derivatives : enable
#endif
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
` + SKY + `
// 0 the edges, 1 the streets, 2 the street ahead.
uniform float uPass;
uniform float uTravel;
uniform float uStreaks;
uniform vec2 uBlink;
uniform float uReach;
uniform float uMad;
uniform float uRush;
varying float vSide;
varying float vEdge;
varying float vAhead;
varying float vRank;
varying float vAlong;
void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec3 C = uColor;
  float s = abs(vSide);
#ifdef GL_OES_standard_derivatives
  float aa = max(fwidth(vSide), 1e-4);
#else
  float aa = 0.04;
#endif
  float d = max(vAhead, 0.0);
  if (uPass < 0.5) {
    vec3 col = hazed(mix(C, vec3(1.0), 0.15) * mix(0.45, 0.14, vRank) + vec3(0.02), px, C, d, 300.0);
    gl_FragColor = vec4(finish(col, px), 1.0) * clamp((vEdge - s) / aa, 0.0, 1.0);
    return;
  }
  float inside = clamp((1.0 - s) / aa + 0.5, 0.0, 1.0);
  if (uPass < 1.5) {
    vec3 col = hazed(C * 0.012 + vec3(0.040, 0.042, 0.048) * mix(1.0, 0.8, vRank), px, C, d, 320.0);
    gl_FragColor = vec4(finish(col, px), 1.0) * inside;
    return;
  }
  float px1 = (1.0 - s) / aa;
  float line = exp(-px1 * px1 / 1.2);
  float body = smoothstep(1.0, 0.78, s);
  float wave = 0.5 + 0.5 * cos(6.2831853 * fract((vAlong + uTravel) / 36.0));
  float flow = mix(1.0, 0.82 + 0.3 * wave, uStreaks);
  float blink = (vSide < 0.0 ? uBlink.x : uBlink.y) * smoothstep(0.2, 1.0, s);
  vec3 lit = C * (0.17 * body * flow + 0.08 * line + 0.22 * blink * body);
  if (uMad > 0.001) {
    // A chevron every 20 m, its tip ahead in the middle of the street: a
    // crisp leading edge and a soft tail behind it, about 1.6 m deep.
    float run = (vAlong - uRush) / 20.0 + 0.22 * s;
    float ph = fract(run);
#ifdef GL_OES_standard_derivatives
    // From the value before it wraps, or the wrap itself would draw a seam.
    float pw = max(fwidth(run), 1e-4);
#else
    float pw = 0.01;
#endif
    float band = smoothstep(0.0, 0.08, ph) * (1.0 - smoothstep(0.08, 0.08 + 1.5 * pw, ph));
    lit += mix(C, vec3(1.0), 0.25) * band * 0.3 * uMad * smoothstep(0.92, 0.7, s)
      * (1.0 - smoothstep(20.0, 120.0, vAlong));
  }
  lit *= mix(0.55, 1.0, smoothstep(3.0, 28.0, vAlong)) * (1.0 - smoothstep(0.6 * uReach, uReach, vAlong))
    * exp(-d / 300.0) * inside;
  gl_FragColor = vec4(finish(lit, px), 0.0);
}`;

  // The buildings around the car, from the same camera, after the streets: lit
  // bodies with their real heights. A light fixed in the world (uKey) falls on
  // their fronts from one side, so two fronts of a block are never alike and
  // the blocks keep their shape as the car turns; their feet catch the
  // street's light, their roof edges are fine lines of it, the corners
  // fainter, drawn on the nearest wall's own pixels: nothing behind shows
  // through, and two walls' lines meet at a corner without overlapping. Each
  // pixel is shaded once, for the nearest wall, after a pass of their depth
  // alone. Each wall fades out over its last pixel at the top and the foot,
  // so the outlines stay smooth at any angle without the GPU's antialiasing.
  // Beside the car the fronts darken into silhouettes; far off they fade into
  // the sky behind them and are gone before the edge of what the service
  // picked (450 m around the car, picked again every 60 m), towers of 60 m
  // and more only after 2.6 km. When they first appear, they grow out of the
  // ground. Points are metres east and north in the service's frame, and up,
  // each with how far up its wall it lies (0 to 1).
  // aWall is the wall's run on the ground; aFace its metres along from its
  // start, a whole number of its own (0 to 96) and its building's height;
  // aEnds 1 for each end of it that is a corner.
  const WALL_VERTEX = CAMERA + `
attribute vec4 aPos;
attribute vec2 aWall;
attribute vec3 aFace;
attribute vec3 aEnds;
uniform float uRise;
varying vec2 vRel;
varying vec2 vNormal;
varying float vHeight;
varying float vUp;
varying vec3 vFace;
varying float vLength;
varying vec2 vEnds;
void main() {
  gl_Position = project(vec3(aPos.xy, aPos.z * uRise));
  vRel = aPos.xy - uCam;
  vNormal = vec2(aWall.y, -aWall.x) / max(length(aWall), 0.001);
  vHeight = aPos.z;
  vUp = aPos.w;
  vFace = aFace;
  vLength = length(aWall);
  vEnds = aEnds.xy;
}`;

  const WALL_FRAGMENT = `
#ifdef GL_OES_standard_derivatives
#extension GL_OES_standard_derivatives : enable
#endif
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
` + SKY + `
uniform float uFade;
// 1 while only the walls' depth is drawn.
uniform float uDepth;
// Where the light comes from, on the ground.
uniform vec2 uKey;
// The lines' colour.
uniform vec3 uEdge;
varying vec2 vRel;
varying vec2 vNormal;
varying float vHeight;
varying float vUp;
varying vec3 vFace;
varying float vLength;
varying vec2 vEnds;
void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  float d = length(vRel);
  float tower = step(60.0, vFace.z);
  float far = mix(430.0, 2600.0, tower);
  float a = uFade * (1.0 - smoothstep(far - 40.0, far, d));
  if (a < 0.004) discard;
#ifdef GL_OES_standard_derivatives
  // The wall's height on the screen, and a metre along it, in pixels.
  float tall = 1.0 / max(length(vec2(dFdx(vUp), dFdy(vUp))), 1e-5);
  float metre = 1.0 / max(length(vec2(dFdx(vFace.x), dFdy(vFace.x))), 1e-5);
#else
  // Without screen derivatives: hard outlines and no lines.
  float tall = 1e5;
  float metre = 0.0;
#endif
  // How many pixels this one lies below the wall's top; over the last one,
  // and over the first above its foot, the wall fades out.
  float top = (1.0 - vUp) * tall;
  float cover = clamp(top, 0.0, 1.0) * clamp(vUp * tall, 0.0, 1.0);
  if (uDepth > 0.5) {
    if (cover < 0.5 || a < 0.5) discard;
    gl_FragColor = vec4(0.0);
    return;
  }
  vec3 C = uColor;
  // The front towards the camera, how much of the light falls on it, and how
  // squarely the camera sees it (1 face on, 0 edge on).
  vec2 n = vNormal * sign(dot(vNormal, -vRel) + 1e-4);
  float key = max(dot(n, uKey), 0.0);
  float facing = abs(dot(vNormal, vRel)) / max(d, 0.001);
  // Smoked glass: dark, lighter where the light falls, darker towards the
  // ground, catching the sky's glow towards the top and more where it is
  // seen edge-on, as glass does.
  vec3 body = (vec3(0.17, 0.18, 0.2) + C * 0.03) * (0.5 + 0.75 * key + 0.12 * facing)
    * mix(0.7, 1.08, vUp) * mix(0.6, 1.0, smoothstep(0.0, 6.0, vHeight));
  float sheen = (0.15 + 0.85 * pow(1.0 - facing, 3.0)) * smoothstep(0.05, 1.0, vUp);
  vec3 col = body + skyAt(vec2(px.x, 0.36 * uRes.y), C) * 0.35 * sheen;
  float roof = exp(-(top - 0.6) * (top - 0.6) / 0.7) * smoothstep(2.5, 6.0, tall);
  float start = vFace.x * metre;
  float end = (vLength - vFace.x) * metre;
  float corner = max(vEnds.x * exp(-start * start / 0.7), vEnds.y * exp(-end * end / 0.7))
    * mix(0.25, 1.0, vUp) * smoothstep(3.0, 8.0, vLength * metre);
  col += uEdge * max(1.5 * roof, 0.45 * corner);
  col *= mix(0.35, 1.0, smoothstep(8.0, 34.0, d));
  col = hazed(col, px, C, d, mix(420.0, 1400.0, tower));
  gl_FragColor = vec4(finish(col, px) * a, a) * cover;
}`;

  // The service's lines as walls: per line its height, its base, 1 when
  // closed, then its points. A wall vertex carries its point and how far up
  // the wall it lies, the wall's direction on the ground, its face (metres
  // along, a number from where it starts, the height) and its corners (those
  // of its ends where the outline turns by more than 25°; an open line's ends
  // lie on a tile's border and are none).
  function buildingGeometry(lines) {
    let count = 0;
    for (const row of lines) {
      if (!Array.isArray(row) || row.length < 7 || row.length % 2 === 0) continue;
      const n = (row.length - 3) / 2;
      count += row[2] === 1 ? n : n - 1;
    }
    const walls = new Float32Array(count * 6 * 12);
    let o = 0;
    const bend = Math.cos((25 * Math.PI) / 180);
    const seed = (px, py) => {
      const v = Math.sin(px * 12.9898 + py * 78.233) * 43758.5453;
      return Math.floor((v - Math.floor(v)) * 97);
    };
    for (const row of lines) {
      if (!Array.isArray(row) || row.length < 7 || row.length % 2 === 0) continue;
      const [top, base] = row;
      const closed = row[2] === 1;
      const n = (row.length - 3) / 2;
      const x = (i) => row[3 + 2 * i];
      const y = (i) => row[4 + 2 * i];
      const corner = [];
      for (let i = 0; i < n; i++) {
        const p = (i + n - 1) % n;
        const q = (i + 1) % n;
        const ux = x(i) - x(p);
        const uy = y(i) - y(p);
        const vx = x(q) - x(i);
        const vy = y(q) - y(i);
        const turns = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1) < bend;
        corner.push(turns && (closed || (i > 0 && i < n - 1)) ? 1 : 0);
      }
      for (let i = 0; i < (closed ? n : n - 1); i++) {
        const j = (i + 1) % n;
        const dx = x(j) - x(i);
        const dy = y(j) - y(i);
        const len = Math.hypot(dx, dy);
        const own = seed(x(i), y(i));
        for (const [k, up] of [[i, 0], [j, 0], [j, 1], [i, 0], [j, 1], [i, 1]]) {
          walls[o++] = x(k); walls[o++] = y(k); walls[o++] = up ? top : base; walls[o++] = up;
          walls[o++] = dx; walls[o++] = dy;
          walls[o++] = k === i ? 0 : len; walls[o++] = own; walls[o++] = top;
          walls[o++] = corner[i]; walls[o++] = corner[j]; walls[o++] = 0;
        }
      }
    }
    return walls.subarray(0, o);
  }

  // The streets by their kind, as the service sends them (motorways, trunk,
  // main, secondary, tertiary, minor and service roads): the metres from their
  // middle to their edge and their rank. A one-way carriageway is a little
  // narrower.
  const STREETS = [[7, 0], [6.5, 0], [6.5, 0], [5.5, 0.2], [4.5, 0.4], [3.5, 0.6], [2.2, 1]];

  // One strip along a line's points into out from o: per corner the way out to
  // the edges, mitred so the street keeps its width round a bend (at most
  // twice it at a sharp one), and with caps its ends carried on a little, so
  // two lines that meet leave no gap. Six vertices a stretch: the corner's
  // middle and the way out, the metres to the edge, the metres along from
  // along0, the rank and the side.
  function strip(out, o, pts, edge, rank, along0, caps) {
    const n = pts.length;
    const dir = [];
    for (let i = 0; i < n - 1; i++) {
      const dx = pts[i + 1][0] - pts[i][0];
      const dy = pts[i + 1][1] - pts[i][1];
      const l = Math.hypot(dx, dy) || 1;
      dir.push([dx / l, dy / l, l]);
    }
    const way = (i) => {
      const a = dir[Math.max(0, i - 1)];
      const b = dir[Math.min(n - 2, i)];
      let mx = a[1] + b[1];
      let my = -a[0] - b[0];
      const ml = Math.hypot(mx, my);
      if (ml < 1e-6) return [a[1], -a[0]];
      mx /= ml;
      my /= ml;
      const k = 1 / Math.max(0.5, mx * a[1] - my * a[0]);
      return [mx * k, my * k];
    };
    let along = along0;
    for (let i = 0; i < n - 1; i++) {
      const [ux, uy, l] = dir[i];
      const capA = caps && i === 0 ? 0.8 * edge : 0;
      const capB = caps && i === n - 2 ? 0.8 * edge : 0;
      const a = [pts[i][0] - ux * capA, pts[i][1] - uy * capA];
      const b = [pts[i + 1][0] + ux * capB, pts[i + 1][1] + uy * capB];
      const wa = way(i);
      const wb = way(i + 1);
      const s0 = along - capA;
      const s1 = along + l + capB;
      for (const [p, w, side, s] of [[a, wa, -1, s0], [b, wb, -1, s1], [b, wb, 1, s1], [a, wa, -1, s0], [b, wb, 1, s1],
        [a, wa, 1, s0]]) {
        out[o++] = p[0]; out[o++] = p[1]; out[o++] = w[0] * side; out[o++] = w[1] * side;
        out[o++] = edge; out[o++] = s; out[o++] = rank; out[o++] = side;
      }
      along += l;
    }
    return o;
  }

  // The service's streets: per line its kind, 1 when it is one-way, then its
  // points.
  function roadGeometry(rows) {
    let count = 0;
    for (const r of rows) if (Array.isArray(r) && r.length >= 6) count += (r.length - 2) / 2 - 1;
    const out = new Float32Array(Math.max(0, count) * 6 * 8);
    let o = 0;
    for (const r of rows) {
      if (!Array.isArray(r) || r.length < 6 || r.length % 2 !== 0 || !STREETS[r[0]]) continue;
      const pts = [];
      for (let i = 2; i < r.length; i += 2) pts.push([r[i], r[i + 1]]);
      const [edge, rank] = STREETS[r[0]];
      o = strip(out, o, pts, edge * (r[1] ? 0.72 : 1), rank, 0, true);
    }
    return out.subarray(0, o);
  }

  function webglPicture(canvas) {
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: true, stencil: false,
      preserveDrawingBuffer: false, powerPreference: 'low-power' });
    if (!gl) return null;
    // Screen derivatives keep the lines' width; the shaders do without them.
    gl.getExtension('OES_standard_derivatives');
    const shader = (type, text) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, text);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    // A program with its attributes at fixed places, the first at 0, and its
    // uniforms; null when the GPU takes either shader or the link amiss.
    const link = (vertex, fragment, attributes, uniforms) => {
      const v = shader(gl.VERTEX_SHADER, vertex);
      const f = shader(gl.FRAGMENT_SHADER, fragment);
      if (!v || !f) return null;
      const pr = gl.createProgram();
      gl.attachShader(pr, v);
      gl.attachShader(pr, f);
      attributes.forEach((name, i) => gl.bindAttribLocation(pr, i, name));
      gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return null;
      const u = {};
      for (const name of uniforms) u[name] = gl.getUniformLocation(pr, name);
      return { pr, u };
    };
    const sky = ['uRes', 'uColor', 'uGlow', 'uBreath', 'uArrive'];
    const camera = ['uCam', 'uDir', 'uView', 'uEye'];
    const ground = link('attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }', GROUND, ['p'],
      [...sky, 'uEye', 'uSeed', 'uTime', 'uRing']);
    if (!ground) return null;
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    // Streets and buildings: without their shaders the picture goes on without them.
    const roadsGL = link(ROAD_VERTEX, ROAD_FRAGMENT, ['aPos', 'aInfo'],
      [...sky, ...camera, 'uLinePx', 'uPass', 'uTravel', 'uStreaks', 'uBlink', 'uReach', 'uMad', 'uRush']);
    const wallsGL = link(WALL_VERTEX, WALL_FRAGMENT, ['aPos', 'aWall', 'aFace', 'aEnds'],
      [...sky, ...camera, 'uRise', 'uFade', 'uDepth', 'uKey', 'uEdge']);
    let walls = null;
    let roads = null;
    const path = { b: gl.createBuffer(), n: 0, sizes: [4, 4], stride: 8 };
    // A buffer of vertices with their attributes' sizes, interleaved.
    const upload = (old, data, sizes) => {
      if (old) gl.deleteBuffer(old.b);
      const stride = sizes.reduce((a, b) => a + b, 0);
      if (!data.length) return null;
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      return { b, n: data.length / stride, sizes, stride };
    };
    const attributes = (x) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, x.b);
      let offset = 0;
      x.sizes.forEach((size, i) => {
        gl.enableVertexAttribArray(i);
        gl.vertexAttribPointer(i, size, gl.FLOAT, false, x.stride * 4, offset * 4);
        offset += size;
      });
      for (let i = x.sizes.length; i < 4; i++) gl.disableVertexAttribArray(i);
    };
    const skyUniforms = (u, p) => {
      gl.uniform2f(u.uRes, canvas.width, canvas.height);
      gl.uniform3f(u.uColor, p.rgb[0] / 255, p.rgb[1] / 255, p.rgb[2] / 255);
      gl.uniform1f(u.uGlow, p.glow);
      gl.uniform1f(u.uBreath, p.breath);
      gl.uniform1f(u.uArrive, p.arrive);
    };
    const cameraUniforms = (u, p) => {
      const r = (p.cam.h * Math.PI) / 180;
      gl.uniform2f(u.uCam, p.cam.x, p.cam.y);
      gl.uniform2f(u.uDir, Math.sin(r), Math.cos(r));
      gl.uniform4f(u.uView, 0.78 * canvas.width, canvas.width, canvas.height, 0.58 * canvas.height);
      gl.uniform1f(u.uEye, p.eye);
    };
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    return {
      // A renderer in software draws fewer pixels from the start.
      soft: /swiftshader|llvmpipe|software/i.test(name),
      resize(width, height) {
        gl.viewport(0, 0, width, height);
      },
      // Lines from the service, or null for none; true when there are some.
      setBuildings(lines) {
        walls = wallsGL && lines ? upload(walls, buildingGeometry(lines), [4, 2, 3, 3]) : upload(walls, [], [4]);
        return !!walls;
      },
      setRoads(rows) {
        roads = roadsGL && rows ? upload(roads, roadGeometry(rows), [4, 4]) : upload(roads, [], [4]);
        return !!roads;
      },
      draw(p) {
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
        gl.useProgram(ground.pr);
        skyUniforms(ground.u, p);
        gl.uniform1f(ground.u.uEye, p.eye);
        gl.uniform1f(ground.u.uSeed, (p.time * 37) % 101);
        gl.uniform1f(ground.u.uTime, p.time % 3600);
        gl.uniform1f(ground.u.uRing, 0);
        attributes({ b: quad, sizes: [2], stride: 2 });
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        if (!p.cam) return;
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        if (roads && p.roads > 0.01) {
          gl.useProgram(roadsGL.pr);
          skyUniforms(roadsGL.u, p);
          cameraUniforms(roadsGL.u, p);
          gl.uniform1f(roadsGL.u.uTravel, p.travel % 2400);
          gl.uniform1f(roadsGL.u.uStreaks, p.streaks ? 1 : 0);
          gl.uniform2f(roadsGL.u.uBlink, p.left, p.right);
          gl.uniform1f(roadsGL.u.uReach, p.reach);
          gl.uniform1f(roadsGL.u.uMad, p.mad);
          gl.uniform1f(roadsGL.u.uRush, p.rush % 1400);
          attributes(roads);
          gl.uniform1f(roadsGL.u.uLinePx, 1.5 * canvas.width / 1920);
          gl.uniform1f(roadsGL.u.uPass, 0);
          gl.drawArrays(gl.TRIANGLES, 0, roads.n);
          gl.uniform1f(roadsGL.u.uLinePx, 0);
          gl.uniform1f(roadsGL.u.uPass, 1);
          gl.drawArrays(gl.TRIANGLES, 0, roads.n);
          if (p.path && p.path.length > 1) {
            const data = new Float32Array((p.path.length - 1) * 6 * 8);
            const o = strip(data, 0, p.path, p.pathEdge, 0, 0, false);
            gl.bindBuffer(gl.ARRAY_BUFFER, path.b);
            gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, o), gl.DYNAMIC_DRAW);
            path.n = o / 8;
            attributes(path);
            gl.uniform1f(roadsGL.u.uPass, 2);
            gl.drawArrays(gl.TRIANGLES, 0, path.n);
          }
        }
        if (p.arrive > 0.01) {
          gl.useProgram(ground.pr);
          gl.uniform1f(ground.u.uRing, 26);
          attributes({ b: quad, sizes: [2], stride: 2 });
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        if (walls && p.buildings > 0.01) {
          gl.useProgram(wallsGL.pr);
          skyUniforms(wallsGL.u, p);
          cameraUniforms(wallsGL.u, p);
          gl.uniform1f(wallsGL.u.uFade, p.buildings);
          gl.uniform1f(wallsGL.u.uRise, p.rise);
          const k = (290 * Math.PI) / 180;
          gl.uniform2f(wallsGL.u.uKey, Math.sin(k), Math.cos(k));
          const hot = p.shown.map((c) => ((c + (255 - c) * 0.45) / 255) * 0.85 * Math.min(1.2, p.glow));
          gl.uniform3f(wallsGL.u.uEdge, hot[0], hot[1], hot[2]);
          attributes(walls);
          gl.enable(gl.DEPTH_TEST);
          gl.depthFunc(gl.LEQUAL);
          gl.depthMask(true);
          gl.clear(gl.DEPTH_BUFFER_BIT);
          gl.uniform1f(wallsGL.u.uDepth, 1);
          gl.colorMask(false, false, false, false);
          gl.disable(gl.BLEND);
          gl.drawArrays(gl.TRIANGLES, 0, walls.n);
          gl.colorMask(true, true, true, true);
          gl.uniform1f(wallsGL.u.uDepth, 0);
          gl.depthMask(false);
          gl.enable(gl.BLEND);
          gl.drawArrays(gl.TRIANGLES, 0, walls.n);
          gl.depthMask(true);
          gl.disable(gl.DEPTH_TEST);
        }
        gl.disable(gl.BLEND);
      },
    };
  }

  // Without WebGL: the glow over a dark ground, without streets or buildings.
  function canvasPicture(canvas) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const rgba = (p, a) => `rgba(${p.rgb.map(Math.round).join(',')},${clamp(a * p.glow, 0, 1)})`;
    return {
      soft: true,
      resize() {},
      setBuildings() {
        return false;
      },
      setRoads() {
        return false;
      },
      draw(p) {
        const w = canvas.width;
        const h = canvas.height;
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = `rgb(${p.rgb.map((c) => Math.round(4 + c * 0.012)).join(',')})`;
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'lighter';
        const sky = ctx.createRadialGradient(w / 2, h * 0.34, 0, w / 2, h * 0.34, Math.max(w, h) * 0.4);
        sky.addColorStop(0, rgba(p, 0.36 + 0.05 * p.breath));
        sky.addColorStop(1, rgba(p, 0));
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, w, h);
        const band = ctx.createLinearGradient(0, h * 0.53, 0, h * 0.63);
        band.addColorStop(0, rgba(p, 0));
        band.addColorStop(0.5, rgba(p, 0.12));
        band.addColorStop(1, rgba(p, 0));
        ctx.fillStyle = band;
        ctx.fillRect(0, h * 0.53, w, h * 0.1);
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
    hasBuildings = false;
    hasRoads = false;
    layout();
  });

  // The share of the device's pixels drawn: lower on a renderer in software, a
  // step lower while frames take longer than about 26 ms, and a step back up
  // after ten windows in a row at the display's pace (about 15 s), unless a
  // step up had to be taken back before; then it stays. A window is 90
  // frames. The first ones after the start or a pause are not judged, nor one
  // that took in a new pick of buildings: they would count as slow frames.
  let quality = picture.soft ? 0.5 : 1;
  let measured = 0;
  let measureStart = 0;
  let paced = 0;
  let raised = false;
  let stayLow = false;
  let rebuilt = false;

  function layout() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.max(1, Math.round(innerWidth * dpr * quality));
    canvas.height = Math.max(1, Math.round(innerHeight * dpr * quality));
    picture.resize(canvas.width, canvas.height);
  }

  function frame(now) {
    const s = now / 1000;
    if (lastFrame && s - lastFrame > 0.5) measured = measureStart = 0;
    const dt = lastFrame ? Math.min(0.1, s - lastFrame) : 0;
    lastFrame = s;
    // Without fresh state the streaks slow down.
    const fresh = (source && source.readyState === 1) || performance.now() - lastState < 3000;
    // The pace follows the speed over about 1.5 s and comes to a full stop,
    // the last of it at 0.4 m/s², rather than creeping on.
    const paceTo = fresh ? paceGoal : 0;
    const paceStep = Math.max(Math.abs(paceTo - pace) * Math.min(1, dt / 1.5), 0.4 * dt);
    pace = Math.abs(paceTo - pace) <= paceStep ? paceTo : pace + Math.sign(paceTo - pace) * paceStep;
    travel += dt * pace;
    arrive += (arriveGoal - arrive) * Math.min(1, dt / 2.2);
    if (state) awake = Math.min(awake + dt, 60);
    const wake = smooth(0, 1.6, awake);
    eye += ((VIEWS[options.view] || VIEWS.street) - eye) * Math.min(1, dt / 0.6);
    // A new colour fades over in 2.4 s, the whole picture at once, and dims a
    // little on the way, the more the further the colours lie apart, as the
    // car's own lights do.
    let dim = 1;
    if (light && fade < 1) {
      fade = Math.min(1, fade + dt / 2.4);
      const k = smooth(0, 1, fade);
      rgb = blend(fadeFrom, light, k);
      const apart = Math.min(1, Math.hypot(...light.map((v, i) => v - fadeFrom[i])) / 250);
      dim = 1 - 0.25 * apart * Math.sin(Math.PI * k);
    } else if (light) {
      rgb = light;
    }
    if (rgb.map(Math.round).join() !== painted) paintStyles(rgb);
    glow = Math.abs(glowGoal - glow) < 0.004 ? glowGoal : glow + (glowGoal - glow) * Math.min(1, dt / 0.8);
    let left = 0;
    let right = 0;
    if (state && state.signal) {
      const period = state.blink || 700;
      const b = 0.5 - 0.5 * Math.cos((2 * Math.PI * (now % period)) / period);
      if (state.signal !== 'right') left = b;
      if (state.signal !== 'left') right = b;
    }
    follow(dt, now);
    const here = cam && cam.o === buildingsOrigin;
    if (here && streets && now - matchedAt > 100) {
      matchedAt = now;
      onStreet = findStreet(cam.x, cam.y, cam.h);
    }
    if (!here) onStreet = null;
    const view = cam ? onTheStreet(dt) : null;
    const showing = hasBuildings && options.buildings && here;
    buildingsFade += ((showing ? 1 : 0) - buildingsFade) * Math.min(1, dt / 1.5);
    buildingsRise = clamp(buildingsRise + (showing ? dt : -dt) / 2.2, 0, 1);
    roadsFade += ((hasRoads && options.buildings && here ? 1 : 0) - roadsFade) * Math.min(1, dt / 1.5);
    if ((buildingsFade > 0.05 || roadsFade > 0.05) !== creditShown) {
      creditShown = !creditShown;
      $('credit').hidden = !creditShown;
    }
    const reach = 400 * smooth(0.35, 2.2, awake) * (1 - arrive);
    // In Mad Max the chevrons come in over a second and glide ahead of the
    // car at 3 m/s.
    mad += ((state && state.fsd === 'Mad Max' && !state.arrived ? 1 : 0) - mad) * Math.min(1, dt / 1.0);
    rush += dt * 3 * (mad > 0.001 ? 1 : 0);
    const way = view && onStreet && reach > 1 ? wayAhead(view, state && state.turn, reach) : null;
    picture.draw({ rgb, shown: rgb, glow: glow * wake * dim, travel, streaks: options.pulses, left, right, arrive,
      breath: 0.5 + 0.5 * Math.sin((s * Math.PI * 2) / 5), time: s, eye,
      cam: buildingsFade > 0.01 || roadsFade > 0.01 ? view : null, buildings: buildingsFade, rise: smooth(0, 1, buildingsRise),
      roads: roadsFade, reach, mad, rush, path: way, pathEdge: onStreet ? onStreet.edge : 0 });
    if (++measured === 90) {
      const ms = measureStart && !rebuilt ? (now - measureStart) / measured : 0;
      if (ms > 26 && quality > 0.35) {
        stayLow = stayLow || raised;
        raised = false;
        paced = 0;
        quality = Math.max(0.35, quality * 0.75);
        layout();
      } else if (ms && ms < 18.5) {
        if (++paced >= 10 && quality < 1 && !stayLow && !picture.soft) {
          raised = true;
          paced = 0;
          quality = Math.min(1, quality / 0.75);
          layout();
        }
      } else if (ms) {
        paced = 0;
      }
      measured = 0;
      measureStart = now;
      rebuilt = false;
    }
    requestAnimationFrame(frame);
  }

  // The light's colour for the page's styles: the progress line, the turn's
  // arrow, the menu's switches, whose knob turns dark on a pale light.
  function paintStyles(shown) {
    const c = shown.map(Math.round);
    painted = c.join();
    const s = document.documentElement.style;
    s.setProperty('--light', `rgb(${c.join(',')})`);
    s.setProperty('--light-rgb', c.join(' '));
    const luminance = c.reduce((sum, v, i) => sum + [0.2126, 0.7152, 0.0722][i] * (v / 255) ** 2.2, 0);
    s.setProperty('--knob', luminance > 0.5 ? '#161616' : '#fff');
  }

  // Shows or hides an element with a fade; once faded out it gives up its room.
  const fading = new Map();
  function reveal(el, on) {
    if (on) {
      clearTimeout(fading.get(el));
      fading.delete(el);
      if (el.hidden) {
        el.classList.add('out');
        el.hidden = false;
        void el.offsetWidth;
      }
      el.classList.remove('out');
    } else if (!el.hidden && !fading.has(el)) {
      el.classList.add('out');
      fading.set(el, setTimeout(() => {
        fading.delete(el);
        el.hidden = true;
      }, 700));
    }
  }

  // A turn's arrow as SVG path data in a 48 unit square: a stem up from the
  // bottom that bends right by deg into a short straight with a head. Drawn as
  // lines of points, then fitted into the square and mirrored for a left turn;
  // an exit keeps the road on as a fainter line (also). In a roundabout the
  // stem runs anticlockwise round a fainter ring for deg and leaves it.
  function arrowPaths(deg, side, kind) {
    const lines = [];
    // A line ending in a head: two strokes back from its end, 43° either side.
    const tipped = (line) => {
      const [x, y] = line[line.length - 1];
      const [px, py] = line[line.length - 2];
      const l = Math.hypot(px - x, py - y) || 1;
      const bx = (px - x) / l;
      const by = (py - y) / l;
      const wing = (a) => [x + 7 * (bx * Math.cos(a) - by * Math.sin(a)), y + 7 * (bx * Math.sin(a) + by * Math.cos(a))];
      lines.push(line, [wing(0.75), [x, y], wing(-0.75)]);
    };
    let also = null;
    if (kind === 'ring') {
      const at = (f) => [7 * Math.sin(f), 7 * Math.cos(f)];
      const th = (deg * Math.PI) / 180;
      const line = [[0, 17]];
      also = [];
      for (let i = 0; i <= 24; i++) {
        const f = (2 * Math.PI * i) / 24;
        if (f <= th) line.push(at(f));
        if (f >= th) also.push(at(f));
      }
      line.push(at(th), [10 * Math.sin(th), 10 * Math.cos(th)], [16 * Math.sin(th), 16 * Math.cos(th)]);
      tipped(line);
    } else {
      const th = (deg * Math.PI) / 180;
      const line = [[0, 0]];
      for (let i = 0; i <= 12; i++) {
        const f = (th * i) / 12;
        line.push([8 - 8 * Math.cos(f), -12 - 8 * Math.sin(f)]);
      }
      const [ex, ey] = line[line.length - 1];
      line.push([ex + 9 * Math.sin(th), ey - 9 * Math.cos(th)]);
      tipped(line);
      if (kind === 'exit') also = [[0, -12], [0, -28]];
    }
    const all = lines.flat().concat(also || []);
    const xs = all.map((p) => p[0]);
    const ys = all.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const k = Math.min(36 / Math.max(x1 - x0, 1), 36 / Math.max(y1 - y0, 1), 2.2);
    const fit = ([x, y]) => {
      const fx = 24 + (x - (x0 + x1) / 2) * k;
      const fy = 24 + (y - (y0 + y1) / 2) * k;
      return `${(side < 0 ? 48 - fx : fx).toFixed(1)} ${fy.toFixed(1)}`;
    };
    const path = (line) => line.map((p, i) => `${i ? 'L' : 'M'}${fit(p)}`).join('');
    return { d: lines.map(path).join(''), also: also ? path(also) : '' };
  }

  // The service gives a turn's distance and words in the page's language, and
  // its kind: the distance shows large, the words under it, and the arrow for
  // the kind beside them. A turn without a kind (QtCar keeps its direction to
  // itself) has no arrow.
  const KINDS = new Map([['uturn', [180]], ['roundabout', [0, 'ring']], ['exit', [40, 'exit']], ['merge', [30]],
    ['slight', [45]], ['sharp', [135]], ['straight', [0]], ['turn', [90]]]);
  function showTurn(t) {
    const words = t && typeof t.words === 'string' ? t.words : '';
    reveal($('turn'), !!words);
    if (!words) return;
    $('turnDist').textContent = typeof t.dist === 'string' ? t.dist : '';
    $('turnWords').textContent = words;
    const kind = KINDS.get(t.kind);
    $('turnGlyph').style.display = kind ? '' : 'none';
    if (kind) {
      // A roundabout's exit lies a quarter round for the right, three quarters
      // for the left, half round without a side.
      const exit = t.side > 0 ? 90 : t.side < 0 ? 270 : 180;
      const glyph = kind[1] === 'ring' ? arrowPaths(exit, 1, 'ring')
        : arrowPaths(kind[0], t.side || (kind[0] === 180 ? -1 : 1), kind[1]);
      $('turnPath').setAttribute('d', glyph.d);
      $('turnAlso').setAttribute('d', glyph.also);
    }
    $('turn').style.setProperty('--near', String(clamp(Number(t.near) || 0, 0, 1)));
  }

  // The page speaks the car's language, as the service says (lang): German as
  // index.html has it where the car is set to German, English otherwise.
  const ENGLISH = {
    arrived: 'Arrived', arrival: 'Arrival', hint: 'Swipe down to close · press and hold for options',
    credit: 'Map: OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors', options: 'Options',
    shows: 'What the view shows', eta: 'Arrival time and progress', turns: 'Turn hints', speed: 'Speedometer',
    pulses: 'Light streaks', buildings: 'Streets and buildings', view: 'View height', street: 'Street', raised: 'Raised',
    above: 'High', bright: 'Brightness', high: 'Bright', low: 'Dimmed', done: 'Done',
  };
  const GERMAN = {};
  for (const el of document.querySelectorAll('[data-t]')) GERMAN[el.dataset.t] = el.textContent;
  for (const el of document.querySelectorAll('[data-t-label]')) GERMAN[el.dataset.tLabel] = el.getAttribute('aria-label');
  let lang = 'de';
  function speak(next) {
    next = next === 'en' ? 'en' : 'de';
    if (next === lang) return;
    lang = next;
    const words = lang === 'en' ? ENGLISH : GERMAN;
    document.documentElement.lang = lang;
    for (const el of document.querySelectorAll('[data-t]')) el.textContent = words[el.dataset.t];
    for (const el of document.querySelectorAll('[data-t-label]')) el.setAttribute('aria-label', words[el.dataset.tLabel]);
  }

  function render(v) {
    speak(v.lang);
    // The car's typeface: the Cybertruck's while CoilShift's Cybertruck UI
    // shows it.
    document.documentElement.classList.toggle('cybertruck', v.font === 'cybertruck');
    // Arrived: the drive's summary instead of arrival, turn and progress.
    const done = v.arrived && typeof v.arrived === 'object' ? v.arrived : null;
    const block = $('arrivedBlock');
    if (done && block.hidden) {
      // The summary rises in each time it appears, and fades when it goes.
      block.classList.remove('rise');
      void block.offsetWidth;
      block.classList.add('rise');
    }
    reveal(block, done);
    if (done) {
      const what = done.dist && done.min ? `${done.dist} in ${done.min} min` : done.min ? `${done.min} min` : '';
      $('arrivedSum').textContent = [what, done.time].filter(Boolean).join(' · ');
    }
    // What is shown keeps its words while it fades out.
    const arrival = !done && options.eta && v.trip && v.eta;
    reveal($('arrival'), arrival);
    if (arrival) {
      $('eta').textContent = v.eta;
      const parts = [];
      if (v.min) parts.push(lang === 'en' ? `${v.min} min left` : `noch ${v.min} min`);
      if (v.dist) parts.push(v.dist);
      $('rest').textContent = parts.join(' · ');
      const progress = typeof v.progress === 'number' && v.progress >= 0;
      reveal($('progress'), progress);
      if (progress) $('progressFill').style.width = `${Math.round(Math.min(1, v.progress) * 1000) / 10}%`;
    }
    reveal($('center'), done || arrival);
    showTurn(!done && options.turns ? v.turn : null);
    // The Self-Driving profile, as the car names it. A new one fades over: the
    // old name fades out, the new one in. A view that comes while it does so
    // leaves it be; one with yet another name fades to that one instead.
    const fsd = !done && typeof v.fsd === 'string' ? v.fsd : '';
    const fsdBlock = $('fsd');
    const profile = $('fsdProfile');
    if (fsd && (fsdBlock.hidden || !profile.textContent)) {
      clearTimeout(profile.timer);
      profile.classList.remove('swap');
      profile.textContent = fsd;
      profile.next = '';
    } else if (fsd && fsd !== profile.textContent && fsd !== profile.next) {
      profile.next = fsd;
      profile.classList.add('swap');
      clearTimeout(profile.timer);
      profile.timer = setTimeout(() => {
        profile.textContent = profile.next;
        profile.next = '';
        profile.classList.remove('swap');
      }, 350);
    }
    reveal(fsdBlock, !!fsd);
    const speed = options.speed && v.speed ? v.speed : '';
    reveal($('speed'), !!speed);
    if (speed) {
      $('speedValue').textContent = speed;
      $('speedUnit').textContent = v.unit || '';
    }
  }

  function applyOptions(o) {
    options = { eta: !!o.eta, speed: !!o.speed, turns: !!o.turns, pulses: !!o.pulses,
      bright: o.bright in BRIGHT ? o.bright : 'auto', buildings: o.buildings !== false,
      view: o.view in VIEWS ? o.view : 'street' };
    if (state) {
      glowGoal = glowFor(state);
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
    // A new colour fades over from the one shown, also from one still fading.
    if (c && light && c.join() !== light.join()) {
      fadeFrom = rgb;
      fade = 0;
    }
    if (c) light = c;
    paceGoal = paceFor(v.kmh);
    arriveGoal = v.arrived ? 1 : 0;
    takeFix(v.pose);
    // Each new pick of buildings is fetched once.
    if (typeof v.bv === 'number' && v.bv !== buildingsAt) {
      buildingsAt = v.bv;
      loadBuildings();
    }
    // A choice still on its way to the service is not undone by an older view.
    applyOptions(v.options && !pending ? v.options : options);
    if (first) {
      // The first colour, brightness and view are there at once, as the
      // picture wakes.
      rgb = fadeFrom = c;
      glow = glowGoal;
      eye = VIEWS[options.view] || VIEWS.street;
      paintStyles(c);
    }
  }

  // Where the car is, for the buildings: its last fix in the service's frame
  // and its heading. QtCar renews both only about once a second, so between
  // them the camera is carried on by the speed and by how fast the car turns,
  // which the steering wheel gives at once: as fast as a wheelbase of 2.89 m
  // and a ratio of 10:1 would turn it, times 0.65, as measured against the
  // heading on drives in Berlin. The fix and the heading only pull the camera
  // back, over about a second, so the city glides instead of surging forward
  // with each fix and stalling until the next. A fix is new when its number
  // is; every view in between repeats it. A view without a fix keeps the last
  // one while the car stands; moving, the city would drive along with it.
  let fix = null;
  let cam = null;
  let hasBuildings = false;
  let buildingsAt = -1;
  let buildingsOrigin = 0;
  let buildingsFade = 0;
  // 0 to 1 over 2.2 s as the buildings first show: they grow out of the ground.
  let buildingsRise = 0;
  let creditShown = false;

  const turnOf = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;

  function takeFix(p) {
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.h !== 'number') {
      if ((Number.parseFloat(state && state.kmh) || 0) >= 2) fix = null;
      return;
    }
    const now = performance.now();
    const fresh = !fix || fix.o !== p.o || fix.n !== p.n || (p.n === undefined && (fix.x !== p.x || fix.y !== p.y));
    const turned = !fix || fix.h !== p.h;
    fix = { x: p.x, y: p.y, h: p.h, o: p.o, n: p.n, at: fresh ? now : fix.at, turnedAt: turned ? now : fix.turnedAt };
  }

  // Degrees a second the car turns at speed v (m/s), right positive.
  function turnRate(v) {
    if (v < 1 || !state || typeof state.steer !== 'number') return 0;
    return (0.65 * steerCurvature(state.steer) * v * 180) / Math.PI;
  }

  function follow(dt, now) {
    if (!fix) {
      cam = null;
      return;
    }
    const v = Math.max(0, Number.parseFloat(state && state.kmh) || 0) / 3.6;
    const turn = turnRate(v);
    // The heading and the fix as they would be now, carried on since they came.
    const h = fix.h + turn * Math.min(1.5, (now - fix.turnedAt) / 1000);
    const age = Math.min(1.5, (now - fix.at) / 1000);
    const r = ((h - (turn * age) / 2) * Math.PI) / 180;
    const tx = fix.x + v * Math.sin(r) * age;
    const ty = fix.y + v * Math.cos(r) * age;
    if (!cam || cam.o !== fix.o || Math.hypot(tx - cam.x, ty - cam.y) > 50) {
      cam = { x: tx, y: ty, h, o: fix.o };
      return;
    }
    cam.h += turn * dt;
    const cr = (cam.h * Math.PI) / 180;
    cam.x += v * Math.sin(cr) * dt;
    cam.y += v * Math.cos(cr) * dt;
    const k = Math.min(1, dt / 1.0);
    cam.x += (tx - cam.x) * k;
    cam.y += (ty - cam.y) * k;
    cam.h += turnOf(h, cam.h) * Math.min(1, dt / 0.8);
  }

  // The streets the service picked, for finding the car's and following it:
  // per line its points, whether it is one-way and how far its edges lie from
  // its middle; its stretches in cells of 50 m; and the lines meeting at each
  // point, by its decimetres, as the service rounds them, so lines that share
  // a point on the map share it here exactly.
  let streets = null;
  let hasRoads = false;
  let roadsFade = 0;
  // The street the car is on, found ten times a second, and the camera as
  // drawn: moved over onto it.
  let onStreet = null;
  let matchedAt = 0;
  const shift = { x: 0, y: 0, h: 0 };
  const pointKey = (p) => `${Math.round(p[0] * 10)},${Math.round(p[1] * 10)}`;

  function indexStreets(rows) {
    const lines = [];
    const cells = new Map();
    const nodes = new Map();
    for (const r of rows || []) {
      if (!Array.isArray(r) || r.length < 6 || r.length % 2 !== 0 || !STREETS[r[0]]) continue;
      const pts = [];
      for (let i = 2; i < r.length; i += 2) pts.push([r[i], r[i + 1]]);
      const li = lines.length;
      lines.push({ pts, oneway: r[1] === 1, edge: STREETS[r[0]][0] * (r[1] === 1 ? 0.72 : 1) });
      pts.forEach((p, i) => {
        const k = pointKey(p);
        if (!nodes.has(k)) nodes.set(k, []);
        nodes.get(k).push([li, i]);
        if (!i) return;
        const q = pts[i - 1];
        for (let cx = Math.floor(Math.min(p[0], q[0]) / 50); cx <= Math.floor(Math.max(p[0], q[0]) / 50); cx++) {
          for (let cy = Math.floor(Math.min(p[1], q[1]) / 50); cy <= Math.floor(Math.max(p[1], q[1]) / 50); cy++) {
            const c = `${cx},${cy}`;
            if (!cells.has(c)) cells.set(c, []);
            cells.get(c).push([li, i - 1]);
          }
        }
      });
    }
    return lines.length ? { lines, cells, nodes } : null;
  }

  // The car's street: of the stretches within 15 m whose direction lies within
  // 35° of the car's either way (a one-way street only its own way), the
  // nearest, the angle counting a metre for every 4°; the street it was on
  // stays while the car keeps within 10 m of its edge and 50° of its way.
  // Its stretch's ends, length and direction (the car's way), and the edges'
  // distance.
  function findStreet(x, y, h) {
    const hx = Math.sin((h * Math.PI) / 180);
    const hy = Math.cos((h * Math.PI) / 180);
    const cx = Math.floor(x / 50);
    const cy = Math.floor(y / 50);
    let best = null;
    for (let i = cx - 1; i <= cx + 1; i++) {
      for (let j = cy - 1; j <= cy + 1; j++) {
        for (const [li, si] of streets.cells.get(`${i},${j}`) || []) {
          const line = streets.lines[li];
          const a = line.pts[si];
          const b = line.pts[si + 1];
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (len < 0.01) continue;
          const ux = (b[0] - a[0]) / len;
          const uy = (b[1] - a[1]) / len;
          const t = clamp((x - a[0]) * ux + (y - a[1]) * uy, 0, len);
          const d = Math.hypot(x - a[0] - ux * t, y - a[1] - uy * t);
          const along = ux * hx + uy * hy;
          if (line.oneway && along < 0) continue;
          const angle = (Math.acos(Math.min(1, Math.abs(along))) * 180) / Math.PI;
          const same = onStreet && onStreet.li === li;
          if (d > (same ? line.edge + 10 : 15) || angle > (same ? 50 : 35)) continue;
          const score = d + angle / 4 - (same ? 3 : 0);
          if (!best || score < best.score) {
            const sign = along >= 0 ? 1 : -1;
            best = { score, li, si, sign, a, b, len, ux: ux * sign, uy: uy * sign, edge: line.edge };
          }
        }
      }
    }
    return best;
  }

  // The camera as drawn: GPS puts the car a few metres off its street, so it
  // is eased over sideways onto the street's middle, and turned to its way
  // where that lies within 20° of the car's, over about half a second; off
  // any street, where the car is.
  function onTheStreet(dt) {
    let gx = 0;
    let gy = 0;
    let gh = 0;
    if (onStreet) {
      const nx = onStreet.uy;
      const ny = -onStreet.ux;
      const off = (cam.x - onStreet.a[0]) * nx + (cam.y - onStreet.a[1]) * ny;
      gx = -off * nx;
      gy = -off * ny;
      const way = turnOf((Math.atan2(onStreet.ux, onStreet.uy) * 180) / Math.PI, cam.h);
      if (Math.abs(way) < 20) gh = way;
    }
    const k = Math.min(1, dt / 0.5);
    shift.x += (gx - shift.x) * k;
    shift.y += (gy - shift.y) * k;
    shift.h += (gh - shift.h) * Math.min(1, dt / 0.6);
    return { x: cam.x + shift.x, y: cam.y + shift.y, h: cam.h + shift.h, o: cam.o };
  }

  // The way ahead of the car, for the light on it: from the camera's place on
  // its street along the street's line; where the line ends or meets others,
  // on along the one that goes on most straight, never into a one-way street
  // against it and not past a bend of more than 60° (the line's own corners
  // up to 150°); but at the junction
  // nearest the navigation's next turn (within 30 m of its distance) into the
  // street that bends within 45° of the turn's angle. Up to length metres, a
  // point every 2 m, smoothed over a few metres so it bends without corners;
  // it starts 1.5 m ahead of the camera.
  function wayAhead(view, turn, length) {
    const m = onStreet;
    let line = streets.lines[m.li];
    let li = m.li;
    let dir = m.sign;
    const s0 = dir > 0 ? m.a : m.b;
    const t = clamp((view.x - s0[0]) * m.ux + (view.y - s0[1]) * m.uy, 0, m.len);
    let last = [s0[0] + m.ux * t, s0[1] + m.uy * t];
    let i = dir > 0 ? m.si + 1 : m.si;
    let ux = m.ux;
    let uy = m.uy;
    let walked = 0;
    let turned = !(turn && typeof turn.m === 'number' && turn.m > 0 && turn.a);
    const raw = [last];
    for (let guard = 0; guard < 800 && walked < length + 10; guard++) {
      const p = line.pts[i];
      if (!p) break;
      const step = Math.hypot(p[0] - last[0], p[1] - last[1]);
      if (step > 0.01) {
        ux = (p[0] - last[0]) / step;
        uy = (p[1] - last[1]) / step;
        walked += step;
        raw.push(p);
        last = p;
      }
      // Which way on from here: every line meeting at this point, both ways.
      const meet = streets.nodes.get(pointKey(p)) || [];
      const junction = meet.length > 1;
      const atTurn = !turned && junction && Math.abs(walked - turn.m) < 30;
      let pick = null;
      for (const [lj, j] of meet) {
        const other = streets.lines[lj];
        for (const d of [1, -1]) {
          const q = other.pts[j + d];
          if (!q || (lj === li && d === -dir) || (other.oneway && d < 0)) continue;
          const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
          if (l < 0.01) continue;
          const vx = (q[0] - p[0]) / l;
          const vy = (q[1] - p[1]) / l;
          // Clockwise from the way so far, as the navigation counts.
          const bend = (-Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy) * 180) / Math.PI;
          const miss = atTurn ? Math.abs(bend - turn.a) : Math.abs(bend) - (lj === li ? 5 : 0);
          if (miss > (atTurn ? 45 : junction ? 60 : 150)) continue;
          if (!pick || miss < pick.miss) pick = { miss, lj, j, d };
        }
      }
      if (!pick) break;
      if (atTurn) turned = true;
      li = pick.lj;
      line = streets.lines[li];
      dir = pick.d;
      i = pick.j + dir;
    }
    if (raw.length < 2) return null;
    // Every 2 m from 1.5 m on, smoothed over about 3 m either way.
    const even = [];
    let need = 1.5;
    let done = 0;
    for (let k = 1; k < raw.length && done <= length; k++) {
      const [x0, y0] = raw[k - 1];
      const [x1, y1] = raw[k];
      const l = Math.hypot(x1 - x0, y1 - y0);
      for (; need <= done + l && need <= length; need += 2) {
        const f = (need - done) / l;
        even.push([x0 + (x1 - x0) * f, y0 + (y1 - y0) * f]);
      }
      done += l;
    }
    if (even.length < 2) return null;
    return even.map((_, k) => {
      let x = 0;
      let y = 0;
      let sum = 0;
      for (let o = -3; o <= 3; o++) {
        const q = even[clamp(k + o, 0, even.length - 1)];
        const w = Math.exp(-(o * o) / 4.5);
        x += q[0] * w;
        y += q[1] * w;
        sum += w;
      }
      return [x / sum, y / sum];
    });
  }

  async function loadBuildings() {
    try {
      const res = await fetch('buildings', { cache: 'no-store' });
      if (res.status === 204) {
        hasBuildings = picture.setBuildings(null);
        hasRoads = picture.setRoads(null);
        streets = null;
        onStreet = null;
        return;
      }
      if (!res.ok) return;
      const doc = await res.json();
      if (doc && Array.isArray(doc.b)) {
        hasBuildings = picture.setBuildings(doc.b);
        const rows = Array.isArray(doc.r) ? doc.r : [];
        hasRoads = picture.setRoads(rows);
        streets = indexStreets(rows);
        onStreet = null;
        buildingsOrigin = doc.o;
        rebuilt = true;
      }
    } catch {
      // The next pick tries again.
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
    for (const b of menu.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(options.view === b.dataset.view));
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
        body: JSON.stringify({ eta: options.eta, speed: options.speed, turns: options.turns, pulses: options.pulses,
          bright: options.bright, buildings: options.buildings, view: options.view }),
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
    const viewChoice = e.target.closest('[data-view]');
    if (option) choose({ ...options, [option.dataset.option]: !options[option.dataset.option] });
    else if (bright) choose({ ...options, bright: bright.dataset.bright });
    else if (viewChoice) choose({ ...options, view: viewChoice.dataset.view });
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
