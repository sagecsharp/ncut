import { describe, expect, it } from 'vitest';
import { boxBounds, edgeMode, edgeResize, edgeStretch, hasCrop, hitTestKept, keptBox, keptPlaneModel, rotateValue, snapAxis, unwrapStep } from './overlayMath';
import { clipModelMatrix, planeCorners } from '../../engine/scene3d/model';
import type { ClipBox } from '../../engine/draw';

const box = (over: Partial<ClipBox> = {}): ClipBox => ({ cx: 500, cy: 300, width: 200, height: 100, rotation: 0, ...over });

describe('keptBox', () => {
  it('is the same box without a crop', () => {
    const b = box();
    expect(keptBox(b, null)).toBe(b);
    expect(keptBox(b, { left: 0, top: 0, right: 0, bottom: 0 })).toBe(b);
    expect(hasCrop({ left: 0, top: 0, right: 0, bottom: 0 })).toBe(false);
  });
  it('hugs the kept rectangle and keeps its place', () => {
    const k = keptBox(box(), { left: 0.25, top: 0, right: 0, bottom: 0.5 });
    expect(k.width).toBeCloseTo(150);
    expect(k.height).toBeCloseTo(50);
    // left edge of the kept part is still at 400 + 50 = 450, top edge at 250
    expect(k.cx - k.width / 2).toBeCloseTo(450);
    expect(k.cx + k.width / 2).toBeCloseTo(600);
    expect(k.cy - k.height / 2).toBeCloseTo(250);
  });
  it('rotates the offset with the clip', () => {
    // cut the left half of a 200 x 100 box, rotated 90 degrees clockwise: the kept center moves along local +x = canvas +y
    const k = keptBox(box({ rotation: 90 }), { left: 0.5, top: 0, right: 0, bottom: 0 });
    expect(k.cx).toBeCloseTo(500);
    expect(k.cy).toBeCloseTo(350);
    expect(k.width).toBeCloseTo(100);
  });
  it('never collapses to nothing', () => {
    const k = keptBox(box(), { left: 0.9, top: 0, right: 0.9, bottom: 0 });
    expect(k.width).toBeGreaterThan(0);
  });
});

describe('hit testing', () => {
  it('uses the kept rectangle', () => {
    const k = keptBox(box(), { left: 0.5, top: 0, right: 0, bottom: 0 });
    expect(hitTestKept(k, 420, 300)).toBe(false);
    expect(hitTestKept(k, 560, 300)).toBe(true);
  });
  it('grows thin boxes to a minimum size', () => {
    const line = box({ height: 1 });
    expect(hitTestKept(line, 500, 304)).toBe(false);
    expect(hitTestKept(line, 500, 304, 12)).toBe(true);
  });
  it('bounds of a rotated box', () => {
    const b = boxBounds(box({ rotation: 90 }));
    expect(b.hw).toBeCloseTo(50);
    expect(b.hh).toBeCloseTo(100);
  });
});

describe('snapAxis', () => {
  it('snaps the center, the low edge and the high edge', () => {
    expect(snapAxis(962, 100, 1920, 6)).toEqual({ adj: -2, at: 960 });
    expect(snapAxis(104, 100, 1920, 6)).toEqual({ adj: -4, at: 0 });
    expect(snapAxis(1815, 100, 1920, 6)).toEqual({ adj: 5, at: 1920 });
  });
  it('does nothing when far away and picks the closest candidate', () => {
    expect(snapAxis(700, 100, 1920, 6)).toBeNull();
    expect(snapAxis(955, 960, 1920, 6)?.at).toBe(960);
  });
});

describe('edgeResize', () => {
  const start = { cx: 500, cy: 300, rotation: 0, bw: 200, bh: 100, scale: 2 };
  it('right edge: grows width and shifts the center by half, left edge stays', () => {
    const r = edgeResize(start, 'r', 700, 300);
    // right edge was at 600, now at 700: box is 300 wide = 150 shape px at scale 2
    expect(r.width).toBeCloseTo(150);
    expect(r.dx).toBeCloseTo(50);
    expect(r.dy).toBeCloseTo(0);
    expect(500 + r.dx - 300 / 2).toBeCloseTo(400); // left edge unchanged
  });
  it('top edge: moving down shrinks the height and keeps the bottom edge', () => {
    const r = edgeResize(start, 't', 500, 300);
    expect(r.height).toBeCloseTo(25);
    expect(r.dy).toBeCloseTo(25);
    expect(300 + r.dy + 50 / 2).toBeCloseTo(350);
  });
  it('is clamped to a minimum size', () => {
    const r = edgeResize(start, 'l', 900, 300, 4);
    expect(r.width).toBeCloseTo(2);
  });
  it('works in a rotated frame', () => {
    // 90 degrees clockwise: local +x points to canvas +y. dragging the right edge to y = 450 widens the box from 200 to 250
    const r = edgeResize({ ...start, rotation: 90 }, 'r', 500, 450);
    expect(r.width).toBeCloseTo(125);
    expect(r.dx).toBeCloseTo(0);
    expect(r.dy).toBeCloseTo(25);
  });
});

