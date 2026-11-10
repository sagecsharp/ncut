import { describe, expect, it } from 'vitest';
import { CAMERA_MOVES, cameraMove, moveProps } from './cameraMoves';
import type { CameraValues } from './cameraMoves';

const home: CameraValues = { x: 0, y: 0, z: 0, pan: 0, tilt: 0, roll: 0, fov: 50 };

describe('camera moves', () => {
  it('push in moves z forward from the current value', () => {
    const keys = cameraMove('pushIn', { ...home, z: 100 }, 4, 30);
    expect(keys.map((k) => [k.prop, k.t])).toEqual([['z', 0], ['z', 4]]);
    expect(keys[0]!.v).toBe(100);
    expect(keys[1]!.v).toBeGreaterThan(100);
  });
  it('pull out and push in are opposite', () => {
    const a = cameraMove('pushIn', home, 2, 30)[1]!.v;
    const b = cameraMove('pullOut', home, 2, 30)[1]!.v;
    expect(a).toBe(-b);
  });
  it('pan left and right turn opposite ways', () => {
    expect(cameraMove('panLeft', home, 2, 30)[1]!.v).toBeLessThan(0);
    expect(cameraMove('panRight', home, 2, 30)[1]!.v).toBeGreaterThan(0);
  });
  it('rise goes up (negative y)', () => {
    expect(cameraMove('rise', home, 2, 30)[1]!.v).toBeLessThan(0);
  });
  it('orbit writes x and pan', () => {
    const keys = cameraMove('orbitLeft', home, 2, 30);
    expect(moveProps(keys).sort()).toEqual(['pan', 'x']);
  });
  it('dolly zoom widens the view while z moves in', () => {
    const keys = cameraMove('dollyZoom', home, 2, 30);
    const z = keys.filter((k) => k.prop === 'z');
    const fov = keys.filter((k) => k.prop === 'fov');
    expect(z[1]!.v).toBeGreaterThan(z[0]!.v);
    expect(fov[1]!.v).toBeGreaterThan(fov[0]!.v);
    expect(fov[1]!.v).toBeLessThanOrEqual(150);
  });
  it('every move is empty for a zero length clip', () => {
    for (const m of CAMERA_MOVES) expect(cameraMove(m.id, home, 0, 30)).toEqual([]);
  });
  it('handheld is deterministic, keeps its ends and stays small', () => {
    const a = cameraMove('handheld', home, 5, 30);
    const b = cameraMove('handheld', home, 5, 30);
    expect(a).toEqual(b);
    const xs = a.filter((k) => k.prop === 'x');
    expect(xs.length).toBeGreaterThan(3);
    expect(xs[0]!.v).toBe(0);
    expect(xs[xs.length - 1]!.v).toBe(0);
    expect(xs[xs.length - 1]!.t).toBe(5);
    for (const k of a) expect(Math.abs(k.v)).toBeLessThanOrEqual(6);
    const ts = xs.map((k) => k.t);
    expect([...ts].sort((p, q) => p - q)).toEqual(ts);
    expect(new Set(ts).size).toBe(ts.length);
  });
  it('handheld on a short clip still has both ends', () => {
    const xs = cameraMove('handheld', home, 0.2, 30).filter((k) => k.prop === 'x');
    expect(xs.map((k) => k.t)).toEqual([0, 0.2]);
  });
});
