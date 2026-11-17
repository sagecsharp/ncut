/**
 * the lut half of the grade: the table a clip's grade looks up and the glsl that does it. the lut sits in the grade at
 * l1 (before the wheels, the default) or l2 (after the curves), see grade.ts gradeLutColor.
 *
 * the glsl exists twice: as GRADE_LUT_GLSL (what runs) and as lutColor (what the tests run). THEY MUST MATCH stage by
 * stage (la tv scale in, lb 1d table, lc 3d table, ld tv scale out, le mix) and compare alike (ties fall alike): when
 * you change one, change the other.
 */
import type { LutTable } from '../lib/cube';
import { GRADE_EPS, lutMixOf, lutOf } from '../lib/gradeData';
import type { Rgb3 } from '../lib/gradeMath';
import type { ClipGrade } from '../types';
import type { GradeData } from './grade';
import { lutNow } from './lutScope';

/** the table of a live lut, how much of it shows, and where it sits in the grade (last = after the curves) */
export interface LutBind { table: LutTable; mix: number; last: boolean; tv: boolean }

/** the bind of a grade, or null when it has no lut that can draw now */
export function lutBindOf(g: ClipGrade | null | undefined): LutBind | null {
  if (!g || g.off === true) return null;
  const l = lutOf(g);
  if (!l) return null;
  const mix = lutMixOf(l);
  if (mix < GRADE_EPS) return null;
  const table = lutNow(l.media);
  if (!table || table.identity) return null;
  if (table.size3 === 0 && table.size1 === 0) return null;
  return { table, mix, last: l.last === true, tv: l.tv === true };
}

/** the six uniforms of a bind. lut = mix, last, made for 16 to 235, has a 3d table. n = 3d points, 1d points, has a 1d table, 0 */
export interface LutUniforms {
  lut: [number, number, number, number];
  n: [number, number, number, number];
  min3: Rgb3;
  span3: Rgb3;
  min1: Rgb3;
  span1: Rgb3;
}

const span = (size: number, min: number, max: number): number => (size > 0 && max > min ? (size - 1) / (max - min) : 0);

/** what u_gLut, u_gLutN, u_gLut3Min, u_gLut3Span, u_gLut1Min and u_gLut1Span hold. a part of size 0 gives zeros */
export function lutUniforms(b: LutBind): LutUniforms {
  const t = b.table;
  const has3 = t.size3 > 0;
  const has1 = t.size1 > 0;
  return {
    lut: [b.mix, b.last ? 1 : 0, b.tv ? 1 : 0, has3 ? 1 : 0],
    n: [t.size3, t.size1, has1 ? 1 : 0, 0],
    min3: has3 ? [t.min3[0], t.min3[1], t.min3[2]] : [0, 0, 0],
    span3: has3 ? [span(t.size3, t.min3[0], t.max3[0]), span(t.size3, t.min3[1], t.max3[1]), span(t.size3, t.min3[2], t.max3[2])] : [0, 0, 0],
    min1: has1 ? [t.min1[0], t.min1[1], t.min1[2]] : [0, 0, 0],
    span1: has1 ? [span(t.size1, t.min1[0], t.max1[0]), span(t.size1, t.min1[1], t.max1[1]), span(t.size1, t.min1[2], t.max1[2])] : [0, 0, 0],
  };
}

/** the grade without its lut, null when no wheel and no curve is left (a lut only grade) */
export function withoutLut(g: GradeData): GradeData | null {
  const out: GradeData = { ...g };
  delete out.lut;
  return out.on[0] === 0 && out.on[1] === 0 && out.on[2] === 0 ? null : out;
}

// ---------------------------------------------------------------------------------------------
// glsl (keep in sync with lutColor below). globals start with g, G_ or u_g
// ---------------------------------------------------------------------------------------------