describe('edgeMode', () => {
  it('sizes a plain shape and stretches everything else', () => {
    expect(edgeMode({ type: 'shape' })).toBe('size');
    expect(edgeMode({ type: 'image' })).toBe('stretch');
    expect(edgeMode({ type: 'video', crop: null })).toBe('stretch');
    expect(edgeMode({ type: 'text', crop: { left: 0, top: 0, right: 0, bottom: 0 } })).toBe('stretch');
  });
  it('has no edge handles on a cropped or a 3d clip', () => {
    expect(edgeMode({ type: 'image', crop: { left: 0.1, top: 0, right: 0, bottom: 0 } })).toBeNull();
    expect(edgeMode({ type: 'shape', crop: { left: 0, top: 0, right: 0, bottom: 0.2 } })).toBeNull();
    expect(edgeMode({ type: 'image', threeD: true })).toBeNull();
  });
});

describe('edgeStretch', () => {
  // a 200 x 100 box that is already stretched 2 on x
  const start = { cx: 500, cy: 300, rotation: 0, bw: 200, bh: 100, scale: 3 };
  it('right edge: the stretch follows the box side and the left edge stays', () => {
    const r = edgeStretch(start, 'r', 2, 700, 300);
    // right edge from 600 to 700: the box is 300 wide = 1.5 x the side at the grab
    expect(r.value).toBeCloseTo(3);
    expect(r.dx).toBeCloseTo(50);
    expect(r.dy).toBeCloseTo(0);
    expect(500 + r.dx - 300 / 2).toBeCloseTo(400);
  });
  it('does not depend on the uniform scale', () => {
    expect(edgeStretch({ ...start, scale: 0.5 }, 'r', 2, 700, 300)).toEqual(edgeStretch(start, 'r', 2, 700, 300));
  });
  it('top edge: moving down shrinks the height and keeps the bottom edge', () => {
    const r = edgeStretch(start, 't', 1, 500, 300);
    expect(r.value).toBeCloseTo(0.5);
    expect(r.dy).toBeCloseTo(25);
    expect(300 + r.dy + 50 / 2).toBeCloseTo(350);
  });
  it('left edge: the right edge stays', () => {
    const r = edgeStretch(start, 'l', 1, 300, 300);
    expect(r.value).toBeCloseTo(1.5);
    expect(r.dx).toBeCloseTo(-50);
    expect(500 + r.dx + 300 / 2).toBeCloseTo(600);
  });
  it('works in a rotated frame', () => {
    // 90 degrees clockwise: local +x points to canvas +y. the right edge dragged to y = 450 widens 200 to 250
    const r = edgeStretch({ ...start, rotation: 90 }, 'r', 1, 500, 450);
    expect(r.value).toBeCloseTo(1.25);
    expect(r.dx).toBeCloseTo(0);
    expect(r.dy).toBeCloseTo(25);
  });
  it('keeps the opposite edge fixed in a 30 degree frame', () => {
    const rad = (30 * Math.PI) / 180;
    const s = { ...start, rotation: 30 };
    // the left edge middle in canvas space
    const leftX = 500 - Math.cos(rad) * 100;
    const leftY = 300 - Math.sin(rad) * 100;
    const r = edgeStretch(s, 'r', 1, 500 + Math.cos(rad) * 250, 300 + Math.sin(rad) * 250);
    const nw = 200 * r.value;
    const cx = 500 + r.dx;
    const cy = 300 + r.dy;
    expect(cx - Math.cos(rad) * (nw / 2)).toBeCloseTo(leftX, 1);
    expect(cy - Math.sin(rad) * (nw / 2)).toBeCloseTo(leftY, 1);
  });
  it('clamps to 0.01..100 and the far edge follows the clamp', () => {
    const lo = edgeStretch(start, 'r', 1, -5000, 300, 0.001);
    expect(lo.value).toBe(0.01);
    // the box is now 2 wide: the left edge (400) did not move
    expect(500 + lo.dx - 2 / 2).toBeCloseTo(400);
    const hi = edgeStretch(start, 'r', 50, 900, 300);
    // the minimum box side (4 px) wins over the clamp when it is larger
    expect(edgeStretch(start, 'r', 1, -5000, 300).value).toBeCloseTo(0.02);
    expect(hi.value).toBe(100);
  });
  it('rounds to 3 decimals', () => {
    const r = edgeStretch(start, 'r', 1, 633, 300);
    expect(r.value).toBe(Math.round(r.value * 1000) / 1000);
    expect(r.value).toBeCloseTo(1.165, 3);
  });
  it('treats a broken stretch at the grab as 1', () => {
    expect(edgeStretch(start, 'r', 0, 700, 300).value).toBeCloseTo(1.5);
    expect(edgeStretch(start, 'r', NaN, 700, 300).value).toBeCloseTo(1.5);
  });
});

