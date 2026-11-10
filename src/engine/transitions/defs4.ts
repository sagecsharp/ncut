/**
 * fourth pack of transitions (16 new looks). same contract as ./defs2.ts: each shader defines
 * `vec4 tr_main(vec2 uv, float p)` and wrapAll adds `transition`, which returns exactly a at p = 0 and
 * exactly b at p = 1. every loop has a constant bound and the texture reads per pixel stay low.
 * every look is a pure function of (uv, p, u_size, u_seed): same in preview and export.
 */
import { wrapAll } from './wrap';

/** distance from the center to a corner, in height units (aspect correct) */
const MAXR = '(0.5 * length(vec2(aspect(), 1.0)))';

export const GLSL_PACK4: Record<string, string> = wrapAll({
  /* ---------- wipe ---------- */

  // the new picture spreads like ink from the middle: fingers of noise, a dark front on the old picture
  'ink-bleed': `
vec4 tr_main(vec2 uv, float p) {
  vec2 q = (uv - 0.5) * vec2(aspect(), 1.0);
  float r = length(q) / ${MAXR};
  vec2 w = vec2(fbm(q * 3.0 + u_seed), fbm(q * 3.0 + u_seed + 31.7));
  float n = r * 0.55 + fbm(q * 6.0 + w * 2.0 + u_seed) * 0.5 - 0.05;
  float t = reveal(p, clamp(n, 0.0, 1.0), 0.35);
  float m = smoothstep(0.42, 0.5, t);
  float rim = smoothstep(0.15, 0.4, t) * (1.0 - smoothstep(0.42, 0.5, t));
  vec4 A = a(uv);
  A.rgb *= 1.0 - 0.7 * rim;
  return mix(A, b(uv), m);
}`,

  // honeycomb: every cell of the old picture shrinks to a point, in a wave from left to right
  'hex-reveal': `
vec3 tr_hex(vec2 pt) {
  vec2 r = vec2(1.0, 1.7320508);
  vec2 h = r * 0.5;
  vec2 ga = mod(pt, r) - h;
  vec2 gb = mod(pt - h, r) - h;
  vec2 gv = dot(ga, ga) < dot(gb, gb) ? ga : gb;
  vec2 ab = abs(gv);
  float d = max(dot(ab, normalize(vec2(1.0, 1.7320508))), ab.x);
  return vec3(pt - gv, d);
}
vec4 tr_main(vec2 uv, float p) {
  vec2 n = vec2(aspect(), 1.0) * 8.0;
  vec3 hx = tr_hex(uv * n);
  vec2 cu = hx.xy / n;
  float dl = hash21(hx.xy + u_seed) * 0.35 + clamp(cu.x, 0.0, 1.0) * 0.25;
  float t = clamp((p - dl) / 0.4, 0.0, 1.0);
  float w = mix(0.56, 0.0, t);
  float mask = 1.0 - smoothstep(w - 0.04, w, hx.z);
  return mix(b(uv), a(uv), mask);
}`,

  // halftone: round dots of the new picture grow until they touch, from the top left
  dots: `
vec4 tr_main(vec2 uv, float p) {
  vec2 n = vec2(aspect(), 1.0) * 20.0;
  vec2 g = uv * n;
  vec2 f = fract(g) - 0.5;
  vec2 cu = (floor(g) + 0.5) / n;
  float grad = clamp(cu.x * 0.5 + (1.0 - cu.y) * 0.5, 0.0, 1.0);
  float tt = clamp(p * 1.35 - 0.35 * grad, 0.0, 1.0);
  float rad = tt * 0.78;
  float m = 1.0 - smoothstep(rad - 0.06, rad, length(f));
  return mix(a(uv), b(uv), m);
}`,

  // a cross opens from the middle, arms first
  plus: `
vec4 tr_main(vec2 uv, float p) {
  vec2 q = abs((uv - 0.5) * vec2(aspect(), 1.0));
  // divided by the value in the corner, so the last corner is reached exactly at the end (wide and tall frames)
  float n = (3.0 * min(q.x, q.y) + 0.8 * max(q.x, q.y)) / (1.5 * min(aspect(), 1.0) + 0.4 * max(aspect(), 1.0));
  return mix(a(uv), b(uv), reveal(p, clamp(n, 0.0, 1.0), 0.04));
}`,

  // a wipe with a saw tooth edge
  zigzag: `
vec4 tr_main(vec2 uv, float p) {
  float tri = abs(fract(uv.y * 7.0) - 0.5);
  float n = (uv.x + tri * 0.25) / 1.13;
  return mix(a(uv), b(uv), reveal(p, clamp(n, 0.0, 1.0), 0.02));
}`,

  // b grows in square by square, every square zooms a little while it opens, in random order
  'tile-pop': `
vec4 tr_main(vec2 uv, float p) {
  vec2 n = vec2(aspect(), 1.0) * 7.0;
  vec2 g = uv * n;
  vec2 id = floor(g);
  vec2 f = g - id - 0.5;
  vec2 cu = (id + 0.5) / n;
  float dl = hash21(id + u_seed) * 0.5;
  float t = clamp((p - dl) / 0.5, 0.0, 1.0);
  float s = t * t * (3.0 - 2.0 * t);
  float edge = max(abs(f.x), abs(f.y));
  float lim = s * 0.54;
  float m = 1.0 - smoothstep(lim - 0.03, lim, edge);
  vec2 pos = cu + (uv - cu) / (0.55 + 0.45 * s);
  return mix(a(uv), b(pos), m);
}`,

  // two curtains gather at the sides, with pleats that tighten as they go
  curtains: `
vec4 tr_main(vec2 uv, float p) {
  float gate = 0.5 * p;
  if (abs(uv.x - 0.5) < gate) return b(uv);
  float den = max(1.0 - p, 0.001);
  float sx = uv.x < 0.5 ? uv.x / den : 1.0 - (1.0 - uv.x) / den;
  float amp = 0.25 * smoothstep(0.0, 0.2, p) * (1.0 - smoothstep(0.85, 1.0, p));
  float fold = 1.0 - amp * (0.5 + 0.5 * sin(sx * 38.0));
  vec4 c = a(vec2(sx, uv.y));
  c.rgb *= fold;
  return over(c, b(uv));
}`,

  /* ---------- move ---------- */

  // alternating rows push out to opposite sides while the new picture slides in behind them
  comb: `
vec4 tr_main(vec2 uv, float p) {
  float row = min(floor(uv.y * 9.0), 8.0);
  float dir = mod(row, 2.0) < 0.5 ? 1.0 : -1.0;
  float local = clamp((p - row / 8.0 * 0.3) / 0.7, 0.0, 1.0);
  float e = local * local * (3.0 - 2.0 * local);
  return a(vec2(uv.x - dir * e, uv.y)) + b(vec2(uv.x + dir * (1.0 - e), uv.y));
}`,

  // the old picture drips down in uneven columns and leaves the new one behind
  melt: `
vec4 tr_main(vec2 uv, float p) {
  float col = floor(uv.x * 36.0);
  float dl = mix(hash11(col + u_seed), noise1(uv.x * 9.0 + u_seed), 0.5) * 0.5;
  float e = clamp((p - dl) / (1.0 - dl), 0.0, 1.0);
  float sh = e * e * 0.8 + e * 0.4;
  float sx = uv.x + sin(uv.y * 40.0 + col) * 0.003 * e;
  return over(a(vec2(sx, uv.y - sh)), b(uv));
}`,

  // squares flip over like cards, in a wave from the top left. the gaps show the picture dimmed
  'flip-tiles': `
vec4 tr_main(vec2 uv, float p) {
  vec2 n = vec2(aspect(), 1.0) * 6.0;
  vec2 g = uv * n;
  vec2 id = floor(g);
  vec2 f = g - id;
  vec2 cu = (id + 0.5) / n;
  float dl = min(cu.x * 0.65 + cu.y * 0.25, 0.9) * 0.6;
  float t = clamp((p - dl) / 0.46, 0.0, 1.0);
  if (t <= 0.0) return a(uv);
  if (t >= 1.0) return b(uv);
  float w = cos(t * PI);
  float x = (f.x - 0.5) / max(abs(w), 0.001) + 0.5;
  if (x < 0.0 || x > 1.0) {
    vec4 bd = t < 0.5 ? a(uv) : b(uv);
    return vec4(bd.rgb * 0.3, bd.a);
  }
  vec2 s = vec2((id.x + x) / n.x, (id.y + f.y) / n.y);
  vec4 c = t < 0.5 ? a(s) : b(s);
  float shade = 0.55 + 0.45 * abs(w);
  return vec4(c.rgb * shade, c.a);
}`,

  /* ---------- stylize ---------- */

  // the old picture breaks into triangles that tumble, shrink and fade, starting from the middle
  shatter: `
vec4 tr_main(vec2 uv, float p) {
  vec2 n = vec2(aspect(), 1.0) * 5.0;
  vec2 g = uv * n;
  vec2 id = floor(g);
  vec2 f = g - id;
  float fl = hash21(id + 11.3) > 0.5 ? 1.0 : 0.0;
  if (fl > 0.5) f.x = 1.0 - f.x;
  float hi = f.x + f.y > 1.0 ? 1.0 : 0.0;
  vec2 c = hi > 0.5 ? vec2(0.6667) : vec2(0.3333);
  float h = hash21(id * 1.7 + vec2(hi * 5.0, u_seed));
  vec2 cu = (id + 0.5) / n;
  float dl = clamp(length(cu - 0.5) / 0.71, 0.0, 1.0) * 0.25 + h * 0.15;
  float t = clamp((p - dl) / 0.6, 0.0, 1.0);
  if (t <= 0.0) return a(uv);
  float sc = 1.0 - 0.85 * t;
  float ang = (h - 0.5) * 3.0 * t;
  vec2 s = c + rot(f - c, -ang) / sc;
  float e = 0.003;
  bool ok = hi > 0.5
    ? (s.x <= 1.0 + e && s.y <= 1.0 + e && s.x + s.y >= 1.0 - e)
    : (s.x >= -e && s.y >= -e && s.x + s.y <= 1.0 + e);
  if (!ok) return b(uv);
  if (fl > 0.5) s.x = 1.0 - s.x;
  vec4 A = a((id + s) / n);
  A.rgb *= 1.0 - 0.45 * t;
  return over(A * (1.0 - smoothstep(0.55, 1.0, t)), b(uv));
}`,

  // twists into a whirl around the middle, cuts, and untwists as the new picture
  'swirl-through': `
vec4 tr_main(vec2 uv, float p) {
  float k = bump(p);
  float m = smoothstep(0.4, 0.6, p);
  vec2 q = (uv - 0.5) * vec2(aspect(), 1.0);
  float r = clamp(length(q) / ${MAXR}, 0.0, 1.0);
  float fall = (1.0 - r) * (1.0 - r);
  vec4 s = vec4(0.0);
  for (int i = 0; i < 6; i++) {
    float f = float(i) / 5.0 - 0.5;
    vec2 w = rot(q, k * (1.0 + f * 0.3) * 9.0 * fall);
    w.x /= aspect();
    s += mix(ac(w + 0.5), bc(w + 0.5), m);
  }
  return s / 6.0;
}`,

  // the picture is sucked into the middle like a pinched lens, then springs back as the new one
  pinch: `
vec4 tr_main(vec2 uv, float p) {
  float k = bump(p);
  float m = smoothstep(0.4, 0.6, p);
  vec2 q = (uv - 0.5) * vec2(aspect(), 1.0);
  float r = clamp(length(q) / ${MAXR}, 0.0, 1.0);
  float fall = (1.0 - r) * (1.0 - r);
  vec4 s = vec4(0.0);
  for (int i = 0; i < 6; i++) {
    float f = float(i) / 5.0;
    vec2 w = q * (1.0 + k * (2.0 + f) * fall);
    w.x /= aspect();
    s += mix(ac(w + 0.5), bc(w + 0.5), m);
  }
  return s / 6.0;
}`,

  // slow noise warps both pictures like they were under water
  liquid: `
vec4 tr_main(vec2 uv, float p) {
  float k = bump(p);
  float m = smoothstep(0.3, 0.7, p);
  vec2 g = uv * vec2(aspect(), 1.0) * 3.0;
  vec2 w = vec2(fbm(g + vec2(p * 2.0, u_seed)), fbm(g + vec2(u_seed + 41.0, p * 2.0))) - 0.5;
  vec2 off = w * 0.25 * k;
  off.x /= aspect();
  return mix(ac(uv + off), bc(uv - off), m);
}`,

  // a slanted edge crosses the frame and splits into red, green and blue fringes
  prism: `
vec4 tr_main(vec2 uv, float p) {
  float d = uv.x * 0.8 + uv.y * 0.2 + sin(uv.y * 9.0) * 0.01;
  float bp = mix(-0.25, 1.25, p);
  float mr = 1.0 - smoothstep(bp - 0.095, bp - 0.045, d);
  float mg = 1.0 - smoothstep(bp - 0.025, bp + 0.025, d);
  float mb = 1.0 - smoothstep(bp + 0.045, bp + 0.095, d);
  vec4 A = a(uv);
  vec4 B = b(uv);
  float al = mix(A.a, B.a, mg);
  vec3 rgb = vec3(mix(A.r, B.r, mr), mix(A.g, B.g, mg), mix(A.b, B.b, mb));
  return vec4(min(rgb, vec3(al)), al);
}`,

  // glass blocks: every square becomes a little lens that flips the picture while it changes
  'glass-tiles': `
vec4 tr_main(vec2 uv, float p) {
  float k = bump(p);
  float m = smoothstep(0.3, 0.7, p);
  vec2 n = vec2(aspect(), 1.0) * 7.0;
  vec2 f = fract(uv * n) - 0.5;
  vec2 pos = uv - f * 1.4 * k / n;
  float edge = smoothstep(0.4, 0.5, max(abs(f.x), abs(f.y)));
  vec4 c = mix(ac(pos), bc(pos), m);
  c.rgb *= 1.0 - 0.5 * k * edge;
  return c;
}`,
});

/** ids in the order they are listed in the registry */
export const PACK4_IDS: string[] = Object.keys(GLSL_PACK4);