export const GRADE_LUT_GLSL: string = `uniform vec4 u_gLut;        // x mix, y 1 = last, z 1 = made for 16 to 235, w 1 = has a 3d table
uniform vec4 u_gLutN;       // x 3d points per side, y 1d points, z 1 = has a 1d table
uniform vec3 u_gLut3Min;
uniform vec3 u_gLut3Span;   // (points - 1) / (max - min)
uniform vec3 u_gLut1Min;
uniform vec3 u_gLut1Span;
uniform highp sampler3D u_gLut3; // RGB32F, unit 2, texelFetch only
uniform highp sampler2D u_gLut1; // RGB32F rows of 256, unit 3, texelFetch only
vec3 gLut1At(int i) { return texelFetch(u_gLut1, ivec2(i & 255, i >> 8), 0).rgb; }
vec3 gLut1D(vec3 c) {
  float n = u_gLutN.y;
  vec3 f = clamp((c - u_gLut1Min) * u_gLut1Span, 0.0, n - 1.0);
  ivec3 i = ivec3(floor(f));
  ivec3 j = min(i + 1, ivec3(int(n) - 1));
  vec3 t = f - vec3(i);
  return vec3(mix(gLut1At(i.r).r, gLut1At(j.r).r, t.r), mix(gLut1At(i.g).g, gLut1At(j.g).g, t.g), mix(gLut1At(i.b).b, gLut1At(j.b).b, t.b));
}
vec3 gLut3At(ivec3 p) { return texelFetch(u_gLut3, p, 0).rgb; }
vec3 gLut3D(vec3 c) {
  float n = u_gLutN.x;
  vec3 f = clamp((c - u_gLut3Min) * u_gLut3Span, 0.0, n - 1.0);
  vec3 b = min(floor(f), vec3(n - 2.0));
  vec3 t = f - b;
  ivec3 p = ivec3(b);
  vec3 c0 = gLut3At(p);
  vec3 c1 = gLut3At(p + ivec3(1));
  if (t.r > t.g) {
    if (t.g > t.b) return (1.0 - t.r) * c0 + (t.r - t.g) * gLut3At(p + ivec3(1, 0, 0)) + (t.g - t.b) * gLut3At(p + ivec3(1, 1, 0)) + t.b * c1;
    if (t.r > t.b) return (1.0 - t.r) * c0 + (t.r - t.b) * gLut3At(p + ivec3(1, 0, 0)) + (t.b - t.g) * gLut3At(p + ivec3(1, 0, 1)) + t.g * c1;
    return (1.0 - t.b) * c0 + (t.b - t.r) * gLut3At(p + ivec3(0, 0, 1)) + (t.r - t.g) * gLut3At(p + ivec3(1, 0, 1)) + t.g * c1;
  }
  if (t.b > t.g) return (1.0 - t.b) * c0 + (t.b - t.g) * gLut3At(p + ivec3(0, 0, 1)) + (t.g - t.r) * gLut3At(p + ivec3(0, 1, 1)) + t.r * c1;
  if (t.b > t.r) return (1.0 - t.g) * c0 + (t.g - t.b) * gLut3At(p + ivec3(0, 1, 0)) + (t.b - t.r) * gLut3At(p + ivec3(0, 1, 1)) + t.r * c1;
  return (1.0 - t.g) * c0 + (t.g - t.r) * gLut3At(p + ivec3(0, 1, 0)) + (t.r - t.b) * gLut3At(p + ivec3(1, 1, 0)) + t.b * c1;
}
vec3 gLutApply(vec3 c) {
  vec3 s = clamp(c, 0.0, 1.0);
  vec3 x = s;
  // la tv scale in
  if (u_gLut.z > 0.5) x = (16.0 + 219.0 * x) / 255.0;
  // lb 1d table
  if (u_gLutN.z > 0.5) x = gLut1D(x);
  // lc 3d table
  if (u_gLut.w > 0.5) x = gLut3D(x);
  // ld tv scale out
  if (u_gLut.z > 0.5) x = (x * 255.0 - 16.0) / 219.0;
  // le mix
  return mix(s, clamp(x, 0.0, 1.0), u_gLut.x);
}
vec3 gradeLutApply(vec3 c) {
  // l1 lut first
  if (u_gLut.y < 0.5) c = gLutApply(c);
  c = gradeApply(c);
  // l2 lut last
  if (u_gLut.y > 0.5) c = gLutApply(c);
  return c;
}
`;

