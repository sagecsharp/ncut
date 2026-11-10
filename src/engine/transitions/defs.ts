/**
 * the look of each transition.
 *
 * contract: define exactly   vec4 transition(vec2 uv, float p)
 *   uv is 0..1 across the frame, (0,0) = TOP LEFT. p is the progress 0..1 (already eased).
 *   a(vec2 uv) = the outgoing picture, b(vec2 uv) = the incoming picture. both return PREMULTIPLIED
 *   rgba (a clip that does not fill the frame is transparent around it) and are transparent outside 0..1.
 *   return premultiplied rgba. at p = 0 the result must be exactly a(uv), at p = 1 exactly b(uv).
 * the effect prelude helpers are available (aspect, hash21, noise2, rot, sat, PI, TAU, u_size, u_res).
 */
export const TRANSITION_GLSL: Record<string, string> = {
  'cross-fade': `vec4 transition(vec2 uv, float p) { return mix(a(uv), b(uv), p); }`,
};