describe('rotation drag', () => {
  it('unwraps across the branch cut', () => {
    expect(unwrapStep(170, -170)).toBeCloseTo(20);
    expect(unwrapStep(-170, 170)).toBeCloseTo(-20);
    expect(unwrapStep(10, 40)).toBeCloseTo(30);
  });
  it('keeps two turns when grabbing a clip at 720', () => {
    // pointer starts at 30 degrees and moves 10 degrees on: 720 -> 730, not 1 -> 11
    let acc = 0;
    let last = 30;
    for (const a of [35, 40]) {
      acc += unwrapStep(last, a);
      last = a;
    }
    expect(rotateValue(720, acc, false)).toBeCloseTo(730);
  });
  it('accumulates a spin through the branch cut', () => {
    let acc = 0;
    let last = 150;
    for (const a of [170, -170, -150]) {
      acc += unwrapStep(last, a);
      last = a;
    }
    expect(acc).toBeCloseTo(60);
    expect(rotateValue(0, acc, false)).toBeCloseTo(60);
  });
  it('snaps to 90s on the unwrapped value, 15s with shift', () => {
    expect(rotateValue(720, 1.5, false)).toBe(720);
    expect(rotateValue(720, 88, false)).toBe(810);
    expect(rotateValue(0, 20, false)).toBeCloseTo(20);
    expect(rotateValue(720, 9, true)).toBe(735);
  });
});

describe('cropped 3d outline', () => {
  const b: ClipBox = { cx: 500, cy: 300, width: 200, height: 100, rotation: 0 };
  const t = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: 0 };
  const model = clipModelMatrix(b, t, 'none', [0, 0, -1000]);
  it('shrinks a plane to the kept rectangle like the 2d box does', () => {
    const crop = { left: 0.25, top: 0, right: 0, bottom: 0.5 };
    const c = planeCorners(keptPlaneModel(model, crop, 'plane'));
    const k = keptBox(b, crop);
    expect(c[0][0]).toBeCloseTo(k.cx - k.width / 2);
    expect(c[1][0]).toBeCloseTo(k.cx + k.width / 2);
    expect(c[0][1]).toBeCloseTo(k.cy - k.height / 2);
    expect(c[2][1]).toBeCloseTo(k.cy + k.height / 2);
  });
  it('keeps a rotated plane in place', () => {
    const m = clipModelMatrix({ ...b, rotation: 90 }, t, 'none', [0, 0, -1000]);
    const c = planeCorners(keptPlaneModel(m, { left: 0.5, top: 0, right: 0, bottom: 0 }, undefined));
    const k = keptBox({ ...b, rotation: 90 }, { left: 0.5, top: 0, right: 0, bottom: 0 });
    const cx = (c[0][0] + c[2][0]) / 2;
    const cy = (c[0][1] + c[2][1]) / 2;
    expect(cx).toBeCloseTo(k.cx);
    expect(cy).toBeCloseTo(k.cy);
  });
  it('wraps and uncropped planes keep their full size', () => {
    expect(keptPlaneModel(model, { left: 0.5, top: 0, right: 0, bottom: 0 }, 'box')).toBe(model);
    expect(keptPlaneModel(model, null, 'plane')).toBe(model);
  });
});
