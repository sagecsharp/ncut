/**
 * bend: a plane rolled round a tube, keeping its length. pure maths, the glsl chunk and the vertex shader patch.
 * no dom, no gl. the unit mesh (x, y in -0.5..0.5, z 0) is bent before the model, so a pivot and every turn compose with it.
 */
import type { ClipBend, Keyframes, Project } from '../../types';
import { isVisualClip } from '../../types';
import { knownShape } from './meshes';

/** columns of the bent strip (meshes.ts bendStrip) and of the bounds walk */
export const BEND_STEPS = 64;
/** degrees under which a bend counts as flat (nothing changes) */
export const BEND_FLAT = 0.01;
export const BEND_ANGLE_MAX = 360;
export const BEND_CENTER_MAX = 1;
export const BEND_SPAN_MIN = 1;
export const BEND_SPAN_MAX = 100000;

/** the bend of one drawn plane (renderer.ts Plane3D.bend), in px of the clip's own plane */
export interface PlaneBend {
  /** curvature in 1/px. + = the ends come toward the viewer */
  k: number;
  /** where the plane stays flat: px from the middle of the full (padded, uncropped) box along the axis */
  c: number;
  /** px of the drawn mesh along the axis (full x the crop share) */
  s: number;
  /** px from the middle of the full box to the middle of the drawn mesh (a crop moves it) */
  o: number;
  /** 0 = along width (x), 1 = along height (y) */
  axis: 0 | 1;
  /** px the surface moves along its inner normal (the side copies of a 3d depth text) */
  lift: number;
  /** bounds of the bent mesh in unit mesh space: x0, x1, y0, y1, z0, z1 (z is px, the model keeps z at scale 1) */
  box: Float32Array;
}

/** sin(x) / x without the loss of a tiny x (the shader has the same form, BEND_GLSL) */
export function bendSinc(x: number): number {
  const x2 = x * x;
  return Math.abs(x) < 0.1 ? 1 - x2 / 6 + (x2 * x2) / 120 : Math.sin(x) / x;
}

/**
 * the bend of a drawn plane, or null when it is flat or the numbers are not usable.
 * own = the clip's own length along the axis (no texture room). full = the length of the drawn box (with the room).
 * lo / size = the crop window of the mesh along the axis, as shares of the full box (0 / 1 = not cropped).
 */
export function planeBend(bend: ClipBend | null | undefined, own: number, full: number, lo = 0, size = 1, lift = 0): PlaneBend | null {
  if (!bend || !(Math.abs(bend.angle) >= BEND_FLAT) || !(own > 0) || !(full > 0) || !(size > 0)) return null;
  const span = bend.span;
  const L = span !== undefined && Number.isFinite(span) && span > 0 ? span : own;
  let k = (Math.min(BEND_ANGLE_MAX, Math.abs(bend.angle)) * Math.sign(bend.angle) * Math.PI) / 180 / L;
  const kMax = (2 * Math.PI) / own;
  if (k > kMax) k = kMax;
  else if (k < -kMax) k = -kMax;
  const ctr = bend.center !== undefined && Number.isFinite(bend.center) ? Math.max(-BEND_CENTER_MAX, Math.min(BEND_CENTER_MAX, bend.center)) : 0;
  const b: PlaneBend = { k, c: ctr * L, s: full * size, o: full * (lo + size / 2 - 0.5), axis: bend.along === 'height' ? 1 : 0, lift, box: new Float32Array(6) };
  bendBounds(b, b.box);
  return b;
}

/** a copy moved `lift` px along the inner normal, with its own bounds */
export function withLift(b: PlaneBend, lift: number): PlaneBend {
  const out: PlaneBend = { ...b, lift, box: new Float32Array(6) };
  bendBounds(out, out.box);
  return out;
}

/**
 * a point of the unit mesh (x, y in -0.5..0.5, z = 0) after the bend: x / y back in unit space, z in px.
 * the same math as bendPos in BEND_GLSL. d = px from the flat line, t = k d:
 *   along = c + d sinc(t) + lift sin(t)       (= c + sin(t) / k + ...)
 *   z     = -k d² sinc(t / 2)² / 2 + lift cos(t)   (= -(1 - cos t) / k + ...)
 */
