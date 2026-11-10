import { describe, expect, it } from 'vitest';
import { DEFAULT_CAMERA, cameraRig, frustumCorners } from '../../engine/scene3d/camera';
import {
  GRID_HALF_LINES,
  clipSegmentNear,
  floorGrid,
  floorGridStep,
  focusFromDrag,
  focusPlanes,
  lockDelta,
  lockForKey,
  moveReadout,
  niceStep,
  nextLock,
  shouldWriteAxis,
  clipPolygonNear,
  copyReadout,
  isTypingTarget,
  parseGridOn,
  rotateReadout,
  scaleReadout,
  sectionCorners,
  signed,
} from './sceneHelpers';

describe('sectionCorners', () => {
  it('matches the engine frustum at a distance', () => {
    const rig = cameraRig({ ...DEFAULT_CAMERA, pan: 20, tilt: -10, x: 30 }, 1920, 1080);
    const a = sectionCorners(rig, 700);
    const b = frustumCorners(rig, 700);
    for (let i = 0; i < 4; i++) for (let k = 0; k < 3; k++) expect(a[i]![k]).toBeCloseTo(b[i]![k]!, 6);
  });
  it('lies on the view axis at that distance and grows with it', () => {
    const rig = cameraRig(DEFAULT_CAMERA, 1920, 1080);
    const near = sectionCorners(rig, 500);
    const far = sectionCorners(rig, 1000);
    for (const c of far) expect(c[2]! - rig.eye[2]).toBeCloseTo(1000, 6);
    expect(far[1]![0] - far[0]![0]).toBeCloseTo((near[1]![0] - near[0]![0]) * 2, 6);
  });
});

describe('focusPlanes', () => {
  it('is one plane without a sharp zone', () => {
    expect(focusPlanes({ distance: 800, range: 0 })).toEqual([{ distance: 800, kind: 'focus' }]);
  });
  it('puts the zone edges at distance +- range (a half depth)', () => {
    const p = focusPlanes({ distance: 800, range: 100 });
    expect(p.map((x) => x.distance)).toEqual([800, 700, 900]);
    expect(p.map((x) => x.kind)).toEqual(['focus', 'near', 'far']);
  });
  it('never puts the near edge behind the lens', () => {
    expect(focusPlanes({ distance: 50, range: 400 })[1]!.distance).toBe(1);
  });
});

describe('focusFromDrag', () => {
  it('adds the travel, rounds and clamps', () => {
    expect(focusFromDrag(800, 10, 60.4, 1, 5000)).toBe(850);
    expect(focusFromDrag(800, 0, -900, 1, 5000)).toBe(1);
    expect(focusFromDrag(800, 0, 99999, 1, 5000)).toBe(5000);
  });
  it('keeps the start for a bad number', () => {
    expect(focusFromDrag(800, 0, Number.NaN, 1, 5000)).toBe(800);
  });
});

describe('niceStep / floorGridStep', () => {
  it('rounds up to 1, 2 or 5 times a power of ten', () => {
    expect(niceStep(1)).toBe(1);
    expect(niceStep(1.2)).toBe(2);
    expect(niceStep(2.1)).toBe(5);
    expect(niceStep(5.1)).toBe(10);
    expect(niceStep(180)).toBe(200);
    expect(niceStep(430)).toBe(500);
    expect(niceStep(0.03)).toBe(0.05);
  });
  it('survives bad input', () => {
    expect(niceStep(0)).toBe(1);
    expect(niceStep(Number.NaN)).toBe(1);
  });
  it('grows with the orbit distance in steps of 1 / 2 / 5', () => {
    const steps = [100, 300, 1000, 3000, 10000, 40000].map(floorGridStep);
    for (let i = 1; i < steps.length; i++) expect(steps[i]!).toBeGreaterThanOrEqual(steps[i - 1]!);
    for (const s of steps) expect([1, 2, 5]).toContain(s / Math.pow(10, Math.floor(Math.log10(s))));
  });
});

describe('clipSegmentNear', () => {
  const eye: [number, number, number] = [0, 0, 0];
  const fwd: [number, number, number] = [0, 0, 1];
  it('keeps a segment that is in front', () => {
    expect(clipSegmentNear(0, 0, 5, 1, 0, 9, eye, fwd, 1)).toEqual([0, 0, 5, 1, 0, 9]);
  });
  it('drops a segment that is behind', () => {
    expect(clipSegmentNear(0, 0, -5, 1, 0, 0.5, eye, fwd, 1)).toBeNull();
  });
  it('cuts a segment at the near plane, either end', () => {
    expect(clipSegmentNear(0, 0, -3, 4, 0, 5, eye, fwd, 1)).toEqual([2, 0, 1, 4, 0, 5]);
    expect(clipSegmentNear(4, 0, 5, 0, 0, -3, eye, fwd, 1)).toEqual([4, 0, 5, 2, 0, 1]);
  });
});

