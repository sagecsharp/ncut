import { describe, expect, it } from 'vitest';
import { boxBounds, edgeResize, hasCrop, hitTestKept, keptBox, snapAxis } from './overlayMath';
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
