import { describe, expect, it } from 'vitest';
import { identity, mul, scaling, translation } from './math';
import {
  MAX_BLUR,
  bindFocus,
  boundFocus,
  depthOf,
  focusBlur,
  focusBlurPixels,
  focusDistanceForPoint,
  makeFocus,
  meshNeedsBlur,
  modelSphere,
  sphereNeedsBlur,
} from './focus';

const f = makeFocus(1, 1000, 100)!;

describe('makeFocus', () => {
  it('is null when off or missing', () => {
    expect(makeFocus(0, 1000, 0)).toBeNull();
    expect(makeFocus(undefined, 1000, 0)).toBeNull();
    expect(makeFocus(-1, 1000, 0)).toBeNull();
    expect(makeFocus(NaN, 1000, 0)).toBeNull();
  });
  it('clamps its values', () => {
    expect(makeFocus(5, 1000, -3)).toEqual({ distance: 1000, strength: 1, range: 0 });
    expect(makeFocus(0.5, -4, undefined)!.distance).toBe(1);
  });
});

describe('focusBlur', () => {
  it('is 0 without focus and inside the sharp zone', () => {
    expect(focusBlur(5000, null)).toBe(0);
    expect(focusBlur(1000, f)).toBe(0);
    expect(focusBlur(1100, f)).toBe(0);
    expect(focusBlur(900, f)).toBe(0);
  });
  it('grows with the distance from the zone, both sides', () => {
    const a = focusBlur(1200, f);
    const b = focusBlur(1600, f);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(focusBlur(500, f)).toBeGreaterThan(0);
    expect(focusBlur(1300, f)).toBeCloseTo(focusBlur(700, f), 12);
  });
  it('is capped by strength * MAX_BLUR', () => {
    expect(focusBlur(1e9, f)).toBeLessThanOrEqual(MAX_BLUR);
    expect(focusBlur(1e9, f)).toBeGreaterThan(MAX_BLUR * 0.99);
    const half = makeFocus(0.5, 1000, 100)!;
    expect(focusBlur(1e9, half)).toBeLessThanOrEqual(MAX_BLUR * 0.5);
    expect(focusBlur(1500, half)).toBeCloseTo(focusBlur(1500, f) * 0.5, 12);
  });
  it('a wider zone blurs less at the same depth', () => {
    expect(focusBlur(1500, makeFocus(1, 1000, 300)!)).toBeLessThan(focusBlur(1500, makeFocus(1, 1000, 0)!));
  });
  it('pixels scale with the frame height only', () => {
    expect(focusBlurPixels(1500, f, 1080)).toBeCloseTo(focusBlur(1500, f) * 1080, 9);
    expect(focusBlurPixels(1500, f, 540) * 2).toBeCloseTo(focusBlurPixels(1500, f, 1080), 9);
  });
});

describe('focusDistanceForPoint', () => {
  it('is the distance along the view direction, not the straight distance', () => {
    expect(focusDistanceForPoint([0, 0, 0], [0, 0, 1], [300, 0, 400])).toBe(400);
    expect(focusDistanceForPoint([0, 0, -100], [0, 0, 1], [0, 0, 250])).toBe(350);
  });
  it('is null behind the camera', () => {
    expect(focusDistanceForPoint([0, 0, 0], [0, 0, 1], [0, 0, -5])).toBeNull();
    expect(focusDistanceForPoint([0, 0, 0], [0, 0, 1], [10, 0, 0])).toBeNull();
  });
});

describe('sphereNeedsBlur', () => {
  it('skips meshes that sit wholly in the sharp zone', () => {
    expect(sphereNeedsBlur(1000, 50, f)).toBe(false);
    expect(sphereNeedsBlur(1000, 100, f)).toBe(false);
    expect(sphereNeedsBlur(1000, 101, f)).toBe(true);
    expect(sphereNeedsBlur(1300, 10, f)).toBe(true);
    expect(sphereNeedsBlur(1000, 10, null)).toBe(false);
  });
});

describe('modelSphere / depthOf', () => {
  it('reads the center and the size of a scaled, moved unit shape', () => {
    const m = mul(translation(10, 20, 30), scaling(200, 100, 50));
    const s = modelSphere(m);
    expect(s.center).toEqual([10, 20, 30]);
    expect(s.radius).toBeCloseTo(0.5 * Math.sqrt(3) * 200, 4);
    expect(modelSphere(identity()).radius).toBeCloseTo(0.5 * Math.sqrt(3), 6);
  });
  it('depth is the clip w of a point', () => {
    const vp = new Float32Array(16);
    vp[11] = 1;
    expect(depthOf(vp, [1, 2, 7])).toBe(7);
  });
});

describe('meshNeedsBlur', () => {
  // a camera at the origin looking down +z: clip w = z
  const vp = new Float32Array(16);
  vp[11] = 1;
  const at = (z: number, size: number) => mul(translation(0, 0, z), scaling(size, size, size));
  it('matches sphereNeedsBlur on the model bounds', () => {
    expect(meshNeedsBlur(at(1000, 100), vp, f)).toBe(false);
    expect(meshNeedsBlur(at(1000, 400), vp, f)).toBe(true);
    expect(meshNeedsBlur(at(1400, 10), vp, f)).toBe(true);
    expect(meshNeedsBlur(at(1400, 10), vp, null)).toBe(false);
  });
});

describe('bindFocus', () => {
  it('looks a focus up by the matrix it rode in on', () => {
    const k = new Float32Array(16);
    expect(boundFocus(k)).toBeNull();
    bindFocus(k, f);
    expect(boundFocus(k)).toBe(f);
    bindFocus(k, null);
    expect(boundFocus(k)).toBe(f);
    expect(boundFocus(new Float32Array(16))).toBeNull();
  });
});
