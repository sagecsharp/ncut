import { describe, expect, it } from 'vitest';
import { shapePictureLive } from '../../engine/draw';
import { createShapeClip, createTextClip } from '../../lib/factory';
import { MAX_SCALE, MIN_SCALE, isStretched, stretchX, stretchY, stretchZ } from '../../types';
import { visualKeyProps } from '../shell/shortcuts';
import { wiggleDefault, wiggleProps } from './keyActions';
import { solidDepthOf } from './place3d';
import { STRETCH_REST, coverScale, thicknessAtRest } from './shapeLogic';
import { pieceOffset, pieceTransform, splitNotes } from './textSplit';
import type { PieceBase } from './textSplit';

describe('thicknessAtRest', () => {
  it('without stretch it is the box side over the scale', () => {
    expect(thicknessAtRest('cylinder', { width: 400, height: 100 }, { scale: 2 })).toBe(200);
    expect(thicknessAtRest('box', { width: 400, height: 100 }, { scale: 2 })).toBe(50);
  });
  it('divides by the stretch of the side it reads', () => {
    // box 400 wide = 100 x scale 2 x stretch 2
    expect(thicknessAtRest('cylinder', { width: 400, height: 90 }, { scale: 2, scaleX: 2, scaleY: 3 })).toBe(100);
    // box 90 tall = 15 x scale 2 x stretch 3
    expect(thicknessAtRest('box', { width: 400, height: 90 }, { scale: 2, scaleX: 2, scaleY: 3 })).toBe(15);
  });
  it('never below 1 and a stretch of the other side does not count', () => {
    expect(thicknessAtRest('box', { width: 400, height: 0.2 }, { scale: 1 })).toBe(1);
    expect(thicknessAtRest('box', { width: 400, height: 90 }, { scale: 1, scaleX: 5 })).toBe(90);
  });
});

describe('fit, reset and fill', () => {
  it('fit and reset put every stretch back to 1', () => {
    expect(STRETCH_REST).toEqual({ scaleX: 1, scaleY: 1, scaleZ: 1 });
  });
  it('fill covers the canvas from a stretched box (the box has the stretch in it)', () => {
    // 100 x 100 at scale 1, stretched x4 on x: the box is 400 x 100, canvas 800 x 400 needs x4 more
    expect(coverScale(1, 400, 100, 800, 400)).toBe(4);
    const s = coverScale(1, 400, 100, 800, 400);
    expect(400 * s).toBeGreaterThanOrEqual(800);
    expect(100 * s).toBeGreaterThanOrEqual(400);
  });
});

describe('solidDepthOf', () => {
  const solid = (over: Record<string, unknown>, tf: Record<string, number> = {}) =>
    ({ threeD: true, shape: 'cylinder', transform: { scale: 1, ...tf }, ...over }) as Parameters<typeof solidDepthOf>[0];
  it('flat clips and planes have no depth', () => {
    expect(solidDepthOf(solid({ threeD: false }), { w: 100, h: 100 }, 1)).toBe(0);
    expect(solidDepthOf(solid({ shape: 'plane' }, { scaleZ: 3 }), { w: 100, h: 100 }, 1)).toBe(0);
  });
  it('a set thickness follows scale, depth stretch and parents', () => {
    expect(solidDepthOf(solid({ shapeDepth: 50 }, { scale: 2, scaleZ: 3 }), { w: 1, h: 1 }, 2)).toBe(600);
  });
  it('the default thickness is the side at rest times the depth stretch', () => {
    // wide 400 = 100 x stretch 4: at rest 100, depth x2 = 200
    expect(solidDepthOf(solid({}, { scaleX: 4, scaleZ: 2 }), { w: 400, h: 50 }, 1)).toBe(200);
    expect(solidDepthOf(solid({ shape: 'box' }, { scaleY: 5, scaleZ: 2 }), { w: 400, h: 250 }, 1)).toBe(100);
  });
  it('a sphere ignores the thickness', () => {
    expect(solidDepthOf(solid({ shape: 'sphere', shapeDepth: 999 }), { w: 80, h: 80 }, 1)).toBe(80);
  });
});

describe('the stretch that is read', () => {
  it('missing or broken is no stretch', () => {
    expect(stretchX({})).toBe(1);
    expect(stretchY({ scaleY: NaN })).toBe(1);
    expect(stretchZ({ scaleZ: Infinity })).toBe(1);
    expect(isStretched({ scaleX: 1, scaleY: 1 })).toBe(false);
  });
  it('a keyed value that swings below zero or past the top is held inside the range, not read as 1', () => {
    expect(stretchX({ scaleX: -0.2 })).toBe(MIN_SCALE);
    expect(stretchY({ scaleY: 0 })).toBe(MIN_SCALE);
    expect(stretchZ({ scaleZ: 1e6 })).toBe(MAX_SCALE);
    expect(stretchX({ scaleX: 2.5 })).toBe(2.5);
  });
});

