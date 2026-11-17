import { describe, expect, it } from 'vitest';
import type { ClipGrade, GradeCurves, GradePoint, Keyframes } from '../../types';
import { GRADE_KEYS, MAX_CURVE_POINTS, MIN_POINT_GAP } from '../../lib/gradeData';
import type { CurveKind, GradeKey } from '../../lib/gradeData';
import { curveSampler, lumaOf, puckOf, rgbFromPuck } from '../../lib/gradeMath';
import type { Rgb3 } from '../../lib/gradeMath';
import {
  addPoint,
  curvePath,
  curvesPatch,
  dragWheel,
  fromPx,
  gradeSummary,
  grabWheel,
  hitPoint,
  hueStripCss,
  insertAfter,
  movePoint,
  nudgePoint,
  nudgeWheel,
  pointFields,
  pointsOf,
  removePoint,
  stepPoint,
  toPx,
  wheelAria,
  wheelKeyPlan,
  wheelKeyState,
  wheelRingCss,
  wheelText,
} from './gradeLogic';

const neutral = (): Record<GradeKey, number> => Object.fromEntries(GRADE_KEYS.map((k) => [k, 0])) as Record<GradeKey, number>;
const angleOf = (rgb: Rgb3): number => {
  const p = puckOf(rgb);
  return (Math.atan2(p.y, p.x) * 180) / Math.PI;
};

describe('wheel drag', () => {
  const rgb = rgbFromPuck(0.3, 0.4, 0.05);

  it('a grab with no movement changes nothing', () => {
    const g = grabWheel('lift', rgb, 100, 100, false);
    expect(dragWheel(g, 100, 100, 48, false)).toEqual(rgb);
    expect(dragWheel(g, 100, 100, 48, true)).toEqual(rgb);
    expect(dragWheel(grabWheel('gain', [0, 0, 0], 5, 5, true), 5, 5, 48, false)).toEqual([0, 0, 0]);
  });

  it('shift drags ten times finer', () => {
    const coarse = dragWheel(grabWheel('gamma', [0, 0, 0], 0, 0, false), 24, 0, 48, false);
    const fine = dragWheel(grabWheel('gamma', [0, 0, 0], 0, 0, true), 24, 0, 48, false);
    expect(puckOf(coarse).x).toBeCloseTo(0.5, 2);
    expect(puckOf(fine).x).toBeCloseTo(0.05, 2);
  });

  it('ctrl keeps to 15 degree hue steps', () => {
    const g = grabWheel('lift', [0, 0, 0], 0, 0, false);
    for (const [dx, dy] of [[20, -13], [-17, 9], [8, 30], [-30, -22]] as const) {
      const a = angleOf(dragWheel(g, dx, dy, 48, true));
      expect(Math.abs(a / 15 - Math.round(a / 15))).toBeLessThan(0.05);
    }
  });

  it('the dot stops at the rim', () => {
    const g = grabWheel('lift', [0, 0, 0], 0, 0, false);
    const out = dragWheel(g, 1000, -1000, 48, false);
    const p = puckOf(out);
    expect(Math.hypot(p.x, p.y)).toBeGreaterThan(0.98);
    expect(Math.hypot(p.x, p.y)).toBeLessThan(1.01);
    // a dot past the rim starts on it
    expect(grabWheel('lift', [0.9, -0.9, 0.9], 0, 0, false).x0 ** 2 + grabWheel('lift', [0.9, -0.9, 0.9], 0, 0, false).y0 ** 2).toBeCloseTo(1, 6);
  });

  it('a drag keeps the luma part', () => {
    const start: Rgb3 = [0.1, 0.05, -0.02];
    const g = grabWheel('gain', start, 10, 10, false);
    const out = dragWheel(g, 25, -4, 48, false);
    expect(out).not.toEqual(start);
    expect(lumaOf(out[0], out[1], out[2])).toBeCloseTo(lumaOf(start[0], start[1], start[2]), 3);
  });

  it('arrows nudge the dot, shift more', () => {
    const up = nudgeWheel([0, 0, 0], 'ArrowUp', false);
    const upBig = nudgeWheel([0, 0, 0], 'ArrowUp', true);
    const right = nudgeWheel([0, 0, 0], 'ArrowRight', false);
    expect(puckOf(up).y).toBeCloseTo(0.01, 2);
    expect(puckOf(up).x).toBeCloseTo(0, 2);
    expect(puckOf(upBig).y).toBeCloseTo(0.1, 2);
    expect(puckOf(right).x).toBeCloseTo(0.01, 2);
    expect(nudgeWheel([0, 0, 0], 'ArrowLeft', false)[2]).toBeLessThan(0);
    expect(nudgeWheel([0, 0, 0], 'a', false)).toEqual([0, 0, 0]);
    const lit: Rgb3 = [0.2, 0.2, 0.2];
    const moved = nudgeWheel(lit, 'ArrowDown', true);
    expect(lumaOf(moved[0], moved[1], moved[2])).toBeCloseTo(0.2, 3);
  });
});

