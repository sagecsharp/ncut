import { describe, expect, it } from 'vitest';
import { cameraRig } from '../../engine/scene3d/camera';
import { type Vec3, cross, dot, length, sub } from '../../engine/scene3d/math';
import { clipModelMatrix, planeCorners } from '../../engine/scene3d/model';
import { STRETCH_PROPS, axisPull, hasDepth, nearestPolyline, ownAxes, perpendicular, ringAxes, ringPoints, ringValueSign, scaleFromDrag, scaledValue, stretchesToClear } from './sceneGizmo';

const box = { cx: 500, cy: 300, width: 200, height: 100, rotation: 0 };
const eye: Vec3 = [0, 0, -1000];

describe('ring axes', () => {
  it('are the world axes for a flat clip', () => {
    const [x, y, z] = ringAxes(box, { z: 0 }, undefined, eye);
    expect(x[0]).toBeCloseTo(1);
    expect(y[1]).toBeCloseTo(1);
    expect(z[2]).toBeCloseTo(1);
  });

  it('roll follows the normal of the plane whatever its turn and tilt', () => {
    const t = { x: 0, y: 0, scale: 1, rotation: 25, opacity: 1, z: 40, rotX: 30, rotY: -50 };
    const model = clipModelMatrix({ ...box, rotation: 25 }, t, undefined, eye);
    const c = planeCorners(model);
    const n = cross(sub(c[1], c[0]), sub(c[3], c[0]));
    const len = length(n);
    const nn: Vec3 = [n[0] / len, n[1] / len, n[2] / len];
    const z = ringAxes(box, t, undefined, eye)[2];
    expect(Math.abs(dot(nn, z))).toBeCloseTo(1, 5);
  });

  it('are unit length and tilt stays perpendicular to turn', () => {
    const [x, y, z] = ringAxes(box, { z: 0, rotX: 20, rotY: 70 }, undefined, eye);
    for (const a of [x, y, z]) expect(length(a)).toBeCloseTo(1, 5);
    expect(dot(x, y)).toBeCloseTo(0, 5);
    expect(dot(x, z)).toBeCloseTo(0, 5);
  });
});

describe('ring geometry', () => {
  it('builds a closed circle around the center in the plane of the axis', () => {
    const pts = ringPoints([10, 20, 30], [0, 0, 1], 50, 16);
    expect(pts).toHaveLength(17);
    expect(pts[0]![0]).toBeCloseTo(pts[16]![0]);
    for (const p of pts) {
      expect(p[2]).toBeCloseTo(30);
      expect(Math.hypot(p[0] - 10, p[1] - 20)).toBeCloseTo(50);
    }
  });
  it('perpendicular vectors are orthonormal, also for a vertical axis', () => {
    const axes: Vec3[] = [
      [0, 1, 0],
      [1, 0, 0],
      [0.6, 0.8, 0],
    ];
    for (const a of axes) {
      const [u, v] = perpendicular(a);
      expect(dot(u, a)).toBeCloseTo(0);
      expect(dot(u, v)).toBeCloseTo(0);
      expect(length(u)).toBeCloseTo(1);
    }
  });
});

describe('ring hit testing', () => {
  // two circles of radius 50 and 80 around (100, 100), as flat arrays
  const circle = (r: number) => {
    const out: number[] = [];
    for (let i = 0; i <= 48; i++) out.push(100 + Math.cos((i / 48) * Math.PI * 2) * r, 100 + Math.sin((i / 48) * Math.PI * 2) * r);
    return out;
  };
  const rings = [circle(50), circle(80), null];
  it('hits the ring whose line is near the point', () => {
    expect(nearestPolyline(rings, 150, 100, 7)?.index).toBe(0);
    expect(nearestPolyline(rings, 100, 180, 7)?.index).toBe(1);
  });
  it('misses in the middle, outside and on hidden rings', () => {
    expect(nearestPolyline(rings, 100, 100, 7)).toBeNull();
    expect(nearestPolyline(rings, 300, 300, 7)).toBeNull();
    expect(nearestPolyline([null], 0, 0, 7)).toBeNull();
  });
  it('the closer ring wins when two are within reach', () => {
    expect(nearestPolyline(rings, 168, 100, 25)?.index).toBe(1);
    expect(nearestPolyline(rings, 140, 100, 25)?.index).toBe(0);
  });
});

describe('ring value sign', () => {
  it('roll follows the pointer clockwise when its axis points away from the viewer', () => {
    expect(ringValueSign('rotation', [0, 0, 1], [0, 0, 1])).toBe(1);
    expect(ringValueSign('rotation', [0, 0, -1], [0, 0, 1])).toBe(-1);
  });
  it('tilt and turn are stored with the opposite sign', () => {
    expect(ringValueSign('rotY', [0, 1, 0.3], [0, 0, 1])).toBe(-1);
    expect(ringValueSign('rotX', [1, 0, -0.3], [0, 0, 1])).toBe(1);
  });
  it('a ring seen from the back flips the direction', () => {
    const rig = cameraRig({ x: 0, y: 0, z: 0, pan: 180, tilt: 0, roll: 0, fov: 50 }, 1920, 1080);
    expect(ringValueSign('rotation', [0, 0, 1], rig.forward)).toBe(-1);
  });
});

