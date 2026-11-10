import { describe, expect, it } from 'vitest';
import { meshNeedsBlur } from './focus';
import { identity, mul, scaling, translation } from './math';
import { planeNeedsBlur, uvWrapsU } from './renderer';

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