describe('wheel texts', () => {
  it('wheelText, wheelAria and gradeSummary', () => {
    expect(wheelText([0.021, -0.008, -0.013])).toBe('r +2.1 g -0.8 b -1.3');
    expect(wheelText([0, 0, 0])).toBe('no change');
    expect(wheelText([0.00001, -0.00001, 0])).toBe('no change');
    expect(wheelAria('lift', [0.021, -0.008, -0.013], 0)).toBe('lift: red +2.1, green -0.8, blue -1.3, level 0.0');
    expect(wheelAria('gain', [0, 0, 0], 0.05)).toBe('gain: red 0.0, green 0.0, blue 0.0, level +5.0');
    const v = neutral();
    expect(gradeSummary(v, undefined)).toBe('nothing set yet');
    v.liftR = 0.1;
    expect(gradeSummary(v, null)).toBe('lift');
    expect(gradeSummary(v, { y: [[0, 0], [0.5, 0.6], [1, 1]] })).toBe('lift, luma curves');
    v.gainY = -0.2;
    expect(gradeSummary(v, { y: [[0, 0], [0.5, 0.6], [1, 1]], hueSat: [[0.1, 0.8]] })).toBe('lift, gain, 2 curves');
    // a neutral list counts as no change
    expect(gradeSummary(neutral(), { y: [[0, 0], [0.5, 0.5], [1, 1]], hueSat: [[0.1, 0.5]] })).toBe('nothing set yet');
    expect(gradeSummary(neutral(), { lumaSat: [[0.5, 0.2]] })).toBe('luma vs sat curves');
  });

  it('the summary names the lut first or last', () => {
    const v = neutral();
    expect(gradeSummary(v, undefined, { name: 'film', last: false })).toBe('lut film');
    expect(gradeSummary(v, undefined, { name: 'film', last: true })).toBe('lut film');
    v.liftR = 0.1;
    v.gammaY = 0.1;
    const y: GradeCurves = { y: [[0, 0], [0.5, 0.6], [1, 1]], hueSat: [[0.1, 0.8]] };
    expect(gradeSummary(v, y, { name: 'film', last: false })).toBe('lut film, lift, gamma, 2 curves');
    expect(gradeSummary(v, y, { name: 'film', last: true })).toBe('lift, gamma, 2 curves, lut film');
    expect(gradeSummary(v, null, { name: null, last: false })).toBe('missing lut, lift, gamma');
    // two arguments: today's text
    expect(gradeSummary(v, y)).toBe('lift, gamma, 2 curves');
    expect(gradeSummary(v, y, null)).toBe('lift, gamma, 2 curves');
  });

  it('wheelKeyPlan removes three keys here, else adds the missing', () => {
    const key = (t: number) => ({ t, v: 0, ease: 'linear' as const });
    const all: Keyframes = { 'grade.liftR': [key(1)], 'grade.liftG': [key(1)], 'grade.liftB': [key(1)] };
    expect(wheelKeyState(all, 'lift', 1, 0.02)).toBe('full');
    expect(wheelKeyPlan(all, 'lift', 1, 0.02)).toEqual({ add: [], remove: ['grade.liftR', 'grade.liftG', 'grade.liftB'] });
    const two: Keyframes = { 'grade.liftR': [key(1)], 'grade.liftG': [key(1)] };
    expect(wheelKeyState(two, 'lift', 1, 0.02)).toBe('half');
    expect(wheelKeyPlan(two, 'lift', 1, 0.02)).toEqual({ add: ['grade.liftB'], remove: [] });
    const elsewhere: Keyframes = { 'grade.liftR': [key(2)] };
    expect(wheelKeyState(elsewhere, 'lift', 1, 0.02)).toBe('half');
    expect(wheelKeyPlan(elsewhere, 'lift', 1, 0.02).add).toEqual(['grade.liftR', 'grade.liftG', 'grade.liftB']);
    expect(wheelKeyState(undefined, 'lift', 1, 0.02)).toBe('none');
    expect(wheelKeyPlan(undefined, 'gain', 1, 0.02)).toEqual({ add: ['grade.gainR', 'grade.gainG', 'grade.gainB'], remove: [] });
    // the level and the other wheels do not count
    expect(wheelKeyState({ 'grade.liftY': [key(1)], 'grade.gainR': [key(1)] }, 'lift', 1, 0.02)).toBe('none');
  });

  it('the ring puts red at -12.9 degrees', () => {
    const css = wheelRingCss();
    expect(css.startsWith('conic-gradient(from -12.9deg, rgb(255, 0, 0) 0deg')).toBe(true);
    expect(css.endsWith('rgb(255, 0, 0) 360deg)')).toBe(true);
    expect(css.match(/rgb\(/g)).toHaveLength(13);
    expect(css).toContain('30deg');
    expect(hueStripCss().startsWith('linear-gradient(to right, rgb(255, 0, 0) 0.0%')).toBe(true);
  });
});

describe('point lists', () => {
  const tone: GradePoint[] = [[0, 0], [1, 1]];

  it('addPoint lands on the line', () => {
    const a = addPoint('y', tone, 0.5)!;
    expect(a.sel).toBe(1);
    expect(a.pts).toEqual([[0, 0], [0.5, 0.5], [1, 1]]);
    const bent: GradePoint[] = [[0, 0], [0.5, 0.7], [1, 1]];
    const b = addPoint('r', bent, 0.25)!;
    expect(b.pts).toHaveLength(4);
    expect(b.pts[b.sel]![0]).toBe(0.25);
    expect(b.pts[b.sel]![1]).toBeCloseTo(curveSampler('r', bent)(0.25), 3);
    // too close to a point, or to a tone end
    expect(addPoint('y', bent, 0.505)).toBeNull();
    expect(addPoint('y', tone, 0.003)).toBeNull();
  });

  it('hue tabs add a quiet point each side', () => {
    const a = addPoint('hueSat', [], 0.5)!;
    expect(a.pts.map((p) => p[0])).toEqual([0.4167, 0.5, 0.5833]);
    expect(a.pts.every((p) => p[1] === 0.5)).toBe(true);
    expect(a.sel).toBe(1);
    // across the wrap
    const w = addPoint('hueHue', [], 0.02)!;
    expect(w.pts.map((p) => p[0])).toEqual([0.02, 0.1033, 0.9367]);
    expect(w.sel).toBe(0);
    // luma vs sat an eighth, only where there is room
    expect(addPoint('lumaSat', [], 0.5)!.pts.map((p) => p[0])).toEqual([0.375, 0.5, 0.625]);
    expect(addPoint('lumaSat', [], 0.05)!.pts.map((p) => p[0])).toEqual([0.05, 0.175]);
    // a neighbour that has no room is left out
    const near = addPoint('hueSat', [[0.5833, 0.9]], 0.5)!;
    expect(near.pts.map((p) => p[0])).toEqual([0.4167, 0.5, 0.5833]);
    // the quiet points sit on the line as it was
    const bent = addPoint('hueSat', [[0.5, 0.9]], 0.6)!;
    expect(bent.pts[bent.sel]![1]).toBeCloseTo(0.9, 3);
  });

  it('addPoint refuses at 16', () => {
    const full: GradePoint[] = Array.from({ length: MAX_CURVE_POINTS }, (_, i) => [i / 16, 0.5] as GradePoint);
    expect(addPoint('hueSat', full, 0.03)).toBeNull();
    expect(addPoint('lumaSat', full, 0.03)).toBeNull();
    const toneFull: GradePoint[] = Array.from({ length: MAX_CURVE_POINTS }, (_, i) => [i / 15, i / 15] as GradePoint);
    expect(addPoint('y', toneFull, 0.03)).toBeNull();
    expect(insertAfter('y', toneFull, 3)).toBeNull();
  });

  it('movePoint keeps the gaps and the tone ends', () => {
    const list: GradePoint[] = [[0, 0], [0.3, 0.4], [0.6, 0.7], [1, 1]];
    expect(movePoint('y', list, 1, 0.9, 0.5)[1]).toEqual([0.59, 0.5]);
    expect(movePoint('y', list, 1, -1, 0.5)[1]).toEqual([0.01, 0.5]);
    expect(movePoint('y', list, 2, 0.5, 2)[2]).toEqual([0.5, 1]);
    expect(movePoint('y', list, 2, 0.5, -2)[2]).toEqual([0.5, 0]);
    expect(movePoint('y', list, 0, 0.5, 0.2)[0]).toEqual([0, 0.2]);
    expect(movePoint('y', list, 3, 0.2, 0.8)[3]).toEqual([1, 0.8]);
    // the input is not changed
    expect(list[1]).toEqual([0.3, 0.4]);
    const hue: GradePoint[] = [[0.1, 0.5], [0.5, 0.5]];
    expect(movePoint('hueSat', hue, 1, 2, 0.5)[1]![0]).toBe(0.99);
    expect(movePoint('hueSat', hue, 0, -1, 0.5)[0]![0]).toBe(0);
    expect(movePoint('hueSat', hue, 0, 0.7, 0.5)[0]![0]).toBeCloseTo(0.5 - MIN_POINT_GAP, 6);
    // the wrap keeps its gap: the first point never lands within the gap of a last point near 1
    const wrap: GradePoint[] = [[0.02, 0.2], [0.5, 0.5], [0.995, 0.5]];
    expect(movePoint('hueSat', wrap, 0, -1, 0.2)[0]![0]).toBeCloseTo(0.995 - 1 + MIN_POINT_GAP, 6);
    expect(movePoint('hueSat', [[0.5, 0.5]], 0, -1, 0.5)[0]![0]).toBe(0);
    expect(movePoint('lumaSat', [[0.2, 0.5]], 0, 5, 0.5)[0]![0]).toBe(1);
  });

  it('removePoint puts a tone end back in its corner', () => {
    const list: GradePoint[] = [[0, 0.3], [0.5, 0.5], [1, 0.8]];
    expect(removePoint('y', list, 0)[0]).toEqual([0, 0]);
    expect(removePoint('y', list, 2)[2]).toEqual([1, 1]);
    expect(removePoint('y', list, 1)).toEqual([[0, 0.3], [1, 0.8]]);
    expect(removePoint('hueSat', [[0.1, 0.2], [0.5, 0.5]], 0)).toEqual([[0.5, 0.5]]);
    expect(removePoint('lumaSat', [[0.1, 0.2]], 0)).toEqual([]);
    expect(removePoint('y', list, 9)).toEqual(list);
  });

  it('insertAfter goes halfway on the line', () => {
    expect(insertAfter('y', tone, 0)).toEqual({ pts: [[0, 0], [0.5, 0.5], [1, 1]], sel: 1 });
    const bent: GradePoint[] = [[0, 0], [0.5, 0.8], [1, 1]];
    const a = insertAfter('g', bent, 1)!;
    expect(a.pts[a.sel]![0]).toBe(0.75);
    expect(a.pts[a.sel]![1]).toBeCloseTo(curveSampler('g', bent)(0.75), 3);
    expect(insertAfter('y', tone, 1)).toBeNull();
    expect(insertAfter('hueSat', [[0.2, 0.5]], 0)!.pts.map((p) => p[0])).toEqual([0.2, 0.7]);
    expect(insertAfter('hueSat', [[0.2, 0.5], [0.8, 0.5]], 0)!.pts.map((p) => p[0])).toEqual([0.2, 0.5, 0.8]);
    expect(insertAfter('hueSat', [[0.2, 0.5], [0.8, 0.5]], 1)!.pts.map((p) => p[0])).toEqual([0, 0.2, 0.8]);
    expect(insertAfter('hueSat', [], 0)).toBeNull();
    // no room between two points
    expect(insertAfter('y', [[0, 0], [0.015, 0.5], [1, 1]], 0)).toBeNull();
  });

  it('stepPoint wraps', () => {
    const three: GradePoint[] = [[0, 0], [0.5, 0.5], [1, 1]];
    expect(stepPoint(three, 0, 1)).toBe(1);
    expect(stepPoint(three, 2, 1)).toBe(0);
    expect(stepPoint(three, 0, -1)).toBe(2);
    expect(stepPoint(three, -1, 1)).toBe(0);
    expect(stepPoint(three, -1, -1)).toBe(2);
    expect(stepPoint([], 0, 1)).toBe(-1);
  });

  it('pointFields round trip', () => {
    const kinds: CurveKind[] = ['y', 'r', 'g', 'b', 'hueSat', 'hueHue', 'lumaSat'];
    for (const kind of kinds) {
      for (const f of pointFields(kind)) {
        const lo = f.feel.min as number;
        const hi = f.feel.max as number;
        for (const s of [lo, Math.round((lo + hi) / 4), Math.round((lo + hi) / 2), hi]) expect(f.toShown(f.fromShown(s))).toBe(s);
      }
    }
    expect(pointFields('y').map((f) => f.label)).toEqual(['in', 'out']);
    expect(pointFields('hueSat').map((f) => f.label)).toEqual(['hue', 'sat']);
    expect(pointFields('hueHue').map((f) => f.label)).toEqual(['hue', 'shift']);
    expect(pointFields('lumaSat').map((f) => f.label)).toEqual(['luma', 'sat']);
    expect(pointFields('hueHue')[1]!.fromShown(0)).toBe(0.5);
    expect(pointFields('hueSat')[1]!.fromShown(100)).toBe(0.5);
  });
});

describe('the grade and the box', () => {
  it('pointsOf gives the corners for a tone list and nothing for the rest, as copies', () => {
    expect(pointsOf(null, 'y')).toEqual([[0, 0], [1, 1]]);
    expect(pointsOf({}, 'hueSat')).toEqual([]);
    const g: ClipGrade = { curves: { b: [[0, 0.1], [1, 1]] } };
    const list = pointsOf(g, 'b');
    expect(list).toEqual([[0, 0.1], [1, 1]]);
    expect(list[0]).not.toBe(g.curves!.b![0]);
  });

  it('curvesPatch replaces one list and keeps the rest', () => {
    const g: ClipGrade = { liftR: 0.1, off: true, curves: { y: [[0, 0], [0.5, 0.6], [1, 1]] } };
    const next = curvesPatch(g, 'r', [[0, 0], [0.5, 0.4], [1, 1]]);
    expect(next.liftR).toBe(0.1);
    expect(next.off).toBe(true);
    expect(next.curves!.y).toEqual(g.curves!.y);
    expect(next.curves!.r).toEqual([[0, 0], [0.5, 0.4], [1, 1]]);
    expect(g.curves!.r).toBeUndefined();
    const gone = curvesPatch(next, 'y', null);
    expect(gone.curves).toEqual({ r: [[0, 0], [0.5, 0.4], [1, 1]] });
    expect(curvesPatch(gone, 'r', null).curves).toBeUndefined();
    expect(curvesPatch(undefined, 'y', null)).toEqual({});
  });

  it('pixels and points go both ways, and a hit takes the nearest', () => {
    expect(toPx([0.5, 0.25], 200, 100)).toEqual({ x: 100, y: 75 });
    expect(fromPx(100, 75, 200, 100)).toEqual([0.5, 0.25]);
    expect(fromPx(-10, 500, 200, 100)).toEqual([0, 0]);
    const pts: GradePoint[] = [[0, 0], [0.5, 0.5], [1, 1]];
    expect(hitPoint(pts, 101, 49, 200, 100)).toBe(1);
    expect(hitPoint(pts, 101, 30, 200, 100)).toBe(-1);
    expect(hitPoint(pts, 4, 96, 200, 100)).toBe(0);
  });

  it('nudgePoint moves by a 255th, a 360th on a hue, shift ten times that', () => {
    const t: GradePoint[] = [[0, 0], [0.5, 0.5], [1, 1]];
    expect(nudgePoint('y', t, 1, 'ArrowRight', false)[1]![0]).toBeCloseTo(0.5 + 1 / 255, 4);
    expect(nudgePoint('y', t, 1, 'ArrowUp', true)[1]![1]).toBeCloseTo(0.5 + 10 / 255, 4);
    expect(nudgePoint('y', t, 0, 'ArrowRight', false)[0]).toEqual([0, 0]);
    expect(nudgePoint('hueSat', [[0.5, 0.5]], 0, 'ArrowLeft', false)[0]![0]).toBeCloseTo(0.5 - 1 / 360, 4);
    expect(nudgePoint('y', t, 1, 'x', false)).toEqual(t);
  });

  it('curvePath starts at the left and has n + 1 points', () => {
    const d = curvePath('y', [[0, 0], [1, 1]], 100, 50, 8);
    expect(d.startsWith('M0.0 50.0')).toBe(true);
    expect(d.endsWith('L100.0 0.0')).toBe(true);
    expect(d.split(' L')).toHaveLength(9);
    expect(curvePath('hueSat', [], 100, 50, 4)).toBe('M0.0 25.0 L25.0 25.0 L50.0 25.0 L75.0 25.0 L100.0 25.0');
  });
});
