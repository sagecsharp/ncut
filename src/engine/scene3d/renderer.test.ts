import { describe, expect, it } from 'vitest';
import { meshNeedsBlur } from './focus';
import { identity, mul, scaling, translation } from './math';
import { OUTLINE_CACHE_LIMIT, lruOverflow, outlineKey, planeNeedsBlur, stackedTexelAlpha, uvWrapsU } from './renderer';

// a camera at the origin looking down +z: depth = z (w = z), no perspective needed for the depth test
const viewProj = (() => {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[11] = 1; // w = z
  return m;
})();
const focus = { distance: 1000, strength: 1, range: 50 };

describe('planeNeedsBlur', () => {
  it('a flat plane exactly in focus needs no blur', () => {
    const model = mul(translation(0, 0, 1000), scaling(400, 300, 1));
    expect(planeNeedsBlur(model, viewProj, focus)).toBe(false);
    // the bounding sphere would have said yes (a 500 wide sphere does not fit the 50 range)
    expect(meshNeedsBlur(model, viewProj, focus)).toBe(true);
  });
  it('a plane outside the sharp range needs it', () => {
    expect(planeNeedsBlur(mul(translation(0, 0, 1200), scaling(100, 100, 1)), viewProj, focus)).toBe(true);
    expect(planeNeedsBlur(mul(translation(0, 0, 900), scaling(100, 100, 1)), viewProj, focus)).toBe(true);
  });
  it('a tilted plane that reaches out of the range at one end needs it', () => {
    // 200 px edge along z: its ends sit 100 px from the center, beyond the range of 50
    const tilted = new Float32Array(identity());
    tilted[10] = 1;
    tilted[0] = 0;
    tilted[2] = 200; // the x edge now runs along z
    tilted[14] = 1000;
    expect(planeNeedsBlur(tilted, viewProj, focus)).toBe(true);
    tilted[2] = 60; // ends at 30 px: inside
    expect(planeNeedsBlur(tilted, viewProj, focus)).toBe(false);
  });
  it('no focus, no blur', () => {
    expect(planeNeedsBlur(identity(), viewProj, null)).toBe(false);
  });
});

describe('uvWrapsU', () => {
  it('the round shapes wrap, the flat ones do not', () => {
    for (const s of ['sphere', 'cylinder', 'capsule'] as const) expect(uvWrapsU(s)).toBe(true);
    for (const s of ['plane', 'box', 'pyramid'] as const) expect(uvWrapsU(s)).toBe(false);
  });
});

describe('stackedTexelAlpha', () => {
  const composite = (per: number, n: number) => 1 - Math.pow(1 - per, n);
  it('n planes with the corrected alpha composite to the texel alpha, not to 1 - (1 - a)^n', () => {
    for (const n of [4, 10, 48]) {
      for (const a of [0.02, 0.1, 0.5, 0.9]) {
        expect(composite(stackedTexelAlpha(a, n), n)).toBeCloseTo(a, 9);
        // the old way: the uncorrected stack is far more solid than the texel
        if (a <= 0.5) expect(composite(a, n)).toBeGreaterThan(a + 0.05);
      }
    }
  });
  it('opaque stays opaque, empty stays empty, one plane is unchanged', () => {
    expect(stackedTexelAlpha(1, 10)).toBe(1);
    expect(stackedTexelAlpha(0, 10)).toBe(0);
    expect(stackedTexelAlpha(Number.NaN, 10)).toBe(0);
    expect(stackedTexelAlpha(0.4, 1)).toBe(0.4);
  });
  it('a clip at opacity o composites to texel alpha x o (the shader corrects the product)', () => {
    const o = 0.5;
    const a = 0.8;
    expect(composite(stackedTexelAlpha(a * o, 20), 20)).toBeCloseTo(0.4, 9);
  });
});

describe('outline cache', () => {
  it('the key tells shape, the three sizes and the width apart', () => {
    const k = outlineKey('box', 100, 50, 25, 4);
    expect(outlineKey('box', 100, 50, 25, 4)).toBe(k);
    expect(outlineKey('sphere', 100, 50, 25, 4)).not.toBe(k);
    expect(outlineKey('box', 101, 50, 25, 4)).not.toBe(k);
    expect(outlineKey('box', 100, 51, 25, 4)).not.toBe(k);
    expect(outlineKey('box', 100, 50, 26, 4)).not.toBe(k);
    expect(outlineKey('box', 100, 50, 25, 4.5)).not.toBe(k);
  });
  it('drops the oldest keys past the limit and nothing below it', () => {
    const keys = Array.from({ length: OUTLINE_CACHE_LIMIT + 3 }, (_, i) => 'k' + i);
    expect(lruOverflow(keys, keys.length, OUTLINE_CACHE_LIMIT)).toEqual(['k0', 'k1', 'k2']);
    expect(lruOverflow(keys.slice(0, OUTLINE_CACHE_LIMIT), OUTLINE_CACHE_LIMIT, OUTLINE_CACHE_LIMIT)).toEqual([]);
  });
});
