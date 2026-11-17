/**
 * the data side of the color grade (types.ts ClipGrade): names, the one gate (isGradeActive), cleaning and comparing.
 * pure, imports only types.ts. the math (lib/gradeMath.ts) and the pixels (engine/grade.ts) build on it.
 */
import type { Clip, ClipGrade, GradeCurves, GradePoint, Keyframes } from '../types';
import { isVisualClip } from '../types';

/** the id of the grade effect (engine/effects/defs/grade.ts) */
export const GRADE_EFFECT = 'grade';
export const GRADE_WHEELS = ['lift', 'gamma', 'gain', 'offset'] as const;
/** red, green, blue push one channel, Y is the level of the wheel */
export const GRADE_PARTS = ['R', 'G', 'B', 'Y'] as const;
export type GradeWheelName = (typeof GRADE_WHEELS)[number];
export type GradePart = (typeof GRADE_PARTS)[number];
export type GradeKey = `${GradeWheelName}${GradePart}`;

/** the 16 wheel numbers, wheel by wheel: liftR liftG liftB liftY gammaR ... offsetY */
export const GRADE_KEYS: GradeKey[] = GRADE_WHEELS.flatMap((w) => GRADE_PARTS.map((p): GradeKey => `${w}${p}`));
/** the keyframe property of each wheel number: 'grade.liftR' ... */
export const GRADE_PROPS: string[] = GRADE_KEYS.map((k) => `grade.${k}`);

const PART_WORD: Record<GradePart, string> = { R: 'red', G: 'green', B: 'blue', Y: 'level' };
/** 'lift red', 'lift green', 'lift blue', 'lift level' ... 'offset level' */
export const GRADE_LABEL = Object.fromEntries(
  GRADE_WHEELS.flatMap((w) => GRADE_PARTS.map((p) => [`${w}${p}`, `${w} ${PART_WORD[p]}`] as const)),
) as Record<GradeKey, string>;

/** luma, red, green, blue (x is the input level), hue vs sat, hue vs hue (x is a hue), luma vs sat */
export const CURVE_KINDS = ['y', 'r', 'g', 'b', 'hueSat', 'hueHue', 'lumaSat'] as const;
export type CurveKind = (typeof CURVE_KINDS)[number];
/** a tone curve: y is the output level, the list spans x 0 to 1 */
export const isToneKind = (k: CurveKind): boolean => k === 'y' || k === 'r' || k === 'g' || k === 'b';
/** a curve over the hue circle: x wraps */
export const isHueKind = (k: CurveKind): boolean => k === 'hueSat' || k === 'hueHue';

/** a wheel number under this is no change */
export const GRADE_EPS = 5e-5;
export const MAX_CURVE_POINTS = 16;
/** two points of a curve are never closer than this in x */
export const MIN_POINT_GAP = 0.01;

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** the stored number of a wheel key, clamped -1..1. a missing, broken or non number reads 0 */
export function gradeNum(g: ClipGrade | null | undefined, key: GradeKey): number {
  const v = g ? g[key] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(-1, v)) : 0;
}

/** one wheel as [r, g, b, y] */
export function wheelOf(g: ClipGrade | null | undefined, wheel: GradeWheelName): [number, number, number, number] {
  return [gradeNum(g, `${wheel}R`), gradeNum(g, `${wheel}G`), gradeNum(g, `${wheel}B`), gradeNum(g, `${wheel}Y`)];
}

/** the clips that can carry a grade: the picture clips and the grade effect */
export function canGrade(c: Clip): boolean {
  return isVisualClip(c) || (c.type === 'effect' && c.effect === GRADE_EFFECT);
}

/** a missing or empty list, or one that changes nothing (a tone curve on the diagonal, the others on 0.5) */
export function isCurveNeutral(kind: CurveKind, pts: readonly GradePoint[] | null | undefined): boolean {
  if (!pts || pts.length === 0) return true;
  const tone = isToneKind(kind);
  for (const p of pts) {
    if (!Array.isArray(p)) return false;
    if (Math.abs(p[1] - (tone ? p[0] : 0.5)) >= 1e-4) return false;
  }
  return true;
}

/** true when the grade changes the picture: not off, and some wheel number or some curve is not neutral. the one gate for engine, effect pass, store and ui */
export function isGradeActive(g: ClipGrade | null | undefined): boolean {
  if (!g || typeof g !== 'object' || g.off === true) return false;
  for (const k of GRADE_KEYS) if (Math.abs(gradeNum(g, k)) >= GRADE_EPS) return true;
  const curves = g.curves;
  if (curves && typeof curves === 'object') for (const kind of CURVE_KINDS) if (!isCurveNeutral(kind, curves[kind])) return true;
  return false;
}

