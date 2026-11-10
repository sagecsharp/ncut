import { describe, expect, it } from 'vitest';
import { BLUR_MARGIN, type Bounds, deviceBounds, unionRegion } from './blurBounds';

const I = [1, 0, 0, 1, 0, 0];

describe('deviceBounds', () => {
  it('an unrotated box under the identity is the box itself', () => {
    const b = deviceBounds(I, 500, 300, 0, { x0: -100, y0: -50, x1: 100, y1: 50 })!;
    expect(b).toEqual({ x0: 400, y0: 250, x1: 600, y1: 350 });
  });
  it('a quarter turn swaps the half sizes', () => {
    const b = deviceBounds(I, 500, 300, 90, { x0: -100, y0: -50, x1: 100, y1: 50 })!;
    expect(b.x0).toBeCloseTo(450, 6);
    expect(b.x1).toBeCloseTo(550, 6);
    expect(b.y0).toBeCloseTo(200, 6);
    expect(b.y1).toBeCloseTo(400, 6);
  });
  it('the context matrix (device scale and offset) is applied after the placement', () => {
    const b = deviceBounds([2, 0, 0, 2, 10, 20], 100, 100, 0, { x0: -10, y0: -10, x1: 10, y1: 10 })!;
    expect(b).toEqual({ x0: 190, y0: 200, x1: 230, y1: 240 });
  });
  it('every point of a rotated, scaled box lies inside the bounds, for random placements', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let n = 0; n < 200; n++) {
      const m = [0.5 + rnd() * 2, (rnd() - 0.5) * 0.4, (rnd() - 0.5) * 0.4, 0.5 + rnd() * 2, rnd() * 50, rnd() * 50];
      const cx = rnd() * 2000;
      const cy = rnd() * 1000;
      const rot = (rnd() - 0.5) * 720;
      const local: Bounds = { x0: -rnd() * 300, y0: -rnd() * 300, x1: rnd() * 300, y1: rnd() * 300 };
      const b = deviceBounds(m, cx, cy, rot, local)!;
      const rad = (rot * Math.PI) / 180;
      for (let k = 0; k < 30; k++) {
        const lx = local.x0 + rnd() * (local.x1 - local.x0);
        const ly = local.y0 + rnd() * (local.y1 - local.y0);
        const px = lx * Math.cos(rad) - ly * Math.sin(rad) + cx;
        const py = lx * Math.sin(rad) + ly * Math.cos(rad) + cy;
        const x = m[0]! * px + m[2]! * py + m[4]!;
        const y = m[1]! * px + m[3]! * py + m[5]!;
        expect(x).toBeGreaterThanOrEqual(b.x0 - 1e-9);
        expect(x).toBeLessThanOrEqual(b.x1 + 1e-9);
        expect(y).toBeGreaterThanOrEqual(b.y0 - 1e-9);
        expect(y).toBeLessThanOrEqual(b.y1 + 1e-9);
      }
    }
  });
  it('a broken number gives null', () => {
    expect(deviceBounds(I, NaN, 0, 0, { x0: 0, y0: 0, x1: 1, y1: 1 })).toBeNull();
    expect(deviceBounds(I, 0, 0, 0, { x0: 0, y0: 0, x1: Infinity, y1: 1 })).toBeNull();
    expect(deviceBounds([NaN, 0, 0, 1, 0, 0], 0, 0, 0, { x0: 0, y0: 0, x1: 1, y1: 1 })).toBeNull();
  });
});

describe('unionRegion', () => {
  it('rounds outward to whole pixels and adds the margin', () => {
    const r = unionRegion([{ x0: 100.2, y0: 50.7, x1: 200.1, y1: 80.9 }], 1920, 1080)!;
    // floor(100.2) = 100, ceil(200.1) = 201; floor(50.7) = 50, ceil(80.9) = 81
    expect(r).toEqual({ x: 100 - BLUR_MARGIN, y: 50 - BLUR_MARGIN, w: 201 - 100 + 2 * BLUR_MARGIN, h: 81 - 50 + 2 * BLUR_MARGIN });
  });
  it('is the union over every sample', () => {
    const r = unionRegion(
      [
        { x0: 100, y0: 100, x1: 200, y1: 200 },
        { x0: 300, y0: 50, x1: 400, y1: 150 },
      ],
      1920,
      1080,
      0,
    )!;
    expect(r).toEqual({ x: 100, y: 50, w: 300, h: 150 });
  });
  it('is cut to the canvas', () => {
    const r = unionRegion([{ x0: -500, y0: -500, x1: 100, y1: 100 }], 1920, 1080, 2)!;
    expect(r).toEqual({ x: 0, y: 0, w: 102, h: 102 });
  });
  it('is null when nothing of it is on the canvas, when it is the whole canvas, when it is empty or broken', () => {
    expect(unionRegion([{ x0: 2000, y0: 0, x1: 2100, y1: 50 }], 1920, 1080)).toBeNull();
    expect(unionRegion([{ x0: -10, y0: -10, x1: 5000, y1: 5000 }], 1920, 1080)).toBeNull();
    expect(unionRegion([], 1920, 1080)).toBeNull();
    expect(unionRegion([{ x0: 0, y0: 0, x1: NaN, y1: 5 }], 1920, 1080)).toBeNull();
    expect(unionRegion([{ x0: 0, y0: 0, x1: 5, y1: 5 }], 0, 1080)).toBeNull();
  });
});
