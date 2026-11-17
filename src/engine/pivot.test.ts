import { describe, expect, it } from 'vitest';
import type { Project, ShapeClip, Transform } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { getClipBox } from './draw';
import {
  PIVOT_MAX,
  PIVOT_SPOTS,
  normalizePivot,
  pictureBox,
  pivotFraction,
  pivotOf,
  pivotOffset,
  samePivot,
  spotOf,
  unturn,
} from './pivot';
import { DEG, rotationX, rotationY, rotationZ, mul, transformPoint } from './scene3d/math';

const project = { id: 'p', name: 'p', createdAt: 0, updatedAt: 0, width: 1920, height: 1080, fps: 30, background: '#000', assets: [], tracks: [], clips: [] } as Project;
const shape = (over: Partial<ShapeClip> = {}): ShapeClip => ({
  id: 's', type: 'shape', trackId: 't', start: 0, duration: 1, name: 's', fadeIn: 0, fadeOut: 0, kind: 'rect', width: 200, height: 100, color: '#fff',
  transform: { ...DEFAULT_TRANSFORM }, ...over,
});

/** the corners of a rotated box, clockwise from the top left */
function corners(b: { cx: number; cy: number; width: number; height: number; rotation: number }): [number, number][] {
  const a = b.rotation * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const x = (sx! * b.width) / 2;
    const y = (sy! * b.height) / 2;
    return [b.cx + x * c - y * s, b.cy + x * s + y * c] as [number, number];
  });
}

describe('pivotFraction, normalizePivot, samePivot, spotOf', () => {
  it('pivotFraction keeps finite numbers in range and reads anything else as 0', () => {
    expect(pivotFraction(0.25)).toBe(0.25);
    expect(pivotFraction(-3)).toBe(-3);
    expect(pivotFraction(12)).toBe(PIVOT_MAX);
    expect(pivotFraction(-12)).toBe(-PIVOT_MAX);
    expect(pivotFraction(Number.NaN)).toBe(0);
    expect(pivotFraction(Number.POSITIVE_INFINITY)).toBe(0);
    expect(pivotFraction('0.5')).toBe(0);
    expect(pivotFraction(null)).toBe(0);
    expect(pivotFraction(undefined)).toBe(0);
    expect(Object.is(pivotFraction(-0), -0) || pivotFraction(-0) === 0).toBe(true);
  });

  it('normalizePivot rounds to 4 decimals and gives null for the middle', () => {
    expect(normalizePivot({ x: 0, y: 0 })).toBeNull();
    expect(normalizePivot({ x: 1e-6, y: 0 })).toBeNull();
    expect(normalizePivot({ x: -1e-6, y: 1e-6 })).toBeNull();
    expect(normalizePivot('x')).toBeNull();
    expect(normalizePivot([1, 2])).toBeNull();
    expect(normalizePivot(null)).toBeNull();
    expect(normalizePivot({ x: 0.123456, y: -0.5 })).toEqual({ x: 0.1235, y: -0.5 });
    expect(normalizePivot({ x: 40, y: 'a' })).toEqual({ x: 10, y: 0 });
    // no negative zero in what is stored
    const n = normalizePivot({ x: -1e-9, y: 0.5 })!;
    expect(Object.is(n.x, 0)).toBe(true);
  });

  it('samePivot treats missing, null and 0 0 as the middle', () => {
    expect(samePivot(undefined, null)).toBe(true);
    expect(samePivot(null, { x: 0, y: 0 })).toBe(true);
    expect(samePivot(undefined, { x: 0, y: 1e-7 })).toBe(true);
    expect(samePivot({ x: 0.5, y: 0 }, { x: 0.5, y: 0 })).toBe(true);
    expect(samePivot({ x: 0.5, y: 0 }, { x: 0.5002, y: 0 })).toBe(false);
    expect(samePivot({ x: 0.5, y: 0 }, null)).toBe(false);
    expect(samePivot(null, { x: 0, y: 0.1 })).toBe(false);
  });

  it('spotOf finds the nine spots and nothing for a point of its own', () => {
    expect(PIVOT_SPOTS).toHaveLength(9);
    for (const s of PIVOT_SPOTS) expect(spotOf({ x: s.x, y: s.y })?.id).toBe(s.id);
    expect(spotOf(null)?.id).toBe('middle');
    expect(spotOf(undefined)?.id).toBe('middle');
    expect(spotOf({ x: 0.3, y: 0 })).toBeNull();
    expect(spotOf({ x: 0.5, y: 0.2 })).toBeNull();
    expect(pivotOf({})).toEqual({ x: 0, y: 0 });
    expect(pivotOf({ pivot: { x: -0.5, y: 99 } })).toEqual({ x: -0.5, y: 10 });
  });
});

