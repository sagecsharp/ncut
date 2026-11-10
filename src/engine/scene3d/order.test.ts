import { describe, expect, it } from 'vitest';
import { DEFAULT_CAMERA, cameraRig, type Camera3D } from './camera';
import { DEG, mul, rotationY, scaling, translation, type Mat4 } from './math';
import { paintOrder } from './order';

const W = 1920;
const H = 1080;
const rig = (o: Partial<Camera3D> = {}) => cameraRig({ ...DEFAULT_CAMERA, ...o }, W, H);

/** a flat plane of w x h centered at canvas offset (x, y) and depth z, turned by turn degrees */
function plane(x: number, y: number, z: number, w = 400, h = 300, turn = 0): { model: Mat4 } {
  return { model: mul(mul(translation(W / 2 + x, H / 2 + y, z), rotationY(turn * DEG)), scaling(w, h, 1)) };
}

describe('paintOrder', () => {
  it('keeps layer order for flat layers in one plane, straight on', () => {
    const r = rig();
    const items = [plane(0, 0, 0, 1920, 1080), plane(700, 300, 0), plane(-600, -200, 0)];
    expect(paintOrder(items, r.viewProj, r.eye)).toEqual([0, 1, 2]);
  });

  it('keeps layer order for flat layers in one plane when the camera pans', () => {
    // the off-center upper layer is farther from a panned camera than the full-frame lower layer
    for (const pan of [-40, -15, 15, 40]) {
      const r = rig({ pan, x: pan * 10 });
      const items = [plane(0, 0, 0, 1920, 1080), plane(800, 0, 0), plane(-800, 0, 0)];
      expect(paintOrder(items, r.viewProj, r.eye)).toEqual([0, 1, 2]);
    }
  });

  it('paints the farther of two parallel planes first, whatever the layer order', () => {
    const r = rig();
    expect(paintOrder([plane(0, 0, -200), plane(0, 0, 300)], r.viewProj, r.eye)).toEqual([1, 0]);
    expect(paintOrder([plane(0, 0, 300), plane(0, 0, -200)], r.viewProj, r.eye)).toEqual([0, 1]);
  });

  it('uses the planes, not the centers, for a big tilted plane behind a small near one', () => {
    const r = rig();
    // a wide plane turned so one end comes close to the camera: its center is far away, but the
    // small plane sits wholly behind it
    const wall = plane(0, 0, 400, 3000, 600, 0);
    const small = plane(600, 0, 900, 200, 200, 0);
    expect(paintOrder([wall, small], r.viewProj, r.eye)).toEqual([1, 0]);
    expect(paintOrder([small, wall], r.viewProj, r.eye)).toEqual([0, 1]);
  });

  it('falls back to view depth for planes that cut through each other', () => {
    const r = rig();
    const a = plane(0, 0, 100, 600, 600, 0);
    const b = plane(0, 0, 150, 600, 600, 80);
    const order = paintOrder([a, b], r.viewProj, r.eye);
    expect(order).toEqual([1, 0]);
  });

  it('handles solid shapes by depth and returns every index once', () => {
    const r = rig({ pan: 20 });
    const items = [
      plane(0, 0, 0, 1920, 1080),
      { ...plane(300, 0, 200), shape: 'box' as const },
      { ...plane(-300, 0, -200), shape: 'sphere' as const },
      plane(0, 200, 0),
    ];
    const order = paintOrder(items, r.viewProj, r.eye);
    expect([...order].sort()).toEqual([0, 1, 2, 3]);
    // the two flat layers in the canvas plane keep their order
    expect(order.indexOf(0)).toBeLessThan(order.indexOf(3));
  });

  it('is empty for no planes and stable for one', () => {
    const r = rig();
    expect(paintOrder([], r.viewProj, r.eye)).toEqual([]);
    expect(paintOrder([plane(0, 0, 0)], r.viewProj, r.eye)).toEqual([0]);
  });
});
