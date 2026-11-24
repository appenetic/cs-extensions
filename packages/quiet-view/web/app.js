// The quiet view: a glow in the ambient lights' colour over a dark screen and a
// road at night, its two lane lines fine filaments of light that run into the
// haze, with streaks of light flowing down them towards the driver at the pace
// of the car. The lines mark the path the car would drive at the steering
// wheel's angle; the line on the signalled side brightens with the indicator.
// The buildings around the car stand in the haze behind. The speedometer with
// the next turn's arrow beside it, and the arrival with the route's progress
// under it, sit quietly on top and fade as they come and go; on arriving, the
// road ends in a ring of light with the drive's summary. The picture wakes
// from black when the page opens. A long press offers what to show. A WebGL
// shader draws the picture in true perspective, with a filmic roll-off and a
// little grain so the dark gradients do not band; on a slow GPU it draws fewer
// pixels, and without WebGL a plainer canvas picture stands in. The service
// streams what the car shows (events), and answers /state while the stream is
// down.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const menu = $('menu');
  const BRIGHT = { auto: 1, high: 1.3, low: 0.6 };
  // The neon style's lines, as in the shader.
  const NEON_LINE = [255, 199, 31];

  // What is shown eases towards what the car shows: colour, brightness, the
  // path's curvature (1/m, right positive) and the streaks' pace (m/s).
  // travel is the distance the streaks have run, so a new pace never makes
  // them jump.
  // The light's colour: rgb eases towards the car's (light); a new colour far
  // from it washes in from the horizon instead, over 1.8 s, the old one
  // (washFrom) still outside the front while wash runs from 0 to 1.
  let rgb = [255, 255, 255];
  let light = null;
  let washFrom = rgb;
  let wash = 1;
  let painted = '';
  let glow = 1;
  let glowGoal = 1;
  let curv = 0;
  let curvRate = 0;
  let target = 0;
  let pace = 0;
  let paceGoal = 0;
  let travel = 0;
  // 0 on the road, 1 arrived; it eases in over a few seconds.
  let arrive = 0;
  let arriveGoal = 0;
  // Seconds since the first data: the picture wakes from black over 1.6 s and
  // the path grows out from the car.
  let awake = 0;
  // 0 the fine lines, 1 the soft beams of the original; it crossfades.
  let look = 0;
  let lookGoal = 0;
  // 0 in the ambient lights' colour, 1 the neon city at dusk; it crossfades.
  let neon = 0;
  let neonGoal = 0;
  // The neon sun's own heading in the world, and the view's: while the car
  // turns the sun stays put, like the city and the stars; on the straight it
  // comes round after the road, at most 3° a second while it is in the
  // picture, 12° while it is out of it, so it soon sets ahead again. Without
  // a fix both stay.
  let sky = null;
  let heading = 0;
  let turning = 0;
  let state = null;
  let lastState = 0;
  let lastFrame = 0;
  let options = { eta: true, speed: true, turns: true, pulses: true, bright: 'auto', buildings: true, look: 'fine',
    style: 'ambient' };
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

  // The steering wheel's angle (right positive) as the curvature of the path
  // the car would drive, in 1/m: the road wheels turn about a tenth as far as
  // the steering wheel, on a 2.89 m wheelbase. 2° bends the path a little over
  // 60 m, 180° turns it on a radius of about 9 m. Under 0.3°, the sensor's
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

  // A critically damped spring towards a target (as game engines smooth a
  // camera): the value moves with a steady speed, without steps or overshoot,
  // and trails a moving target by about the smoothing time. Stable for any
  // frame time. Returns the new value and its rate.
  function spring(value, rate, goal, smoothing, dt) {
    const omega = 2 / smoothing;
    const x = omega * dt;
    const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const change = value - goal;
    const pull = (rate + omega * change) * dt;
    return [goal + (change + pull) * decay, (rate - omega * pull) * decay];
  }

  // Where the path heads: the steering wheel alone. Without its angle (in Park
  // it can be invalid) the path straightens.
  function targetFor(v) {
    return typeof v.steer === 'number' ? steerCurvature(v.steer) : 0;
  }

  // ---- The picture ----

  // The neon style's sky, t of the way from the horizon (0) to the top (1),
  // bx the share of the half width from the sun; and its band of pink haze
  // along the horizon, dy pixels below it. The sun stands where the view,
  // turned sky radians from the sky's own heading, sees bearing 0; off the
  // picture beyond 75°. The sky and the haze the city stands in share them.
  // Colours are before the roll-off.
  const DUSK_SKY = `
float sunAt(float sky, float w) {
  return 0.5 * w - 0.78 * w * tan(clamp(sky, -1.3, 1.3));
}
vec3 duskSky(float t, float bx) {
  vec3 col = mix(vec3(0.60, 0.13, 0.34), vec3(0.34, 0.05, 0.30), smoothstep(0.0, 0.3, t));
  col = mix(col, vec3(0.13, 0.025, 0.19), smoothstep(0.2, 0.65, t));
  col = mix(col, vec3(0.035, 0.012, 0.08), smoothstep(0.55, 1.0, t));
  return col * (0.7 + 0.3 * exp(-bx * bx * 2.0));
}
vec3 duskHaze(float dy, float h, float bx) {
  float hz = dy / (0.03 * h);
  return vec3(0.85, 0.24, 0.5) * 0.22 * exp(-hz * hz) * (0.55 + 0.45 * exp(-bx * bx * 3.0));
}`;

  // A camera 1.25 m above the middle of a 3.5 m lane, the horizon at 58 % of
  // the height; a pixel below the horizon sees the ground z metres ahead. The
  // lines mark the path the car would drive, like a backup camera's guides: a
  // circle through the car for the steering's curvature, its lines circles
  // 1.75 m inside and outside, so the lane keeps its width round the bend. The
  // path shows for about 60 m and no further than it turns back. Streaks of
  // light 24 m apart run down it. Line widths come from screen derivatives
  // where the GPU has them, so a line keeps its width whichever way it runs.
  // In the soft look, as in the original, each line is a broad band of light
  // on the ground instead, swelling as the streaks would pass. In the neon
  // style a retro city at dusk takes the glow's place, its lines in yellow.
  const FRAGMENT = `
#ifdef GL_OES_standard_derivatives
#extension GL_OES_standard_derivatives : enable
#endif
precision highp float;
uniform vec2 uRes;
uniform vec3 uColor;
uniform vec3 uColorOld;
uniform float uWave;
uniform float uGlow;
uniform float uCurv;
uniform float uTravel;
uniform float uStreaks;
uniform vec2 uBlink;
uniform float uBreath;
uniform float uSeed;
uniform float uArrive;
uniform float uTime;
uniform float uLook;
uniform float uReach;
uniform float uNeon;
uniform float uSky;
uniform float uStars;

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

// A number from 0 to 1 for whole numbers, the same for the same ones.
float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
` + DUSK_SKY + `

// The neon style's sky at dusk and the wet road under it: deep indigo
// overhead, through magenta to hot pink along the horizon; stars, a few
// bright, most faint, slowly twinkling, fixed by bearing as the car turns
// (uStars, its heading); and a sun half set on the horizon, low enough to
// stay below the arrival, that keeps its place while the car turns (uSky).
// The road mirrors the haze and the sun in a rippled column.
vec3 dusk(vec2 px, float w, float h, float f) {
  float yH = 0.58 * h;
  float dy = px.y - yH;
  float sx0 = sunAt(uSky, w);
  float bx = (px.x - sx0) / (0.5 * w);
  vec3 col;
  if (dy < 0.0) {
    float t = -dy / yH;
    col = duskSky(t, bx);
    // Stars by bearing and height, 200 cells to a full turn.
    vec2 sky = vec2(uStars + atan((px.x - 0.5 * w) / f), atan(-dy / f)) * (200.0 / 6.2831853);
    vec2 cell = floor(sky);
    float n = hash(vec2(mod(cell.x, 200.0), cell.y) + 17.0);
    if (n > 0.8) {
      vec2 at = 0.15 + 0.7 * vec2(fract(n * 13.7), fract(n * 71.3));
      float d = length(fract(sky) - at) * (6.2831853 / 200.0) * f;
      float b = 0.08 + 0.9 * pow(fract(n * 37.1), 4.0);
      float twinkle = 0.75 + 0.25 * sin(uTime * (0.5 + fract(n * 5.3)) + n * 40.0);
      col += vec3(1.0, 0.9, 0.97) * b * twinkle * exp(-d * d / 0.8) * smoothstep(0.08, 0.3, t);
    }
    // The sun: pale yellow on top, pink where it sets, and its glow.
    float R = 0.095 * h;
    float r = length(vec2(px.x - sx0, dy));
    vec3 sun = mix(vec3(1.6, 0.42, 0.55), vec3(1.7, 1.25, 0.6), smoothstep(0.0, 0.9, -dy / R));
    float disc = 1.0 - smoothstep(R - 1.0, R + 1.0, r);
    col = mix(col, sun, disc);
    col += (1.0 - disc) * (vec3(1.0, 0.35, 0.5) * 0.45 * exp(-max(r - R, 0.0) / (0.3 * R))
      + vec3(0.7, 0.16, 0.4) * 0.2 * exp(-r * r / (4.0 * R * R)));
  } else {
    col = mix(vec3(0.15, 0.03, 0.16), vec3(0.012, 0.004, 0.028), smoothstep(0.0, 0.3 * h, dy));
    // The column under the sun, broken by ripples that come closer together
    // towards the horizon until they are too fine to show and sway its edges;
    // and the haze's broader sheen.
    float wave = 30.0 * log(max(dy, 1.0) / h);
    float sway = sin(1.7 * wave + uTime * 0.7) * 0.012 * h;
    float sx = (px.x - sx0 + sway) / (0.065 * h);
    float ripple = mix(0.7, 0.55 + 0.3 * sin(wave + uTime * 0.9) + 0.25 * sin(2.3 * wave - uTime * 1.3),
      smoothstep(8.0, 30.0, dy));
    col += vec3(1.0, 0.5, 0.5) * 0.42 * exp(-sx * sx) * exp(-dy / (0.22 * h)) * smoothstep(0.0, 0.02 * h, dy) * ripple;
    float wx = (px.x - sx0) / (0.3 * w);
    col += vec3(0.6, 0.14, 0.4) * 0.12 * exp(-wx * wx) * exp(-dy / (0.12 * h));
  }
  return col + duskHaze(dy, h, bx);
}

// One line of the path, c metres right of its middle, seen from a pixel Y
// rows below the horizon: its distance in pixels across the screen, its metres
// per pixel, and how far along the path its nearest point on the screen lies.
// All taken from the line's own slope on the screen beside the pixel, not the
// ground's at the pixel, so its light is even on both sides however fast the
// ground shrinks, and a streak lights the halo along the line rather than in
// level bars. A radius of 0 is the gentle path's parabola.
vec3 lineAt(float c, float Y, float x, float z, float lateral, float rad, float f) {
  float off = lateral - c;
  if (rad == 0.0) {
    vec2 g = vec2(1.25, 0.5 * uCurv * z * z - c) / Y;
    float yF = max(Y - off * g.y / dot(g, g), 0.25);
    return vec3(abs(off) / (abs(g.x) + abs(g.y)), abs(g.x) + abs(g.y), f * 1.25 / yF);
  }
  // Mirrored so that the bend's centre lies to the right, at (rad, 0); the
  // line's nearest point on the ground lies on the same radius.
  float sg = sign(uCurv);
  float xs = x * sg;
  vec2 n = normalize(vec2(xs - rad, z));
  float lr = rad - c * sg;
  float xq = rad + n.x * lr;
  float zq = max(n.y * lr, 0.05);
  vec2 g = vec2(-1.25 * n.x, xq * n.x + zq * n.y) * zq / (f * 1.25);
  vec2 foot = vec2(xs * Y / 1.25, Y) - off * sg * g / max(dot(g, g), 1e-12);
  float yF = max(foot.y, 0.25);
  float aF = rad * atan(f * 1.25 / yF, rad - foot.x * 1.25 / yF);
  return vec3(abs(off) / (abs(g.x) + abs(g.y)), abs(g.x) + abs(g.y), aF);
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  float w = uRes.x;
  float h = uRes.y;
  // A new colour washes in from the horizon: the new one inside a front that
  // grows from the vanishing point, the old one still outside it.
  float far = length((px - vec2(0.5 * w, 0.58 * h)) / w * vec2(1.0, 1.4));
  float front = uWave * 0.95;
  vec3 C = mix(uColorOld, uColor, 1.0 - smoothstep(front - 0.18, front, far));
  vec3 col = C * 0.012;
  vec2 g = (px - vec2(0.5 * w, 0.30 * h)) / vec2(0.62 * w, 0.30 * h);
  col += C * exp(-dot(g, g) * 1.8) * (0.40 + 0.07 * uBreath + 0.10 * uArrive);
  float yH = 0.58 * h;
  float by = (px.y - yH) / (0.010 * h);
  float bx = (px.x - 0.5 * w) / (0.32 * w);
  col += C * exp(-by * by) * exp(-bx * bx) * 0.12;
  float dy = px.y - yH;
  float f = 0.78 * w;
  if (uNeon > 0.001) col = mix(col, dusk(px, w, h, f), uNeon);
  // The lines' colour.
  vec3 L = mix(C, vec3(1.0, 0.78, 0.12), uNeon);
  float z = f * 1.25 / max(dy, 0.25);
  float mpp = z / f;
  float x = (px.x - 0.5 * w) * mpp;
  // Where the pixel lies against the path: metres to its right, metres along
  // it. A gentle path is a parabola, within a centimetre of the circle over
  // 75 m and precise on the straight, so nothing snaps as the wheel passes
  // the middle.
  float lateral = x - 0.5 * uCurv * z * z;
  float along = z;
  float turn = 1.0;
  float rad = 0.0;
  if (abs(uCurv) > 1e-3) {
    rad = 1.0 / abs(uCurv);
    float xs = x * sign(uCurv);
    float th = atan(z, rad - xs);
    lateral = (rad - length(vec2(xs - rad, z))) * sign(uCurv);
    along = rad * th;
    turn = 1.0 - smoothstep(2.0, 2.5, th);
  }
  float m = perPixel(lateral, mpp);
  float ma = perPixel(along, mpp);
  if (dy > 0.0) {
    float fog = exp(-z / 70.0);
    // The path grows out from the car as the picture wakes.
    float reach = 75.0 * uReach;
    float path = (1.0 - smoothstep(reach - 30.0, reach, along)) * turn;
    // On arrival the path ends 26 m ahead, in a ring of light.
    float aEnd = mix(600.0, 26.0, uArrive);
    float ends = 1.0 - uArrive * smoothstep(aEnd - 8.0, aEnd + 1.0, along);
    // A streak's head is crisp on the line, though no softer than a pixel and
    // a half and no sharper than 1.2 m.
    float head = clamp(1.5 * ma / 24.0, 0.05, 0.2);
    float fade = uStreaks * (1.0 - uArrive);
    float fine = 1.0 - uLook;
    // The soft beams fade sooner, as in the original, or their light would
    // crowd into a bright spot where the road narrows to a few pixels.
    float soft = uLook * exp(-z / 38.0) * (1.0 - smoothstep(30.0, 62.0, along)) * ends * path;
    // In neon the broad beams are a pink glow on the wet road: yellow this
    // wide would outshine the scene, and dimmed it turns olive.
    soft *= 1.0 - 0.4 * uNeon;
    vec3 B = mix(L, vec3(1.0, 0.3, 0.62), uNeon);
    // A wet road mirrors the sky's glow: a soft column under it that rises
    // from nothing at the horizon and fades towards the car.
    float sx = (px.x - 0.5 * w) / (0.26 * w);
    col += C * 0.06 * exp(-sx * sx) * smoothstep(0.0, 0.03 * h, dy) * exp(-dy / (0.18 * h)) * (1.0 - uNeon);
    for (int i = 0; i < 2; i++) {
      float side = i == 0 ? -1.0 : 1.0;
      vec3 ln = lineAt(side * 1.75, max(dy, 0.25), x, z, lateral, rad, f);
      float d = ln.x;
      float wpx = 0.04 / ln.y;
      float coreW = max(1.1, wpx);
      // The streak as at the line's nearest point, where the pixel's light
      // comes from. In the halo it blurs over the halo's width and the
      // pixel's distance, as a glow gathers more of the line the further it
      // is from it; far off only the streaks' mean remains.
      float s = fract((ln.z + uTravel) / 24.0);
      float streak = fade * smoothstep(0.0, head, s) * pow(1.0 - smoothstep(0.03, 0.42, s), 1.5);
      float blur = clamp((0.008 * w + d) * ma / 24.0, 0.05, 1.0);
      float glint = fade * mix(smoothstep(0.0, blur, s) * pow(1.0 - smoothstep(0.03, 0.42 + blur, s), 1.5), 0.16,
        smoothstep(0.25, 0.7, blur));
      // The light also keeps within a few metres of its line on the ground,
      // should the distance on the screen fail far from it.
      float dl = abs(lateral - side * 1.75);
      float close = exp(-dl * dl / 2.0);
      float wide = exp(-dl * dl / 18.0);
      float core = exp(-d * d / (coreW * coreW)) * min(1.0, wpx / 1.1 + 0.2);
      float blink = i == 0 ? uBlink.x : uBlink.y;
      float gain = (1.0 + 1.5 * blink) * fog * ends * path * fine;
      vec3 hot = mix(L, vec3(1.0), (0.55 + 0.25 * blink) * (1.0 - 0.45 * uNeon));
      // The streak lights the line and its near halo; the wide halo stays
      // even, or the streak's edge would draw a line across the screen.
      col += hot * core * (0.34 + 1.3 * streak) * gain * close;
      col += L * exp(-d / (0.008 * w)) * 0.30 * (0.34 + 0.9 * glint) * gain * close;
      col += L * exp(-d / (0.045 * w)) * 0.034 * gain * wide;
      // The soft look, as in the original: a broad band of light on the
      // ground about the line, its width in metres, so the perspective
      // narrows it, round a brighter heart. The streaks run down the heart
      // as long, soft pulses, so they do not light a bar across the road;
      // where they come closer together than the pixels can show, only
      // their mean remains.
      float sb = dl / 0.8;
      float sc = dl / 0.3;
      float ps = fract((along + uTravel) / 24.0);
      float pulse = fade * mix(0.3, smoothstep(0.0, 0.15, ps) * (1.0 - smoothstep(0.15, 0.65, ps)),
        smoothstep(6.0, 20.0, 24.0 / ma));
      float beam = 0.55 * exp(-0.5 * sb * sb) + exp(-0.5 * sc * sc) * (0.3 + 0.7 * pulse);
      col += mix(B, vec3(1.0), 0.06 + 0.12 * blink) * beam * (1.0 + 0.9 * blink) * soft;
    }
    // Between the beams the road holds a little of their light.
    float mid = lateral / 1.6;
    col += B * 0.035 * exp(-mid * mid * mid * mid) * soft;
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
      // Halo and wave keep to a few metres on the ground, like the lines' light.
      float halo = exp(-e / (fw * 14.0)) * exp(-e * e / 18.0) * 0.22;
      float phase = fract(uTime / 3.2);
      float front = len - r - phase * 7.0;
      float wv = front / max(0.12, 1.5 * fw);
      float wave = exp(-wv * wv) * exp(-front * front / 2.0) * (1.0 - phase) * (1.0 - phase) * 0.5;
      float pr = len / r;
      float pool = exp(-pr * pr * 1.4) * 0.10;
      vec3 hot = mix(L, vec3(1.0), 0.6);
      // The haze at the pixel's own distance, and nothing far beyond the ring.
      float near = fog * (1.0 - smoothstep(aEnd + 6.0, aEnd + 30.0, along));
      col += (hot * ring + L * (halo + wave + pool)) * uArrive * near;
    }
  }
  vec2 q = px / uRes - 0.5;
  col *= 1.0 - 0.35 * smoothstep(0.35, 0.85, length(q * vec2(1.25, 1.0)));
  col = 1.0 - exp(-col * 1.6 * uGlow);
  col += (grain(px + uSeed) - 0.5) / 170.0;
  gl_FragColor = vec4(col, 1.0);
}`;

  // The buildings around the car, from the same camera, after the road: a
  // city at night. Their walls are dark silhouettes against the glow, each
  // pixel darkened once, for the nearest wall, however many stand in a row;
  // lighter towards the ground, where they stand in the haze and the street's
  // light rises up their feet, and darker where a wall faces the camera than
  // where it is seen edge-on, so the blocks read as blocks. Their windows lie
  // in floors of 3.3 m, one every 2.6 m along a wall; about one in six is lit,
  // in the light's colour, warmer. Where the windows come closer together
  // than the pixels can show, only their faint mean remains, so nothing
  // shimmers. Their roof edges are fine lines of the light, the corners
  // fainter, drawn on the nearest wall's own pixels: nothing behind shows
  // through, and two walls' lines meet at their corner without overlapping.
  // Each wall fades out over its last pixel at the top and the foot, so the
  // outlines stay smooth at any angle without the GPU's antialiasing, which
  // would cost every pixel of the road too. All fade in
  // from 40 m, so those beside the car stay out of the way, thin out into the
  // haze and are gone before the edge of what the service picked (450 m around
  // the car, picked again every 60 m); when they first appear, they grow out
  // of the ground. Points are metres east and north in the service's frame,
  // and up, each with how far up its wall it lies (0 to 1).
  const BUILDING_CAMERA = `
uniform vec2 uCam;
uniform vec2 uDir;
uniform vec4 uView;
// A point on the screen. uView: focal length, width, height and horizon, in
// pixels; depth runs from 5 m to 3 km.
vec4 project(vec3 p) {
  vec2 d = p.xy - uCam;
  float ahead = dot(d, uDir);
  float right = d.x * uDir.y - d.y * uDir.x;
  float up = p.z - 1.25;
  return vec4(right * 2.0 * uView.x / uView.y,
    (1.0 - 2.0 * uView.w / uView.z) * ahead + up * 2.0 * uView.x / uView.z,
    ahead * 3005.0 / 2995.0 - 30000.0 / 2995.0, ahead);
}`;

  const BUILDING_SEEN = `
#ifdef GL_OES_standard_derivatives
#extension GL_OES_standard_derivatives : enable
#endif
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform float uFade;
// How much of a building at d metres is there: from 40 m on, gone by 390 m.
float present(float d) {
  return uFade * smoothstep(40.0, 140.0, d) * (1.0 - smoothstep(310.0, 390.0, d));
}
// And how much of it shows through the haze.
float seen(float d) {
  return present(d) * exp(-d / 260.0);
}`;

  // aWall is the wall's run on the ground; aFace its metres along from its
  // start, a whole number of its own (0 to 96) for its windows, and its
  // building's height; aEnds 1 for each end of it that is a corner, and its
  // building's own number from 0 to 1.
  const WALL_VERTEX = BUILDING_CAMERA + `
attribute vec4 aPos;
attribute vec2 aWall;
attribute vec3 aFace;
attribute vec3 aEnds;
uniform float uRise;
// 1 for the walls' mirror image in the wet road.
uniform float uMirror;
varying vec2 vRel;
varying vec2 vNormal;
varying float vHeight;
varying float vUp;
varying vec3 vFace;
varying float vLength;
varying vec3 vEnds;
void main() {
  gl_Position = project(vec3(aPos.xy, aPos.z * uRise * (1.0 - 2.0 * uMirror)));
  vRel = aPos.xy - uCam;
  vNormal = vec2(aWall.y, -aWall.x) / max(length(aWall), 0.001);
  vHeight = aPos.z;
  vUp = aPos.w;
  vFace = aFace;
  vLength = length(aWall);
  vEnds = aEnds;
}`;

  const WALL_FRAGMENT = BUILDING_SEEN + DUSK_SKY + `
uniform vec3 uLight;
uniform float uShade;
// The lines' colour, and their strength.
uniform vec4 uEdge;
// 1 while only the walls' depth is drawn.
uniform float uDepth;
// 0 in the ambient lights' colour, 1 the neon city.
uniform float uNeon;
// How strongly the mirror image in the wet road shows, 0 for the walls
// themselves; and the time, for its ripples.
uniform float uReflect;
uniform float uShimmer;
// The picture's width and height in pixels, and how far the view is turned
// from the sky's heading, in radians.
uniform vec2 uScreen;
uniform float uSky;
varying vec2 vRel;
varying vec2 vNormal;
varying float vHeight;
varying float vUp;
varying vec3 vFace;
varying float vLength;
varying vec3 vEnds;
// A number from 0 to 1 for whole numbers, the same for the same ones.
float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
void main() {
  float d = length(vRel);
  float face = abs(dot(vNormal, vRel)) / max(d, 0.001);
  float fog = seen(d);
  // In the neon city the walls stay solid into the distance and take on the
  // colour of the haze before them instead, the sky's where they meet it,
  // their feet deeper in it; only at the end of the buildings picked do they
  // fade. So they hide the sun, as do those near the car that are still
  // fading in, wherever they stand before it: its disc and the glow close
  // round it.
  float low = smoothstep(0.0, 10.0, vHeight);
  vec2 at = vec2(gl_FragCoord.x, uScreen.y - gl_FragCoord.y);
  float dy = at.y - 0.58 * uScreen.y;
  float sunX = 0.0;
  float solid = 0.0;
  if (uNeon > 0.001) {
    sunX = sunAt(uSky, uScreen.x);
    float R = 0.095 * uScreen.y;
    float r = length(vec2(at.x - sunX, dy));
    float sun = max(1.0 - smoothstep(R - 1.0, R + 1.0, r), 0.6 * exp(-max(r - R, 0.0) / (0.3 * R)))
      * step(dy, 0.0) * smoothstep(25.0, 40.0, d);
    solid = uFade * (1.0 - smoothstep(370.0, 390.0, d)) * max(smoothstep(40.0, 140.0, d), sun);
  }
  float a = mix(uShade * fog * (0.8 + 0.2 * face) * mix(0.35, 1.0, low), solid, uNeon);
  // A wall too faint to see hides nothing either.
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
  // Only a pixel mostly covered hides what lies behind it; for the depth
  // alone, nothing more is needed.
  if (uDepth > 0.5) {
    if (cover < 0.5) discard;
    gl_FragColor = vec4(0.0);
    return;
  }
  // The windows, centred on the wall, above the ground floor and below the
  // parapet of a building over 6 m.
  float cells = floor(vLength / 2.6);
  vec2 g = vec2((vFace.x - 0.5 * (vLength - cells * 2.6)) / 2.6, (vHeight - 0.8) / 3.3);
  vec2 cell = floor(g);
  vec2 f = g - cell;
  // The wall's number is whole at its corners; rounded, it stays so between
  // them, or the hash would turn the smallest wobble into stripes.
  float n = hash(cell + vec2(13.0, 7.0) * floor(vFace.y + 0.5));
  // In the neon city each building is one of three kinds by its own number:
  // its floors banded in cyan light, a tower of warm lit rooms, or dark with
  // its roof edge in neon. The tower's rooms light up as the style comes.
  float kind = vEnds.z;
  float banded = uNeon * step(kind, 0.35);
  float tower = uNeon * step(0.35, kind) * step(kind, 0.65);
  float lit = step(mix(0.83, 0.42, tower), n) * (0.45 + 0.55 * fract(n * 7.13));
#ifdef GL_OES_standard_derivatives
  vec2 fw = max(vec2(fwidth(g.x), fwidth(g.y)), vec2(1e-4));
#else
  vec2 fw = vec2(1.0);
#endif
  float pane = (smoothstep(0.25 - fw.x, 0.25 + fw.x, f.x) - smoothstep(0.75 - fw.x, 0.75 + fw.x, f.x))
    * (smoothstep(0.22 - fw.y, 0.22 + fw.y, f.y) - smoothstep(0.78 - fw.y, 0.78 + fw.y, f.y));
  // A lit pane glows a little onto the wall around it.
  vec2 beyond = max(abs(f - 0.5) - vec2(0.25, 0.28), 0.0);
  float halo = exp(-dot(beyond, beyond) / 0.006) * 0.35;
  float onWall = step(0.0, g.x) * step(g.x, cells) * step(1.0, g.y) * step(vHeight, vFace.z - 1.2) * step(6.0, vFace.z);
  float windows = onWall * mix(0.045 * (1.0 + 2.0 * tower), (pane + halo) * lit,
    smoothstep(2.5, 6.0, 1.0 / max(fw.x, fw.y)));
  // Some rooms are lit warmer, some more in the light's colour; in the neon
  // city peach, a few pink.
  vec3 room = mix(mix(uLight, vec3(1.0, 0.9, 0.78), 0.25 + 0.5 * fract(n * 3.7)),
    mix(vec3(1.0, 0.72, 0.42), vec3(1.0, 0.45, 0.8), step(0.75, fract(n * 3.7))), uNeon);
  // Light from below: the street's glow on the feet of the walls, more on
  // those that face the road; pink in the neon city.
  float foot = exp(-vHeight / 4.0) * (0.4 + 0.6 * face);
  // A banded building's floors: a line of cyan light at each, a pixel or so
  // wide, only their faint mean where the floors come too close together.
#ifdef GL_OES_standard_derivatives
  float storey = 3.3 / max(length(vec2(dFdx(vHeight), dFdy(vHeight))), 1e-5);
#else
  float storey = 0.0;
#endif
  float slab = abs(fract(g.y + 0.5) - 0.5) * storey;
  float floors = mix(0.12, exp(-slab * slab / 1.2), smoothstep(3.0, 8.0, storey))
    * step(1.0, g.y) * step(vHeight, vFace.z - 0.5) * banded;
  vec3 glow = room * windows * mix(0.6, 0.8, uNeon) + mix(uLight * 0.06, vec3(0.85, 0.25, 0.75) * 0.05, uNeon) * foot
    + vec3(0.25, 0.85, 1.0) * floors * 0.45;
  // The roof edge, a line along the wall's top pixels, and the corners, half
  // on each wall that meets there and fainter towards the ground. On a wall
  // only a few pixels high or wide they would fill it, so they leave it.
  float roof = exp(-(top - 0.6) * (top - 0.6) / 0.7) * smoothstep(2.5, 6.0, tall);
  float start = vFace.x * metre;
  float end = (vLength - vFace.x) * metre;
  float corner = max(vEnds.x * exp(-start * start / 0.7), vEnds.y * exp(-end * end / 0.7))
    * mix(0.2, 1.0, vUp) * smoothstep(3.0, 8.0, vLength * metre);
  // In the neon city the lines are cyan or pink by the building, and stronger.
  vec3 trim = mix(vec3(1.0, 0.32, 0.78), vec3(0.3, 0.88, 1.0), step(kind, 0.35) + step(0.82, kind));
  vec3 edge = mix(uEdge.rgb, trim, uNeon) * uEdge.a * fog
    * max(mix(1.1, 1.5, uNeon) * roof, mix(0.3, 0.5, uNeon) * corner);
  // The mirror image: only what shines, broken by ripples and fainter
  // further from the wall's foot, with a little of the walls' dark.
  if (uReflect > 0.0) {
    float ripple = 0.55 + 0.45 * sin(vHeight * 1.9 - uShimmer * 1.2) * sin(vHeight * 0.7 + uShimmer * 0.5);
    gl_FragColor = vec4((glow * fog + edge) * uReflect * ripple * exp(-vHeight / 25.0), a * 0.35 * uReflect) * cover;
    return;
  }
  // Dark glass, tinted by the light, or violet in the haze, and what shines
  // from it, premultiplied.
  vec3 tint = uLight * 0.025;
  if (uNeon > 0.001) {
    float bx = (at.x - sunX) / (0.5 * uScreen.x);
    vec3 haze = duskSky(max(-dy / (0.58 * uScreen.y), 0.0), bx) * exp(-max(dy, 0.0) / (0.08 * uScreen.y))
      + duskHaze(dy, uScreen.y, bx);
    vec3 violet = vec3(0.09, 0.03, 0.17) * (1.3 - 0.3 * face);
    float clear = exp(-d / 260.0) * mix(0.5, 1.0, low) * (1.0 - smoothstep(300.0, 380.0, d));
    tint = mix(tint, mix(haze, violet, clear), uNeon);
  }
  gl_FragColor = vec4(tint * a + glow * fog + edge, a) * cover;
}`;

  // The service's lines as walls: per line its height, its base, 1 when
  // closed, then its points. A wall vertex carries its point and how far up
  // the wall it lies, the wall's direction on the ground, its face (metres
  // along, a number from where it starts, the height), its corners (those of
  // its ends where the outline turns by more than 25°; an open line's ends lie
  // on a tile's border and are none) and its building's own number.
  function buildingGeometry(lines) {
    const walls = [];
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
      const kind = (seed(y(0), x(0)) + 0.5) / 97;
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
          walls.push(x(k), y(k), up ? top : base, up, dx, dy, k === i ? 0 : len, own, top, corner[i], corner[j], kind);
        }
      }
    }
    return new Float32Array(walls);
  }

  function webglPicture(canvas) {
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: true, stencil: false,
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
    const road = link('attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }', FRAGMENT, ['p'],
      ['uRes', 'uColor', 'uColorOld', 'uWave', 'uGlow', 'uCurv', 'uTravel', 'uStreaks', 'uBlink', 'uBreath', 'uSeed',
        'uArrive', 'uTime', 'uLook', 'uReach', 'uNeon', 'uSky', 'uStars']);
    if (!road) return null;
    const u = road.u;
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    // The buildings: without their shaders the picture goes on without them.
    const camera = ['uCam', 'uDir', 'uView', 'uFade'];
    const wallsGL = link(WALL_VERTEX, WALL_FRAGMENT, ['aPos', 'aWall', 'aFace', 'aEnds'],
      [...camera, 'uRise', 'uLight', 'uShade', 'uEdge', 'uDepth', 'uNeon', 'uMirror', 'uReflect', 'uShimmer', 'uScreen',
        'uSky']);
    let walls = null;
    // A buffer of vertices with their attributes' sizes, interleaved.
    const upload = (data, sizes) => {
      const stride = sizes.reduce((a, b) => a + b, 0);
      if (!data.length) return null;
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      return { b, n: data.length / stride, sizes, stride };
    };
    const use = (x, program, p, r) => {
      gl.useProgram(program.pr);
      gl.uniform2f(program.u.uCam, p.cam.x, p.cam.y);
      gl.uniform2f(program.u.uDir, Math.sin(r), Math.cos(r));
      gl.uniform4f(program.u.uView, 0.78 * canvas.width, canvas.width, canvas.height, 0.58 * canvas.height);
      gl.uniform1f(program.u.uFade, p.buildings);
      gl.uniform1f(program.u.uRise, p.rise);
      gl.bindBuffer(gl.ARRAY_BUFFER, x.b);
      let offset = 0;
      x.sizes.forEach((size, i) => {
        gl.enableVertexAttribArray(i);
        gl.vertexAttribPointer(i, size, gl.FLOAT, false, x.stride * 4, offset * 4);
        offset += size;
      });
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
        if (walls) gl.deleteBuffer(walls.b);
        walls = null;
        if (!wallsGL || !lines) return false;
        walls = upload(buildingGeometry(lines), [4, 2, 3, 3]);
        return !!walls;
      },
      draw(p) {
        gl.useProgram(road.pr);
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.uniform2f(u.uRes, canvas.width, canvas.height);
        gl.uniform3f(u.uColor, p.rgb[0] / 255, p.rgb[1] / 255, p.rgb[2] / 255);
        gl.uniform3f(u.uColorOld, p.old[0] / 255, p.old[1] / 255, p.old[2] / 255);
        gl.uniform1f(u.uWave, p.wave);
        gl.uniform1f(u.uLook, p.look);
        gl.uniform1f(u.uNeon, p.neon);
        gl.uniform1f(u.uSky, p.sky);
        gl.uniform1f(u.uStars, ((p.heading % 360) * Math.PI) / 180);
        gl.uniform1f(u.uReach, p.reach);
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
        if (!walls || !p.cam || p.buildings < 0.01) return;
        const r = (p.cam.h * Math.PI) / 180;
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        // The walls: first their depth alone, then their shade where each is
        // the nearest, with their lines in a colour nearer white. In neon the
        // wet road mirrors them first, under the horizon.
        use(walls, wallsGL, p, r);
        const hot = p.shown.map((c) => (c + (255 - c) * 0.35) / 255);
        gl.uniform3f(wallsGL.u.uLight, p.shown[0] / 255, p.shown[1] / 255, p.shown[2] / 255);
        gl.uniform1f(wallsGL.u.uShade, 0.7);
        gl.uniform4f(wallsGL.u.uEdge, hot[0], hot[1], hot[2], Math.min(1.2, p.glow));
        gl.uniform1f(wallsGL.u.uNeon, p.neon);
        gl.uniform1f(wallsGL.u.uShimmer, p.time % 3600);
        gl.uniform2f(wallsGL.u.uScreen, canvas.width, canvas.height);
        gl.uniform1f(wallsGL.u.uSky, p.sky);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        for (const mirror of p.neon > 0.01 ? [1, 0] : [0]) {
          gl.depthMask(true);
          gl.clear(gl.DEPTH_BUFFER_BIT);
          gl.uniform1f(wallsGL.u.uMirror, mirror);
          gl.uniform1f(wallsGL.u.uReflect, mirror * 0.35 * p.neon);
          gl.uniform1f(wallsGL.u.uDepth, 1);
          gl.colorMask(false, false, false, false);
          gl.drawArrays(gl.TRIANGLES, 0, walls.n);
          gl.colorMask(true, true, true, true);
          gl.uniform1f(wallsGL.u.uDepth, 0);
          gl.depthMask(false);
          gl.enable(gl.BLEND);
          gl.drawArrays(gl.TRIANGLES, 0, walls.n);
          gl.disable(gl.BLEND);
        }
        gl.depthMask(true);
        gl.disable(gl.DEPTH_TEST);
        for (let i = 1; i < walls.sizes.length; i++) gl.disableVertexAttribArray(i);
      },
    };
  }

  // Without WebGL: the same scene in screen space, two soft beams for the lines;
  // in neon a magenta sky and yellow beams.
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
      setBuildings() {
        return false;
      },
      draw(p) {
        const w = canvas.width;
        const h = canvas.height;
        const glow = p.neon > 0.5 ? [255, 60, 170] : p.rgb;
        const lines = p.neon > 0.5 ? NEON_LINE : p.rgb;
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = `rgb(${glow.map((c) => Math.round(4 + c * 0.012)).join(',')})`;
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'lighter';
        const sky = ctx.createRadialGradient(w / 2, h * 0.3, 0, w / 2, h * 0.3, Math.max(w, h) * 0.4);
        sky.addColorStop(0, rgba(p, 0.42 + 0.06 * p.breath, glow));
        sky.addColorStop(1, rgba(p, 0, glow));
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, w, h);
        for (const side of [-1, 1]) {
          const blink = side < 0 ? p.left : p.right;
          const far = point(p, side, 0);
          const near = point(p, side, 1);
          const grad = ctx.createLinearGradient(far.x, far.y, near.x, near.y);
          grad.addColorStop(0, rgba(p, 0, lines));
          grad.addColorStop(1, rgba(p, 0.5 * (1 + blink), lines));
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
          ctx.strokeStyle = rgba(p, 0.7 * p.arrive, lines.map((c) => c + (255 - c) * 0.6));
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
    hasBuildings = false;
    layout();
  });

  // The share of the device's pixels drawn: lower on a renderer in software,
  // and lower again while frames take longer than about 26 ms. The first 90
  // frames, and the first 90 after a pause, are not judged: the page's start
  // and the pause itself would count as slow frames.
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
    if (lastFrame && s - lastFrame > 0.5) measured = measureStart = 0;
    const dt = lastFrame ? Math.min(0.1, s - lastFrame) : 0;
    lastFrame = s;
    // Without fresh state the road straightens and the streaks slow down.
    const fresh = (source && source.readyState === 1) || performance.now() - lastState < 3000;
    // The steering angle comes about 30 times a second, unevenly; a spring
    // carries the path smoothly from reading to reading, about 0.08 s behind a
    // turning wheel. Without the angle the path straightens slowly.
    const steering = state && typeof state.steer === 'number';
    [curv, curvRate] = spring(curv, curvRate, fresh ? target : 0, steering ? 0.08 : 0.6, dt);
    // The pace follows the speed over about 1.5 s and comes to a full stop,
    // the last of it at 0.4 m/s², rather than creeping on.
    const paceTo = fresh ? paceGoal : 0;
    const paceStep = Math.max(Math.abs(paceTo - pace) * Math.min(1, dt / 1.5), 0.4 * dt);
    pace = Math.abs(paceTo - pace) <= paceStep ? paceTo : pace + Math.sign(paceTo - pace) * paceStep;
    travel += dt * pace;
    arrive += (arriveGoal - arrive) * Math.min(1, dt / 2.2);
    if (state) awake = Math.min(awake + dt, 60);
    const wake = smooth(0, 1.6, awake);
    look = Math.abs(lookGoal - look) < 0.002 ? lookGoal : look + (lookGoal - look) * Math.min(1, dt / 0.7);
    neon = Math.abs(neonGoal - neon) < 0.002 ? neonGoal : neon + (neonGoal - neon) * Math.min(1, dt / 0.7);
    // Colour and brightness fade over like the lights do.
    wash = Math.min(1, wash + dt / 1.8);
    if (light && light.join() !== rgb.join()) {
      const k = Math.min(1, dt / 0.6);
      rgb = rgb.map((v, i) => (Math.abs(light[i] - v) < 1 ? light[i] : v + (light[i] - v) * k));
    }
    if (wash >= 1) washFrom = rgb;
    const washed = smooth(0, 1, wash);
    const shown = rgb.map((v, i) => washFrom[i] + (v - washFrom[i]) * washed);
    // In neon the page's own light is the lines' yellow.
    const accent = shown.map((v, i) => v + (NEON_LINE[i] - v) * neon);
    if (accent.map(Math.round).join() !== painted) paintStyles(accent);
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
    if (cam) followSky(cam.h, dt);
    const showing = hasBuildings && options.buildings && cam && cam.o === buildingsOrigin;
    buildingsFade += ((showing ? 1 : 0) - buildingsFade) * Math.min(1, dt / 1.5);
    buildingsRise = clamp(buildingsRise + (showing ? dt : -dt) / 2.2, 0, 1);
    if ((buildingsFade > 0.05) !== creditShown) {
      creditShown = !creditShown;
      $('credit').hidden = !creditShown;
    }
    picture.draw({ rgb, old: washFrom, wave: washed, shown, look, neon, reach: smooth(0.35, 2.2, awake),
      sky: sky === null ? 0 : (turnOf(heading, sky) * Math.PI) / 180, heading,
      glow: glow * wake, curv, travel, streaks: options.pulses, left, right, arrive,
      breath: 0.5 + 0.5 * Math.sin((s * Math.PI * 2) / 5), time: s, cam: showing || buildingsFade > 0.01 ? cam : null,
      buildings: buildingsFade, rise: smooth(0, 1, buildingsRise) });
    if (++measured === 90) {
      if (measureStart && (now - measureStart) / measured > 26 && quality > 0.35) {
        quality = Math.max(0.35, quality * 0.75);
        layout();
      }
      measured = 0;
      measureStart = now;
    }
    requestAnimationFrame(frame);
  }

  function followSky(h, dt) {
    const step = turnOf(h, heading);
    heading = h;
    // The first heading, or one that jumps rather than turns: the sun ahead.
    if (sky === null || Math.abs(step) > 30) {
      sky = h;
      turning = 0;
      return;
    }
    if (dt <= 0) return;
    turning += (Math.abs(step) / dt - turning) * Math.min(1, dt / 0.5);
    const off = turnOf(h, sky);
    const out = smooth(40, 52, Math.abs(off));
    const most = (3 * (1 - smooth(2, 6, turning)) * (1 - out) + 12 * out) * dt;
    sky += clamp((off * dt) / (12 - 9 * out), -most, most);
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

  // The service words a turn as "in 150 m links" or, without its direction,
  // "Abbiegen in 150 m": the distance shows large, the words under it, and the
  // arrow for what they say beside them.
  const KINDS = [[/wenden/, 180], [/Kreisverkehr/, 0, 'ring'], [/Ausfahrt/, 40, 'exit'], [/einfädeln/, 30],
    [/leicht/, 45], [/scharf/, 135], [/geradeaus/, 0], [/links|rechts/, 90]];
  function showTurn(t) {
    const text = t && typeof t.text === 'string' ? t.text : '';
    reveal($('turn'), !!text);
    if (!text) return;
    const m = /^in (\S+ \S+) (.+)$/.exec(text) || /^Abbiegen in (\S+ \S+)$/.exec(text);
    const words = m ? (m[2] || 'Abbiegen') : '';
    $('turnDist').textContent = m ? m[1] : text;
    $('turnWords').textContent = words;
    const kind = KINDS.find(([re]) => re.test(words));
    $('turnGlyph').style.display = kind ? '' : 'none';
    if (kind) {
      // A roundabout's exit lies a quarter round for the right, three quarters
      // for the left, half round without a side.
      const exit = t.side > 0 ? 90 : t.side < 0 ? 270 : 180;
      const glyph = kind[2] === 'ring' ? arrowPaths(exit, 1, 'ring')
        : arrowPaths(kind[1], t.side || (kind[1] === 180 ? -1 : 1), kind[2]);
      $('turnPath').setAttribute('d', glyph.d);
      $('turnAlso').setAttribute('d', glyph.also);
    }
    $('turn').style.setProperty('--near', String(clamp(Number(t.near) || 0, 0, 1)));
  }

  function render(v) {
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
      if (v.min) parts.push(`noch ${v.min} min`);
      if (v.dist) parts.push(v.dist);
      $('rest').textContent = parts.join(' · ');
      const progress = typeof v.progress === 'number' && v.progress >= 0;
      reveal($('progress'), progress);
      if (progress) $('progressFill').style.width = `${Math.round(Math.min(1, v.progress) * 1000) / 10}%`;
    }
    reveal($('center'), done || arrival);
    showTurn(!done && options.turns ? v.turn : null);
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
      look: o.look === 'soft' ? 'soft' : 'fine', style: o.style === 'neon' ? 'neon' : 'ambient' };
    lookGoal = options.look === 'soft' ? 1 : 0;
    neonGoal = options.style === 'neon' ? 1 : 0;
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
    // A new colour far from the one shown washes in from the horizon; while
    // one washes in, or for small steps, it eases.
    if (c && light && wash >= 1 && Math.hypot(c[0] - rgb[0], c[1] - rgb[1], c[2] - rgb[2]) > 90) {
      washFrom = rgb;
      rgb = c;
      wash = 0;
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
      // The first colour, brightness and look are there at once, as the
      // picture wakes.
      rgb = washFrom = c;
      glow = glowGoal;
      look = lookGoal;
      neon = neonGoal;
      paintStyles(c);
    }
  }

  // Where the car is, for the buildings: its last fix in the service's frame
  // and its heading, carried on between fixes by the speed and by how fast the
  // heading turned lately, and eased over about 0.35 s, so a fix never jumps.
  // A view without a fix keeps the last one while the car stands; moving, the
  // city would drive along with it.
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
    let rate = fix && fix.o === p.o ? fix.rate : 0;
    if (fix && fix.o === p.o && p.h !== fix.h) {
      const dt = (now - fix.turnedAt) / 1000;
      rate = dt < 3 ? 0.5 * rate + 0.5 * clamp(turnOf(p.h, fix.h) / Math.max(dt, 0.05), -60, 60) : 0;
    }
    const turnedAt = !fix || p.h !== fix.h ? now : fix.turnedAt;
    fix = { x: p.x, y: p.y, h: p.h, o: p.o, at: now, turnedAt, rate };
  }

  function follow(dt, now) {
    if (!fix) {
      cam = null;
      return;
    }
    const v = Math.max(0, Number.parseFloat(state && state.kmh) || 0) / 3.6;
    const age = Math.min(1.5, (now - fix.at) / 1000);
    // The turn carries the heading on for 0.3 s; a heading that then stays
    // put means the turn ended, and the carrying fades out by 0.9 s.
    const since = (now - fix.turnedAt) / 1000;
    const carry = since <= 0.3 ? since : 0.3 * Math.max(0, (0.9 - since) / 0.6);
    const h = fix.h + (v > 1 ? fix.rate * carry : 0);
    const r = (h * Math.PI) / 180;
    const tx = fix.x + v * Math.sin(r) * age;
    const ty = fix.y + v * Math.cos(r) * age;
    if (!cam || cam.o !== fix.o || Math.hypot(tx - cam.x, ty - cam.y) > 50) {
      cam = { x: tx, y: ty, h, o: fix.o };
      return;
    }
    const cr = (cam.h * Math.PI) / 180;
    cam.x += v * Math.sin(cr) * dt;
    cam.y += v * Math.cos(cr) * dt;
    const k = Math.min(1, dt / 0.35);
    cam.x += (tx - cam.x) * k;
    cam.y += (ty - cam.y) * k;
    cam.h += turnOf(h, cam.h) * k;
  }

  async function loadBuildings() {
    try {
      const res = await fetch('buildings', { cache: 'no-store' });
      if (res.status === 204) {
        hasBuildings = picture.setBuildings(null);
        return;
      }
      if (!res.ok) return;
      const doc = await res.json();
      if (doc && Array.isArray(doc.b)) {
        hasBuildings = picture.setBuildings(doc.b);
        buildingsOrigin = doc.o;
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
    for (const b of menu.querySelectorAll('[data-look]')) b.setAttribute('aria-pressed', String(options.look === b.dataset.look));
    for (const b of menu.querySelectorAll('[data-style]')) b.setAttribute('aria-pressed', String(options.style === b.dataset.style));
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
          bright: options.bright, buildings: options.buildings, look: options.look, style: options.style }),
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
    const lookChoice = e.target.closest('[data-look]');
    const styleChoice = e.target.closest('[data-style]');
    if (option) choose({ ...options, [option.dataset.option]: !options[option.dataset.option] });
    else if (bright) choose({ ...options, bright: bright.dataset.bright });
    else if (lookChoice) choose({ ...options, look: lookChoice.dataset.look });
    else if (styleChoice) choose({ ...options, style: styleChoice.dataset.style });
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
