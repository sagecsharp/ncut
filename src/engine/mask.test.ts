import { describe, expect, it } from 'vitest';
import { createShapeClip } from '../lib/factory';
import type { Mask, VisualClip } from '../types';
import { DEFAULT_MASK, MASK_MAX_SIDE, blurAlpha, featherPx, hasMask, heartPoints, maskCoverage, maskSignature, maskWorkSize, maskedPicture, starPoints } from './mask';

const m = (o: Partial<Mask> = {}): Mask => ({ ...DEFAULT_MASK, feather: 0, ...o });
const clip = (mask?: Mask | null): VisualClip => ({ ...createShapeClip('t', 0, { duration: 1 }), mask });

describe('hasMask / maskSignature', () => {
  it('no mask: false and empty signature', () => {
    expect(hasMask(clip())).toBe(false);
    expect(hasMask(clip(null))).toBe(false);
    expect(maskSignature(clip())).toBe('');
    expect(maskSignature(clip(null))).toBe('');
  });
  it('a mask: true and a signature', () => {
    expect(hasMask(clip(m()))).toBe(true);
    expect(maskSignature(clip(m()))).not.toBe('');
  });
  it('every field changes the signature', () => {
    const base = maskSignature(clip(m()));
    const changes: Partial<Mask>[] = [
      { shape: 'rect' },
      { x: 0.1 },
      { y: 0.1 },
      { width: 0.5 },
      { height: 0.5 },
      { rotation: 10 },
      { feather: 0.3 },
      { invert: true },
      { radius: 0.4 },
    ];
    const seen = new Set([base]);
    for (const c of changes) {
      const s = maskSignature(clip(m(c)));
      expect(seen.has(s)).toBe(false);
      seen.add(s);
    }
  });
  it('the same mask gives the same signature', () => {
    expect(maskSignature(clip(m({ x: 0.2 })))).toBe(maskSignature(clip(m({ x: 0.2 }))));
  });
});

