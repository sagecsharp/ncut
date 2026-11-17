import { describe, expect, it } from 'vitest';
import { DEFAULT_CAMERA, cameraRig, type Camera3D } from './camera';
import { DEG, mul, rotationY, scaling, translation, type Mat4 } from './math';
import { planeBend } from './bend';
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

describe('paintOrder with the new solids', () => {
  const r = rig({ pan: 20 });
  it('treats cone, pyramid and torus like the other solids', () => {
    // a solid is never judged by one plane: it is flat = false, so its 8 box corners count
    for (const shape of ['box', 'cone', 'pyramid', 'torus'] as const) {
      const wall = plane(0, 0, 400, 3000, 600, 0);
      const far = { ...plane(600, 0, 900, 200, 200, 0), shape };
      expect(paintOrder([wall, far], r.viewProj, r.eye), shape).toEqual([1, 0]);
      const near = { ...plane(0, 0, -300, 200, 200, 0), shape };
      expect(paintOrder([wall, near], r.viewProj, r.eye), shape).toEqual([0, 1]);
    }
  });
  it('an unknown shape id orders like a plane', () => {
    const s = rig();
    const a = plane(0, 0, 0, 1920, 1080);
    const unknown = { ...plane(700, 300, 0), shape: 'hexagon' as never };
    // same plane as the lower layer: layer order wins, which only a flat item gets
    expect(paintOrder([a, unknown], s.viewProj, s.eye)).toEqual([0, 1]);
    expect(paintOrder([unknown, a], s.viewProj, s.eye)).toEqual([0, 1]);
  });
  it('returns every index once with all shapes mixed', () => {
    const shapes = ['plane', 'box', 'sphere', 'cylinder', 'cone', 'pyramid', 'torus'] as const;
    const items = shapes.map((shape, i) => ({ ...plane(i * 100 - 300, 0, i * 50 - 150, 200, 200, i * 10), shape }));
    expect([...paintOrder(items, r.viewProj, r.eye)].sort()).toEqual(items.map((_, i) => i).sort());
  });
});

describe('paintOrder with bent planes', () => {
  /** a bent card: a plane of 400 x 300 at the canvas middle, bent along its width by `angle` degrees */
  function card(angle: number, z = 0, x = 0): { model: Mat4; bend: { box: Float32Array } } {
    const b = planeBend({ angle }, 400, 400)!;
    return { model: plane(x, 0, z, 400, 300).model, bend: { box: b.box } };
  }

  it('a bent card over a flat video in the same plane paints after it', () => {
    const r = rig();
    // the card is the lower layer, bent toward the viewer: it is wholly in front of the video plane
    const items = [card(90), plane(0, 0, 0, 1920, 1080)];
    expect(paintOrder(items, r.viewProj, r.eye)).toEqual([1, 0]);
  });

  it('a card bent away paints before the flat video', () => {
    const r = rig();
    const items = [plane(0, 0, 0, 1920, 1080), card(-90)];
    expect(paintOrder(items, r.viewProj, r.eye)).toEqual([1, 0]);
  });

  it('two cards of one bent row in one plane sort by depth, not by layer', () => {
    const r = rig();
    // both on one tube at z 0: the one at x 600 sits round the far side of the tube
    const far = { model: plane(600, 0, 0, 400, 400).model, bend: { box: planeBend({ angle: 90, span: 1600, center: -600 / 1600 }, 400, 400)!.box } };
    const mid = { model: plane(0, 0, 0, 400, 400).model, bend: { box: planeBend({ angle: 90, span: 1600 }, 400, 400)!.box } };
    expect(paintOrder([far, mid], r.viewProj, r.eye)).toEqual([1, 0]);
    expect(paintOrder([mid, far], r.viewProj, r.eye)).toEqual([0, 1]);
  });

  it('a slightly bent card keeps its layer over a flat video when the camera pans', () => {
    for (const pan of [15, 40]) {
      for (const angle of [0.05, 0.4, 1, -0.2]) {
        const r = rig({ pan, x: pan * 10 });
        const b = planeBend({ angle }, 400, 400)!;
        const video = plane(0, 0, 0, 1920, 1080);
        const c = { model: plane(800, 0, 0, 400, 300).model, bend: { box: b.box } };
        expect(paintOrder([video, c], r.viewProj, r.eye), `pan ${pan} angle ${angle}`).toEqual([0, 1]);
      }
    }
  });

  it('a bent plane with no bend or a flat one still sorts like a plane', () => {
    const r = rig();
    const items = [{ ...plane(0, 0, 0, 1920, 1080), bend: null }, { ...plane(700, 300, 0), bend: null }];
    expect(paintOrder(items, r.viewProj, r.eye)).toEqual([0, 1]);
  });
});
