/**
 * second pack of transitions: move / wipe / stylize. same contract as ./defs.ts, but each shader defines
 * `vec4 tr_main(vec2 uv, float p)` and wrapAll adds `transition` which returns exactly a at p = 0 and
 * exactly b at p = 1. every loop has a constant bound, at most ~24 texture reads per pixel.
 * (the 3d ones live in ./defs3d.ts)
 */
import { wrapAll } from './wrap';

/** distance from the center to a corner, in height units (aspect correct) */
const MAXR = '(0.5 * length(vec2(aspect(), 1.0)))';

const wipe = (n: string, e = '0.04') => `
vec4 tr_main(vec2 uv, float p) {
  return mix(a(uv), b(uv), reveal(p, clamp(${n}, 0.0, 1.0), ${e}));
}`;

const stretch = (flip: boolean) => `
vec4 tr_main(vec2 uv, float p) {
  float x = ${flip ? '1.0 - uv.x' : 'uv.x'};
  float seam = 1.0 - p;
  if (x < seam) {
    float xa = x / (1.0 + 2.0 * p);
    return a(vec2(${flip ? '1.0 - xa' : 'xa'}, uv.y));
  }
  float xb = (x - seam) / max(p, 0.0001);
  return b(vec2(${flip ? '1.0 - xb' : 'xb'}, uv.y));
}`;

const barn = (c: 'x' | 'y') => `
vec4 tr_main(vec2 uv, float p) {
  float h = p * 0.5;
  float t = uv.${c};
  vec2 off = vec2(${c === 'x' ? 'h, 0.0' : '0.0, h'});
  vec4 A = t < 0.5 ? a(uv + off) * step(t + h, 0.5) : a(uv - off) * step(0.5, t - h);
  return over(A, b(uv));
}`;

