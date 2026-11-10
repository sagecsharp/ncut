/**
 * 3d transitions: faux perspective in the shader. a card (the whole frame) is rotated around an axis and
 * every pixel casts a ray at it (tr_hit), so edges shrink and grow like a real camera would see them.
 * the camera sits at z = TR_D looking at the z = 0 plane, where an unrotated card maps 1:1 to the frame.
 * screen space here: x right (aspect units), y UP, height 1. tr_s / tr_uv convert from / to frame uv.
 * a clip that is smaller than the frame is just a transparent area of the card: nothing special needed.
 */
import { wrapAll } from './wrap';

const LIB = `
const float TR_D = 2.5;
vec2 tr_s(vec2 uv) { return vec2((uv.x - 0.5) * aspect(), 0.5 - uv.y); }
vec2 tr_uv(vec2 sc) { return vec2(sc.x / aspect() + 0.5, 0.5 - sc.y); }
mat3 tr_rotY(float t) {
  float c = cos(t);
  float s = sin(t);
  return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
}
mat3 tr_rotX(float t) {
  float c = cos(t);
  float s = sin(t);
  return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c);
}
vec4 tr_shade(vec4 c, float k) { return vec4(c.rgb * k, c.a); }
/**
 * camera ray through screen point sc against the card with orientation R and rotation origin pivot.
 * returns (local x, local y, distance, 1) or all zero when missed or seen from behind.
 */
vec4 tr_hit(vec2 sc, mat3 R, vec3 pivot) {
  vec3 O = vec3(0.0, 0.0, TR_D);
  vec3 d = vec3(sc, -TR_D);
  vec3 n = R[2];
  float den = dot(d, n);
  if (dot(n, O - pivot) <= 0.0 || abs(den) < 0.00001) return vec4(0.0);
  float t = dot(pivot - O, n) / den;
  if (t <= 0.0) return vec4(0.0);
  vec3 L = transpose(R) * (O + d * t - pivot);
  return vec4(L.xy, t, 1.0);
}
/** b sitting still behind the moving a, slightly small at first */
vec4 tr_back(vec2 uv, float p) { return b(0.5 + (uv - 0.5) / (0.9 + 0.1 * p)); }
`;

const cube = (vert: boolean, sg: string) => `${LIB}
vec4 tr_main(vec2 uv, float p) {
  bool vert = ${vert ? 'true' : 'false'};
  float sg = ${sg};
  vec2 sc = tr_s(uv);
  float th = sg * p * PI * 0.5;
  float r = vert ? 0.5 : aspect() * 0.5;
  mat3 R = vert ? tr_rotX(th) : tr_rotY(th);
  mat3 Q = vert ? tr_rotX(-sg * PI * 0.5) : tr_rotY(-sg * PI * 0.5);
  mat3 RB = R * Q;
  vec3 c0 = vec3(0.0, 0.0, -r - 0.4 * bump(p));
  vec3 pa = c0 + R * vec3(0.0, 0.0, r);
  vec3 pb = c0 + R * (vert ? vec3(0.0, sg * r, 0.0) : vec3(-sg * r, 0.0, 0.0));
  vec4 hA = tr_hit(sc, R, pa);
  vec4 hB = tr_hit(sc, RB, pb);
  vec4 cA = vec4(0.0);
  vec4 cB = vec4(0.0);
  if (hA.w > 0.5) cA = tr_shade(a(tr_uv(hA.xy)), 0.45 + 0.55 * R[2].z);
  if (hB.w > 0.5) cB = tr_shade(b(tr_uv(hB.xy)), 0.45 + 0.55 * RB[2].z);
  return over(cA, cB);
}`;

const flip = (vert: boolean) => `${LIB}
vec4 tr_main(vec2 uv, float p) {
  vec2 sc = tr_s(uv);
  float ang = p < 0.5 ? p * PI : p * PI - PI;
  mat3 R = ${vert ? 'tr_rotX(ang)' : 'tr_rotY(ang)'};
  vec4 h = tr_hit(sc, R, vec3(0.0, 0.0, -0.5 * bump(p)));
  if (h.w < 0.5) return vec4(0.0);
  vec2 q = tr_uv(h.xy);
  vec4 c = p < 0.5 ? a(q) : b(q);
  return tr_shade(c, 0.4 + 0.6 * cos(ang));
}`;