describe('maskCoverage', () => {
  it('rect: center in, outside out', () => {
    const k = m({ shape: 'rect', width: 0.5, height: 0.5 });
    expect(maskCoverage(k, 0, 0)).toBe(1);
    expect(maskCoverage(k, 0.24, 0.24)).toBe(1);
    expect(maskCoverage(k, 0.3, 0)).toBe(0);
    expect(maskCoverage(k, 0, -0.3)).toBe(0);
  });
  it('rect: radius rounds the corners', () => {
    const sq = m({ shape: 'rect', width: 0.5, height: 0.5 });
    const round = m({ shape: 'rect', width: 0.5, height: 0.5, radius: 1 });
    expect(maskCoverage(sq, 0.24, 0.24)).toBe(1);
    expect(maskCoverage(round, 0.24, 0.24)).toBe(0);
    expect(maskCoverage(round, 0, 0)).toBe(1);
    expect(maskCoverage(round, 0.24, 0)).toBe(1);
  });
  it('ellipse', () => {
    const k = m({ shape: 'ellipse', width: 0.6, height: 0.2 });
    expect(maskCoverage(k, 0, 0)).toBe(1);
    expect(maskCoverage(k, 0.29, 0)).toBe(1);
    expect(maskCoverage(k, 0, 0.09)).toBe(1);
    expect(maskCoverage(k, 0.25, 0.09)).toBe(0);
    expect(maskCoverage(k, 0, 0.2)).toBe(0);
  });
  it('x / y move the figure', () => {
    const k = m({ shape: 'ellipse', x: 0.25, y: -0.25, width: 0.2, height: 0.2 });
    expect(maskCoverage(k, 0.25, -0.25)).toBe(1);
    expect(maskCoverage(k, 0, 0)).toBe(0);
  });
  it('split: rotation 0 keeps the left, 90 the top, 180 the right, 270 the bottom', () => {
    const at = (rotation: number, u: number, v: number) => maskCoverage(m({ shape: 'split', rotation }), u, v);
    expect(at(0, -0.3, 0)).toBe(1);
    expect(at(0, 0.3, 0)).toBe(0);
    expect(at(90, 0, -0.3)).toBe(1);
    expect(at(90, 0, 0.3)).toBe(0);
    expect(at(180, 0.3, 0)).toBe(1);
    expect(at(180, -0.3, 0)).toBe(0);
    expect(at(270, 0, 0.3)).toBe(1);
    expect(at(270, 0, -0.3)).toBe(0);
  });
  it('split passes through x, y', () => {
    const k = m({ shape: 'split', x: 0.2 });
    expect(maskCoverage(k, 0.1, 0)).toBe(1);
    expect(maskCoverage(k, 0.3, 0)).toBe(0);
  });
  it('band: a stripe of height, rotating it', () => {
    const h = m({ shape: 'band', height: 0.2 });
    expect(maskCoverage(h, 0.45, 0.05)).toBe(1);
    expect(maskCoverage(h, -0.45, -0.05)).toBe(1);
    expect(maskCoverage(h, 0, 0.2)).toBe(0);
    const v = m({ shape: 'band', height: 0.2, rotation: 90 });
    expect(maskCoverage(v, 0.05, 0.45)).toBe(1);
    expect(maskCoverage(v, 0.2, 0)).toBe(0);
  });
  it('band at 45 degrees follows the diagonal', () => {
    const k = m({ shape: 'band', height: 0.1, rotation: 45 });
    expect(maskCoverage(k, 0.3, 0.3)).toBe(1);
    expect(maskCoverage(k, 0.3, -0.3)).toBe(0);
  });
  it('rect rotated 90 on a square picture swaps its sides', () => {
    const k = m({ shape: 'rect', width: 0.8, height: 0.2, rotation: 90 });
    expect(maskCoverage(k, 0, 0.35)).toBe(1);
    expect(maskCoverage(k, 0.35, 0)).toBe(0);
  });
  it('aspect: rotation happens in pixels', () => {
    // a 2:1 picture: a rect 0.5 wide x 1 high is a 1000 x 1000 px square, turned 45 degrees its corner
    // points right at 707px of 2000px = 0.354 of the width
    const k = m({ shape: 'rect', width: 0.5, height: 1, rotation: 45 });
    expect(maskCoverage(k, 0.34, 0, 2)).toBe(1);
    expect(maskCoverage(k, 0.37, 0, 2)).toBe(0);
  });
  it('star: center in, far corner out, tip up', () => {
    const k = m({ shape: 'star', width: 1, height: 1 });
    expect(maskCoverage(k, 0, 0)).toBe(1);
    expect(maskCoverage(k, 0.48, 0.48)).toBe(0);
    expect(maskCoverage(k, 0, -0.45)).toBe(1);
    // between the two top arms, above the notch
    expect(maskCoverage(k, 0.12, -0.45)).toBe(0);
  });
  it('heart: center in, corners out, notch at the top', () => {
    const k = m({ shape: 'heart', width: 1, height: 1 });
    expect(maskCoverage(k, 0, 0)).toBe(1);
    expect(maskCoverage(k, 0.48, 0.48)).toBe(0);
    expect(maskCoverage(k, -0.48, -0.48)).toBe(0);
    expect(maskCoverage(k, 0, 0.4)).toBe(1);
    expect(maskCoverage(k, 0, -0.49)).toBe(0);
  });
  it('invert flips every shape', () => {
    for (const shape of ['rect', 'ellipse', 'split', 'band', 'star', 'heart'] as const) {
      const a = m({ shape, width: 0.5, height: 0.5 });
      const b = m({ shape, width: 0.5, height: 0.5, invert: true });
      for (const [u, v] of [[0, 0], [0.4, 0.4], [-0.3, 0.1], [0.1, -0.45]] as const) {
        expect(maskCoverage(a, u, v) + maskCoverage(b, u, v)).toBe(1);
      }
    }
  });
  it('zero size shows nothing (invert: everything)', () => {
    for (const shape of ['rect', 'ellipse', 'band', 'star', 'heart'] as const) {
      expect(maskCoverage(m({ shape, width: 0, height: 0 }), 0, 0)).toBe(0);
      expect(maskCoverage(m({ shape, width: 0, height: 0, invert: true }), 0, 0)).toBe(1);
    }
    expect(maskCoverage(m({ shape: 'rect', width: 0.5, height: 0 }), 0, 0)).toBe(0);
  });
  it('bad numbers do not throw', () => {
    expect(() => maskCoverage(m({ x: Number.NaN, width: Number.NaN }), 0, 0, 0)).not.toThrow();
  });
});

