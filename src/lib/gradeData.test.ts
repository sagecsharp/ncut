import { describe, expect, it } from 'vitest';
import type { Clip, ClipGrade, EffectClip, GradePoint, Keyframes, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import {
  CURVE_KINDS,
  GRADE_EFFECT,
  GRADE_EPS,
  GRADE_KEYS,
  GRADE_LABEL,
  GRADE_PARTS,
  GRADE_PROPS,
  GRADE_WHEELS,
  MAX_CURVE_POINTS,
  MIN_POINT_GAP,
  canGrade,
  gradeNum,
  hasGrade,
  isCurveNeutral,
  isGradeActive,
  isHueKind,
  isToneKind,
  normalizeCurve,
  normalizeGrade,
  sameGrade,
  wheelOf,
  withoutGradeKeys,
} from './gradeData';

const base = { trackId: 't', start: 0, duration: 5, name: 'c', fadeIn: 0, fadeOut: 0 };
const video = (o: Partial<VideoClip> = {}): VideoClip => ({
  ...base,
  id: 'v',
  type: 'video',
  assetId: 'a',
  trimStart: 0,
  speed: 1,
  volume: 1,
  muted: false,
  transform: { ...DEFAULT_TRANSFORM },
  ...o,
});
const effect = (id: string, o: Partial<EffectClip> = {}): EffectClip => ({ ...base, id: 'e', type: 'effect', effect: id, amount: 1, params: {}, seed: 0, ...o });
const key = (t: number, v: number) => ({ t, v, ease: 'linear' as const });

describe('names', () => {
  it('has the 16 keys wheel by wheel', () => {
    expect(GRADE_KEYS).toHaveLength(16);
    expect(GRADE_KEYS.slice(0, 5)).toEqual(['liftR', 'liftG', 'liftB', 'liftY', 'gammaR']);
    expect(GRADE_KEYS[15]).toBe('offsetY');
    expect(GRADE_WHEELS).toEqual(['lift', 'gamma', 'gain', 'offset']);
    expect(GRADE_PARTS).toEqual(['R', 'G', 'B', 'Y']);
    expect(GRADE_EFFECT).toBe('grade');
  });
  it('has props and labels', () => {
    expect(GRADE_PROPS[0]).toBe('grade.liftR');
    expect(GRADE_PROPS[15]).toBe('grade.offsetY');
    expect(GRADE_LABEL.liftR).toBe('lift red');
    expect(GRADE_LABEL.gammaG).toBe('gamma green');
    expect(GRADE_LABEL.gainB).toBe('gain blue');
    expect(GRADE_LABEL.offsetY).toBe('offset level');
    expect(Object.keys(GRADE_LABEL)).toEqual(GRADE_KEYS);
  });
  it('has the curve kinds', () => {
    expect(CURVE_KINDS).toEqual(['y', 'r', 'g', 'b', 'hueSat', 'hueHue', 'lumaSat']);
    expect(CURVE_KINDS.filter(isToneKind)).toEqual(['y', 'r', 'g', 'b']);
    expect(CURVE_KINDS.filter(isHueKind)).toEqual(['hueSat', 'hueHue']);
    expect(GRADE_EPS).toBe(5e-5);
    expect(MAX_CURVE_POINTS).toBe(16);
    expect(MIN_POINT_GAP).toBe(0.01);
  });
});

describe('gradeNum and wheelOf', () => {
  it('reads a finite number clamped, else 0', () => {
    expect(gradeNum({ liftR: 0.5 }, 'liftR')).toBe(0.5);
    expect(gradeNum({ liftR: 4 }, 'liftR')).toBe(1);
    expect(gradeNum({ liftR: -4 }, 'liftR')).toBe(-1);
    expect(gradeNum({ liftR: NaN }, 'liftR')).toBe(0);
    expect(gradeNum({ liftR: Infinity }, 'liftR')).toBe(0);
    expect(gradeNum({ liftR: '1' as unknown as number }, 'liftR')).toBe(0);
    expect(gradeNum({}, 'gainY')).toBe(0);
    expect(gradeNum(null, 'gainY')).toBe(0);
    expect(gradeNum(undefined, 'gainY')).toBe(0);
  });
  it('wheelOf is r g b y', () => {
    expect(wheelOf({ gainR: 0.1, gainG: 0.2, gainB: 0.3, gainY: 0.4, liftR: 1 }, 'gain')).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(wheelOf(undefined, 'offset')).toEqual([0, 0, 0, 0]);
  });
});

describe('normalizeGrade', () => {
  it('clamps and rounds to 4 decimals', () => {
    expect(normalizeGrade({ liftR: 2, liftG: -2, liftB: 0.123456 })).toEqual({ liftR: 1, liftG: -1, liftB: 0.1235 });
  });
  it('drops NaN, infinity and non numbers', () => {
    expect(normalizeGrade({ liftR: NaN, liftG: Infinity, liftB: '0.5', liftY: null, gainY: 0.5 })).toEqual({ gainY: 0.5 });
  });
  it('drops unknown keys', () => {
    expect(normalizeGrade({ liftR: 0.5, bogus: 1 })).toEqual({ liftR: 0.5 });
    expect(normalizeGrade({ curves: { nope: [[0, 0], [1, 1]] }, extra: true })).toEqual({});
  });
  it('drops tiny numbers', () => {
    expect(normalizeGrade({ liftR: 4e-5, liftG: -4e-5, liftB: 6e-5 })).toEqual({ liftB: 0.0001 });
    expect(normalizeGrade({ liftR: 0 })).toEqual({});
  });
  it('keeps off only when true', () => {
    expect(normalizeGrade({ off: true, liftR: 0.5 })).toEqual({ liftR: 0.5, off: true });
    expect(normalizeGrade({ off: false })).toEqual({});
    expect(normalizeGrade({ off: 1 })).toEqual({});
  });
  it('is null for a non object, {} for an empty one', () => {
    expect(normalizeGrade(null)).toBeNull();
    expect(normalizeGrade(undefined)).toBeNull();
    expect(normalizeGrade(5)).toBeNull();
    expect(normalizeGrade('x')).toBeNull();
    expect(normalizeGrade([1])).toBeNull();
    expect(normalizeGrade({})).toEqual({});
  });
  it('writes keys in a fixed order: wheels, curves, off', () => {
    const g = normalizeGrade({ off: true, curves: { y: [[0, 0], [0.5, 0.7], [1, 1]] }, offsetY: 0.1, liftR: 0.2 })!;
    expect(Object.keys(g)).toEqual(['liftR', 'offsetY', 'curves', 'off']);
  });
  it('cleans curves per kind, keeps neutral lists, drops bad ones', () => {
    const g = normalizeGrade({
      curves: {
        y: [[1, 1], [0, 0], [0.5, 0.5]],
        r: 'no',
        g: [[0, 0], [1, 1]],
        hueSat: [[0.3, 0.7], [0.1, 0.6]],
      },
    })!;
    expect(g.curves).toEqual({ y: [[0, 0], [0.5, 0.5], [1, 1]], hueSat: [[0.1, 0.6], [0.3, 0.7]] });
    expect(Object.keys(g.curves!)).toEqual(['y', 'hueSat']);
    expect(normalizeGrade({ curves: {} })).toEqual({});
    expect(normalizeGrade({ curves: 5 })).toEqual({});
  });
});

describe('normalizeCurve', () => {
  it('is null for a non list', () => {
    expect(normalizeCurve('y', null)).toBeNull();
    expect(normalizeCurve('y', 'x')).toBeNull();
    expect(normalizeCurve('hueSat', {})).toBeNull();
  });
  it('keeps finite pairs, clamps and rounds', () => {
    const c = normalizeCurve('lumaSat', [[0.12346, 2], [NaN, 0.5], ['a', 1], [0.5], [-1, -1]])!;
    expect(c).toEqual([[0, 0], [0.1235, 1]]);
  });
  it('sorts by x', () => {
    expect(normalizeCurve('y', [[0.7, 0.9], [0.3, 0.2]])).toEqual([[0, 0], [0.3, 0.2], [0.7, 0.9], [1, 1]]);
  });
  it('the first of two close points wins', () => {
    expect(normalizeCurve('lumaSat', [[0.5, 0.1], [0.504, 0.9], [0.8, 0.5]])).toEqual([[0.5, 0.1], [0.8, 0.5]]);
    // stable: the same x keeps the first listed
    expect(normalizeCurve('lumaSat', [[0.5, 0.2], [0.5, 0.8]])).toEqual([[0.5, 0.2]]);
  });
  it('a gap of exactly 0.01 stays', () => {
    expect(normalizeCurve('lumaSat', [[0.5, 0.1], [0.51, 0.9]])).toHaveLength(2);
  });
  it('caps at 16 points', () => {
    const many: GradePoint[] = Array.from({ length: 40 }, (_, i) => [i / 40, i / 40]);
    expect(normalizeCurve('lumaSat', many)).toHaveLength(16);
    const tone = normalizeCurve('y', many.map(([x]) => [x, 0.9 * x] as GradePoint))!;
    expect(tone).toHaveLength(16);
    expect(tone[0]).toEqual([0, 0]);
    expect(tone[15]).toEqual([1, 1]);
    const hue = normalizeCurve('hueHue', many)!;
    expect(hue).toHaveLength(16);
  });
  it('tone lists span 0 to 1 with corners added', () => {
    expect(normalizeCurve('r', [[0.5, 0.8]])).toEqual([[0, 0], [0.5, 0.8], [1, 1]]);
  });
  it('a point near 0 or 1 is the start or end, moved to x 0 or 1', () => {
    expect(normalizeCurve('y', [[0.005, 0.2], [0.5, 0.5]])).toEqual([[0, 0.2], [0.5, 0.5], [1, 1]]);
    expect(normalizeCurve('y', [[0.5, 0.5], [0.996, 0.8]])).toEqual([[0, 0], [0.5, 0.5], [1, 0.8]]);
    expect(normalizeCurve('y', [[0, 0.1], [1, 0.9]])).toEqual([[0, 0.1], [1, 0.9]]);
  });
  it('inner points keep the gap to both ends', () => {
    const c = normalizeCurve('y', [[0.01, 0.3], [0.99, 0.6]])!;
    expect(c).toEqual([[0, 0], [0.01, 0.3], [0.99, 0.6], [1, 1]]);
    // 0.009 is the start itself and 0.012 is too close to it: it goes
    expect(normalizeCurve('y', [[0.009, 0.3], [0.012, 0.9]])).toEqual([[0, 0.3], [1, 1]]);
  });
  it('the two corners alone are null, a moved corner is not', () => {
    expect(normalizeCurve('y', [[0, 0], [1, 1]])).toBeNull();
    expect(normalizeCurve('y', [])).toBeNull();
    expect(normalizeCurve('g', [[0, 0.1], [1, 1]])).toEqual([[0, 0.1], [1, 1]]);
  });
  it('a point on the diagonal is kept (a just added point stays)', () => {
    expect(normalizeCurve('b', [[0.5, 0.5]])).toEqual([[0, 0], [0.5, 0.5], [1, 1]]);
  });
  it('hue lists turn x 1 into 0', () => {
    expect(normalizeCurve('hueSat', [[1, 0.8], [0.5, 0.5]])).toEqual([[0, 0.8], [0.5, 0.5]]);
  });
  it('hue lists keep the gap across the wrap', () => {
    // 0.002 and 0.996 are 0.006 apart over the wrap: the later one goes
    expect(normalizeCurve('hueHue', [[0.002, 0.4], [0.5, 0.5], [0.996, 0.6]])).toEqual([[0.002, 0.4], [0.5, 0.5]]);
    expect(normalizeCurve('hueHue', [[0, 0.4], [0.99, 0.6]])).toEqual([[0, 0.4], [0.99, 0.6]]);
  });
  it('empty or all bad hue lists are null, a single point stays', () => {
    expect(normalizeCurve('hueSat', [])).toBeNull();
    expect(normalizeCurve('lumaSat', [[NaN, 1]])).toBeNull();
    expect(normalizeCurve('hueSat', [[0.3, 0.9]])).toEqual([[0.3, 0.9]]);
  });
});

describe('isCurveNeutral', () => {
  it('missing and empty are neutral', () => {
    expect(isCurveNeutral('y', undefined)).toBe(true);
    expect(isCurveNeutral('y', null)).toBe(true);
    expect(isCurveNeutral('hueSat', [])).toBe(true);
  });
  it('tone: on the diagonal', () => {
    expect(isCurveNeutral('y', [[0, 0], [0.5, 0.5], [1, 1]])).toBe(true);
    expect(isCurveNeutral('r', [[0, 0], [0.5, 0.5001], [1, 1]])).toBe(true);
    expect(isCurveNeutral('r', [[0, 0], [0.5, 0.51], [1, 1]])).toBe(false);
    expect(isCurveNeutral('b', [[0, 0.1], [1, 1]])).toBe(false);
  });
  it('the others: on 0.5', () => {
    expect(isCurveNeutral('hueSat', [[0, 0.5], [0.5, 0.5]])).toBe(true);
    expect(isCurveNeutral('lumaSat', [[0.2, 0.5], [0.8, 0.7]])).toBe(false);
    expect(isCurveNeutral('hueHue', [[0.2, 0.52]])).toBe(false);
    // a tone-like list is not neutral for a hue kind
    expect(isCurveNeutral('hueSat', [[0, 0], [1, 1]])).toBe(false);
  });
});

describe('isGradeActive', () => {
  it('is false for nothing, empty, zeros, off and neutral lists', () => {
    expect(isGradeActive(undefined)).toBe(false);
    expect(isGradeActive(null)).toBe(false);
    expect(isGradeActive({})).toBe(false);
    expect(isGradeActive({ liftR: 0, gainY: 0 })).toBe(false);
    expect(isGradeActive({ liftR: 0.5, off: true })).toBe(false);
    expect(isGradeActive({ liftR: 1e-5 })).toBe(false);
    expect(isGradeActive({ curves: { y: [[0, 0], [1, 1]], hueSat: [[0.2, 0.5]] } })).toBe(false);
  });
  it('is true at 1e-4 and for a moved curve', () => {
    expect(isGradeActive({ liftR: 1e-4 })).toBe(true);
    expect(isGradeActive({ gammaB: -1e-4 })).toBe(true);
    expect(isGradeActive({ curves: { lumaSat: [[0.5, 0.8]] } })).toBe(true);
    expect(isGradeActive({ curves: { y: [[0, 0], [0.5, 0.6], [1, 1]] } })).toBe(true);
  });
  it('a grade with off false is on', () => {
    expect(isGradeActive({ offsetY: 0.2, off: undefined })).toBe(true);
  });
});

describe('sameGrade', () => {
  it('null, undefined and empty are the same', () => {
    expect(sameGrade(null, undefined)).toBe(true);
    expect(sameGrade(undefined, {})).toBe(true);
    expect(sameGrade({ liftR: 0 }, null)).toBe(true);
  });
  it('compares after cleaning', () => {
    expect(sameGrade({ liftR: 0.50001 }, { liftR: 0.5 })).toBe(true);
    expect(sameGrade({ liftR: 0.5 }, { liftR: 0.6 })).toBe(false);
    expect(sameGrade({ liftR: 0.5, bogus: 1 }, { liftR: 0.5 })).toBe(true);
  });
  it('key order does not matter', () => {
    expect(sameGrade({ gainY: 0.2, liftR: 0.1 }, { liftR: 0.1, gainY: 0.2 })).toBe(true);
  });
  it('off and curves count', () => {
    expect(sameGrade({ liftR: 0.5, off: true }, { liftR: 0.5 })).toBe(false);
    const c: ClipGrade = { curves: { y: [[0, 0], [0.5, 0.6], [1, 1]] } };
    expect(sameGrade(c, { curves: { y: [[1, 1], [0.5, 0.6], [0, 0]] } })).toBe(true);
    expect(sameGrade(c, { curves: { y: [[0, 0], [0.5, 0.7], [1, 1]] } })).toBe(false);
  });
});

describe('withoutGradeKeys', () => {
  it('undefined stays undefined', () => {
    expect(withoutGradeKeys(undefined)).toBeUndefined();
  });
  it('no grade key gives the same object', () => {
    const kf: Keyframes = { x: [key(0, 1)] };
    expect(withoutGradeKeys(kf)).toBe(kf);
    const empty: Keyframes = {};
    expect(withoutGradeKeys(empty)).toBe(empty);
  });
  it('drops every grade key and keeps the rest in a copy', () => {
    const kf: Keyframes = { x: [key(0, 1)], 'grade.liftR': [key(0, 0.1)], 'grade.gainY': [key(1, 0.2)] };
    const out = withoutGradeKeys(kf)!;
    expect(out).toEqual({ x: [key(0, 1)] });
    expect(out).not.toBe(kf);
    expect(kf['grade.liftR']).toBeDefined();
  });
  it('nothing left is undefined', () => {
    expect(withoutGradeKeys({ 'grade.liftR': [key(0, 0.1)] })).toBeUndefined();
  });
});

describe('canGrade and hasGrade', () => {
  it('picture clips and the grade effect can carry a grade', () => {
    expect(canGrade(video())).toBe(true);
    expect(canGrade(effect(GRADE_EFFECT))).toBe(true);
    expect(canGrade(effect('shake'))).toBe(false);
    const audio: Clip = { ...base, id: 'a', type: 'audio', assetId: 'a', trimStart: 0, speed: 1, volume: 1, muted: false };
    expect(canGrade(audio)).toBe(false);
    expect(typeof canGrade(video())).toBe('boolean');
  });
  it('hasGrade: an active grade', () => {
    expect(hasGrade(video())).toBe(false);
    expect(hasGrade(video({ grade: { liftR: 0.2 } }))).toBe(true);
    expect(hasGrade(video({ grade: {} }))).toBe(false);
    expect(hasGrade(video({ grade: null }))).toBe(false);
    expect(hasGrade(effect(GRADE_EFFECT, { grade: { gainY: 0.1 } }))).toBe(true);
  });
  it('hasGrade: off counts, keys count', () => {
    expect(hasGrade(video({ grade: { liftR: 0.2, off: true } }))).toBe(true);
    expect(hasGrade(video({ keyframes: { 'grade.liftR': [key(0, 0.1), key(1, 0.3)] } }))).toBe(true);
    expect(hasGrade(video({ keyframes: { 'grade.liftR': [] } }))).toBe(false);
    expect(hasGrade(video({ keyframes: { x: [key(0, 0)] } }))).toBe(false);
  });
  it('hasGrade: a clip that cannot carry one never has one', () => {
    expect(hasGrade(effect('shake', { grade: { liftR: 0.5 } }))).toBe(false);
  });
});