export function bendLocal(b: PlaneBend, x: number, y: number, out: [number, number, number]): [number, number, number] {
  const u = b.axis === 1 ? y : x;
  const d = u * b.s + b.o - b.c;
  const t = b.k * d;
  const hs = bendSinc(0.5 * t);
  const along = b.c + d * bendSinc(t) + b.lift * Math.sin(t);
  const z = -0.5 * b.k * d * d * hs * hs + b.lift * Math.cos(t);
  const a = (along - b.o) / b.s;
  if (b.axis === 1) {
    out[0] = x;
    out[1] = a;
  } else {
    out[0] = a;
    out[1] = y;
  }
  out[2] = z;
  return out;
}

/** the normal at a mesh point as the shader makes it (unit space covector, not normalized): (-sin t · s, 0, -cos t) for width */
export function bendNormal(b: PlaneBend, x: number, y: number, out: [number, number, number]): [number, number, number] {
  const u = b.axis === 1 ? y : x;
  const t = b.k * (u * b.s + b.o - b.c);
  const sn = Math.sin(t);
  const cs = Math.cos(t);
  out[0] = b.axis === 1 ? 0 : -sn * b.s;
  out[1] = b.axis === 1 ? -sn * b.s : 0;
  out[2] = -cs;
  return out;
}

/** bounds of the BEND_STEPS + 1 strip columns after the bend (exact for the drawn mesh: it is the polyline through them) */
export function bendBounds(b: PlaneBend, out: Float32Array): Float32Array {
  const p: [number, number, number] = [0, 0, 0];
  let a0 = Infinity;
  let a1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (let i = 0; i <= BEND_STEPS; i++) {
    const u = i / BEND_STEPS - 0.5;
    bendLocal(b, b.axis === 1 ? 0 : u, b.axis === 1 ? u : 0, p);
    const a = b.axis === 1 ? p[1] : p[0];
    if (a < a0) a0 = a;
    if (a > a1) a1 = a;
    if (p[2] < z0) z0 = p[2];
    if (p[2] > z1) z1 = p[2];
  }
  if (b.axis === 1) {
    out[0] = -0.5;
    out[1] = 0.5;
    out[2] = a0;
    out[3] = a1;
  } else {
    out[0] = a0;
    out[1] = a1;
    out[2] = -0.5;
    out[3] = 0.5;
  }
  out[4] = z0;
  out[5] = z1;
  return out;
}

/**
 * the outline of a bent plane in unit mesh space, n + 1 points per edge: edge a (the other coordinate -0.5) from u = -0.5
 * to 0.5, then edge b (+0.5) from u = 0.5 back to -0.5. a closed polygon, 2 (n + 1) points, x y z each.
 */
export function bendOutline(b: PlaneBend, n: number): Float32Array {
  const out = new Float32Array((n + 1) * 2 * 3);
  const p: [number, number, number] = [0, 0, 0];
  let w = 0;
  const put = (u: number, v: number) => {
    bendLocal(b, b.axis === 1 ? v : u, b.axis === 1 ? u : v, p);
    out[w++] = p[0];
    out[w++] = p[1];
    out[w++] = p[2];
  };
  for (let i = 0; i <= n; i++) put(i / n - 0.5, -0.5);
  for (let i = n; i >= 0; i--) put(i / n - 0.5, 0.5);
  return out;
}

/** a clip that is bent at this moment (a resolved clip): |bend.angle| >= BEND_FLAT, and a plane when it is 3d */
export function isBent(clip: { bend?: ClipBend | null; threeD?: boolean; shape?: string }): boolean {
  const b = clip.bend;
  return !!b && Math.abs(b.angle) >= BEND_FLAT && (!clip.threeD || knownShape(clip.shape) === 'plane');
}

/** a clip that bends at some time: keys on bend.angle, or a static angle (the stored clip) */
export function hasBend(clip: { bend?: ClipBend | null; keyframes?: Keyframes; threeD?: boolean; shape?: string }): boolean {
  if (clip.threeD && knownShape(clip.shape) !== 'plane') return false;
  if ((clip.keyframes?.['bend.angle']?.length ?? 0) > 0) return true;
  return !!clip.bend && Math.abs(clip.bend.angle) >= BEND_FLAT;
}

const usesCache = new WeakMap<object, { n: number; v: boolean }>();

