/**
 * the 3d renderer, unlit or lit by light.ts: textured planes with a depth buffer, plus plain colored lines for editor
 * helpers. a render with a lit plane uses a second program (LIT_VS / LIT_FS), every other render the plane program as it
 * always was. one webgl2 context per channel, like the effects runner. the result is a transparent canvas
 * (premultiplied alpha) that the 2d frame renderer draws on top of what is already there.
 */
import type { SceneFog, Shape3D } from '../../types';
import { createCanvas } from '../../lib/canvas';
import type { Mat4, Vec3 } from './math';
import { mulInto } from './math';
import { fogOn, writeFogUniforms } from './fog';
import { type FocusRig, MAX_BLUR, blurReach, boundFocus, meshNeedsBlur } from './focus';
import { type LightRig, planeLight } from './light';
import { type MeshGroup, interleave, interleaveLit, knownShape, litShapeMesh, shapeMesh } from './meshes';
import { paintOrder } from './order';
import { solidOutline } from './outline3d';

type GLCanvas = OffscreenCanvas | HTMLCanvasElement;

export interface Plane3D {
  image: TexImageSource;
  /**
   * set for pictures that do not change every frame (images, rendered text): the texture is uploaded
   * once per key and gets mipmaps. change the key when the pixels change. leave undefined for video.
   */
  cacheKey?: string;
  /** maps the unit shape (x, y, z in -0.5..0.5; a plane has z = 0) into world space */
  model: Mat4;
  /** missing or an id this build does not know = 'plane' (see meshes.ts) */
  shape?: Shape3D;
  /** 0..1 */
  alpha: number;
  /**
   * the part of the picture to show as [u0, v0, du, dv] (0..1 of the texture). missing = all of it.
   * the mesh uv 0..1 is remapped into this window.
   */
  uv?: [number, number, number, number];
  /**
   * rounded corners (plane only): radius in pixels of the plane, with the plane's own size in pixels.
   * the alpha is cut by a rounded rectangle with a ~1 screen pixel soft edge. missing / 0 = square.
   */
  radius?: number;
  size?: [number, number];
  /**
   * the layer (clip) this plane belongs to. coplanar layers are nudged toward the viewer by their layer number; the
   * planes of one stack (a 3d text's sides) share a layer, so they are not nudged against each other (they have real
   * depth between them). missing = the plane's place in the list.
   */
  layer?: number;
  /**
   * the number of planes that share this picture as a stack (a 3d text's sides). the shader gives every texel the alpha
   * that makes the n planes composite to the texel's own alpha (times `alpha`) instead of 1 - (1 - a)^n, so soft edges,
   * blurred halos and faded letters stay soft. missing or <= 1 = a plain plane. see stackedTexelAlpha.
   */
  stack?: number;
  /**
   * a line around a solid (a shape other than 'plane'): centered on its silhouette and on its hard edges, see
   * outline3d.ts. ignored on a plane.
   */
  outline?: PlaneOutline;
  /**
   * pictures for single sides of a solid, by side name (meshes.ts groups, faces.ts faceNames). a side with no entry shows
   * `image` / `uv` as usual. missing or empty = the plain path: one draw for the whole mesh. ignored on a plane.
   */
  faces?: Record<string, FacePicture>;
  /**
   * 0..1: how much the light of the render (renderScene `light`) shades this plane. missing / 0 = unlit, exactly as before.
   * a plane gets one light (its normal turned to the eye, light.ts planeLight); a solid is lit per vertex.
   */
  lit?: number;
  /**
   * key-less pictures only: the same number on two renders means the same pixels in the same image object (the copies of
   * one motion blur), so the upload of the earlier render may be kept. missing = upload as usual.
   */
  serial?: number;
}

/** the picture of one side of a solid */
export interface FacePicture {
  image: TexImageSource;
  /** like Plane3D.cacheKey: set for a picture that stays the same (uploaded once per key). a video frame has none. */
  cacheKey?: string;
  /** the window into the picture that the side's uv 0..1 shows, like Plane3D.uv. it may reach outside 0..1 (a picture shown whole inside a bigger side) */
  uv?: [number, number, number, number];
  /**
   * [u0, v0, du, dv] of the texture: outside this rectangle the side is see-through instead of the smeared edge of the
   * picture (the picture's crop, for a side that shows it whole). missing = no cut.
   */
  clip?: [number, number, number, number];
}

export interface PlaneOutline {
  /** straight rgba, 0..1 */
  color: [number, number, number, number];
  /** line width in the units the mesh has after `size` (canvas pixels of the clip) */
  width: number;
  /** the lengths the unit mesh is scaled by inside `model`: x, y, z */
  size: [number, number, number];
  /** true = the solid itself is not drawn (a figure without a fill): only the line shows */
  hollow?: boolean;
}

/**
 * the alpha one plane of a stack of `n` needs so that the n planes composite to `a` (0..1): 1 - (1 - a)^(1/n).
 * the fragment shader does the same per texel (keep in sync); exported for tests.
 */
export function stackedTexelAlpha(a: number, n: number): number {
  if (!(a > 0)) return 0;
  if (!(a < 1)) return 1;
  if (!(n > 1)) return a;
  return 1 - Math.pow(1 - a, 1 / n);
}

export interface Lines3D {
  /** x, y, z of each segment end, two points per segment */
  points: number[];
  /** straight rgba, 0..1 */
  color: [number, number, number, number];
}