describe('the picture of a shape with a keyed stretch', () => {
  const key = [{ t: 0, v: 1, ease: 'linear' }, { t: 1, v: 2, ease: 'linear' }];
  it('is live (no texture kept per frame), with and without its outline in the picture', () => {
    const still = createShapeClip('t', 0, {});
    expect(shapePictureLive(still)).toBe(false);
    expect(shapePictureLive(still, true)).toBe(false);
    const x = createShapeClip('t', 0, {});
    x.keyframes = { scaleX: key } as never;
    expect(shapePictureLive(x)).toBe(true);
    expect(shapePictureLive(x, true)).toBe(true);
    const y = createShapeClip('t', 0, {});
    y.keyframes = { scaleY: key } as never;
    expect(shapePictureLive(y, true)).toBe(true);
  });
  it('an even scale or a move does not make it live', () => {
    const c = createShapeClip('t', 0, {});
    c.keyframes = { scale: key, x: key } as never;
    expect(shapePictureLive(c)).toBe(false);
    expect(shapePictureLive(c, true)).toBe(false);
  });
});

describe('wiggle', () => {
  it('offers the stretch of both sides with the amount scale has', () => {
    const c = createShapeClip('t', 0, {});
    expect(wiggleProps(c).map((w) => w.prop)).toEqual(['x', 'y', 'rotation', 'scale', 'scaleX', 'scaleY']);
    expect(wiggleDefault(c, 'scaleX')).toBe(wiggleDefault(c, 'scale'));
    expect(wiggleDefault(c, 'scaleY')).toBe(0.1);
  });
});

describe('key everything', () => {
  it('a clip nobody stretched gets the usual five', () => {
    expect(visualKeyProps(createShapeClip('t', 0, {}))).toEqual(['x', 'y', 'scale', 'rotation', 'opacity']);
  });
  it('a stretched axis or one with keys is added', () => {
    const c = createShapeClip('t', 0, {});
    c.transform = { ...c.transform, scaleX: 2 };
    expect(visualKeyProps(c)).toEqual(['x', 'y', 'scale', 'scaleX', 'rotation', 'opacity']);
    const k = createShapeClip('t', 0, {});
    k.keyframes = { scaleY: [{ t: 0, v: 1, ease: 'linear' }] } as never;
    expect(visualKeyProps(k)).toEqual(['x', 'y', 'scale', 'scaleY', 'rotation', 'opacity']);
  });
  it('depth only for a stretched solid', () => {
    const c = createShapeClip('t', 0, { threeD: true, shape: 'box' });
    c.transform = { ...c.transform, scaleZ: 2 };
    expect(visualKeyProps(c)).toContain('scaleZ');
    const flat = createShapeClip('t', 0, { threeD: true });
    flat.transform = { ...flat.transform, scaleZ: 2 };
    expect(visualKeyProps(flat)).not.toContain('scaleZ');
  });
  it('text wrapped on a solid has a depth, extruded text only with one', () => {
    const wrapped = createTextClip('t', 0, { threeD: true, shape: 'box' });
    wrapped.transform = { ...wrapped.transform, scaleZ: 2 };
    expect(visualKeyProps(wrapped)).toContain('scaleZ');
    const thin = createTextClip('t', 0, { threeD: true, extrude: { depth: 0 } as never });
    thin.transform = { ...thin.transform, scaleZ: 2 };
    expect(visualKeyProps(thin)).not.toContain('scaleZ');
    const thick = createTextClip('t', 0, { threeD: true, extrude: { depth: 40 } as never });
    thick.transform = { ...thick.transform, scaleZ: 2 };
    expect(visualKeyProps(thick)).toContain('scaleZ');
  });
});

describe('text split keeps the stretch', () => {
  const base = (tf: Record<string, number>): PieceBase => ({ start: 0, transform: { x: 0, y: 0, scale: 2, rotation: 0, opacity: 1, ...tf } });
  it('the offset is stretched per side', () => {
    const o = pieceOffset(base({ scaleX: 3, scaleY: 0.5 }), { cx: 10, cy: 10 }, 0);
    expect(o.dx).toBeCloseTo(60);
    expect(o.dy).toBeCloseTo(10);
  });
  it('the piece keeps scaleX and scaleY and sits at the stretched spot', () => {
    const t = pieceTransform(base({ scaleX: 3 }), { cx: 10, cy: 0, rot: 0 }, 0);
    expect(t.transform.scaleX).toBe(3);
    expect(t.transform.x).toBeCloseTo(60);
  });
  it('without a stretch nothing changes', () => {
    expect(pieceOffset(base({}), { cx: 10, cy: 4 }, 0).dx).toBeCloseTo(20);
  });
  it('an animated stretch is noted', () => {
    const c = createTextClip('t', 0, {});
    c.keyframes = { scaleX: [{ t: 0, v: 1, ease: 'linear' }] } as never;
    expect(splitNotes(c).some((n) => n.includes('animated'))).toBe(true);
  });
  it('curved text with an uneven stretch is noted: its letters are slanted and a piece cannot be', () => {
    const c = createTextClip('t', 0, { curve: 180 });
    c.transform = { ...c.transform, scaleX: 2 };
    expect(splitNotes(c).some((n) => n.includes('slant'))).toBe(true);
    const even = createTextClip('t', 0, { curve: 180 });
    even.transform = { ...even.transform, scaleX: 2, scaleY: 2 };
    expect(splitNotes(even).some((n) => n.includes('slant'))).toBe(false);
    const straight = createTextClip('t', 0, {});
    straight.transform = { ...straight.transform, scaleX: 2 };
    expect(splitNotes(straight).some((n) => n.includes('slant'))).toBe(false);
  });
});