// ---------------------------------------------------------------------------------------------
// the same math in typescript (keep in sync with the glsl above)
// ---------------------------------------------------------------------------------------------

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const clampTo = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** the 1d table on one channel */
function lut1D(t: LutTable, c: number, ch: number): number {
  const n = t.size1;
  const f = clampTo((c - t.min1[ch]!) * span(n, t.min1[ch]!, t.max1[ch]!), 0, n - 1);
  const i = Math.floor(f);
  const j = Math.min(i + 1, n - 1);
  const k = f - i;
  const a = t.data1[i * 3 + ch]!;
  const b = t.data1[j * 3 + ch]!;
  return a * (1 - k) + b * k;
}

/** the 3d table, tetrahedral */
function lut3D(t: LutTable, c: Rgb3): Rgb3 {
  const n = t.size3;
  const d = t.data3;
  const f: Rgb3 = [0, 0, 0];
  const p: Rgb3 = [0, 0, 0];
  const s: Rgb3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    f[k] = clampTo((c[k]! - t.min3[k]!) * span(n, t.min3[k]!, t.max3[k]!), 0, n - 1);
    p[k] = Math.min(Math.floor(f[k]!), n - 2);
    s[k] = f[k]! - p[k]!;
  }
  const at = (dr: number, dg: number, db: number): Rgb3 => {
    const i = (((p[2]! + db) * n + (p[1]! + dg)) * n + (p[0]! + dr)) * 3;
    return [d[i]!, d[i + 1]!, d[i + 2]!];
  };
  const c0 = at(0, 0, 0);
  const c1 = at(1, 1, 1);
  const [tr, tg, tb] = s;
  let w0: number;
  let w1: number;
  let w2: number;
  let w3: number;
  let a: Rgb3;
  let b: Rgb3;
  if (tr > tg) {
    if (tg > tb) {
      w0 = 1 - tr;
      w1 = tr - tg;
      w2 = tg - tb;
      w3 = tb;
      a = at(1, 0, 0);
      b = at(1, 1, 0);
    } else if (tr > tb) {
      w0 = 1 - tr;
      w1 = tr - tb;
      w2 = tb - tg;
      w3 = tg;
      a = at(1, 0, 0);
      b = at(1, 0, 1);
    } else {
      w0 = 1 - tb;
      w1 = tb - tr;
      w2 = tr - tg;
      w3 = tg;
      a = at(0, 0, 1);
      b = at(1, 0, 1);
    }
  } else if (tb > tg) {
    w0 = 1 - tb;
    w1 = tb - tg;
    w2 = tg - tr;
    w3 = tr;
    a = at(0, 0, 1);
    b = at(0, 1, 1);
  } else if (tb > tr) {
    w0 = 1 - tg;
    w1 = tg - tb;
    w2 = tb - tr;
    w3 = tr;
    a = at(0, 1, 0);
    b = at(0, 1, 1);
  } else {
    w0 = 1 - tg;
    w1 = tg - tr;
    w2 = tr - tb;
    w3 = tb;
    a = at(0, 1, 0);
    b = at(1, 1, 0);
  }
  return [w0 * c0[0] + w1 * a[0] + w2 * b[0] + w3 * c1[0], w0 * c0[1] + w1 * a[1] + w2 * b[1] + w3 * c1[1], w0 * c0[2] + w1 * a[2] + w2 * b[2] + w3 * c1[2]];
}

/** one straight 0..1 color through a lut */
export function lutColor(rgb: Rgb3, b: LutBind): Rgb3 {
  const t = b.table;
  const s: Rgb3 = [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])];
  let x: Rgb3 = [s[0], s[1], s[2]];
  // la tv scale in
  if (b.tv) x = [(16 + 219 * x[0]) / 255, (16 + 219 * x[1]) / 255, (16 + 219 * x[2]) / 255];
  // lb 1d table
  if (t.size1 > 0) x = [lut1D(t, x[0], 0), lut1D(t, x[1], 1), lut1D(t, x[2], 2)];
  // lc 3d table
  if (t.size3 > 0) x = lut3D(t, x);
  // ld tv scale out
  if (b.tv) x = [(x[0] * 255 - 16) / 219, (x[1] * 255 - 16) / 219, (x[2] * 255 - 16) / 219];
  // le mix
  const m = b.mix;
  return [s[0] * (1 - m) + clamp01(x[0]) * m, s[1] * (1 - m) + clamp01(x[1]) * m, s[2] * (1 - m) + clamp01(x[2]) * m];
}
