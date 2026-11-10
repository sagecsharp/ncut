/**
 * glsl snippets shared by the second effect pack. they are pasted in front of an effect's own code
 * (each effect is compiled alone, so there is no clash between effects).
 */

/**
 * sample patterns for blurs.
 *  vogel(i, n, rot0): tap i of n of a golden angle spiral, a point inside the unit disc with even
 *                     area density. rot0 turns the whole pattern.
 *  jitter(uv):        a per pixel angle (0..tau) hashed from the project pixel, the same for the preview
 *                     and the export. turns spiral banding into fine static noise.
 *  mir(x):            mirrored repeat. identity on 0..1, then ping pongs (0..1..0..1) with period 2.
 */
export const DISC = `
vec2 vogel(int i, int n, float rot0) {
  float fi = float(i);
  float r = sqrt((fi + 0.5) / float(n));
  float th = fi * 2.39996323 + rot0;
  return vec2(cos(th), sin(th)) * r;
}
float jitter(vec2 uv) { return hash21(floor(uv * u_size)) * TAU; }
float mir(float x) { return 1.0 - abs(fract(x * 0.5) * 2.0 - 1.0); }
`;
