/**
 * the look of each transition.
 *
 * contract: define exactly   vec4 transition(vec2 uv, float p)   (helpers above it, prefixed tr_)
 *   uv is 0..1 across the frame, (0,0) = TOP LEFT. p is the progress 0..1 (already eased).
 *   a(vec2 uv) = the outgoing picture, b(vec2 uv) = the incoming picture. both return PREMULTIPLIED
 *   rgba (a clip that does not fill the frame is transparent around it) and are transparent outside 0..1.
 *   ac / bc are the same but repeat the edge pixels outside the frame.
 *   return premultiplied rgba. at p = 0 the result must be exactly a(uv), at p = 1 exactly b(uv).
 * helpers from runner.ts: over(top, under), bump(p) (0 -> 1 -> 0), reveal(p, n, softness).
 * the effect prelude helpers are available too (aspect, hash21, noise2, fbm, rot, sat, PI, TAU, u_size, u_seed).
 */

const slide = (dx: string, dy: string) => `
vec4 transition(vec2 uv, float p) {
  // b travels in over a. a fades away near the end so nothing is left behind a picture with holes.
  vec4 B = b(uv - vec2(${dx}, ${dy}) * (1.0 - p));
  vec4 A = a(uv) * (1.0 - smoothstep(0.5, 1.0, p));
  return over(B, A);
}`;

const push = (dx: string, dy: string) => `
vec4 transition(vec2 uv, float p) {
  vec2 d = vec2(${dx}, ${dy});
  return a(uv + d * p) + b(uv - d * (1.0 - p));
}`;

const whip = (dir: string) => `
vec4 tr_push(vec2 uv, float p) {
  vec2 d = vec2(${dir}, 0.0);
  return a(uv + d * p) + b(uv - d * (1.0 - p));
}
vec4 transition(vec2 uv, float p) {
  float k = bump(p);
  vec4 s = vec4(0.0);
  for (int i = 0; i < 12; i++) {
    float f = (float(i) / 11.0 - 0.5) * k * 0.4;
    s += tr_push(uv, clamp(p + f, 0.0, 1.0));
  }
  return s / 12.0;
}`;

const wipe = (n: string) => `
vec4 transition(vec2 uv, float p) {
  return mix(a(uv), b(uv), reveal(p, ${n}, 0.03));
}`;