const PLANE_VS = `#version 300 es
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec2 a_uv;
uniform mat4 u_mvp;
// only read while fog is on (u_fogOn > 0): the world position of the vertex, for the distance to the eye
uniform mat4 u_model;
uniform float u_fogOn;
out vec2 v_uv;
out vec3 v_world;
// distance along the view direction (depth of field)
out float v_depth;
void main() {
  v_uv = a_uv;
  v_world = u_fogOn > 0.0 ? (u_model * vec4(a_pos, 1.0)).xyz : vec3(0.0);
  gl_Position = u_mvp * vec4(a_pos, 1.0);
  v_depth = gl_Position.w;
}`;
export const PLANE_FS = `#version 300 es
precision highp float;
const float SOLID = 0.98;
in vec2 v_uv;
in vec3 v_world;
in float v_depth;
uniform sampler2D u_tex;
uniform float u_alpha;
uniform vec4 u_uv;
uniform float u_radius;
uniform vec2 u_size;
// 1 = only the solid pixels, 2 = only the see-through ones (see render)
uniform float u_pass;
// fog (fog.ts): rgb of the fog color, near / far - near / amount. u_fogOn = 0: off, nothing below runs.
uniform float u_fogOn;
uniform vec3 u_fogColor;
uniform vec3 u_fogRange;
uniform vec3 u_eye;
// depth of field (focus.ts focusBlur): u_focusOn = 0 for sharp meshes, nothing below runs for them.
// u_focus = distance, sharp range, reach, strength * MAX_BLUR. u_frameH = backing height in pixels.
// u_edge = 1: the mesh is a plane, its border fades by the blur radius.
uniform float u_focusOn;
uniform vec4 u_focus;
uniform float u_frameH;
uniform float u_edge;
// 1 = the picture wraps round the mesh in u (sphere, cylinder, cone, capsule, torus): taps wrap at the seam instead of clamping
uniform float u_wrapU;
// number of planes that share this picture (a 3d text's side stack). 1 = a plain plane.
uniform float u_stack;
// 1 = the picture is only real inside the rectangle u_clip (u0, v0, u1, v1 of the texture): see-through outside (a side that shows a picture whole)
uniform float u_clipOn;
uniform vec4 u_clip;
// 1 = this side shows a picture of its own and the solid's own picture lies under it (texture unit 1, read through the
// window u_underUv): where the side's picture is see-through (around a picture that is shown whole, soft letter edges)
// the own picture shows, not the inside of the solid. mixed here, so the alpha, the passes and the fog see one picture.
uniform sampler2D u_under;
uniform float u_underOn;
uniform vec4 u_underUv;
out vec4 outColor;
// 1 inside the real part of the picture, 0 outside (always 1 while u_clipOn is 0)
float clipMask(vec2 p) {
  if (u_clipOn < 0.5) return 1.0;
  return (p.x >= u_clip.x && p.y >= u_clip.y && p.x <= u_clip.z && p.y <= u_clip.w) ? 1.0 : 0.0;
}
// a vogel disc of taps (radius r in screen pixels), each read at the mip level that matches the tap spacing
vec4 discBlur(vec2 tc, vec2 dx, vec2 dy, float r) {
  float s = max(1.0, r * 0.6);
  vec2 gx = dx * s;
  vec2 gy = dy * s;
  vec2 lo = u_uv.xy;
  vec2 hi = u_uv.xy + u_uv.zw;
  vec2 size = max(u_uv.zw, vec2(1e-6));
  vec4 sum = textureGrad(u_tex, tc, gx, gy) * clipMask(tc);
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 2.399963;
    float rad = r * sqrt((float(i) + 0.5) / 12.0);
    vec2 o = vec2(cos(a), sin(a)) * rad;
    vec2 p = tc + dx * o.x + dy * o.y;
    if (u_wrapU > 0.5) {
      // wrap u inside the window of the picture that the mesh shows
      p.x = lo.x + fract((p.x - lo.x) / size.x) * size.x;
      p.y = clamp(p.y, lo.y, hi.y);
    } else p = clamp(p, lo, hi);
    // a tap outside the real part of the picture counts as see-through, not as the smeared edge
    sum += textureGrad(u_tex, p, gx, gy) * clipMask(p);
  }
  return sum / 13.0;
}
void main() {
  vec2 tc = u_uv.xy + v_uv * u_uv.zw;
  vec4 c;
  // blur radius in screen pixels (0 = sharp)
  float blur = 0.0;
  if (u_focusOn > 0.0) {
    // derivatives first, outside any branch that depends on the pixel
    vec2 dx = dFdx(tc);
    vec2 dy = dFdy(tc);
    vec2 gu = vec2(length(vec2(dFdx(v_uv.x), dFdy(v_uv.x))), length(vec2(dFdx(v_uv.y), dFdy(v_uv.y))));
    float dz = max(abs(v_depth - u_focus.x) - u_focus.y, 0.0);
    blur = u_focus.w * u_frameH * dz / (dz + u_focus.z);
    if (blur > 0.25) {
      c = discBlur(tc, dx, dy, blur);
      if (u_edge > 0.5) {
        vec2 e = min(v_uv, 1.0 - v_uv) / max(gu, vec2(1e-6));
        float t = clamp(min(e.x, e.y) / (1.5 * blur), 0.0, 1.0);
        c *= t * t * (3.0 - 2.0 * t);
      }
    } else {
      blur = 0.0;
      c = texture(u_tex, tc) * clipMask(tc);
    }
  } else {
    c = texture(u_tex, tc) * clipMask(tc);
  }
  if (u_underOn > 0.5) {
    vec4 un = texture(u_under, u_underUv.xy + v_uv * u_underUv.zw);
    c += un * (1.0 - c.a);
  }
  // the texture is premultiplied, so is the output
  c *= u_alpha;
  if (u_radius > 0.0) {
    // signed distance to a rounded rectangle, in plane pixels. the edge fades over about one screen pixel.
    vec2 q = abs((v_uv - 0.5) * u_size) - (u_size * 0.5 - vec2(u_radius));
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - u_radius;
    c *= clamp(0.5 - d / (max(fwidth(d), 1e-4) * (1.0 + blur)), 0.0, 1.0);
  }
  if (u_stack > 1.5) {
    // the n planes of a stack show the same picture: give each the alpha that makes them composite to the alpha this
    // texel has now (picture x plane alpha x blur edge), not to 1 - (1 - a)^n. keep in sync with stackedTexelAlpha.
    float sa = clamp(c.a, 0.0, 1.0);
    float sa2 = 1.0 - pow(1.0 - sa, 1.0 / u_stack);
    c *= sa2 / max(sa, 1e-4);
  }
  if (c.a < 0.004) discard;
  if (u_pass < 1.5 ? c.a < SOLID : c.a >= SOLID) discard;
  if (u_fogOn > 0.0) {
    // FOG MATH: must match fog.ts (fogFactor + mixFog). un-premultiply, mix, premultiply again; alpha is kept.
    float f = clamp((distance(v_world, u_eye) - u_fogRange.x) / u_fogRange.y, 0.0, 1.0) * u_fogRange.z;
    vec3 rgb = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
    c.rgb = mix(rgb, u_fogColor, f) * c.a;
  }
  outColor = c;
}`;
export const LIT_VS = `#version 300 es
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec2 a_uv;
// lit solids only (their lit mesh). a plane's vao has none: it reads 0 here and never uses it (u_light.w = 0)
layout(location = 2) in vec3 a_normal;
uniform mat4 u_mvp;
// read while fog is on, and for a lit solid (its normal)
uniform mat4 u_model;
uniform float u_fogOn;
// rgb = the light of a plane (cpu, light.ts planeLight) with w = 0, or (1, 1, 1, lit amount) for a solid lit here
uniform vec4 u_light;
// sky, horizon, ground (linear, times 1 - sun), toward the sun, sun color (linear, times sun): light.ts LightRig.env
uniform vec3 u_env[5];
out vec2 v_uv;
out vec3 v_world;
out float v_depth;
out vec3 v_light;
void main() {
  v_uv = a_uv;
  v_world = u_fogOn > 0.0 ? (u_model * vec4(a_pos, 1.0)).xyz : vec3(0.0);
  gl_Position = u_mvp * vec4(a_pos, 1.0);
  v_depth = gl_Position.w;
  v_light = vec3(1.0);
  if (u_light.w > 0.0) {
    // LIGHT MATH: must match light.ts litFactor. the normal goes through the cofactor of the model (right under any
    // scale), flipped back for a mirrored one. world y points down.
    vec3 c0 = u_model[0].xyz;
    vec3 c1 = u_model[1].xyz;
    vec3 c2 = u_model[2].xyz;
    vec3 n = mat3(cross(c1, c2), cross(c2, c0), cross(c0, c1)) * a_normal * sign(dot(c0, cross(c1, c2)));
    float len = length(n);
    n = len > 0.0 ? n / len : vec3(0.0, -1.0, 0.0);
    float up = -n.y;
    vec3 lin = u_env[0] * max(up, 0.0) + u_env[1] * (1.0 - abs(up)) + u_env[2] * max(-up, 0.0) + u_env[4] * max(dot(n, u_env[3]), 0.0);
    v_light = pow(max(mix(vec3(1.0), lin, u_light.w), vec3(1e-6)), vec3(1.0 / 2.2));
  }
}`;
/** the line LIT_FS adds right before the fog block */
export const LIGHT_LINE = '  // LIGHT: rgb only, after the alpha tests: the passes, the stack and the fog see the lit color\n  c.rgb *= u_light.w > 0.0 ? v_light : u_light.rgb;\n';
/** PLANE_FS with the light in it: its inputs before outColor, LIGHT_LINE before the fog. throws when an anchor is not there exactly once. */
export function litFragment(src: string): string {
  const decl = 'out vec4 outColor;\n';
  const fog = '  if (u_fogOn > 0.0) {\n';
  if (src.split(decl).length !== 2 || src.split(fog).length !== 2) throw new Error('litFragment: the plane shader changed, move the anchors');
  return src.replace(decl, 'uniform vec4 u_light;\nin vec3 v_light;\n' + decl).replace(fog, LIGHT_LINE + fog);
}
const LIT_FS = litFragment(PLANE_FS);
const LINE_VS = `#version 300 es
layout(location = 0) in vec3 a_pos;
uniform mat4 u_vp;
void main() {
  gl_Position = u_vp * vec4(a_pos, 1.0);
}`;
const LINE_FS = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 outColor;
void main() {
  outColor = vec4(u_color.rgb * u_color.a, u_color.a);
}`;

// the line around a solid (see outline3d.ts): flat color, position only. the fog math is the plane shader's (keep in sync).
const OUTLINE_VS = `#version 300 es
layout(location = 0) in vec3 a_pos;
uniform mat4 u_mvp;
// only read while fog is on (u_fogOn > 0)
uniform mat4 u_model;
uniform float u_fogOn;
out vec3 v_world;
void main() {
  v_world = u_fogOn > 0.0 ? (u_model * vec4(a_pos, 1.0)).xyz : vec3(0.0);
  gl_Position = u_mvp * vec4(a_pos, 1.0);
}`;
const OUTLINE_FS = `#version 300 es
precision highp float;
in vec3 v_world;
// premultiplied
uniform vec4 u_color;
uniform float u_fogOn;
uniform vec3 u_fogColor;
uniform vec3 u_fogRange;
uniform vec3 u_eye;
out vec4 outColor;
void main() {
  vec4 c = u_color;
  if (u_fogOn > 0.0) {
    // FOG MATH: must match the plane shader (and fog.ts). un-premultiply, mix, premultiply again; alpha is kept.
    float f = clamp((distance(v_world, u_eye) - u_fogRange.x) / u_fogRange.y, 0.0, 1.0) * u_fogRange.z;
    vec3 rgb = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
    c.rgb = mix(rgb, u_fogColor, f) * c.a;
  }
  outColor = c;
}`;

/** a key-less scratch upload can be kept when the slot holds the same image object from a render with the same serial and the same mips */
export function canReuseScratch(prevImage: unknown, prevSerial: number | undefined, prevMips: boolean, image: unknown, serial: number | undefined, mips: boolean): boolean {
  return serial !== undefined && prevSerial === serial && prevImage === image && prevMips === mips;
}

/**
 * what u_light holds for one plane of a lit render (see LIT_VS): unlit (1, 1, 1, 0); a lit solid (1, 1, 1, k), lit in
 * the vertex shader; a lit plane (its light, 0), one normal worked out here. k = lit clamped to 0..1.
 */
export function lightUniform(lit: number | undefined, shape: Shape3D, model: ArrayLike<number>, eye: ArrayLike<number>, env: ArrayLike<number>, out: Float32Array): void {
  const k = lit !== undefined && lit > 0 ? (lit < 1 ? lit : 1) : 0;
  if (!(k > 0)) {
    out[0] = 1;
    out[1] = 1;
    out[2] = 1;
    out[3] = 0;
    return;
  }
  if (shape !== 'plane') {
    out[0] = 1;
    out[1] = 1;
    out[2] = 1;
    out[3] = k;
    return;
  }
  planeLight(model, eye, k, env, out);
  out[3] = 0;
}

const CACHE_LIMIT = 48;
/** how many outline piece sets stay on the gpu. an animated width or size makes a new one per frame, the oldest go. */
export const OUTLINE_CACHE_LIMIT = 64;

/** the cache key of the outline pieces of a solid: shape, the three sizes and the line width (to a thousandth) */
export function outlineKey(shape: string, sx: number, sy: number, sz: number, width: number): string {
  return `${shape}|${sx.toFixed(3)}|${sy.toFixed(3)}|${sz.toFixed(3)}|${width.toFixed(3)}`;
}

/**
 * the least recently used entry goes first when a map ordered by use grows past `limit`: returns the keys to drop.
 * (a map keeps insertion order, a hit is moved to the end by the caller.)
 */
export function lruOverflow(keys: Iterable<string>, size: number, limit: number): string[] {
  const out: string[] = [];
  let over = size - limit;
  for (const k of keys) {
    if (over-- <= 0) break;
    out.push(k);
  }
  return out;
}

/** the gpu side of one solidOutline: three vaos (the core is indexed, the hull and the strips are plain triangles) and their draw counts */
interface OutlineGpu {
  hullVao: WebGLVertexArrayObject | null;
  coreVao: WebGLVertexArrayObject | null;
  stripVao: WebGLVertexArrayObject | null;
  indexCount: number;
  hullCount: number;
  stripCount: number;
  buffers: (WebGLBuffer | null)[];
}

/** shapes whose picture wraps round the mesh in u (the seam sits at u = 0 / 1): see meshes.ts */
const WRAPS_U = new Set<Shape3D>(['sphere', 'cylinder', 'cone', 'capsule', 'torus']);
export function uvWrapsU(shape: Shape3D): boolean {
  return WRAPS_U.has(shape);
}

/**
 * can any part of a plane (the unit square, z = 0, under `model`) be out of focus? the depth along the view direction
 * is linear over the plane, so its real extent is the center depth +- (|a| + |b|) from the two edge vectors (the four
 * corners through viewProj). false = both ends sit inside the sharp range: the blur and its mip chain are skipped.
 * solids keep the bounding sphere test (meshNeedsBlur).
 */
export function planeNeedsBlur(model: ArrayLike<number>, viewProj: ArrayLike<number>, f: FocusRig | null): boolean {
  if (!f) return false;
  const w = (x: number, y: number, z: number) => viewProj[3]! * x + viewProj[7]! * y + viewProj[11]! * z;
  const dc = w(model[12]!, model[13]!, model[14]!) + viewProj[15]!;
  const ext = 0.5 * (Math.abs(w(model[0]!, model[1]!, model[2]!)) + Math.abs(w(model[4]!, model[5]!, model[6]!)));
  return dc - ext < f.distance - f.range || dc + ext > f.distance + f.range;
}

/** one run of indices of a faced solid with the picture it shows */
interface FaceRun {
  tex: WebGLTexture;
  uv: [number, number, number, number];
  clip: [number, number, number, number] | null;
  start: number;
  count: number;
  /** true = the solid's own picture (a side without a picture of its own) */
  own: boolean;
}

const FULL_UV: [number, number, number, number] = [0, 0, 1, 1];

interface Mesh {
  vao: WebGLVertexArrayObject | null;
  count: number;
  /** the index range of each side (empty for a plane) */
  groups: MeshGroup[];
  buffers: (WebGLBuffer | null)[];
}

/** the uniform locations of a plane program (the base one and the lit one have the same names; light / env only on the lit one) */
interface PlaneLocs {
  mvp: WebGLUniformLocation | null;
  alpha: WebGLUniformLocation | null;
  uv: WebGLUniformLocation | null;
  radius: WebGLUniformLocation | null;
  size: WebGLUniformLocation | null;
  pass: WebGLUniformLocation | null;
  model: WebGLUniformLocation | null;
  fogOn: WebGLUniformLocation | null;
  fogColor: WebGLUniformLocation | null;
  fogRange: WebGLUniformLocation | null;
  eye: WebGLUniformLocation | null;
  focusOn: WebGLUniformLocation | null;
  focus: WebGLUniformLocation | null;
  frameH: WebGLUniformLocation | null;
  edge: WebGLUniformLocation | null;
  wrapU: WebGLUniformLocation | null;
  stack: WebGLUniformLocation | null;
  clipOn: WebGLUniformLocation | null;
  clip: WebGLUniformLocation | null;
  under: WebGLUniformLocation | null;
  underOn: WebGLUniformLocation | null;
  underUv: WebGLUniformLocation | null;
  light: WebGLUniformLocation | null;
  env: WebGLUniformLocation | null;
}

interface PlaneProgram {
  program: WebGLProgram;
  loc: PlaneLocs;
}

class SceneRenderer {
  readonly canvas: GLCanvas;
  private gl: WebGL2RenderingContext;
  /** the plane program of the render in progress: base, or lit while a render has a lit plane */
  private prog: PlaneProgram;
  private base: PlaneProgram;
  private lit: PlaneProgram | null = null;
  private litState: 'none' | 'started' | 'ready' | 'failed' = 'none';
  private litPending: { program: WebGLProgram; vs: WebGLShader; fs: WebGLShader } | null = null;
  private litMeshes = new Map<Shape3D, Mesh>();
  private lightBuf = new Float32Array(4);
  /** the u_light the program holds now (nan = not sent yet in this render): an equal one is not sent again */
  private lastLight = new Float32Array(4);
  private lineProg: WebGLProgram;
  private outlineProg: WebGLProgram;
  private oMvp: WebGLUniformLocation | null;
  private oModel: WebGLUniformLocation | null;
  private oColor: WebGLUniformLocation | null;
  private oFogOn: WebGLUniformLocation | null;
  private oFogColor: WebGLUniformLocation | null;
  private oFogRange: WebGLUniformLocation | null;
  private oEye: WebGLUniformLocation | null;
  /** the fog and eye of the render in progress, for the outline program (its uniforms are its own) */
  private fogging = false;
  private eyeNow: Vec3 = [0, 0, 0];
  /** least recently used first (map order): a hit moves the entry to the end. null = pieces were empty. */
  private outlines = new Map<string, OutlineGpu | null>();
  /** a 1 x 1 see-through texture: what texture unit 1 holds while no side picture is drawn */
  private blank: WebGLTexture | null = null;
  private fogBuf = new Float32Array(6);
  /** the model-view-projection of the plane being drawn (written per plane, read by the gl call right away) */
  private mvpBuf = new Float32Array(16);
  private uVp: WebGLUniformLocation | null;
  private uColor: WebGLUniformLocation | null;
  private meshes = new Map<Shape3D, Mesh>();
  private lineVao: WebGLVertexArrayObject | null;
  private lineBuf: WebGLBuffer | null;
  private cache = new Map<string, { tex: WebGLTexture; used: number }>();
  private scratch: WebGLTexture[] = [];
  /** scratch textures that currently have a mip filter (only while a mesh is blurred) */
  private scratchMips: boolean[] = [];
  /** the image object and serial a key-less scratch slot last uploaded with a serial (see canReuseScratch) */
  private scratchImage: (TexImageSource | null)[] = [];
  private scratchSerial: (number | undefined)[] = [];
  private frame = 0;
  /** scratch slots used so far in this render, and the key-less picture uploaded last (see ownTexture) */
  private slot = 0;
  private lastImage: TexImageSource | null = null;
  private lastMips = false;
  /** textures of the sides of the solid being drawn: not evicted before it is drawn */
  private pinned = new Set<WebGLTexture>();
  private aniso: { ext: EXT_texture_filter_anisotropic; max: number } | null = null;
  dead = false;

  constructor(canvas: GLCanvas, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    const basep = this.link(PLANE_VS, PLANE_FS);
    this.base = { program: basep, loc: this.locate(basep) };
    this.prog = this.base;
    // only enables it: the lit program is compiled and linked without asking for the status (startLit)
    gl.getExtension('KHR_parallel_shader_compile');
    this.lineProg = this.link(LINE_VS, LINE_FS);
    this.outlineProg = this.link(OUTLINE_VS, OUTLINE_FS);
    const op = this.outlineProg;
    this.oMvp = gl.getUniformLocation(op, 'u_mvp');
    this.oModel = gl.getUniformLocation(op, 'u_model');
    this.oColor = gl.getUniformLocation(op, 'u_color');
    this.oFogOn = gl.getUniformLocation(op, 'u_fogOn');
    this.oFogColor = gl.getUniformLocation(op, 'u_fogColor');
    this.oFogRange = gl.getUniformLocation(op, 'u_fogRange');
    this.oEye = gl.getUniformLocation(op, 'u_eye');
    this.uVp = gl.getUniformLocation(this.lineProg, 'u_vp');
    this.uColor = gl.getUniformLocation(this.lineProg, 'u_color');


    this.lineVao = gl.createVertexArray();
    gl.bindVertexArray(this.lineVao);
    this.lineBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    if (ext) this.aniso = { ext, max: Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number) };

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.dead = true;
    });
  }

  /** the context is gone (the event can come a moment after the loss, so ask the context too) */
  isLost(): boolean {
    return this.dead || this.gl.isContextLost();
  }

  /**
   * free every gpu object and the drawing buffer. the renderer is unusable afterwards (dead): drop it from the map so
   * the next use builds a fresh one.
   */
  dispose(): void {
    this.dead = true;
    try {
      const gl = this.gl;
      for (const e of this.cache.values()) gl.deleteTexture(e.tex);
      this.cache.clear();
      for (const t of this.scratch) if (t) gl.deleteTexture(t);
      if (this.blank) gl.deleteTexture(this.blank);
      this.blank = null;
      this.scratch = [];
      this.scratchImage = [];
      this.scratchSerial = [];
      for (const m of this.meshes.values()) {
        gl.deleteVertexArray(m.vao);
        for (const b of m.buffers) gl.deleteBuffer(b);
      }
      this.meshes.clear();
      for (const m of this.litMeshes.values()) {
        gl.deleteVertexArray(m.vao);
        for (const b of m.buffers) gl.deleteBuffer(b);
      }
      this.litMeshes.clear();
      for (const o of this.outlines.values()) this.freeOutline(o);
      this.outlines.clear();
      gl.deleteVertexArray(this.lineVao);
      gl.deleteBuffer(this.lineBuf);
      gl.deleteProgram(this.base.program);
      if (this.lit) gl.deleteProgram(this.lit.program);
      if (this.litPending) {
        gl.deleteProgram(this.litPending.program);
        gl.deleteShader(this.litPending.vs);
        gl.deleteShader(this.litPending.fs);
        this.litPending = null;
      }
      gl.deleteProgram(this.lineProg);
      gl.deleteProgram(this.outlineProg);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      // the antialiased depth + color buffer goes with a 1x1 canvas
      this.canvas.width = 1;
      this.canvas.height = 1;
    } catch {
      // already gone
    }
  }

  /** the uniform locations of a plane program. light and env are null on the base one. */
  private locate(p: WebGLProgram): PlaneLocs {
    const gl = this.gl;
    const at = (name: string) => gl.getUniformLocation(p, name);
    return {
      mvp: at('u_mvp'),
      alpha: at('u_alpha'),
      uv: at('u_uv'),
      radius: at('u_radius'),
      size: at('u_size'),
      pass: at('u_pass'),
      model: at('u_model'),
      fogOn: at('u_fogOn'),
      fogColor: at('u_fogColor'),
      fogRange: at('u_fogRange'),
      eye: at('u_eye'),
      focusOn: at('u_focusOn'),
      focus: at('u_focus'),
      frameH: at('u_frameH'),
      edge: at('u_edge'),
      wrapU: at('u_wrapU'),
      stack: at('u_stack'),
      clipOn: at('u_clipOn'),
      clip: at('u_clip'),
      under: at('u_under'),
      underOn: at('u_underOn'),
      underUv: at('u_underUv'),
      light: at('u_light'),
      env: at('u_env'),
    };
  }

  /**
   * start compiling the lit program, without asking for any status (the driver can build it in the background). the
   * first lit render asks (litProgram). no-op once started or when the context is gone.
   */
  startLit(): void {
    if (this.litState !== 'none' || this.isLost()) return;
    const gl = this.gl;
    try {
      const vs = gl.createShader(gl.VERTEX_SHADER)!;
      gl.shaderSource(vs, LIT_VS);
      gl.compileShader(vs);
      const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
      gl.shaderSource(fs, LIT_FS);
      gl.compileShader(fs);
      const program = gl.createProgram()!;
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      this.litPending = { program, vs, fs };
      this.litState = 'started';
    } catch {
      this.litState = 'failed';
    }
  }

  /** the lit program, once it is linked. null = it failed (lit planes are drawn unlit) */
  private litProgram(): PlaneProgram | null {
    if (this.litState === 'ready') return this.lit;
    if (this.litState === 'failed') return null;
    this.startLit();
    const pend = this.litPending;
    if (!pend) return null;
    this.litPending = null;
    const gl = this.gl;
    if (!gl.getProgramParameter(pend.program, gl.LINK_STATUS)) {
      console.warn('[ncut] the lit 3d program failed, lit clips are drawn unlit', gl.getProgramInfoLog(pend.program), gl.getShaderInfoLog(pend.vs), gl.getShaderInfoLog(pend.fs));
      gl.deleteProgram(pend.program);
      gl.deleteShader(pend.vs);
      gl.deleteShader(pend.fs);
      this.litState = 'failed';
      return null;
    }
    this.lit = { program: pend.program, loc: this.locate(pend.program) };
    this.litState = 'ready';
    return this.lit;
  }

  private link(vsSrc: string, fsSrc: string): WebGLProgram {
    const gl = this.gl;
    const make = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'shader failed');
      return sh;
    };
    const p = gl.createProgram();
    gl.attachShader(p, make(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, make(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link failed');
    return p;
  }

  /** the gpu mesh for a shape, built on first use */
  private mesh(shape: Shape3D): Mesh {
    const hit = this.meshes.get(shape);
    if (hit) return hit;
    const gl = this.gl;
    const data = shapeMesh(shape);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, interleave(data), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    const mesh: Mesh = { vao, count: data.indices.length, groups: data.groups, buffers: [vbo, ibo] };
    this.meshes.set(shape, mesh);
    return mesh;
  }

  /** the gpu mesh of a lit solid (normals at location 2), built on first use. mesh() stays as it is. */
  private litMesh(shape: Shape3D): Mesh {
    const hit = this.litMeshes.get(shape);
    if (hit) return hit;
    const gl = this.gl;
    const data = litShapeMesh(shape);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, interleaveLit(data), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 32, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 32, 20);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    const mesh: Mesh = { vao, count: data.indices.length, groups: data.groups, buffers: [vbo, ibo] };
    this.litMeshes.set(shape, mesh);
    return mesh;
  }

  private freeOutline(o: OutlineGpu | null): void {
    if (!o) return;
    const gl = this.gl;
    gl.deleteVertexArray(o.hullVao);
    gl.deleteVertexArray(o.coreVao);
    gl.deleteVertexArray(o.stripVao);
    for (const b of o.buffers) gl.deleteBuffer(b);
  }

  /** the gpu pieces of the line around a solid, built on first use. null = nothing to draw (empty pieces). */
  private outlineGpu(shape: Shape3D, o: PlaneOutline): OutlineGpu | null {
    const key = outlineKey(shape, o.size[0], o.size[1], o.size[2], o.width);
    if (this.outlines.has(key)) {
      const hit = this.outlines.get(key)!;
      this.outlines.delete(key);
      this.outlines.set(key, hit);
      return hit;
    }
    const gl = this.gl;
    const data = solidOutline(shape, o.size[0], o.size[1], o.size[2], o.width);
    let gpu: OutlineGpu | null = null;
    if (data.indices.length > 0 && data.hull.length > 0 && data.core.length > 0) {
      // the index buffer binding belongs to the bound vao: with a mesh's vao still bound (the plane loop leaves the last
      // one bound) the new index buffer would replace that mesh's own
      gl.bindVertexArray(null);
      const buf =(target: number, src: ArrayBufferView) => {
        const b = gl.createBuffer();
        gl.bindBuffer(target, b);
        gl.bufferData(target, src, gl.STATIC_DRAW);
        return b;
      };
      const positions = (b: WebGLBuffer | null, ibo: WebGLBuffer | null) => {
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        if (ibo) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        return vao;
      };
      const hull = buf(gl.ARRAY_BUFFER, data.hull);
      const core = buf(gl.ARRAY_BUFFER, data.core);
      const ibo = buf(gl.ELEMENT_ARRAY_BUFFER, data.indices);
      const strips = data.strips.length > 0 ? buf(gl.ARRAY_BUFFER, data.strips) : null;
      gpu = {
        hullVao: positions(hull, null),
        coreVao: positions(core, ibo),
        stripVao: strips ? positions(strips, null) : null,
        indexCount: data.indices.length,
        hullCount: data.hull.length / 3,
        stripCount: data.strips.length / 3,
        buffers: [hull, core, ibo, strips],
      };
      gl.bindVertexArray(null);
    }
    this.outlines.set(key, gpu);
    // really delete the evicted ones: an animated width or size makes a new entry every frame
    for (const k of lruOverflow(this.outlines.keys(), this.outlines.size, OUTLINE_CACHE_LIMIT)) {
      this.freeOutline(this.outlines.get(k) ?? null);
      this.outlines.delete(k);
    }
    return gpu;
  }

  /**
   * the line around one solid, drawn after the solid itself: core into the stencil, hull where the core is not (the
   * silhouette line), strips along the hard edges inside. stencil bit 0 = the core, bit 1 = something was painted
   * already (the hull has a front and a back, the strips lie on both faces: every pixel is painted once).
   * the depth of field blur does not apply to the line: it stays sharp.
   * expects this.mvpBuf to hold the plane's mvp. gives the gl state back the way the plane loop needs it: the plane
   * program of the render and `vao` bound.
   */
  private drawOutline(plane: Plane3D, shape: Shape3D, gpu: OutlineGpu, offsetUnits: number, vao: WebGLVertexArrayObject | null): void {
    const gl = this.gl;
    const o = plane.outline!;
    const ca = o.color[3];
    const a = ca * Math.min(1, plane.alpha);
    gl.useProgram(this.outlineProg);
    gl.uniformMatrix4fv(this.oMvp, false, this.mvpBuf);
    gl.uniform1f(this.oFogOn, this.fogging ? 1 : 0);
    if (this.fogging) {
      gl.uniformMatrix4fv(this.oModel, false, plane.model);
      gl.uniform3f(this.oFogColor, this.fogBuf[0]!, this.fogBuf[1]!, this.fogBuf[2]!);
      gl.uniform3f(this.oFogRange, this.fogBuf[3]!, this.fogBuf[4]!, this.fogBuf[5]!);
      gl.uniform3f(this.oEye, this.eyeNow[0], this.eyeNow[1], this.eyeNow[2]);
    }
    gl.enable(gl.STENCIL_TEST);
    gl.stencilMask(0xff);
    gl.clearStencil(0);
    gl.clear(gl.STENCIL_BUFFER_BIT);

    // the core only marks the stencil
    gl.colorMask(false, false, false, false);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.stencilFunc(gl.ALWAYS, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    gl.stencilMask(0x01);
    gl.bindVertexArray(gpu.coreVao);
    gl.drawElements(gl.TRIANGLES, gpu.indexCount, gl.UNSIGNED_SHORT, 0);
    gl.colorMask(true, true, true, true);
    gl.enable(gl.DEPTH_TEST);

    gl.uniform4f(this.oColor, o.color[0] * a, o.color[1] * a, o.color[2] * a, a);
    // the silhouette: hull minus core
    gl.stencilFunc(gl.EQUAL, 0, 0x03);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
    gl.stencilMask(0x02);
    gl.depthMask(plane.alpha >= 0.98 && ca >= 0.98);
    gl.bindVertexArray(gpu.hullVao);
    gl.drawArrays(gl.TRIANGLES, 0, gpu.hullCount);

    // the hard edges inside: they lie exactly on the faces, so pull them a bit more toward the viewer
    if (gpu.stripVao && gpu.stripCount > 0) {
      gl.stencilFunc(gl.EQUAL, 0, 0x02);
      gl.depthMask(false);
      gl.polygonOffset(-1, offsetUnits - 8);
      gl.bindVertexArray(gpu.stripVao);
      gl.drawArrays(gl.TRIANGLES, 0, gpu.stripCount);
    }

    gl.disable(gl.STENCIL_TEST);
    gl.stencilMask(0xff);
    gl.polygonOffset(0, offsetUnits);
    gl.depthMask(false);
    gl.useProgram(this.prog.program);
    gl.bindVertexArray(vao);
  }

  private newTexture(mips: boolean): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (mips && this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.ext.TEXTURE_MAX_ANISOTROPY_EXT, this.aniso.max);
    return tex;
  }

  /**
   * bind the texture of a picture, uploading when needed, and give it back (null when the upload failed). a picture with
   * a key is uploaded once (and gets mips); one without uploads into the scratch texture `slot` every time.
   */
  private acquire(image: TexImageSource, cacheKey: string | undefined, slot: number, mips: boolean, serial?: number): WebGLTexture | null {
    const gl = this.gl;
    if (cacheKey !== undefined) {
      const hit = this.cache.get(cacheKey);
      if (hit) {
        hit.used = this.frame;
        gl.bindTexture(gl.TEXTURE_2D, hit.tex);
        return hit.tex;
      }
      const tex = this.newTexture(true);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        gl.generateMipmap(gl.TEXTURE_2D);
      } catch {
        gl.deleteTexture(tex);
        return null;
      }
      this.cache.set(cacheKey, { tex, used: this.frame });
      if (this.cache.size > CACHE_LIMIT) this.evict();
      return tex;
    }
    let tex = this.scratch[slot];
    if (!tex) {
      tex = this.newTexture(false);
      this.scratch[slot] = tex;
    } else {
      gl.bindTexture(gl.TEXTURE_2D, tex);
    }
    // the same frame as the render before (the copies of a motion blur): its upload is still in the texture
    if (canReuseScratch(this.scratchImage[slot] ?? null, this.scratchSerial[slot], this.scratchMips[slot] === true, image, serial, mips)) return tex;
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      // a blurred video frame reads smaller mip levels: build them for this frame only
      if (mips !== (this.scratchMips[slot] === true)) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
        this.scratchMips[slot] = mips;
      }
      if (mips) gl.generateMipmap(gl.TEXTURE_2D);
      this.scratchImage[slot] = serial !== undefined ? image : null;
      this.scratchSerial[slot] = serial;
    } catch {
      this.scratchImage[slot] = null;
      this.scratchSerial[slot] = undefined;
      return null;
    }
    return tex;
  }

  /** the texture of a plane's own picture, bound. the same image object as the plane before it (the planes of a stack) is not uploaded again. */
  private ownTexture(plane: Plane3D, blurred: boolean): WebGLTexture | null {
    const gl = this.gl;
    if (plane.cacheKey === undefined && this.slot > 0 && plane.image === this.lastImage && blurred === this.lastMips && this.scratch[this.slot - 1]) {
      const tex = this.scratch[this.slot - 1]!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      return tex;
    }
    this.lastImage = null;
    const tex = this.acquire(plane.image, plane.cacheKey, this.slot, blurred, plane.serial);
    if (tex && plane.cacheKey === undefined) {
      this.lastImage = plane.image;
      this.lastMips = blurred;
      this.slot++;
    }
    return tex;
  }

  /**
   * the draws of a solid with pictures on some of its sides: one run of indices per side (neighbours that show the own
   * picture are one run), each with its texture and uv window. null = no side has a picture of its own, or the mesh has
   * no sides: the plain path. a side whose picture cannot be uploaded shows the own picture.
   * a key-less picture (a video frame) takes a scratch slot of its own for the frame, one image object shared by several
   * sides takes one. textures made here are held back from eviction until the plane is drawn (`pinned`).
   */
  private faceRuns(plane: Plane3D, mesh: Mesh, own: WebGLTexture, blurred: boolean): FaceRun[] | null {
    const faces = plane.faces;
    if (!faces || mesh.groups.length === 0) return null;
    let any = false;
    for (const g of mesh.groups) if (faces[g.name]) any = true;
    if (!any) return null;
    const ownRun = { tex: own, uv: plane.uv ?? FULL_UV, clip: null as FaceRun['clip'] };
    this.pinned.add(own);
    const byImage = new Map<TexImageSource, WebGLTexture | null>();
    const made = new Map<FacePicture, typeof ownRun>();
    const runs: FaceRun[] = [];
    for (const g of mesh.groups) {
      const pic = faces[g.name];
      let r = ownRun;
      if (pic) {
        let m = made.get(pic);
        if (!m) {
          let tex: WebGLTexture | null | undefined = pic.cacheKey === undefined ? byImage.get(pic.image) : undefined;
          if (tex === undefined) {
            tex = this.acquire(pic.image, pic.cacheKey, this.slot, blurred);
            if (pic.cacheKey === undefined) {
              if (tex) this.slot++;
              byImage.set(pic.image, tex);
            }
          }
          if (tex) {
            this.pinned.add(tex);
            m = { tex, uv: pic.uv ?? FULL_UV, clip: pic.clip ?? null };
            made.set(pic, m);
          }
        }
        if (m) r = m;
      }
      const last = runs[runs.length - 1];
      const isOwn = r === ownRun;
      if (last && last.own === isOwn && last.tex === r.tex && last.uv === r.uv && last.clip === r.clip && last.start + last.count === g.start) last.count += g.count;
      else runs.push({ tex: r.tex, uv: r.uv, clip: r.clip, start: g.start, count: g.count, own: isOwn });
    }
    // a later plane must not take one of these for "the picture uploaded just before"
    this.lastImage = null;
    return runs;
  }

  /**
   * one pass over the runs of a faced solid: each run binds its own texture (faceRuns left another one bound).
   * `hollow`: the solid has no fill of its own (only its line): the sides without a picture are not drawn, and nothing
   * lies under the ones that have one. otherwise a side's picture is mixed over the own picture (texture unit 1).
   */
  private drawRuns(runs: FaceRun[], hollow: boolean): void {
    const gl = this.gl;
    const loc = this.prog.loc;
    let bound: WebGLTexture | null = null;
    let clipOn = false;
    let underOn = false;
    for (const r of runs) {
      if (r.own && hollow) continue;
      const under = !r.own && !hollow;
      if (under !== underOn) {
        gl.uniform1f(loc.underOn, under ? 1 : 0);
        underOn = under;
      }
      if (r.tex !== bound) {
        gl.bindTexture(gl.TEXTURE_2D, r.tex);
        bound = r.tex;
      }
      gl.uniform4f(loc.uv, r.uv[0], r.uv[1], r.uv[2], r.uv[3]);
      const on = r.clip !== null;
      if (on) gl.uniform4f(loc.clip, r.clip![0], r.clip![1], r.clip![0] + r.clip![2], r.clip![1] + r.clip![3]);
      if (on !== clipOn) {
        gl.uniform1f(loc.clipOn, on ? 1 : 0);
        clipOn = on;
      }
      gl.drawElements(gl.TRIANGLES, r.count, gl.UNSIGNED_SHORT, r.start * 2);
    }
    if (clipOn) gl.uniform1f(loc.clipOn, 0);
    if (underOn) gl.uniform1f(loc.underOn, 0);
  }

  /** texture unit 1 (the own picture under a side's picture): `tex`, or the blank one. unit 0 is the active one after. */
  private bindUnder(tex: WebGLTexture | null): void {
    const gl = this.gl;
    if (!this.blank) {
      this.blank = gl.createTexture();
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.blank);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, tex ?? this.blank);
    gl.activeTexture(gl.TEXTURE0);
  }

  private evict(): void {
    // drop the least recently used half
    const entries = [...this.cache.entries()].sort((a, b) => a[1].used - b[1].used);
    for (let i = 0; i < entries.length / 2; i++) {
      // the sides of the solid being set up are still to be drawn
      if (this.pinned.has(entries[i]![1].tex)) continue;
      this.gl.deleteTexture(entries[i]![1].tex);
      this.cache.delete(entries[i]![0]);
    }
  }

  render(planes: Plane3D[], lines: Lines3D[], viewProj: Mat4, eye: Vec3, w: number, h: number, fog: SceneFog | null = null, focus: FocusRig | null = null, light: LightRig | null = null): GLCanvas | null {
    const gl = this.gl;
    if (this.isLost()) return null;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.frame++;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.clearStencil(0);
    gl.stencilMask(0xff);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);

    // back to front (see order.ts), so see-through pixels blend over what is behind them.
    // each plane is drawn twice: its solid pixels write depth, which sorts out planes that cut
    // through each other; its see-through pixels (soft edges, shadows, fades) only test depth, so
    // they never punch a hole into a plane that is painted after them.
    const order = paintOrder(planes, viewProj, eye);

    // a render with a lit plane runs the lit program for all its planes (an unlit one gets a light of 1), any other render
    // the plane program exactly as before
    const litProg = light ? this.litProgram() : null;
    const lighting = litProg !== null;
    this.prog = litProg ?? this.base;
    const loc = this.prog.loc;
    gl.useProgram(this.prog.program);
    this.lastLight.fill(NaN);
    // the picture under a side's picture reads texture unit 1: it always holds a texture (the blank one between solids)
    gl.uniform1i(loc.under, 1);
    gl.uniform1f(loc.underOn, 0);
    this.bindUnder(null);
    gl.activeTexture(gl.TEXTURE0);
    this.eyeNow = eye;
    // fog: set once per render. off = one uniform at 0, the shader skips it.
    const fogging = fogOn(fog);
    this.fogging = fogging;
    writeFogUniforms(fog, this.fogBuf);
    gl.uniform1f(loc.fogOn, fogging ? 1 : 0);
    if (fogging) {
      gl.uniform3f(loc.fogColor, this.fogBuf[0]!, this.fogBuf[1]!, this.fogBuf[2]!);
      gl.uniform3f(loc.fogRange, this.fogBuf[3]!, this.fogBuf[4]!, this.fogBuf[5]!);
      gl.uniform3f(loc.eye, eye[0], eye[1], eye[2]);
    }
    if (lighting) gl.uniform3fv(loc.env, light!.env);
    // depth of field: set once per render. off = one uniform at 0 for every mesh.
    if (focus) {
      gl.uniform4f(loc.focus, focus.distance, focus.range, blurReach(focus), focus.strength * MAX_BLUR);
      gl.uniform1f(loc.frameH, h);
    } else gl.uniform1f(loc.focusOn, 0);
    // the key-less picture that was uploaded last, and whether it got mips: the next plane with the same image object
    // (the planes of a stack share their picture) binds that texture again instead of uploading it once more
    this.slot = 0;
    this.lastImage = null;
    this.lastMips = false;
    this.pinned.clear();
    // planes at the same depth (flat 3d layers stacked like 2d ones) must keep their layer order:
    // nudge each one toward the viewer by a few depth steps per layer
    gl.enable(gl.POLYGON_OFFSET_FILL);
    for (const index of order) {
      const plane = planes[index]!;
      if (!(plane.alpha > 0.001)) continue;
      const offsetUnits = -4 * (plane.layer ?? index);
      gl.polygonOffset(0, offsetUnits);
      const shape = knownShape(plane.shape);
      // a line around a solid (nothing to draw for empty pieces, a zero width or a see-through color)
      const ol = plane.outline;
      const line = shape !== 'plane' && ol && ol.width > 0 && ol.color[3] > 0 ? this.outlineGpu(shape, ol) : null;
      // no fill: neither the texture nor the solid is drawn, only the line (and the pictures on single sides, below)
      const hollow = !!line && !!ol!.hollow;
      if (hollow && !(shape !== 'plane' && plane.faces)) {
        mulInto(this.mvpBuf, viewProj, plane.model);
        this.drawOutline(plane, shape, line!, offsetUnits, this.mesh(shape).vao);
        continue;
      }
      const blurred = focus !== null && (shape === 'plane' ? planeNeedsBlur(plane.model, viewProj, focus) : meshNeedsBlur(plane.model, viewProj, focus));
      const ownTex = this.ownTexture(plane, blurred);
      if (!ownTex) continue;
      if (lighting) lightUniform(plane.lit, shape, plane.model, eye, light!.env, this.lightBuf);
      const litSolid = lighting && this.lightBuf[3]! > 0;
      const mesh = litSolid ? this.litMesh(shape) : this.mesh(shape);
      // pictures on single sides: set up before anything is drawn (they change the bound texture)
      const runs = shape !== 'plane' && plane.faces ? this.faceRuns(plane, mesh, ownTex, blurred) : null;
      if (hollow && !runs) {
        mulInto(this.mvpBuf, viewProj, plane.model);
        this.drawOutline(plane, shape, line!, offsetUnits, mesh.vao);
        continue;
      }
      if (focus) {
        gl.uniform1f(loc.focusOn, blurred ? 1 : 0);
        if (blurred) {
          gl.uniform1f(loc.edge, shape === 'plane' ? 1 : 0);
          gl.uniform1f(loc.wrapU, uvWrapsU(shape) ? 1 : 0);
        }
      }
      // uniformMatrix4fv copies the numbers at the call, so one buffer serves every plane
      gl.uniformMatrix4fv(loc.mvp, false, mulInto(this.mvpBuf, viewProj, plane.model));
      if (fogging || litSolid) gl.uniformMatrix4fv(loc.model, false, plane.model);
      if (lighting) {
        const lb = this.lightBuf;
        const ll = this.lastLight;
        if (lb[0] !== ll[0] || lb[1] !== ll[1] || lb[2] !== ll[2] || lb[3] !== ll[3]) {
          gl.uniform4f(loc.light, lb[0]!, lb[1]!, lb[2]!, lb[3]!);
          ll.set(lb);
        }
      }
      gl.uniform1f(loc.alpha, Math.min(1, plane.alpha));
      // the stack correction runs on the final texel alpha, so the solid / see-through pass test below it sees the corrected
      // alpha: only a texel that is fully opaque on a fully opaque plane writes depth, a soft or faded one blends
      gl.uniform1f(loc.stack, plane.stack !== undefined && plane.stack > 1 ? plane.stack : 1);
      const uv = plane.uv;
      if (uv) gl.uniform4f(loc.uv, uv[0], uv[1], uv[2], uv[3]);
      else gl.uniform4f(loc.uv, 0, 0, 1, 1);
      const size = plane.size;
      if (plane.radius && plane.radius > 0 && size) {
        gl.uniform1f(loc.radius, plane.radius);
        gl.uniform2f(loc.size, size[0], size[1]);
      } else gl.uniform1f(loc.radius, 0);
      gl.bindVertexArray(mesh.vao);
      if (runs && !hollow) {
        // the own picture under the pictures of single sides
        this.bindUnder(ownTex);
        if (uv) gl.uniform4f(loc.underUv, uv[0], uv[1], uv[2], uv[3]);
        else gl.uniform4f(loc.underUv, 0, 0, 1, 1);
      }
      // a plane that is faded as a whole has no solid pixels
      if (plane.alpha >= 0.98) {
        gl.depthMask(true);
        gl.uniform1f(loc.pass, 1);
        if (runs) this.drawRuns(runs, hollow);
        else gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
      }
      gl.depthMask(false);
      gl.uniform1f(loc.pass, 2);
      // the solid pass of every side comes before the see-through pass of any (the sides of one solid depth sort
      // against each other through the depth buffer); the runs bind their own texture again
      if (runs) this.drawRuns(runs, hollow);
      else gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
      if (runs) {
        this.pinned.clear();
        // the own picture may be evicted later: unit 1 never keeps a texture that can go away
        if (!hollow) this.bindUnder(null);
      }
      if (line) this.drawOutline(plane, shape, line, offsetUnits, mesh.vao);
    }
    gl.depthMask(true);
    gl.disable(gl.POLYGON_OFFSET_FILL);

    if (lines.length > 0) {
      gl.useProgram(this.lineProg);
      gl.bindVertexArray(this.lineVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
      gl.uniformMatrix4fv(this.uVp, false, viewProj);
      gl.depthMask(false);
      for (const l of lines) {
        if (l.points.length < 6) continue;
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(l.points), gl.DYNAMIC_DRAW);
        gl.uniform4f(this.uColor, l.color[0], l.color[1], l.color[2], l.color[3]);
        gl.drawArrays(gl.LINES, 0, l.points.length / 3);
      }
      gl.depthMask(true);
    }
    gl.bindVertexArray(null);
    return this.canvas;
  }
}

const renderers = new Map<string, SceneRenderer>();
/** channels whose renderer failed to start: not tried again before this time (ms) */
const retryAt = new Map<string, number>();
/** how long to wait before trying to start a renderer again after a failure (like the font retry in text.ts) */
export const SCENE_RETRY_MS = 2000;

/** true while a failed start of a channel must not be retried yet */
export function startBlocked(until: number | undefined, now: number): boolean {
  return until !== undefined && now < until;
}

function getRenderer(channel: string): SceneRenderer | null {
  const cur = renderers.get(channel);
  if (cur && !cur.isLost()) return cur;
  if (cur) {
    // lost: free what is left of it, a fresh one is built below
    renderers.delete(channel);
    cur.dispose();
  }
  // the pause is for the preview only: an export renders faster than real time, a wall clock pause would
  // drop the 3d clips from however many frames fit into it. it asks again on every frame instead.
  if (channel !== 'export' && startBlocked(retryAt.get(channel), Date.now())) return null;
  const fail = (): null => {
    retryAt.set(channel, Date.now() + SCENE_RETRY_MS);
    return null;
  };
  let canvas: GLCanvas | null = null;
  if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(2, 2);
  else if (typeof document !== 'undefined') canvas = createCanvas();
  const gl = canvas
    ? (canvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: true,
        depth: true,
        stencil: true,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
      }) as WebGL2RenderingContext | null)
    : null;
  if (!canvas || !gl) return fail();
  try {
    const r = new SceneRenderer(canvas, gl);
    renderers.set(channel, r);
    retryAt.delete(channel);
    return r;
  } catch (e) {
    console.error('[ncut] 3d renderer failed to start', e);
    try {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      // gone
    }
    return fail();
  }
}

/**
 * free the gpu resources of a channel's 3d renderer (textures, meshes, programs, the antialiased drawing buffer) and
 * forget it, plus any pending start retry. the next renderScene on the channel builds a fresh one.
 */
export function releaseSceneRenderer(channel: string): void {
  retryAt.delete(channel);
  const r = renderers.get(channel);
  if (!r) return;
  renderers.delete(channel);
  r.dispose();
}

/** how many channels have a renderer (for tests) */
export function sceneRendererCount(): number {
  return renderers.size;
}

/**
 * draw planes (and helper lines) through a camera. returns a transparent canvas of width x height
 * to composite right away (it is reused by the next call on the channel), or null without webgl2.
 */
export function renderScene(
  planes: Plane3D[],
  lines: Lines3D[],
  viewProj: Mat4,
  eye: Vec3,
  width: number,
  height: number,
  channel = 'default',
  /** distance haze over the planes (types.ts SceneFog). null = none. */
  fog: SceneFog | null = null,
  /** depth of field. undefined = the one the camera rig bound to viewProj (camera.ts); null = none */
  focus?: FocusRig | null,
  /** the light of lit planes (light.ts sceneLightAt). null = none: every plane is drawn unlit with the plane program. */
  light: LightRig | null = null,
): GLCanvas | null {
  if (width < 1 || height < 1 || (planes.length === 0 && lines.length === 0)) return null;
  let r = getRenderer(channel);
  if (!r) return null;
  const fo = focus === undefined ? boundFocus(viewProj) : focus;
  const out = r.render(planes, lines, viewProj, eye, width, height, fog, fo, light);
  if (out || !r.isLost()) return out;
  // the context was lost: try once more on a fresh renderer (getRenderer drops the lost one)
  r = getRenderer(channel);
  return r ? r.render(planes, lines, viewProj, eye, width, height, fog, fo, light) : null;
}

/** start compiling the lit program of a channel's renderer before its first lit frame. no renderer yet = nothing to do. */
export function warmSceneLight(channel: string): void {
  const r = renderers.get(channel);
  if (r) r.startLit();
}
