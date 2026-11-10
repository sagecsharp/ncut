import { describe, expect, it } from 'vitest';
import { createTextClip } from '../lib/factory';
import { SIDE_MAX, SIDE_MIN, canTintFace, depthPixels, hasTextDepth, sideAlpha, sideCount, sideOffsets, sideSignature } from './textDepth';

const ex = { depth: 0.5, angle: 45, color: '#ff0000' };
const t = (over: Record<string, unknown> = {}) => createTextClip('t', 0, { threeD: true, extrude: ex, fontSize: 100, ...over } as never);

describe('hasTextDepth', () => {
  it('needs a 3d text with an extrude of some depth on a plane', () => {
    expect(hasTextDepth(t())).toBe(true);
    expect(hasTextDepth(t({ threeD: false }))).toBe(false);
    expect(hasTextDepth(t({ extrude: null }))).toBe(false);
    expect(hasTextDepth(t({ extrude: { ...ex, depth: 0 } }))).toBe(false);
    expect(hasTextDepth(t({ shape: 'box' }))).toBe(false);
    expect(hasTextDepth(t({ shape: 'plane' }))).toBe(true);
  });
});

describe('depthPixels', () => {
  it('is depth x font size x scale, depth capped at 1', () => {
    expect(depthPixels(t())).toBe(50);
    expect(depthPixels(t({ transform: { x: 0, y: 0, scale: 2, rotation: 0, opacity: 1 } }))).toBe(100);
    expect(depthPixels(t({ extrude: { ...ex, depth: 3 } }))).toBe(100);
    expect(depthPixels(t({ extrude: null }))).toBe(0);
  });
});

describe('sideCount / sideOffsets', () => {
  it('one plane per 2 pixels, between 4 and 48', () => {
    expect(sideCount(0)).toBe(0);
    expect(sideCount(1)).toBe(SIDE_MIN);
    expect(sideCount(8)).toBe(4);
    expect(sideCount(20)).toBe(10);
    expect(sideCount(500)).toBe(SIDE_MAX);
  });
  it('offsets run from the full depth down to one step behind the face', () => {
    const o = sideOffsets(20);
    expect(o.length).toBe(10);
    expect(o[0]).toBeCloseTo(20, 9);
    expect(o[o.length - 1]).toBeCloseTo(2, 9);
    for (let i = 1; i < o.length; i++) expect(o[i]!).toBeLessThan(o[i - 1]!);
    expect(sideOffsets(0)).toEqual([]);
  });
  it('depends on the depth only', () => {
    expect(sideOffsets(33)).toEqual(sideOffsets(33));
  });
});

describe('sideAlpha', () => {
  it('stays opaque at full alpha and goes to nothing at 0', () => {
    expect(sideAlpha(1)).toBe(1);
    expect(sideAlpha(0)).toBe(0);
    expect(sideAlpha(Number.NaN)).toBe(0);
  });
  it('is the clip opacity itself: the renderer corrects the stack, the side composites to the opacity (not its square)', () => {
    expect(sideAlpha(0.5)).toBe(0.5);
    expect(sideAlpha(2)).toBe(1);
    expect(sideAlpha(-1)).toBe(0);
  });
});

describe('depthPixels with broken numbers', () => {
  it('is 0, never NaN', () => {
    expect(depthPixels(t({ fontSize: Number.NaN }))).toBe(0);
    expect(depthPixels(t({ extrude: { ...ex, depth: Number.NaN } }))).toBe(0);
    expect(depthPixels(t({ transform: { x: 0, y: 0, scale: Number.POSITIVE_INFINITY, rotation: 0, opacity: 1 } }))).toBe(0);
  });
});

describe('cache key and tint', () => {
  it('the silhouette key is the text signature + side + colour', () => {
    expect(sideSignature('sig', '#f00')).toBe('sig|side|#f00');
    expect(sideSignature('sig', '#f00')).not.toBe(sideSignature('sig', '#0f0'));
  });
  it('a face with a shadow or a box cannot simply be tinted', () => {
    expect(canTintFace({})).toBe(true);
    expect(canTintFace({ shadow: { color: '#000' } })).toBe(false);
    expect(canTintFace({ background: '#000' })).toBe(false);
    expect(canTintFace({ highlight: { background: '#000' } })).toBe(false);
    expect(canTintFace({ highlight: {} })).toBe(true);
  });
});