describe('floorGrid', () => {
  const rig = cameraRig({ ...DEFAULT_CAMERA, y: -300, z: -2000, tilt: 20 }, 1920, 1080);
  const input = { eye: rig.eye, forward: rig.forward, targetX: 960, targetZ: 400, orbitDistance: 2000, floorY: 1080, near: rig.near };
  it('uses a step that follows the orbit distance', () => {
    expect(floorGrid(input).step).toBe(500);
    expect(floorGrid({ ...input, orbitDistance: 200 }).step).toBe(50);
  });
  it('stays under the line cap', () => {
    const g = floorGrid(input);
    expect(g.lines.length / 6).toBeLessThanOrEqual(2 * (2 * GRID_HALF_LINES + 1));
    expect(g.lines.length % 6).toBe(0);
  });
  it('lies on the floor', () => {
    const g = floorGrid(input);
    for (let i = 1; i < g.lines.length; i += 3) expect(g.lines[i]).toBe(1080);
    expect(g.axisX![1]).toBe(1080);
  });
  it('has the axis lines through the origin and leaves them out of the grid', () => {
    const g = floorGrid({ ...input, targetX: 0, targetZ: 0 });
    expect(g.axisX).not.toBeNull();
    expect(g.axisZ).not.toBeNull();
    // axis x runs along x at z = 0
    expect(g.axisX![2]).toBe(0);
    expect(g.axisX![5]).toBe(0);
    // axis z runs along z at x = 0
    expect(g.axisZ![0]).toBe(0);
    expect(g.axisZ![3]).toBe(0);
    for (let i = 0; i < g.lines.length; i += 6) {
      const alongX = g.lines[i + 2] === g.lines[i + 5];
      if (alongX) expect(g.lines[i + 2]).not.toBe(0);
      else expect(g.lines[i]).not.toBe(0);
    }
  });
  it('cuts everything at the near plane', () => {
    const g = floorGrid(input);
    for (let i = 0; i < g.lines.length; i += 3) {
      const d = (g.lines[i]! - rig.eye[0]) * rig.forward[0] + (g.lines[i + 1]! - rig.eye[1]) * rig.forward[1] + (g.lines[i + 2]! - rig.eye[2]) * rig.forward[2];
      expect(d).toBeGreaterThanOrEqual(rig.near - 1e-6);
    }
  });
});

describe('axis lock', () => {
  it('maps keys to axes', () => {
    expect(lockForKey('x')).toBe(0);
    expect(lockForKey('Y')).toBe(1);
    expect(lockForKey('z')).toBe(2);
    expect(lockForKey('a')).toBeNull();
    expect(lockForKey('Escape')).toBeNull();
  });
  it('toggles and switches', () => {
    expect(nextLock(null, 0)).toBe(0);
    expect(nextLock(0, 0)).toBeNull();
    expect(nextLock(0, 2)).toBe(2);
  });
  it('keeps only the locked axis', () => {
    expect(lockDelta([5, 6, 7], 1)).toEqual([0, 6, 0]);
    expect(lockDelta([5, 6, 7], null)).toEqual([5, 6, 7]);
  });
});

describe('readouts', () => {
  it('signs numbers', () => {
    expect(signed(240)).toBe('+240');
    expect(signed(-12.346)).toBe('-12.35');
    expect(signed(0.001)).toBe('0');
    expect(signed(-0.001)).toBe('0');
  });
  it('shows a locked move on its axis', () => {
    expect(moveReadout([240, 3, 0], 0)).toBe('x +240');
    expect(moveReadout([0, 0, -50], 2)).toBe('z -50');
  });
  it('shows every moved axis of a free move', () => {
    expect(moveReadout([240, -30, 0], null)).toBe('x +240 y -30');
    expect(moveReadout([0, 0, 0], null)).toBe('x 0');
  });
  it('shows turns and scale', () => {
    expect(rotateReadout('tilt', 15)).toBe('tilt +15deg');
    expect(rotateReadout('roll', -7.5)).toBe('roll -7.5deg');
    expect(scaleReadout(1.254)).toBe('scale 1.25x');
  });
});

describe('parseGridOn', () => {
  it('is on unless stored off', () => {
    expect(parseGridOn(null)).toBe(true);
    expect(parseGridOn('1')).toBe(true);
    expect(parseGridOn('0')).toBe(false);
  });
});

describe('clipPolygonNear', () => {
  const eye: [number, number, number] = [0, 0, 0];
  const fwd: [number, number, number] = [0, 0, 1];
  const sq = (z0: number, z1: number): Array<[number, number, number]> => [
    [-1, -1, z0],
    [1, -1, z0],
    [1, 1, z1],
    [-1, 1, z1],
  ];
  it('keeps a polygon fully in front', () => {
    expect(clipPolygonNear(sq(5, 5), eye, fwd, 1)).toHaveLength(4);
  });
  it('drops a polygon fully behind', () => {
    expect(clipPolygonNear(sq(-5, -2), eye, fwd, 1)).toHaveLength(0);
  });
  it('cuts one that crosses the near plane', () => {
    const out = clipPolygonNear(sq(-3, 5), eye, fwd, 1);
    expect(out.length).toBe(4);
    for (const p of out) expect(p[2]).toBeGreaterThanOrEqual(1 - 1e-9);
    expect(out.some((p) => Math.abs(p[2] - 1) < 1e-9)).toBe(true);
  });
});

describe('copy and typing helpers', () => {
  it('adds copy to a readout', () => expect(copyReadout('x +20')).toBe('x +20 copy'));
  it('knows text fields', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('shouldWriteAxis', () => {
  it('writes the locked axis, moved axes and axes written before', () => {
    expect(shouldWriteAxis(0, 0, 0, [false, false, false])).toBe(true);
    expect(shouldWriteAxis(1, 0, 0, [false, false, false])).toBe(false);
    expect(shouldWriteAxis(1, -1, 5, [false, false, false])).toBe(true);
    // lock pressed after y was dragged: y must go back to its grab value
    expect(shouldWriteAxis(1, 0, 0, [true, true, false])).toBe(true);
    expect(shouldWriteAxis(2, 0, 0, [true, true, false])).toBe(false);
  });
});
