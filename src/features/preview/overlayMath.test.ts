import { describe, expect, it } from 'vitest';
import { BEND_OUTLINE_STEPS, asScenePlane, boundsMiddle, boxBounds, groupStep, clipQuad, edgeCrop, edgeCropRaw, edgeMode, edgeResize, edgeStretch, hasCrop, hitTestKept, keptBox, keptShare, keptPlaneModel, projectRig, pointInBent, quadPoints, rayBent, rayQuad, rotateValue, snapAxis, snapAxisTo, snapLines, unwrapStep, worldCenter3d } from './overlayMath';
import { projectPoint, screenRay } from '../../engine/scene3d/camera';
import { createProject, createShapeClip } from '../../lib/factory';
import { DEFAULT_TRANSFORM } from '../../types';
import type { ShapeClip } from '../../types';
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
  it('a shape that is stretched as well: the start scale carries the stretch of that side', () => {
    // a 200 wide figure at scale 1 with a stretch of 2 shows 400 wide. the right edge goes from 700 to 800: 500 wide = a 250 figure
    const r = edgeResize({ cx: 500, cy: 300, rotation: 0, bw: 400, bh: 100, scale: 1 * 2 }, 'r', 800, 300);
    expect(r.width).toBeCloseTo(250);
    expect(r.dx).toBeCloseTo(50);
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
  it('sizes a plain shape and crops everything else', () => {
    expect(edgeMode({ type: 'shape' })).toBe('size');
    expect(edgeMode({ type: 'image' })).toBe('crop');
    expect(edgeMode({ type: 'video' })).toBe('crop');
    expect(edgeMode({ type: 'text' })).toBe('crop');
  });
  it('stretches any clip with ctrl', () => {
    expect(edgeMode({ type: 'shape' }, true)).toBe('stretch');
    expect(edgeMode({ type: 'image' }, true)).toBe('stretch');
    expect(edgeMode({ type: 'video' }, true)).toBe('stretch');
  });
  it('has no edge handles on a 3d clip', () => {
    expect(edgeMode({ type: 'image', threeD: true })).toBeNull();
    expect(edgeMode({ type: 'image', threeD: true }, true)).toBeNull();
  });
});

describe('edgeCrop', () => {
  const pic = { cx: 500, cy: 300, width: 400, height: 200, rotation: 0 };
  it('cuts the share of the picture between its edge and the pointer', () => {
    expect(edgeCrop(pic, 'l', 400, 300)).toBeCloseTo(0.25);
    expect(edgeCrop(pic, 'r', 600, 300)).toBeCloseTo(0.25);
    expect(edgeCrop(pic, 't', 500, 250)).toBeCloseTo(0.25);
    expect(edgeCrop(pic, 'b', 500, 350)).toBeCloseTo(0.25);
  });
  it('is 0 past the edge and never more than the max', () => {
    expect(edgeCrop(pic, 'l', 100, 300)).toBe(0);
    expect(edgeCrop(pic, 'l', 2000, 300)).toBeCloseTo(0.99);
    expect(edgeCrop(pic, 'l', 2000, 300, 0.5)).toBeCloseTo(0.5);
    expect(edgeCrop(pic, 'l', NaN, 300)).toBe(0);
  });
  it('measures in the clip axes of a turned picture', () => {
    // turned 90 degrees: the clip's left edge is at the top of the screen
    expect(edgeCrop({ ...pic, rotation: 90 }, 'l', 500, 200)).toBeCloseTo(0.25);
  });
  it('with a grab the crop moves by as much as the pointer did (no jump on the press)', () => {
    // pressed 4 px inside the right edge of a picture already cut 10% there
    const grab = { at: edgeCropRaw(pic, 'r', 656, 300), crop: 0.1 };
    expect(edgeCrop(pic, 'r', 656, 300, 0.99, grab)).toBeCloseTo(0.1);
    expect(edgeCrop(pic, 'r', 616, 300, 0.99, grab)).toBeCloseTo(0.2);
    expect(edgeCrop(pic, 'r', 900, 300, 0.99, grab)).toBe(0);
  });
  it('the cut edge lands under the pointer (kept box)', () => {
    const v = edgeCrop(pic, 'r', 650, 300);
    const k = keptBox(pic, { left: 0, top: 0, right: v, bottom: 0 });
    expect(k.cx + k.width / 2).toBeCloseTo(650);
  });
});