describe('getClipBox with a pivot', () => {
  it('getClipBox gives px / py from the fractions of the scaled and stretched box', () => {
    const c = shape({ transform: { ...DEFAULT_TRANSFORM, scale: 2, scaleX: 1.5 }, pivot: { x: -0.5, y: 0.25 } });
    const b = getClipBox(project, c);
    expect(b.width).toBe(600);
    expect(b.height).toBe(200);
    expect(b.px).toBe(-300);
    expect(b.py).toBe(50);
  });

  it('getClipBox of a clip without a pivot has no px / py', () => {
    expect('px' in getClipBox(project, shape())).toBe(false);
    expect('py' in getClipBox(project, shape())).toBe(false);
    expect('px' in getClipBox(project, shape({ pivot: null }))).toBe(false);
    expect('px' in getClipBox(project, shape({ pivot: { x: 0, y: 0 } }))).toBe(false);
    expect('px' in getClipBox(project, shape({ pivot: { x: Number.NaN, y: 0 } }))).toBe(false);
  });
});

describe('pictureBox', () => {
  it('pictureBox returns the same object without a pivot', () => {
    const b = getClipBox(project, shape());
    expect(pictureBox(b)).toBe(b);
    const z = { ...b, px: 0, py: 0 };
    expect(pictureBox(z)).toBe(z);
  });

  it('pictureBox moves the box from its pivot to its middle at 0, 90 and 37 degrees', () => {
    for (const rotation of [0, 90, 37]) {
      const c = shape({ transform: { ...DEFAULT_TRANSFORM, x: 100, y: -40, rotation }, pivot: { x: -0.5, y: 0.25 } });
      const box = getClipBox(project, c);
      expect(box.px).toBe(-100);
      expect(box.py).toBe(25);
      const pic = pictureBox(box);
      expect(pic.width).toBe(200);
      expect(pic.height).toBe(100);
      expect(pic.rotation).toBe(rotation);
      const a = rotation * DEG;
      // R p from the middle of the picture is the position
      const rp = [-100 * Math.cos(a) - 25 * Math.sin(a), -100 * Math.sin(a) + 25 * Math.cos(a)];
      expect(pic.cx + rp[0]!).toBeCloseTo(box.cx, 9);
      expect(pic.cy + rp[1]!).toBeCloseTo(box.cy, 9);
      // the picture is the old box moved by -R p
      const old = corners({ cx: box.cx, cy: box.cy, width: box.width, height: box.height, rotation });
      const now = corners(pic);
      for (let i = 0; i < 4; i++) {
        expect(now[i]![0]).toBeCloseTo(old[i]![0] - rp[0]!, 9);
        expect(now[i]![1]).toBeCloseTo(old[i]![1] - rp[1]!, 9);
      }
    }
    // the check from the spec: pivot left, 90 degrees, the bar hangs down from the position
    const hang = pictureBox({ cx: 960, cy: 540, width: 200, height: 100, rotation: 90, px: -100, py: 0 });
    expect(hang.cx).toBeCloseTo(960, 9);
    expect(hang.cy).toBeCloseTo(640, 9);
  });
});

describe('pivotOffset and unturn', () => {
  const t = (over: Partial<Transform>): Transform => ({ ...DEFAULT_TRANSFORM, ...over });

  it('pivotOffset is R(r) p for a 2d clip and ignores rotX / rotY there', () => {
    expect(pivotOffset(t({}), false, 0, 0)).toEqual([0, 0, 0]);
    const o = pivotOffset(t({ rotation: 90, rotX: 40, rotY: 30 }), false, -100, 0);
    expect(o[0]).toBeCloseTo(0, 9);
    expect(o[1]).toBeCloseTo(-100, 9);
    expect(o[2]).toBeCloseTo(0, 9);
    const a = 37 * DEG;
    const p = pivotOffset(t({ rotation: 37 }), false, 30, -20);
    expect(p[0]).toBeCloseTo(30 * Math.cos(a) + 20 * Math.sin(a), 9);
    expect(p[1]).toBeCloseTo(30 * Math.sin(a) - 20 * Math.cos(a), 9);
    expect(p[2]).toBeCloseTo(0, 9);
    // the same as the 2d spin matrix (float32 there, so a looser check)
    const m = transformPoint(rotationZ(37 * DEG), 30, -20, 0);
    expect(p[0]).toBeCloseTo(m[0]!, 4);
    expect(p[1]).toBeCloseTo(m[1]!, 4);
  });

  it('pivotOffset of a 3d clip follows turn, tilt and spin like the model', () => {
    const tr = t({ rotation: 20, rotX: 30, rotY: -50 });
    const m = mul(mul(rotationY(50 * DEG), rotationX(-30 * DEG)), rotationZ(20 * DEG));
    const want = transformPoint(m, 10, 20, 0);
    const got = pivotOffset(tr, true, 10, 20);
    for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(want[i]!, 4);
  });

  it('unturn undoes pivotOffset for random 3d turns', () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 25; i++) {
      const tr = t({ rotation: rnd() * 360 - 180, rotX: rnd() * 180 - 90, rotY: rnd() * 180 - 90 });
      const px = rnd() * 400 - 200;
      const py = rnd() * 400 - 200;
      const back = unturn(tr, true, pivotOffset(tr, true, px, py));
      expect(back[0]).toBeCloseTo(px, 9);
      expect(back[1]).toBeCloseTo(py, 9);
      expect(back[2]).toBeCloseTo(0, 9);
      // a 2d clip too
      const b2 = unturn(tr, false, pivotOffset(tr, false, px, py));
      expect(b2[0]).toBeCloseTo(px, 9);
      expect(b2[1]).toBeCloseTo(py, 9);
    }
  });
});