describe('scale drag', () => {
  it('is the ratio of the distances, clamped', () => {
    expect(scaleFromDrag(2, 100, 150, 0.01, 100)).toBeCloseTo(3);
    expect(scaleFromDrag(2, 100, 0, 0.01, 100)).toBe(0.01);
    expect(scaleFromDrag(50, 10, 100, 0.01, 100)).toBe(100);
  });
});

describe('stretch per axis', () => {
  it('the own axes of a flat clip are the canvas axes, a roll turns x and y but not z', () => {
    const [x, y, z] = ownAxes(box, { z: 0 }, undefined, eye);
    expect(x[0]).toBeCloseTo(1);
    expect(y[1]).toBeCloseTo(1);
    expect(z[2]).toBeCloseTo(1);
    const [rx, ry, rz] = ownAxes({ ...box, rotation: 90 }, { z: 0 }, undefined, eye);
    expect(rx[1]).toBeCloseTo(1);
    expect(ry[0]).toBeCloseTo(-1);
    expect(rz[2]).toBeCloseTo(1);
  });

  it('own axes stay a unit, perpendicular basis under turn, tilt and roll', () => {
    const [x, y, z] = ownAxes({ ...box, rotation: 35 }, { z: 20, rotX: 25, rotY: -40 }, undefined, eye);
    for (const a of [x, y, z]) expect(length(a)).toBeCloseTo(1, 5);
    expect(dot(x, y)).toBeCloseTo(0, 5);
    expect(dot(x, z)).toBeCloseTo(0, 5);
    expect(dot(y, z)).toBeCloseTo(0, 5);
  });

  it('own x follows the width of the plane', () => {
    const t = { z: 0, rotY: 50 };
    const c = planeCorners(clipModelMatrix(box, { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, ...t }, undefined, eye));
    const w = sub(c[1], c[0]);
    const x = ownAxes(box, t, undefined, eye)[0];
    expect(dot(x, [w[0] / length(w), w[1] / length(w), w[2] / length(w)])).toBeCloseTo(1, 5);
  });

  it('depth only exists on a solid or on extruded 3d text', () => {
    expect(hasDepth({ type: 'image', threeD: true })).toBe(false);
    expect(hasDepth({ type: 'image', threeD: true, shape: 'plane' })).toBe(false);
    expect(hasDepth({ type: 'image', threeD: true, shape: 'box' })).toBe(true);
    expect(hasDepth({ type: 'shape', threeD: true, shape: 'sphere' })).toBe(true);
    expect(hasDepth({ type: 'image', threeD: false, shape: 'box' })).toBe(false);
    expect(hasDepth({ type: 'text', threeD: true, extrude: { depth: 0.3 } })).toBe(true);
    expect(hasDepth({ type: 'text', threeD: true, extrude: { depth: 0 } })).toBe(false);
    expect(hasDepth({ type: 'text', threeD: true, extrude: null })).toBe(false);
    expect(hasDepth({ type: 'text', threeD: false, extrude: { depth: 0.3 } })).toBe(false);
  });

  it('the props follow the axes', () => {
    expect(STRETCH_PROPS).toEqual(['scaleX', 'scaleY', 'scaleZ']);
  });

  it('the pull is the distance along the handle, signed', () => {
    // handle pointing right from (100, 100)
    expect(axisPull(100, 100, 160, 100, 200, 100)).toBeCloseTo(100);
    expect(axisPull(100, 100, 160, 100, 200, 300)).toBeCloseTo(100);
    expect(axisPull(100, 100, 160, 100, 40, 100)).toBeCloseTo(-60);
    // a diagonal handle
    expect(axisPull(0, 0, 30, 30, 50, 50)).toBeCloseTo(Math.hypot(50, 50));
    // no handle length: no pull
    expect(axisPull(5, 5, 5, 5, 50, 50)).toBe(0);
  });

  it('the value is the grab value times the ratio, clamped and rounded', () => {
    expect(scaledValue(2, 60, 90, null, 0.01, 100)).toBe(3);
    expect(scaledValue(1, 60, 20, null, 0.01, 100)).toBe(0.333);
    expect(scaledValue(1, 60, -20, null, 0.01, 100)).toBe(0.01);
    expect(scaledValue(50, 10, 1000, null, 0.01, 100)).toBe(100);
    expect(scaledValue(1, 0, 10, null, 0.01, 100)).toBe(100);
  });

  it('a typed factor takes over from the pointer, a bad one does not', () => {
    expect(scaledValue(2, 60, 600, 1.5, 0.01, 100)).toBe(3);
    expect(scaledValue(2, 60, 120, 0, 0.01, 100)).toBe(4);
    expect(scaledValue(2, 60, 120, -3, 0.01, 100)).toBe(4);
    expect(scaledValue(2, 60, 120, 1e9, 0.01, 100)).toBe(100);
  });

  it('alt + s only writes the axes that are stretched or keyed', () => {
    expect(stretchesToClear({}, undefined)).toEqual([]);
    expect(stretchesToClear({ scaleX: 1, scaleY: 1 }, {})).toEqual([]);
    expect(stretchesToClear({ scaleX: 2 }, undefined)).toEqual(['scaleX']);
    expect(stretchesToClear({ scaleX: 2, scaleZ: 0.5 }, undefined)).toEqual(['scaleX', 'scaleZ']);
    expect(stretchesToClear({ scaleY: 1 }, { scaleY: [{}, {}] })).toEqual(['scaleY']);
    expect(stretchesToClear({}, { scaleZ: [] })).toEqual([]);
  });
});
