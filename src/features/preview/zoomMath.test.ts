import { describe, expect, it } from 'vitest';
import { MAX_ZOOM, MIN_ZOOM, accumulateWheel, clampPan, clampScale, fitScale, normalizeZoom, percentLabel, resolveScale, stepZoom, wheelPixels, zoomPan } from './zoomMath';

describe('fitScale', () => {
  it('is the larger-fitting side', () => {
    expect(fitScale(800, 400, 1920, 1080)).toBeCloseTo(400 / 1080);
    expect(fitScale(400, 800, 1920, 1080)).toBeCloseTo(400 / 1920);
  });
  it('falls back to 1 for a missing size', () => {
    expect(fitScale(0, 400, 1920, 1080)).toBe(1);
    expect(fitScale(800, 400, 0, 1080)).toBe(1);
  });
});

describe('resolveScale / normalizeZoom', () => {
  it('fit resolves to the fitted scale, numbers are clamped', () => {
    expect(resolveScale('fit', 0.4)).toBe(0.4);
    expect(resolveScale(2, 0.4)).toBe(2);
    expect(resolveScale(100, 0.4)).toBe(MAX_ZOOM);
    expect(resolveScale(0.001, 0.4)).toBe(MIN_ZOOM);
    expect(clampScale(NaN)).toBe(1);
  });
  it('a scale within a hair of fit is fit', () => {
    expect(normalizeZoom(0.401, 0.4)).toBe('fit');
    expect(normalizeZoom(0.5, 0.4)).toBe(0.5);
  });
});

describe('stepZoom', () => {
  it('steps up through the table from fit', () => {
    expect(stepZoom(0.4, 1, 0.4)).toBe(0.5);
    expect(stepZoom(0.5, 1, 0.4)).toBe(0.67);
    expect(stepZoom(1, 1, 0.4)).toBe(1.5);
  });
  it('stops at the largest step', () => {
    expect(stepZoom(8, 1, 0.4)).toBe(8);
  });
  it('steps down and lands on fit instead of going under it', () => {
    expect(stepZoom(1.5, -1, 0.4)).toBe(1);
    expect(stepZoom(0.5, -1, 0.4)).toBe('fit');
    expect(stepZoom(0.4, -1, 0.4)).toBe('fit');
  });
  it('a zoom picked below the fitted size keeps stepping down to the smallest step', () => {
    expect(stepZoom(0.5, -1, 0.8)).toBe(0.33);
    expect(stepZoom(0.25, -1, 0.8)).toBe(0.25);
  });
  it('a fitted size that is itself above a step is reached from above', () => {
    // fit 80 %: 100 % is the first step up, back down lands on fit
    expect(stepZoom(0.8, 1, 0.8)).toBe(1);
    expect(stepZoom(1, -1, 0.8)).toBe('fit');
  });
});

describe('zoomPan', () => {
  it('keeps the point under the pointer fixed', () => {
    // canvas center at pan (10, -20), pointer 100 right and 50 below it, zoom x2
    const before = { px: 100, py: 50, pan: { x: 10, y: -20 }, k: 2 };
    const r = zoomPan(before.pan.x, before.pan.y, before.px, before.py, before.k);
    // the point sits d from the center; after the zoom it is d * k from the new center, which moved by the pan change
    expect(before.px * before.k + (r.panX - before.pan.x)).toBeCloseTo(before.px);
    expect(before.py * before.k + (r.panY - before.pan.y)).toBeCloseTo(before.py);
  });
  it('zooming around the canvas center does not move it', () => {
    expect(zoomPan(5, 7, 0, 0, 3)).toEqual({ panX: 5, panY: 7 });
  });
  it('k = 1 changes nothing', () => {
    expect(zoomPan(5, 7, 40, 40, 1)).toEqual({ panX: 5, panY: 7 });
  });
});

describe('clampPan', () => {
  it('centers a canvas that fits on that axis', () => {
    expect(clampPan(50, -30, 400, 200, 800, 600)).toEqual({ panX: 0, panY: 0 });
  });
  it('lets a larger canvas move until its edge is a margin past the panel edge', () => {
    // frame 1000 wide in a 600 panel: edges meet at 200, plus the margin
    expect(clampPan(900, 0, 1000, 200, 600, 600, 32)).toEqual({ panX: 232, panY: 0 });
    expect(clampPan(-900, 0, 1000, 200, 600, 600, 32)).toEqual({ panX: -232, panY: 0 });
    expect(clampPan(100, 0, 1000, 200, 600, 600, 32)).toEqual({ panX: 100, panY: 0 });
  });
  it('clamps both axes on their own', () => {
    const r = clampPan(9999, -9999, 2000, 2000, 500, 500, 0);
    expect(r).toEqual({ panX: 750, panY: -750 });
  });
});

describe('wheel', () => {
  it('normalizes the delta mode', () => {
    expect(wheelPixels(3, 0)).toBe(3);
    expect(wheelPixels(3, 1)).toBe(48);
    expect(wheelPixels(1, 2)).toBe(100);
  });
  it('a mouse notch is one step, a small pinch adds up', () => {
    expect(accumulateWheel(0, -100)).toEqual({ acc: 0, step: -1 });
    expect(accumulateWheel(0, 100)).toEqual({ acc: 0, step: 1 });
    let r = accumulateWheel(0, -20);
    expect(r).toEqual({ acc: -20, step: 0 });
    r = accumulateWheel(r.acc, -20);
    r = accumulateWheel(r.acc, -25);
    expect(r).toEqual({ acc: 0, step: -1 });
  });
});

describe('percentLabel', () => {
  it('rounds to whole percent', () => {
    expect(percentLabel(0.4321)).toBe('43%');
    expect(percentLabel(2)).toBe('200%');
  });
});