describe('keptShare', () => {
  it('is what the crop keeps of each axis', () => {
    expect(keptShare(null)).toEqual({ x: 1, y: 1 });
    const s = keptShare({ left: 0.1, right: 0.2, top: 0.5, bottom: 0 });
    expect(s.x).toBeCloseTo(0.7);
    expect(s.y).toBeCloseTo(0.5);
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
  it('lands on a quarter turn from up to 8 degrees away, and alt never snaps', () => {
    expect(rotateValue(0, 83, false)).toBe(90);
    expect(rotateValue(0, 187.5, false)).toBe(180);
    expect(rotateValue(0, -7, false)).toBe(0);
    expect(rotateValue(0, 81, false)).toBeCloseTo(81);
    expect(rotateValue(0, 178, false, true)).toBeCloseTo(178);
    expect(rotateValue(0, 178, true, true)).toBeCloseTo(178);
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

describe('pivoted 3d clips', () => {
  const make = (o: Partial<ShapeClip> = {}) => {
    const p = createProject();
    const clip = { ...createShapeClip(p.tracks[0]!.id, 0, { duration: 10, width: 200, height: 100, threeD: true }), id: 'a', ...o };
    p.clips = [clip];
    return { p, clip };
  };
  it('worldCenter3d is the position of a pivoted 3d clip, not its picture middle', () => {
    const { p, clip } = make({ pivot: { x: 0.5, y: 0 }, transform: { ...DEFAULT_TRANSFORM, x: 50, y: -30, z: 80, rotY: 30 } });
    const c = worldCenter3d(p, clip, 1);
    expect(c[0]).toBeCloseTo(p.width / 2 + 50, 3);
    expect(c[1]).toBeCloseTo(p.height / 2 - 30, 3);
    expect(c[2]).toBeCloseTo(80, 3);
  });
  it('clipQuad of a pivoted 3d clip outlines its picture', () => {
    const { p, clip } = make({ pivot: { x: 0.5, y: 0 }, transform: { ...DEFAULT_TRANSFORM, x: 50, z: 80 } });
    const q = clipQuad(p, clip, 1, projectRig(p, 1));
    const cx = p.width / 2 + 50;
    const cy = p.height / 2;
    // the picture runs 200 px to the left of the position
    expect(q.world[0][0]).toBeCloseTo(cx - 200, 3);
    expect(q.world[1][0]).toBeCloseTo(cx, 3);
    expect(q.world[0][1]).toBeCloseTo(cy - 50, 3);
    expect(q.world[2][1]).toBeCloseTo(cy + 50, 3);
    // the depth is the picture's middle
    const mid = projectPoint(projectRig(p, 1), cx - 100, cy, 80, p.width, p.height);
    expect(q.depth).toBeCloseTo(mid.depth, 3);
  });
});

describe('bent 3d clips', () => {
  const make = (o: Partial<ShapeClip> = {}) => {
    const p = createProject();
    const clip = { ...createShapeClip(p.tracks[0]!.id, 0, { duration: 10, width: 200, height: 100, threeD: true }), id: 'a', ...o };
    p.clips = [clip];
    return { p, clip };
  };
  const z80 = { ...DEFAULT_TRANSFORM, z: 80 };
  it('clipQuad of a bent plane: bent corners, 2 x 25 outline points, the depth of the bent middle', () => {
    const { p, clip } = make({ transform: z80, bend: { angle: 180 } });
    const flat = make({ transform: z80 });
    const rig = projectRig(p, 1);
    const q = clipQuad(p, clip, 1, rig);
    const f = clipQuad(flat.p, flat.clip, 1, rig);
    expect(q.bent).not.toBeNull();
    expect(q.bent!.n).toBe(BEND_OUTLINE_STEPS + 1);
    expect(q.bent!.n).toBe(25);
    expect(q.bent!.world.length).toBe(50);
    expect(q.bent!.screen.length).toBe(100);
    // the bent corners come in from the flat ones and leave the plane
    expect(Math.abs(q.world[0][0] - p.width / 2)).toBeLessThan(Math.abs(f.world[0][0] - p.width / 2));
    expect(Math.abs(q.world[0][2] - 80)).toBeGreaterThan(1);
    // the middle stays in place: the depth is the projected middle
    const mid = projectPoint(rig, p.width / 2, p.height / 2, 80, p.width, p.height);
    expect(q.depth).toBeCloseTo(mid.depth, 3);
  });
  it('clipQuad of a bent plane with its center off the middle takes the bent middle depth', () => {
    const { p, clip } = make({ transform: z80, bend: { angle: 180, center: 0.5 } });
    const flat = make({ transform: z80 });
    const rig = projectRig(p, 1);
    const q = clipQuad(p, clip, 1, rig);
    const f = clipQuad(flat.p, flat.clip, 1, rig);
    const mid = projectPoint(rig, (q.bent!.world[12]![0] + q.bent!.world[37]![0]) / 2, (q.bent!.world[12]![1] + q.bent!.world[37]![1]) / 2, (q.bent!.world[12]![2] + q.bent!.world[37]![2]) / 2, p.width, p.height);
    expect(q.depth).not.toBeCloseTo(f.depth, 0);
    expect(Math.abs(q.depth - f.depth)).toBeGreaterThan(5);
    expect(q.depth).toBeCloseTo(mid.depth, 3);
  });
  it('clipQuad of a flat plane sets bent null', () => {
    const { p, clip } = make({ transform: z80 });
    expect(clipQuad(p, clip, 1, projectRig(p, 1)).bent).toBeNull();
    // a flat bend (angle 0) is flat too
    const z = make({ transform: z80, bend: { angle: 0 } });
    expect(clipQuad(z.p, z.clip, 1, projectRig(z.p, 1)).bent).toBeNull();
  });
  it('clipQuad of a bent pivoted plane outlines its picture', () => {
    const { p, clip } = make({ pivot: { x: 0.5, y: 0 }, transform: { ...DEFAULT_TRANSFORM, x: 50, z: 80 }, bend: { angle: 90 } });
    const rig = projectRig(p, 1);
    const q = clipQuad(p, clip, 1, rig);
    const cx = p.width / 2 + 50 - 100;
    const cy = p.height / 2;
    // the middle of the strip (the middle of edge a and edge b) is the middle of the picture
    const a = q.bent!.world[12]!;
    const b = q.bent!.world[37]!;
    expect((a[0] + b[0]) / 2).toBeCloseTo(cx, 3);
    expect((a[1] + b[1]) / 2).toBeCloseTo(cy, 3);
    expect((a[2] + b[2]) / 2).toBeCloseTo(80, 3);
    const mid = projectPoint(rig, cx, cy, 80, p.width, p.height);
    expect(q.depth).toBeCloseTo(mid.depth, 3);
  });
  it('pointInBent and rayBent hit the bent strip and miss where the flat plane was', () => {
    const { p, clip } = make({ bend: { angle: 180 } });
    const rig = projectRig(p, 1);
    const q = clipQuad(p, clip, 1, rig);
    const mx = p.width / 2;
    const my = p.height / 2;
    // a half turn pulls the sides in to about 64 px from the middle (flat: 100)
    expect(pointInBent(q, mx, my)).toBe(true);
    expect(pointInBent(q, mx + 40, my)).toBe(true);
    expect(pointInBent(q, mx + 90, my)).toBe(false);
    const ray = (x: number, y: number) => screenRay(rig, x, y, p.width, p.height);
    const r0 = ray(mx, my);
    expect(rayBent(r0.origin, r0.dir, q)).not.toBeNull();
    const r1 = ray(mx + 90, my);
    expect(rayBent(r1.origin, r1.dir, q)).toBeNull();
    // the flat plane was there
    const flat = make();
    const fq = clipQuad(flat.p, flat.clip, 1, rig);
    expect(rayQuad(r1.origin, r1.dir, fq.world)).not.toBeNull();
    expect(pointInBent(fq, mx + 90, my)).toBe(true);
  });
  it('pointInBent hits a closed tube and a card turned past 90 where the outline folds over itself', () => {
    const tube = make({ bend: { angle: 360 } });
    const rig = projectRig(tube.p, 1);
    const tq = clipQuad(tube.p, tube.clip, 1, rig);
    const mx = tube.p.width / 2;
    const my = tube.p.height / 2;
    for (const dx of [-25, -10, 0, 10, 25]) expect(pointInBent(tq, mx + dx, my)).toBe(true);
    const card = make({ transform: { ...DEFAULT_TRANSFORM, rotY: 60 }, bend: { angle: 180 } });
    const cq = clipQuad(card.p, card.clip, 1, projectRig(card.p, 1));
    expect(pointInBent(cq, mx, my)).toBe(true);
  });
  it('clipQuad of a bent 2d clip flattens it like the renderer: no shape, no z, tilt or turn', () => {
    const { p, clip } = make({ threeD: false, shape: 'box', transform: { ...DEFAULT_TRANSFORM, z: 80, rotY: 60 }, bend: { angle: 90 } } as never);
    const rig = projectRig(p, 1);
    const q = clipQuad(p, asScenePlane(clip), 1, rig);
    expect(q.bent).not.toBeNull();
    const plain = make({ threeD: false, transform: { ...DEFAULT_TRANSFORM }, bend: { angle: 90 } } as never);
    const r = clipQuad(plain.p, asScenePlane(plain.clip), 1, rig);
    expect(r.bent).not.toBeNull();
    for (let i = 0; i < 100; i++) expect(q.bent!.screen[i]).toBeCloseTo(r.bent!.screen[i]!, 3);
  });
  it('quadPoints gives 4 points flat and 50 bent', () => {
    const { p, clip } = make({ bend: { angle: 90 } });
    const rig = projectRig(p, 1);
    const flat = make();
    expect(quadPoints(clipQuad(flat.p, flat.clip, 1, rig), 1).split(' ')).toHaveLength(4);
    expect(quadPoints(clipQuad(p, clip, 1, rig), 1).split(' ')).toHaveLength(50);
  });
});

describe('boundsMiddle', () => {
  it('is the middle of the bounds of every rectangle', () => {
    expect(boundsMiddle([])).toBeNull();
    expect(boundsMiddle([{ minX: 0, minY: 0, maxX: 100, maxY: 50 }, { minX: 300, minY: 20, maxX: 400, maxY: 250 }])).toEqual({ x: 200, y: 125 });
  });
});

describe('groupStep', () => {
  it('scales a position away from the middle', () => {
    const d = groupStep(300, 100, 200, 100, 2, 0);
    expect(d.dx).toBeCloseTo(100);
    expect(d.dy).toBeCloseTo(0);
    expect(groupStep(200, 100, 200, 100, 3, 45)).toEqual({ dx: 0, dy: 0 });
  });
  it('turns a position clockwise around the middle (y down, like a clip rotation)', () => {
    // right of the middle, a quarter turn clockwise ends below it
    const d = groupStep(300, 100, 200, 100, 1, 90);
    expect(300 + d.dx).toBeCloseTo(200);
    expect(100 + d.dy).toBeCloseTo(200);
  });
  it('a turned group keeps its picture together: the step matches the turn of the clip box around the middle', () => {
    // a clip whose box middle sits at its position: after the step, a point of its box lands where turning that point would
    const d = groupStep(250, 160, 200, 100, 1.5, 30);
    const a = (30 * Math.PI) / 180;
    const vx = (250 - 200) * 1.5;
    const vy = (160 - 100) * 1.5;
    expect(250 + d.dx).toBeCloseTo(200 + vx * Math.cos(a) - vy * Math.sin(a));
    expect(160 + d.dy).toBeCloseTo(100 + vx * Math.sin(a) + vy * Math.cos(a));
  });
});

describe('snapAxisTo', () => {
  const lines = snapLines(1000, [{ lo: 600, hi: 800 }]);
  it('lines are the canvas middle and edges, then each box low, middle, high', () => {
    expect(lines).toEqual([500, 0, 1000, 600, 700, 800]);
  });
  it('snaps an edge or the middle of the span to another clip', () => {
    // the right edge (390 + 205 = 595) lands on the other clip's left edge
    expect(snapAxisTo(390, 205, lines, 6)).toEqual({ adj: 5, at: 600 });
    // the middle lands on the other clip's middle
    expect(snapAxisTo(703, 20, lines, 6)).toEqual({ adj: -3, at: 700 });
    // the left edge on its right edge
    expect(snapAxisTo(822, 20, lines, 6)).toEqual({ adj: -2, at: 800 });
  });
  it('the closest wins and nothing beyond the threshold', () => {
    expect(snapAxisTo(504, 300, lines, 6)).toEqual({ adj: -4, at: 500 });
    expect(snapAxisTo(350, 20, lines, 6)).toBeNull();
  });
});