/** the clip shows a grade or has keys on one (switched off counts: it is still there) */
export function hasGrade(c: Clip): boolean {
  if (!canGrade(c)) return false;
  const grade = (c as { grade?: ClipGrade | null }).grade;
  if (isGradeActive({ ...grade, off: false })) return true;
  const kf = c.keyframes;
  if (kf) for (const k in kf) if (k.startsWith('grade.') && kf[k]!.length > 0) return true;
  return false;
}

/**
 * a curve list as it is stored: finite pairs clamped to 0..1 and rounded to 4 decimals, sorted by x, no two points
 * closer than MIN_POINT_GAP (the first wins), at most 16. a tone curve always spans x 0 to 1 and returns null when it is the
 * diagonal's two corners; a hue curve wraps (x 1 is 0) and keeps the gap across the wrap. null for a non list or nothing left
 */
export function normalizeCurve(kind: CurveKind, v: unknown): GradePoint[] | null {
  if (!Array.isArray(v)) return null;
  const hue = isHueKind(kind);
  const pairs: GradePoint[] = [];
  for (const p of v as unknown[]) {
    if (!Array.isArray(p) || typeof p[0] !== 'number' || typeof p[1] !== 'number') continue;
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    let x = round4(clamp01(p[0]));
    if (hue && x === 1) x = 0;
    pairs.push([x, round4(clamp01(p[1]))]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const kept: GradePoint[] = [];
  for (const p of pairs) {
    const last = kept[kept.length - 1];
    if (last && p[0] - last[0] < MIN_POINT_GAP - 1e-9) continue;
    kept.push(p);
  }
  if (isToneKind(kind)) {
    const first = kept.find((p) => p[0] < MIN_POINT_GAP);
    let lastEnd: GradePoint | undefined;
    for (const p of kept) if (p[0] > 1 - MIN_POINT_GAP) lastEnd = p;
    const start: GradePoint = first ? [0, first[1]] : [0, 0];
    const end: GradePoint = lastEnd ? [1, lastEnd[1]] : [1, 1];
    const inner = kept.filter((p) => p[0] >= MIN_POINT_GAP && p[0] <= 1 - MIN_POINT_GAP);
    const out: GradePoint[] = [start, ...inner.slice(0, MAX_CURVE_POINTS - 2), end];
    if (out.length === 2 && out[0]![1] === 0 && out[1]![1] === 1) return null;
    return out;
  }
  if (hue) while (kept.length > 1 && kept[0]![0] + 1 - kept[kept.length - 1]![0] < MIN_POINT_GAP - 1e-9) kept.pop();
  const out = kept.slice(0, MAX_CURVE_POINTS);
  return out.length > 0 ? out : null;
}

/**
 * a grade as it is stored: wheel numbers finite, clamped -1..1, rounded to 4 decimals and left out under GRADE_EPS, curves
 * cleaned per kind (a neutral list is kept, a bad one dropped), `off` only when true, unknown keys dropped. keys come in a
 * fixed order (the wheel numbers, the curves, off), so equal grades have equal json. null only for a value that is no object
 */
export function normalizeGrade(v: unknown): ClipGrade | null {
  if (!isObj(v)) return null;
  const out: Rec = {};
  for (const k of GRADE_KEYS) {
    const n = v[k];
    if (typeof n !== 'number' || !Number.isFinite(n)) continue;
    const r = round4(Math.min(1, Math.max(-1, n)));
    if (Math.abs(r) >= GRADE_EPS) out[k] = r;
  }
  const curves = v.curves;
  if (isObj(curves)) {
    const clean: Rec = {};
    for (const kind of CURVE_KINDS) {
      const pts = normalizeCurve(kind, curves[kind]);
      if (pts) clean[kind] = pts;
    }
    if (Object.keys(clean).length > 0) out.curves = clean as GradeCurves;
  }
  if (v.off === true) out.off = true;
  return out as ClipGrade;
}

/** equal after cleaning (a missing grade is an empty one) */
export function sameGrade(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalizeGrade(a) ?? {}) === JSON.stringify(normalizeGrade(b) ?? {});
}

/** the keys without every 'grade.' list: the same object when it has none, undefined when nothing is left */
export function withoutGradeKeys(kf: Keyframes | undefined): Keyframes | undefined {
  if (!kf) return undefined;
  let has = false;
  for (const k in kf) if (k.startsWith('grade.')) has = true;
  if (!has) return kf;
  const out: Keyframes = {};
  for (const k in kf) if (!k.startsWith('grade.')) out[k] = kf[k]!;
  return Object.keys(out).length > 0 ? out : undefined;
}