describe('point lists', () => {
  it('star has 10 corners, heart a smooth outline, both fill the unit box', () => {
    expect(starPoints()).toHaveLength(10);
    expect(heartPoints().length).toBeGreaterThan(20);
    for (const pts of [starPoints(), heartPoints()]) {
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      expect(Math.min(...xs)).toBeCloseTo(-0.5, 6);
      expect(Math.max(...xs)).toBeCloseTo(0.5, 6);
      expect(Math.min(...ys)).toBeCloseTo(-0.5, 6);
      expect(Math.max(...ys)).toBeCloseTo(0.5, 6);
    }
  });
  it('the star points up', () => {
    const top = starPoints()[0]!;
    expect(top[0]).toBeCloseTo(0, 6);
    expect(top[1]).toBeCloseTo(-0.5, 6);
  });
});

describe('maskWorkSize / featherPx', () => {
  it('keeps small pictures, caps big ones proportionally', () => {
    expect(maskWorkSize(640, 360)).toEqual({ w: 640, h: 360 });
    const big = maskWorkSize(4096, 2048)!;
    expect(big.w).toBe(MASK_MAX_SIDE);
    expect(big.h).toBe(MASK_MAX_SIDE / 2);
    expect(maskWorkSize(0, 100)).toBeNull();
    expect(maskWorkSize(Number.NaN, 100)).toBeNull();
  });
  it('feather is a fraction of half the shorter side', () => {
    expect(featherPx(m({ feather: 0.5 }), 400, 200)).toBe(50);
    expect(featherPx(m({ feather: 0 }), 400, 200)).toBe(0);
    expect(featherPx(m({ feather: 9 }), 400, 200)).toBe(100);
  });
});

describe('blurAlpha', () => {
  it('softens a step and keeps it monotonic', () => {
    const w = 40;
    const a = new Float32Array(w);
    for (let i = 20; i < w; i++) a[i] = 255;
    blurAlpha(a, w, 1, 3);
    expect(a[0]).toBeCloseTo(0, 3);
    expect(a[w - 1]).toBeCloseTo(255, 3);
    expect(a[19]!).toBeGreaterThan(0);
    expect(a[19]!).toBeLessThan(255);
    for (let i = 1; i < w; i++) expect(a[i]!).toBeGreaterThanOrEqual(a[i - 1]! - 1e-3);
    expect(a[19]! + a[20]!).toBeCloseTo(255, 1);
  });
  it('a flat image stays flat (clamped edges)', () => {
    const a = new Float32Array(25).fill(200);
    blurAlpha(a, 5, 5, 2);
    for (const v of a) expect(v).toBeCloseTo(200, 3);
  });
  it('radius 0 does nothing', () => {
    const a = Float32Array.from([0, 255, 0]);
    blurAlpha(a, 3, 1, 0);
    expect(Array.from(a)).toEqual([0, 255, 0]);
  });
});

describe('maskedPicture without a canvas (node)', () => {
  it('returns the source when there is no mask', () => {
    const src = {} as CanvasImageSource;
    expect(maskedPicture(src, 100, 100, clip())).toBe(src);
  });
  it('returns the source when no canvas can be made, never throws', () => {
    const src = {} as CanvasImageSource;
    expect(maskedPicture(src, 100, 100, clip(m()), 'export')).toBe(src);
    expect(maskedPicture(src, 0, 0, clip(m()))).toBe(src);
  });
});
