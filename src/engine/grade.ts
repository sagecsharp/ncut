/**
 * the pixels of the color grade (types.ts ClipGrade): wheel numbers to uniforms, the curve lists to a 256 x 7 table, the
 * glsl chunk the clip look and the grade effect share, and its mirror in typescript. no gl calls here: clipLook.ts and
 * the effects runner upload what gradeData gives.
 *
 * the glsl exists twice: as GRADE_GLSL (what runs) and as gradeColor / ditherAt (what the tests run). THEY MUST MATCH
 * stage by stage (g1 wheels, g2 tone curves, g3 color curves, g4 dither): when you change one, change the other.
 */
import type { ClipGrade, GradeCurves, GradePoint } from '../types';
import { CURVE_KINDS, GRADE_EPS, GRADE_KEYS, gradeNum, isCurveNeutral, isGradeActive, normalizeCurve, wheelOf } from '../lib/gradeData';
import type { CurveKind, GradeWheelName } from '../lib/gradeData';
import { CB_DIV, CR_DIV, HUE_RED, KB, KG, KR, TAU, curveSampler } from '../lib/gradeMath';
import type { Rgb3 } from '../lib/gradeMath';

/** how far a wheel number moves its wheel: lift and offset by half, gain by one stop, gamma by a power of two */
export const LIFT_K = 0.5;
export const GAIN_K = 1;
export const GAMMA_K = 1;
export const OFFSET_K = 0.5;

/** what the gpu needs for one grade */
export interface GradeData {
  lift: Rgb3;
  gain: Rgb3;
  gamma: Rgb3;
  offset: Rgb3;
  /** wheels, tone curves, color curves, dither */
  on: [number, number, number, number];
  /** tone rows on: luma, red, green, blue */
  tone: [number, number, number, number];
  /** 256 x 7, null when no list is active */
  table: Float32Array | null;
  /** the curves signature: the gpu uploads the table when it changes */
  key: string;
}

/** the curve table of one set of lists */
export interface CurveBake {
  table: Float32Array;
  key: string;
  tone: [number, number, number, number];
  color: boolean;
}

// the numbers the glsl prints and the mirror uses (the same digits on both sides)
const P6 = (x: number): number => Number(x.toFixed(6));
const P8 = (x: number): number => Number(x.toFixed(8));
const C_KR = P6(KR);
const C_KG = P6(KG);
const C_KB = P6(KB);
const C_CB = P6(CB_DIV);
const C_CR = P6(CR_DIV);
const C_HUE = P8(HUE_RED);
const C_TAU = P8(TAU);

const WIDTH = 256;
const ROWS = 7;
const CACHE_SIZE = 16;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const fract = (x: number): number => x - Math.floor(x);
/** a wheel number under the eps reads 0 */
const eps = (v: number): number => (Math.abs(v) >= GRADE_EPS ? v : 0);

interface Active {
  kind: CurveKind;
  pts: GradePoint[];
}

/** the lists that change something, cleaned */
function activeLists(c: GradeCurves | undefined): Active[] {
  const out: Active[] = [];
  if (!c || typeof c !== 'object') return out;
  for (const kind of CURVE_KINDS) {
    const pts = normalizeCurve(kind, c[kind]);
    if (pts && !isCurveNeutral(kind, pts)) out.push({ kind, pts });
  }
  return out;
}

