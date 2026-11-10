/**
 * glsl helpers shared by the overlay pack (pasted in front of an effect's own code, each effect is
 * compiled alone). all overlays work in "aspect space": x runs 0..aspect, y runs 0..1 (down), so
 * one unit is one frame height and circles stay round.
 *
 *  apos(uv)           uv -> aspect space
 *  lit(c, light)      screen blend: adds light to the picture without ever going above white
 *  blob(d, r, w)      1 inside radius r, 0 outside, soft edge of half width w around r
 *  pnoise(x, n, s)    1d value noise that repeats every n (a whole number), s = seed. for angles.
 *  crand(id, l)       3 random numbers 0..1 for grid cell id of layer l (stable, seeded by u_seed)
 *
 * particle layout used by most overlays (one particle per grid cell, 3 layers for depth):
 *   q = p * cells; id = floor(q); f = q - id;
 *   then for the 3x3 cells around the pixel: pos = g + 0.2 + 0.6 * h.xy, d = length(f - pos).
 *   a particle never reaches further than the neighbour cells, so the cost is a fixed 9 per layer.
 */
export const OVERLAY_COMMON = `
vec2 apos(vec2 uv) { return vec2(uv.x * aspect(), uv.y); }
vec3 lit(vec3 c, vec3 light) { return 1.0 - (1.0 - c) * (1.0 - clamp(light, 0.0, 1.0)); }
float blob(float d, float r, float w) { return 1.0 - smoothstep(r - max(w, 0.00001), r + max(w, 0.00001), d); }
float pnoise(float x, float n, float s) {
  float i = floor(x);
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(hash11(mod(i, n) + s * 0.731), hash11(mod(i + 1.0, n) + s * 0.731), f);
}
vec3 crand(vec2 id, float l) {
  vec2 o = id + vec2(l * 31.7 + u_seed * 1.37, l * 17.3 + u_seed * 0.71);
  vec2 h = hash22(o);
  return vec3(h, hash21(o.yx + h * 71.3));
}
`;