/** true when a picture clip of the project has a bend (hasBend). a WeakMap on the clips array plus its length, like light.ts usesLight */
export function usesBend(project: Project): boolean {
  const arr = project.clips;
  const hit = usesCache.get(arr);
  if (hit && hit.n === arr.length) return hit.v;
  let v = false;
  for (const c of arr) {
    if (isVisualClip(c) && hasBend(c)) {
      v = true;
      break;
    }
  }
  usesCache.set(arr, { n: arr.length, v });
  return v;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * a clean bend from anything, or null. angle: a finite number clamped to -360..360, else 0. along: 'height' is kept,
 * 'width' and anything else are dropped (width is the default). center: a finite number other than 0, clamped to -1..1.
 * span: a finite number above 0, clamped to 1..100000. null / not an object gives null.
 */
export function parseBend(v: unknown): ClipBend | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { angle?: unknown; along?: unknown; center?: unknown; span?: unknown };
  const out: ClipBend = { angle: finite(o.angle) ? Math.max(-BEND_ANGLE_MAX, Math.min(BEND_ANGLE_MAX, o.angle)) : 0 };
  if (o.along === 'height') out.along = 'height';
  if (finite(o.center) && o.center !== 0) out.center = Math.max(-BEND_CENTER_MAX, Math.min(BEND_CENTER_MAX, o.center));
  if (finite(o.span) && o.span > 0) out.span = Math.max(BEND_SPAN_MIN, Math.min(BEND_SPAN_MAX, o.span));
  return out;
}

/** the same drawn bend (k, c, s, o, axis; lift is not compared). two nulls are the same */
export function sameBend(a: PlaneBend | null | undefined, b: PlaneBend | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.k === b.k && a.c === b.c && a.s === b.s && a.o === b.o && a.axis === b.axis;
}

/**
 * the bend of a clip whose own px are scaled by `k` on the way to where it is drawn (a 2d parent's scale folded into the
 * world box). only span is px, so only span scales. k = 1 or no span gives the same object.
 */
export function bendInWorld(bend: ClipBend | null | undefined, k: number): ClipBend | null | undefined {
  if (!bend || bend.span === undefined || k === 1 || !(k > 0)) return bend;
  return { ...bend, span: bend.span * k };
}

/**
 * the bend in the vertex shader. u_bend = (k, c, s, o), u_bendMore = (axis, lift). u_eye turns the normal of a lit bent
 * plane toward the eye (a plane shows both faces, like light.ts planeLight). MATH: must match bendLocal.
 */
export const BEND_GLSL = `uniform vec4 u_bend;
uniform vec2 u_bendMore;
uniform vec3 u_eye;
float bendSinc(float x) {
  float x2 = x * x;
  return abs(x) < 0.1 ? 1.0 - x2 / 6.0 + x2 * x2 / 120.0 : sin(x) / x;
}
vec3 bendPos(vec3 p, out vec3 bn) {
  bool tall = u_bendMore.x > 0.5;
  float k = u_bend.x;
  float d = (tall ? p.y : p.x) * u_bend.z + u_bend.w - u_bend.y;
  float t = k * d;
  float sn = sin(t);
  float cs = cos(t);
  float hs = bendSinc(0.5 * t);
  float along = u_bend.y + d * bendSinc(t) + u_bendMore.y * sn;
  float z = -0.5 * k * d * d * hs * hs + u_bendMore.y * cs;
  float a = (along - u_bend.w) / u_bend.z;
  bn = tall ? vec3(0.0, -sn * u_bend.z, -cs) : vec3(-sn * u_bend.z, 0.0, -cs);
  return tall ? vec3(p.x, a, z) : vec3(a, p.y, z);
}
`;

/** LIT_VS with the bend in it. throws when an anchor is not there as often as expected (like litFragment) */
export function bentVertex(src: string): string {
  const main = 'void main() {\n';
  const pos = 'vec4(a_pos, 1.0)';
  const nrm = '* a_normal *';
  const unit = '    n = len > 0.0 ? n / len : vec3(0.0, -1.0, 0.0);\n';
  const count = (s: string) => src.split(s).length - 1;
  if (count(main) !== 1 || count(pos) !== 2 || count(nrm) !== 1 || count(unit) !== 1) {
    throw new Error('bentVertex: the lit vertex shader changed, move the anchors');
  }
  return src
    .replace(main, BEND_GLSL + main + '  vec3 bn;\n  vec3 bp = bendPos(a_pos, bn);\n')
    .split(pos)
    .join('vec4(bp, 1.0)')
    .replace(nrm, '* bn *')
    .replace(unit, unit + '    // a plane shows both faces: its normal faces the eye (like light.ts planeLight)\n    if (dot(n, u_eye - (u_model * vec4(bp, 1.0)).xyz) < 0.0) n = -n;\n');
}