export const TRANSITION_GLSL: Record<string, string> = {
  'cross-fade': `
vec4 transition(vec2 uv, float p) { return mix(a(uv), b(uv), p); }`,

  'dip-black': `
vec4 transition(vec2 uv, float p) {
  vec4 A = a(uv);
  vec4 B = b(uv);
  float k = 1.0 - abs(p * 2.0 - 1.0);
  vec4 base = p < 0.5 ? A : B;
  return mix(base, vec4(0.0, 0.0, 0.0, max(A.a, B.a)), smoothstep(0.0, 1.0, k));
}`,

  'dip-white': `
vec4 transition(vec2 uv, float p) {
  vec4 A = a(uv);
  vec4 B = b(uv);
  float k = 1.0 - abs(p * 2.0 - 1.0);
  vec4 base = p < 0.5 ? A : B;
  return mix(base, vec4(max(A.a, B.a)), smoothstep(0.0, 1.0, k));
}`,

  'blur-fade': `
vec4 tr_soft(vec2 uv, float r, float m) {
  vec4 s = vec4(0.0);
  for (int i = 0; i < 14; i++) {
    float f = float(i);
    float ang = f * 2.39996;
    float rad = sqrt((f + 0.5) / 14.0) * r;
    vec2 o = vec2(cos(ang), sin(ang)) * rad;
    o.x /= aspect();
    s += mix(ac(uv + o), bc(uv + o), m);
  }
  return s / 14.0;
}
vec4 transition(vec2 uv, float p) {
  float k = bump(p);
  return tr_soft(uv, k * 0.06, smoothstep(0.25, 0.75, p));
}`,

  dissolve: `
vec4 transition(vec2 uv, float p) {
  vec2 g = uv * vec2(aspect(), 1.0);
  float n = fbm(g * 9.0 + u_seed) * 0.75 + hash21(floor(uv * u_size / 4.0)) * 0.25;
  return mix(a(uv), b(uv), reveal(p, clamp(n, 0.0, 1.0), 0.08));
}`,

  'slide-left': slide('1.0', '0.0'),
  'slide-right': slide('-1.0', '0.0'),
  'slide-up': slide('0.0', '1.0'),
  'slide-down': slide('0.0', '-1.0'),

  'push-left': push('1.0', '0.0'),
  'push-right': push('-1.0', '0.0'),
  'push-up': push('0.0', '1.0'),
  'push-down': push('0.0', '-1.0'),

  'whip-left': whip('1.0'),
  'whip-right': whip('-1.0'),

  'zoom-in': `
vec2 tr_zoom(vec2 uv, float z) { return (uv - 0.5) / z + 0.5; }
vec4 transition(vec2 uv, float p) {
  float k = bump(p);
  float m = smoothstep(0.35, 0.65, p);
  vec4 s = vec4(0.0);
  for (int i = 0; i < 12; i++) {
    float f = float(i) / 11.0 * k * 0.6;
    vec4 A = ac(tr_zoom(uv, 1.0 + p * 1.6 + f));
    vec4 B = bc(tr_zoom(uv, 1.0 / (1.0 + (1.0 - p) * 1.6 + f)));
    s += mix(A, B, m);
  }
  return s / 12.0;
}`,

  'zoom-out': `
vec2 tr_zoom(vec2 uv, float z) { return (uv - 0.5) / z + 0.5; }
vec4 transition(vec2 uv, float p) {
  float k = bump(p);
  float m = smoothstep(0.35, 0.65, p);
  vec4 s = vec4(0.0);
  for (int i = 0; i < 12; i++) {
    float f = float(i) / 11.0 * k * 0.6;
    vec4 A = ac(tr_zoom(uv, 1.0 / (1.0 + p * 1.6 + f)));
    vec4 B = bc(tr_zoom(uv, 1.0 + (1.0 - p) * 1.6 + f));
    s += mix(A, B, m);
  }
  return s / 12.0;
}`,

  spin: `
vec2 tr_turn(vec2 uv, float ang, float z) {
  vec2 q = uv - 0.5;
  q.x *= aspect();
  q = rot(q, -ang) / z;
  q.x /= aspect();
  return q + 0.5;
}
vec4 transition(vec2 uv, float p) {
  float k = bump(p);
  float m = smoothstep(0.35, 0.65, p);
  float z = 1.0 + k * 0.7;
  vec4 s = vec4(0.0);
  for (int i = 0; i < 12; i++) {
    float f = (float(i) / 11.0 - 0.5) * k * 0.5;
    vec4 A = ac(tr_turn(uv, (p + f) * 2.6, z));
    vec4 B = bc(tr_turn(uv, (p + f - 1.0) * 2.6, z));
    s += mix(A, B, m);
  }
  return s / 12.0;
}`,

  'wipe-left': wipe('1.0 - uv.x'),
  'wipe-right': wipe('uv.x'),
  'wipe-up': wipe('1.0 - uv.y'),
  'wipe-down': wipe('uv.y'),

  iris: `
vec4 transition(vec2 uv, float p) {
  vec2 q = (uv - 0.5) * vec2(aspect(), 1.0);
  float d = length(q) / (0.5 * length(vec2(aspect(), 1.0)));
  return mix(a(uv), b(uv), reveal(p, clamp(d, 0.0, 1.0), 0.03));
}`,

  clock: `
vec4 transition(vec2 uv, float p) {
  vec2 q = (uv - 0.5) * vec2(aspect(), 1.0);
  float n = fract(atan(q.x, -q.y) / TAU);
  return mix(a(uv), b(uv), reveal(p, n, 0.02));
}`,

  blinds: `
vec4 transition(vec2 uv, float p) {
  float n = fract(uv.y * 9.0);
  return mix(a(uv), b(uv), reveal(p, n, 0.06));
}`,

  checker: `
vec4 transition(vec2 uv, float p) {
  vec2 g = uv * vec2(aspect(), 1.0) * 6.0;
  vec2 id = floor(g);
  float delay = mod(id.x + id.y, 2.0) * 0.5;
  float local = clamp(p * 2.0 - delay, 0.0, 1.0);
  return mix(a(uv), b(uv), reveal(local, fract(g.x), 0.06));
}`,

  glitch: `
vec4 tr_pick(vec2 uv, float p) {
  float k = bump(p);
  float t = floor(p * 14.0);
  float band = floor(uv.y * 20.0);
  float r1 = hash21(vec2(band, t + u_seed));
  float r2 = hash21(vec2(band + 7.0, t * 1.7 + 3.0));
  float shift = (r1 - 0.5) * 0.3 * k * (r2 > 0.4 ? 1.0 : 0.0);
  float pick = p >= r2 * 0.98 + 0.01 ? 1.0 : 0.0;
  vec2 q = vec2(uv.x + shift, uv.y);
  return mix(ac(q), bc(q), pick);
}
vec4 transition(vec2 uv, float p) {
  vec2 o = vec2(0.014 * bump(p), 0.0);
  vec4 c0 = tr_pick(uv, p);
  vec4 c1 = tr_pick(uv + o, p);
  vec4 c2 = tr_pick(uv - o, p);
  return vec4(c1.r, c0.g, c2.b, max(c0.a, max(c1.a, c2.a)));
}`,

  pixelate: `
vec4 transition(vec2 uv, float p) {
  float k = bump(p);
  float px = 1.0 + 110.0 * k * k;
  vec2 cell = vec2(px) / u_size;
  vec2 q = k > 0.01 ? (floor(uv / cell) + 0.5) * cell : uv;
  return mix(ac(q), bc(q), smoothstep(0.4, 0.6, p));
}`,

  'rgb-split': `
vec4 tr_both(vec2 uv, float m) { return mix(ac(uv), bc(uv), m); }
vec4 transition(vec2 uv, float p) {
  float k = bump(p);
  float m = smoothstep(0.3, 0.7, p);
  vec2 o = (uv - 0.5) * 0.12 * k + vec2(0.02 * k, 0.0);
  vec4 c0 = tr_both(uv, m);
  vec4 c1 = tr_both(uv + o, m);
  vec4 c2 = tr_both(uv - o, m);
  return vec4(c1.r, c0.g, c2.b, max(c0.a, max(c1.a, c2.a)));
}`,

  flash: `
vec4 transition(vec2 uv, float p) {
  vec4 base = mix(a(uv), b(uv), smoothstep(0.4, 0.6, p));
  float k = pow(bump(p), 2.5);
  vec3 rgb = min(base.rgb * (1.0 + 5.0 * k) + k * base.a * 0.5, vec3(base.a));
  return vec4(rgb, base.a);
}`,

  ripple: `
vec4 transition(vec2 uv, float p) {
  float k = bump(p);
  vec2 q = (uv - 0.5) * vec2(aspect(), 1.0);
  float d = length(q);
  vec2 dir = d > 0.0001 ? q / d : vec2(0.0);
  float w = sin(d * 42.0 - p * 20.0) * 0.035 * k;
  vec2 off = dir * w;
  off.x /= aspect();
  return mix(ac(uv + off), bc(uv + off), smoothstep(0.3, 0.7, p));
}`,
};