const keyOf = (lists: Active[]): string => lists.map((l) => `${l.kind}:${l.pts.map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`).join(' ')}`).join(';');

/** the curves object keeps its identity through resolveClip, so this hits every frame */
const keyCache = new WeakMap<object, string>();

function curvesKey(c: GradeCurves | undefined): string {
  if (!c || typeof c !== 'object') return '';
  const hit = keyCache.get(c);
  if (hit !== undefined) return hit;
  const key = keyOf(activeLists(c));
  keyCache.set(c, key);
  return key;
}

/** a true lru: a hit moves to the newest end, the oldest goes out past 16 */
const bakes = new Map<string, CurveBake>();

/** the table of the curves, null when every list is neutral */
export function bakeCurves(c: GradeCurves | undefined): CurveBake | null {
  const key = curvesKey(c);
  if (key === '') return null;
  const hit = bakes.get(key);
  if (hit) {
    bakes.delete(key);
    bakes.set(key, hit);
    return hit;
  }
  const lists = activeLists(c);
  const byKind = new Map<CurveKind, GradePoint[]>(lists.map((l) => [l.kind, l.pts]));
  const table = new Float32Array(WIDTH * ROWS);
  for (let row = 0; row < ROWS; row++) {
    const kind = CURVE_KINDS[row]!;
    const pts = byKind.get(kind);
    const f = pts ? curveSampler(kind, pts) : null;
    for (let i = 0; i < WIDTH; i++) {
      let v: number;
      if (row < 4) v = f ? f(i / 255) : i / 255;
      else if (row === 4) v = f ? clamp(2 * f(i / 256), 0, 2) : 1;
      else if (row === 5) v = f ? clamp(f(i / 256) - 0.5, -0.5, 0.5) : 0;
      else v = f ? clamp(2 * f(i / 255), 0, 2) : 1;
      table[row * WIDTH + i] = v;
    }
  }
  const bake: CurveBake = {
    table,
    key,
    tone: [byKind.has('y') ? 1 : 0, byKind.has('r') ? 1 : 0, byKind.has('g') ? 1 : 0, byKind.has('b') ? 1 : 0],
    color: byKind.has('hueSat') || byKind.has('hueHue') || byKind.has('lumaSat'),
  };
  bakes.set(key, bake);
  if (bakes.size > CACHE_SIZE) bakes.delete(bakes.keys().next().value!);
  return bake;
}

/** the uniforms of a grade, or null when it changes nothing (missing, off, neutral) */
export function gradeData(g: ClipGrade | null | undefined): GradeData | null {
  if (!isGradeActive(g)) return null;
  const wheels = GRADE_KEYS.some((k) => Math.abs(gradeNum(g, k)) >= GRADE_EPS);
  const bake = bakeCurves(g!.curves);
  const toneOn = bake !== null && bake.tone.some((t) => t > 0);
  const colorOn = bake !== null && bake.color;
  if (!wheels && !toneOn && !colorOn) return null;
  const per = (wheel: GradeWheelName, f: (p: number) => number): Rgb3 => {
    const [r, gg, b, y] = wheelOf(g, wheel).map(eps) as [number, number, number, number];
    return [f(y + r), f(y + gg), f(y + b)];
  };
  return {
    lift: per('lift', (p) => LIFT_K * p),
    gain: per('gain', (p) => Math.max(0, 1 + GAIN_K * p)),
    gamma: per('gamma', (p) => 2 ** (-GAMMA_K * p)),
    offset: per('offset', (p) => OFFSET_K * p),
    on: [wheels ? 1 : 0, toneOn ? 1 : 0, colorOn ? 1 : 0, 1],
    tone: bake ? [...bake.tone] : [0, 0, 0, 0],
    table: bake ? bake.table : null,
    key: bake ? bake.key : '',
  };
}

/** changes with every wheel number and list. '' when the grade changes nothing */
export function gradeSignature(g: ClipGrade | null | undefined): string {
  if (!isGradeActive(g)) return '';
  return 'g' + GRADE_KEYS.map((k) => eps(gradeNum(g, k))).join(',') + '|' + curvesKey(g!.curves);
}

// ---------------------------------------------------------------------------------------------
// glsl (keep in sync with gradeColor and ditherAt below). globals start with g, G_ or u_g
// ---------------------------------------------------------------------------------------------

export const GRADE_GLSL = `precision highp int;
uniform vec3 u_gLift;
uniform vec3 u_gGain;
uniform vec3 u_gGamma;  // exactly 1.0 = no pow on that channel
uniform vec3 u_gOff;
uniform vec4 u_gOn;     // x wheels, y tone curves, z color curves, w dither
uniform vec4 u_gTone;   // tone rows on: luma, red, green, blue
uniform highp sampler2D u_gCurves; // 256 x 7 R32F, unit 1, texelFetch only
const vec3 G_LUMA = vec3(${C_KR}, ${C_KG}, ${C_KB});
float gRow(int row, float v) {
  float f = clamp(v, 0.0, 1.0) * 255.0;
  int i = int(floor(f));
  int j = min(i + 1, 255);
  return mix(texelFetch(u_gCurves, ivec2(i, row), 0).r, texelFetch(u_gCurves, ivec2(j, row), 0).r, f - float(i));
}
float gHueRow(int row, float h) {
  float f = fract(h) * 256.0;
  float fi = floor(f);
  int i = int(fi) & 255;
  int j = (i + 1) & 255;
  return mix(texelFetch(u_gCurves, ivec2(i, row), 0).r, texelFetch(u_gCurves, ivec2(j, row), 0).r, f - fi);
}
vec3 gradeApply(vec3 c) {
  // g1 wheels
  if (u_gOn.x > 0.5) {
    vec3 u = clamp(c, 0.0, 1.0);
    if (u_gGamma.r != 1.0) u.r = u.r > 0.0 ? pow(u.r, u_gGamma.r) : 0.0;
    if (u_gGamma.g != 1.0) u.g = u.g > 0.0 ? pow(u.g, u_gGamma.g) : 0.0;
    if (u_gGamma.b != 1.0) u.b = u.b > 0.0 ? pow(u.b, u_gGamma.b) : 0.0;
    u = u_gLift + (u_gGain - u_gLift) * u;
    c = clamp(u + u_gOff, 0.0, 1.0);
  }
  // g2 tone curves
  if (u_gOn.y > 0.5) {
    if (u_gTone.x > 0.5) { float l = dot(c, G_LUMA); c = clamp(c + (gRow(0, l) - l), 0.0, 1.0); }
    if (u_gTone.y > 0.5) c.r = gRow(1, c.r);
    if (u_gTone.z > 0.5) c.g = gRow(2, c.g);
    if (u_gTone.w > 0.5) c.b = gRow(3, c.b);
  }
  // g3 color curves
  if (u_gOn.z > 0.5) {
    float y = dot(c, G_LUMA);
    vec2 q = vec2((c.b - y) / ${C_CB}, (c.r - y) / ${C_CR});
    if (dot(q, q) > 1e-10) {
      float h = fract((atan(q.y, q.x) - ${C_HUE}) / ${C_TAU});
      float t = gHueRow(5, h) * ${C_TAU};
      float k = gHueRow(4, h) * gRow(6, y);
      float cs = cos(t);
      float sn = sin(t);
      q = vec2(q.x * cs - q.y * sn, q.x * sn + q.y * cs) * k;
      float r = y + ${C_CR} * q.y;
      float b = y + ${C_CB} * q.x;
      c = clamp(vec3(r, (y - ${C_KR} * r - ${C_KB} * b) / ${C_KG}, b), 0.0, 1.0);
    }
  }
  return c;
}
uint gHash(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
// g4 dither: under half a level, the same on r g b, fixed per pixel
vec3 gDither(vec3 c, vec2 px) {
  if (u_gOn.w < 0.5) return c;
  uint h = gHash(uint(px.x) + uint(px.y) * 65536u);
  float n = (float(h >> 8u) + 0.5) / 16777216.0 - 0.5;
  return clamp(c + n / 255.0, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------
// the same math in typescript (keep in sync with the glsl above)
// ---------------------------------------------------------------------------------------------

function rowAt(t: Float32Array, row: number, v: number): number {
  const f = clamp01(v) * 255;
  const i = Math.floor(f);
  const j = Math.min(i + 1, 255);
  const a = t[row * WIDTH + i]!;
  const b = t[row * WIDTH + j]!;
  return a + (b - a) * (f - i);
}

function hueRowAt(t: Float32Array, row: number, h: number): number {
  const f = fract(h) * 256;
  const fi = Math.floor(f);
  const i = fi & 255;
  const j = (i + 1) & 255;
  const a = t[row * WIDTH + i]!;
  const b = t[row * WIDTH + j]!;
  return a + (b - a) * (f - fi);
}

/** the grade on a straight 0..1 color, without the dither (stages g1 to g3) */
export function gradeColor(rgb: Rgb3, d: GradeData): Rgb3 {
  let r = rgb[0];
  let g = rgb[1];
  let b = rgb[2];
  // g1 wheels
  if (d.on[0] > 0.5) {
    let ur = clamp01(r);
    let ug = clamp01(g);
    let ub = clamp01(b);
    if (d.gamma[0] !== 1) ur = ur > 0 ? Math.pow(ur, d.gamma[0]) : 0;
    if (d.gamma[1] !== 1) ug = ug > 0 ? Math.pow(ug, d.gamma[1]) : 0;
    if (d.gamma[2] !== 1) ub = ub > 0 ? Math.pow(ub, d.gamma[2]) : 0;
    r = clamp01(d.lift[0] + (d.gain[0] - d.lift[0]) * ur + d.offset[0]);
    g = clamp01(d.lift[1] + (d.gain[1] - d.lift[1]) * ug + d.offset[1]);
    b = clamp01(d.lift[2] + (d.gain[2] - d.lift[2]) * ub + d.offset[2]);
  }
  // g2 tone curves
  if (d.on[1] > 0.5 && d.table) {
    if (d.tone[0] > 0.5) {
      const l = C_KR * r + C_KG * g + C_KB * b;
      const m = rowAt(d.table, 0, l) - l;
      r = clamp01(r + m);
      g = clamp01(g + m);
      b = clamp01(b + m);
    }
    if (d.tone[1] > 0.5) r = rowAt(d.table, 1, r);
    if (d.tone[2] > 0.5) g = rowAt(d.table, 2, g);
    if (d.tone[3] > 0.5) b = rowAt(d.table, 3, b);
  }
  // g3 color curves
  if (d.on[2] > 0.5 && d.table) {
    const y = C_KR * r + C_KG * g + C_KB * b;
    const qx = (b - y) / C_CB;
    const qy = (r - y) / C_CR;
    if (qx * qx + qy * qy > 1e-10) {
      const h = fract((Math.atan2(qy, qx) - C_HUE) / C_TAU);
      const t = hueRowAt(d.table, 5, h) * C_TAU;
      const k = hueRowAt(d.table, 4, h) * rowAt(d.table, 6, y);
      const cs = Math.cos(t);
      const sn = Math.sin(t);
      const nx = (qx * cs - qy * sn) * k;
      const ny = (qx * sn + qy * cs) * k;
      const nr = y + C_CR * ny;
      const nb = y + C_CB * nx;
      r = clamp01(nr);
      g = clamp01((y - C_KR * nr - C_KB * nb) / C_KG);
      b = clamp01(nb);
    }
  }
  return [r, g, b];
}

function gHash(v: number): number {
  const s = (Math.imul(v, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}

/** the amount added to r g b at a pixel (counted from the top left), 0..1 units, under half an 8 bit level */
export function ditherAt(px: number, py: number): number {
  // g4 dither
  const h = gHash((px + py * 65536) >>> 0);
  const n = ((h >>> 8) + 0.5) / 16777216 - 0.5;
  return n / 255;
}

/** warm lights, cool darks and a soft s curve: the card in the effects tab */
export const DEMO_GRADE: ClipGrade = {
  liftR: -0.03,
  liftB: 0.06,
  gainR: 0.1,
  gainB: -0.1,
  curves: {
    y: [
      [0, 0],
      [0.25, 0.2],
      [0.75, 0.8],
      [1, 1],
    ],
  },
};