export const GLSL_PACK2: Record<string, string> = wrapAll({
  /* ---------- move ---------- */

  // radial blur that punches through the cut
  'zoom-blur': `
vec4 tr_main(vec2 uv, float p) {
  float k = bump(p);
  float m = smoothstep(0.3, 0.7, p);
  float z = 1.0 + 0.25 * k;
  vec4 s = vec4(0.0);
  for (int i = 0; i < 12; i++) {
    float f = float(i) / 11.0;
    vec2 q = (uv - 0.5) * (1.0 - k * 0.35 * f) / z + 0.5;
    s += mix(ac(q), bc(q), m);
  }
  return s / 12.0;
}`,

  'stretch-left': stretch(false),
  'stretch-right': stretch(true),

  // a rotates away around the bottom left corner
  roll: `
vec4 tr_main(vec2 uv, float p) {
  vec2 q = vec2(uv.x * aspect(), 1.0 - uv.y);
  q = rot(q, p * PI * 0.5);
  vec4 A = a(vec2(q.x / aspect(), 1.0 - q.y));
  return over(A, b(uv));
}`,

  'slide-diagonal': `
vec4 tr_main(vec2 uv, float p) {
  vec4 B = b(uv - vec2(1.0, -1.0) * (1.0 - p));
  vec4 A = a(uv) * (1.0 - smoothstep(0.5, 1.0, p));
  return over(B, A);
}`,

  // a squeezes into a center line, b unsqueezes out of it
  squeeze: `
vec4 tr_main(vec2 uv, float p) {
  float sc = max(p < 0.5 ? 1.0 - p * 2.0 : p * 2.0 - 1.0, 0.0005);
  vec2 q = vec2(uv.x, 0.5 + (uv.y - 0.5) / sc);
  return p < 0.5 ? a(q) : b(q);
}`,

  /* ---------- wipe ---------- */

  'wipe-diagonal': wipe('(uv.x + 1.0 - uv.y) * 0.5'),
  'barn-h': barn('x'),
  'barn-v': barn('y'),

  diamond: `
vec4 tr_main(vec2 uv, float p) {
  vec2 q = (uv - 0.5) * vec2(aspect(), 1.0);
  float n = (abs(q.x) + abs(q.y)) / (0.5 * aspect() + 0.5);
  return mix(a(uv), b(uv), reveal(p, clamp(n, 0.0, 1.0), 0.03));
}`,

  // five point star iris. the boundary is a polyline, so the radius at an angle is a line intersection.
  star: `
vec4 tr_main(vec2 uv, float p) {
  vec2 q = (uv - 0.5) * vec2(aspect(), 1.0);
  float r = length(q);
  float ang = atan(q.x, -q.y);
  float seg = TAU / 5.0;
  float ph = abs(mod(ang + seg * 0.5, seg) - seg * 0.5);
  float ri = 0.42;
  vec2 e = vec2(ri * cos(seg * 0.5) - 1.0, ri * sin(seg * 0.5));
  vec2 d = vec2(cos(ph), sin(ph));
  float t = e.y / (d.x * e.y - d.y * e.x);
  float n = r / t / (${MAXR} / ri);
  return mix(a(uv), b(uv), reveal(p, clamp(n, 0.0, 1.0), 0.03));
}`,

  // heart iris (exact heart distance, grown from the middle). aspect correct.
  heart: `
float tr_d2(vec2 v) { return dot(v, v); }
float tr_heart(vec2 h) {
  h.x = abs(h.x);
  if (h.y + h.x > 1.0) return sqrt(tr_d2(h - vec2(0.25, 0.75))) - 0.35355339;
  return sqrt(min(tr_d2(h - vec2(0.0, 1.0)), tr_d2(h - 0.5 * max(h.x + h.y, 0.0)))) * sign(h.x - h.y);
}
vec4 tr_main(vec2 uv, float p) {
  vec2 q = vec2((uv.x - 0.5) * aspect(), 0.5 - uv.y);
  float s = max(p * ${MAXR} * 3.0, 0.0001);
  float d = tr_heart(q / s + vec2(0.0, 0.55)) * s;
  float m = clamp(0.5 - d / 0.012, 0.0, 1.0);
  return mix(a(uv), b(uv), m);
}`,

  spiral: `
vec4 tr_main(vec2 uv, float p) {
  vec2 q = (uv - 0.5) * vec2(aspect(), 1.0);
  float r = length(q) / ${MAXR};
  float n = fract(atan(q.y, q.x) / TAU + r * 2.0);
  return mix(a(uv), b(uv), reveal(p, n, 0.05));
}`,

  'radial-bars': `
vec4 tr_main(vec2 uv, float p) {
  vec2 q = (uv - 0.5) * vec2(aspect(), 1.0);
  float n = fract(atan(q.x, -q.y) / TAU * 12.0);
  return mix(a(uv), b(uv), reveal(p, n, 0.06));
}`,

  // a hand fan opening from the bottom middle
  fan: `
vec4 tr_main(vec2 uv, float p) {
  vec2 q = vec2((uv.x - 0.5) * aspect(), 1.0 - uv.y);
  float n = clamp(atan(q.x, max(q.y, 0.0001)) / PI + 0.5, 0.0, 1.0);
  return mix(a(uv), b(uv), reveal(p, n, 0.04));
}`,

  'wave-wipe': wipe('0.5 + (uv.x - 0.5) * 0.8 + 0.1 * sin(uv.y * TAU * 2.5)', '0.05'),

  // organic edge: a wide soft threshold on noise tilted left to right
  'noise-wipe': `
vec4 tr_main(vec2 uv, float p) {
  float n = 0.55 * uv.x + 0.45 * fbm(uv * vec2(aspect(), 1.0) * 3.0 + u_seed);
  return mix(a(uv), b(uv), reveal(p, clamp(n, 0.0, 1.0), 0.25));
}`,

  // rows wipe in one after the other, every second row from the other side
  stripes: `
vec4 tr_main(vec2 uv, float p) {
  float row = floor(uv.y * 8.0);
  float stag = row / 7.0 * 0.6;
  float local = clamp((p - stag) / 0.4, 0.0, 1.0);
  float x = mod(row, 2.0) < 0.5 ? uv.x : 1.0 - uv.x;
  return mix(a(uv), b(uv), reveal(local, x, 0.03));
}`,

  // b opens from the middle line outwards
  split: wipe('abs(uv.x - 0.5) * 2.0', '0.03'),

  /* ---------- stylize ---------- */

  // noise edge with a hot rim, a burns away into b
  burn: `
vec4 tr_main(vec2 uv, float p) {
  float w = 0.18;
  float n = clamp(fbm(uv * vec2(aspect(), 1.0) * 4.0 + u_seed) * 0.7 + (1.0 - uv.y) * 0.3, 0.0, 1.0);
  float t = (p * (1.0 + w) - n) / w;
  vec4 A = a(uv);
  vec4 B = b(uv);
  float hole = smoothstep(0.92, 1.0, t);
  float charv = smoothstep(0.0, 0.8, t);
  float glow = smoothstep(0.1, 0.55, t) * (1.0 - smoothstep(0.9, 1.0, t));
  vec3 hot = mix(vec3(1.0, 0.3, 0.05), vec3(1.0, 0.85, 0.45), smoothstep(0.6, 0.95, t));
  vec4 bu = A;
  bu.rgb = A.rgb * (1.0 - 0.75 * charv) + hot * glow * A.a;
  bu.rgb = min(bu.rgb, vec3(bu.a));
  return mix(bu, B, hole);
}`,

  // old tv: a collapses to a line, then a dot, b fades up
  'tv-off': `
vec4 tr_main(vec2 uv, float p) {
  float p1 = clamp(p / 0.45, 0.0, 1.0);
  float p2 = clamp((p - 0.45) / 0.25, 0.0, 1.0);
  float p3 = clamp((p - 0.7) / 0.3, 0.0, 1.0);
  float sy = mix(1.0, 0.006, smoothstep(0.0, 1.0, p1));
  float sx = mix(1.0, 0.006, smoothstep(0.0, 1.0, p2));
  vec2 q = vec2(0.5 + (uv.x - 0.5) / sx, 0.5 + (uv.y - 0.5) / sy);
  vec4 A = a(q);
  A.rgb = mix(A.rgb * (1.0 + 1.5 * p1), vec3(A.a), smoothstep(0.55, 1.0, p1));
  A.rgb = min(A.rgb, vec3(A.a));
  A *= 1.0 - p3;
  vec4 B = b(uv) * smoothstep(0.55, 1.0, p);
  return over(A, B);
}`,

  // the bright parts of a go first
  'luma-fade': `
vec4 tr_main(vec2 uv, float p) {
  vec4 A = a(uv);
  float l = A.a > 0.01 ? luma(A.rgb / A.a) : 0.5;
  return mix(A, b(uv), reveal(p, 1.0 - l, 0.2));
}`,

  // the picture folds into a spinning kaleidoscope and unfolds as b
  'kaleido-spin': `
vec4 tr_main(vec2 uv, float p) {
  float w = smoothstep(0.0, 0.3, p) * (1.0 - smoothstep(0.7, 1.0, p));
  vec2 q = (uv - 0.5) * vec2(aspect(), 1.0);
  float seg = TAU / 6.0;
  float ang = atan(q.y, q.x) + p * 3.0;
  ang = abs(mod(ang, seg) - seg * 0.5);
  vec2 k = vec2(cos(ang), sin(ang)) * length(q);
  k.x /= aspect();
  vec2 pos = mix(uv, k + 0.5, w);
  return mix(ac(pos), bc(pos), smoothstep(0.4, 0.6, p));
}`,

  // each picture is pushed around by the brightness of the other one
  morph: `
vec4 tr_main(vec2 uv, float p) {
  vec4 A = a(uv);
  vec4 B = b(uv);
  float la = A.a > 0.01 ? luma(A.rgb / A.a) : 0.5;
  float lb = B.a > 0.01 ? luma(B.rgb / B.a) : 0.5;
  vec2 oa = vec2(cos(lb * PI), sin(lb * PI) - 0.5) * 0.12 * p;
  vec2 ob = vec2(cos(la * PI), sin(la * PI) - 0.5) * -0.12 * (1.0 - p);
  return mix(ac(uv + oa), bc(uv + ob), smoothstep(0.2, 0.8, p));
}`,

  // a bright band crosses the frame, the pictures swap behind it
  'light-sweep': `
vec4 tr_main(vec2 uv, float p) {
  float d = uv.x * 0.85 + uv.y * 0.15;
  float bp = mix(-0.3, 1.3, p);
  vec4 base = mix(a(uv), b(uv), 1.0 - smoothstep(bp - 0.03, bp + 0.03, d));
  float gd = (d - bp) / 0.08;
  float g = exp(-gd * gd);
  vec3 rgb = min(base.rgb + g * 0.9 * base.a, vec3(base.a));
  return vec4(rgb, base.a);
}`,

  // vertical roll, a black frame bar rides between the two pictures
  'film-roll': `
vec4 tr_main(vec2 uv, float p) {
  float g = 0.07;
  float tt = 1.0 + g;
  float k = bump(p);
  vec4 s = vec4(0.0);
  for (int i = 0; i < 6; i++) {
    float pp = clamp(p + (float(i) / 5.0 - 0.5) * 0.15 * k, 0.0, 1.0);
    float ya = uv.y + pp * tt;
    float yb = uv.y - (1.0 - pp) * tt;
    vec4 c = a(vec2(uv.x, ya)) + b(vec2(uv.x, yb));
    if (ya > 1.0 && ya < 1.0 + g) c = vec4(0.0, 0.0, 0.0, 1.0);
    s += c;
  }
  return s / 6.0;
}`,

  // blur, glow and a cross fade
  dreamy: `
vec4 tr_main(vec2 uv, float p) {
  float k = bump(p);
  float m = smoothstep(0.25, 0.75, p);
  vec4 s = vec4(0.0);
  for (int i = 0; i < 12; i++) {
    float f = float(i);
    float ang = f * 2.39996;
    float rad = sqrt((f + 0.5) / 12.0) * k * 0.07;
    vec2 o = vec2(cos(ang), sin(ang)) * rad;
    o.x /= aspect();
    s += mix(ac(uv + o), bc(uv + o), m);
  }
  s /= 12.0;
  vec3 rgb = s.rgb + k * 0.35 * (s.rgb * s.rgb + vec3(0.1 * s.a));
  return vec4(min(rgb, vec3(s.a)), s.a);
}`,

  // a short hard shake around the cut
  'shake-cut': `
vec4 tr_main(vec2 uv, float p) {
  float m = smoothstep(0.49, 0.51, p);
  vec4 s = vec4(0.0);
  for (int i = 0; i < 5; i++) {
    float pt = p + (float(i) - 2.0) * 0.012;
    float k = bump(pt);
    k *= k;
    vec2 off = vec2(snoise1(pt * 45.0 + u_seed), snoise1(pt * 45.0 + 37.7 + u_seed)) * 0.05 * k;
    vec2 q = (uv - 0.5) / (1.0 + 0.08 * k) + 0.5 + off;
    s += mix(ac(q), bc(q), m);
  }
  return s / 5.0;
}`,

  // colors go black and white, invert, cut to b at the peak and come back
  'color-pulse': `
vec4 tr_main(vec2 uv, float p) {
  vec4 c = mix(a(uv), b(uv), smoothstep(0.42, 0.58, p));
  float k = bump(p);
  vec3 rgb = mix(c.rgb, vec3(luma(c.rgb)), smoothstep(0.0, 0.6, k));
  rgb = mix(rgb, vec3(c.a) - rgb, smoothstep(0.4, 1.0, k));
  return vec4(clamp(rgb, 0.0, c.a), c.a);
}`,
});