export const GLSL_3D: Record<string, string> = wrapAll({
  'cube-left': cube(false, '-1.0'),
  'cube-right': cube(false, '1.0'),
  'cube-up': cube(true, '-1.0'),
  'cube-down': cube(true, '1.0'),

  'flip-horizontal': flip(false),
  'flip-vertical': flip(true),

  // a opens like double doors hinged at the left and right edge, b waits behind
  door: `${LIB}
vec4 tr_main(vec2 uv, float p) {
  vec2 sc = tr_s(uv);
  float hw = aspect() * 0.5;
  float th = p * PI * 0.5;
  vec4 hL = tr_hit(sc, tr_rotY(th), vec3(-hw, 0.0, 0.0));
  vec4 hR = tr_hit(sc, tr_rotY(-th), vec3(hw, 0.0, 0.0));
  vec4 cL = vec4(0.0);
  vec4 cR = vec4(0.0);
  float k = 0.35 + 0.65 * cos(th);
  if (hL.w > 0.5 && hL.x >= 0.0) cL = tr_shade(a(tr_uv(vec2(hL.x - hw, hL.y))), k);
  if (hR.w > 0.5 && hR.x <= 0.0) cR = tr_shade(a(tr_uv(vec2(hR.x + hw, hR.y))), k);
  return over(cL, over(cR, tr_back(uv, p)));
}`,

  // the two halves of a fold away from the middle line like a closing book
  fold: `${LIB}
vec4 tr_main(vec2 uv, float p) {
  vec2 sc = tr_s(uv);
  float th = p * PI * 0.5;
  vec4 hT = tr_hit(sc, tr_rotX(-th), vec3(0.0));
  vec4 hU = tr_hit(sc, tr_rotX(th), vec3(0.0));
  vec4 cT = vec4(0.0);
  vec4 cU = vec4(0.0);
  float k = 0.35 + 0.65 * cos(th);
  if (hT.w > 0.5 && hT.y >= 0.0) cT = tr_shade(a(tr_uv(hT.xy)), k);
  if (hU.w > 0.5 && hU.y <= 0.0) cU = tr_shade(a(tr_uv(hU.xy)), k);
  return over(cT, over(cU, tr_back(uv, p)));
}`,

  // the page rolls up around a cylinder that travels from the right edge to the left. the back of the
  // paper is darker. x runs in aspect units from the left edge.
  'page-turn': `
vec4 tr_back2(vec4 c, float k) { return vec4(c.rgb * 0.5 * k + vec3(0.2 * k) * c.a, c.a); }
vec4 tr_main(vec2 uv, float p) {
  float asp = aspect();
  float R = 0.1;
  float f = mix(asp, -(asp * 0.5 + PI * R + R), p);
  float x = uv.x * asp;
  float y = uv.y;
  vec4 B = b(uv);
  if (x < f) {
    vec4 flat0 = a(uv);
    float xo = f + PI * R + (f - x);
    vec4 back = tr_back2(a(vec2(xo / asp, y)), 0.9);
    return over(back, over(flat0, B));
  }
  if (x < f + R) {
    float u = clamp((x - f) / R, 0.0, 1.0);
    float ph = asin(u);
    vec4 fr = a(vec2((f + R * ph) / asp, y));
    fr = vec4(fr.rgb * (1.0 - 0.3 * u), fr.a);
    vec4 bk = tr_back2(a(vec2((f + R * (PI - ph)) / asp, y)), 0.75 + 0.25 * (1.0 - u));
    return over(bk, over(fr, B));
  }
  return B;
}`,

  // b arrives from far away while a falls back and fades
  'fly-in': `${LIB}
vec4 tr_main(vec2 uv, float p) {
  vec2 sc = tr_s(uv);
  vec4 hA = tr_hit(sc, tr_rotX(p * 0.6), vec3(0.0, 0.0, -5.0 * p));
  vec4 hB = tr_hit(sc, tr_rotX(-(1.0 - p) * 0.6), vec3(0.0, 0.0, -5.0 * (1.0 - p)));
  vec4 cA = vec4(0.0);
  vec4 cB = vec4(0.0);
  if (hA.w > 0.5) cA = a(tr_uv(hA.xy)) * (1.0 - smoothstep(0.1, 0.65, p));
  if (hB.w > 0.5) cB = b(tr_uv(hB.xy)) * smoothstep(0.0, 0.5, p);
  return over(cA, cB);
}`,

  // a swings away around its left edge
  swing: `${LIB}
vec4 tr_main(vec2 uv, float p) {
  vec2 sc = tr_s(uv);
  float hw = aspect() * 0.5;
  float th = p * PI * 0.5;
  vec4 h = tr_hit(sc, tr_rotY(th), vec3(-hw, 0.0, 0.0));
  vec4 cA = vec4(0.0);
  if (h.w > 0.5) cA = tr_shade(a(tr_uv(vec2(h.x - hw, h.y))), 0.35 + 0.65 * cos(th));
  return over(cA, tr_back(uv, p));
}`,
});
