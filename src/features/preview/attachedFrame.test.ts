import { describe, expect, it } from 'vitest';
import { mul, normalize, rotationZ, scaling, transformPoint } from '../../engine/scene3d/math';
import type { Vec3 } from '../../engine/scene3d/math';
import type { Clip, Project, VisualClip } from '../../types';
import { localDelta3, worldVectorToFrame } from './attached';
import { asScenePlane, sceneCenter, usesParentFrame, worldCenter3d } from './overlayMath';
import { ringAxes } from './sceneGizmo';

const img = (id: string, over: Partial<VisualClip> = {}): VisualClip =>
  ({
    id,
    type: 'image',
    trackId: 't',
    start: 0,
    duration: 10,
    name: id,
    fadeIn: 0,
    fadeOut: 0,
    assetId: 'a',
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    ...over,
  }) as VisualClip;

const project = (clips: Clip[]): Project =>
  ({ width: 1000, height: 500, tracks: [{ id: 't', kind: 'video', name: 'v', locked: false, hidden: false }], clips, assets: [] }) as unknown as Project;

const close = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  for (let i = 0; i < b.length; i++) expect(a[i]).toBeCloseTo(b[i]!, 5);
};

describe('worldVectorToFrame', () => {
  it('is the vector itself for the identity', () => {
    const id = new Float32Array(16);
    id[0] = id[5] = id[10] = id[15] = 1;
    close(worldVectorToFrame(id, [3, -4, 5])!, [3, -4, 5]);
  });

  it('undoes a uniform scale', () => {
    close(worldVectorToFrame(scaling(2, 2, 2), [0, 0, 10])!, [0, 0, 5]);
  });

  it('undoes a turn around z and the scale together', () => {
    const m = mul(rotationZ(Math.PI / 2), scaling(2, 2, 2));
    // going the other way: the world vector of a local one, then back
    const local: Vec3 = [3, -7, 4];
    const w = transformPoint(m, local[0], local[1], local[2]);
    const origin = transformPoint(m, 0, 0, 0);
    close(worldVectorToFrame(m, [w[0] - origin[0], w[1] - origin[1], w[2] - origin[2]])!, local);
  });

  it('is exact for a tilted parent too', () => {
    // a quarter turn about x: local y becomes world z
    const m = new Float32Array(16);
    m[0] = 1;
    m[6] = 1; // col1 = (0, 0, 1)
    m[9] = -1; // col2 = (0, -1, 0)
    m[15] = 1;
    close(worldVectorToFrame(m, [0, 0, 3])!, [0, 3, 0]);
  });

  it('gives up on a parent scaled to nothing', () => {
    expect(worldVectorToFrame(new Float32Array(16), [1, 2, 3])).toBeNull();
  });
});

describe('localDelta3', () => {
  const parent = img('p', { transform: { x: 100, y: 50, scale: 2, rotation: 90, opacity: 1 } });
  const child = img('c', { parent: 'p', threeD: true, transform: { x: 10, y: 20, z: 7, scale: 1, rotation: 0, opacity: 1 } });
  const p = project([parent, child]);

  it('is the vector itself without a parent', () => {
    expect(localDelta3(p, parent, 0, [1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('halves a z drag under a parent scaled by two, and keeps x and y still', () => {
    close(localDelta3(p, child, 0, [0, 0, 10]), [0, 0, 5]);
  });

  it('turns a world movement into the parent frame', () => {
    // the parent turned a quarter turn clockwise on screen: its x axis points down the canvas, twice as long
    close(localDelta3(p, child, 0, [0, 20, 0]), [10, 0, 0]);
  });
});

describe('usesParentFrame / sceneCenter', () => {
  const parent = img('p', { transform: { x: 100, y: 50, scale: 2, rotation: 90, opacity: 1 } });
  const child3d = img('c', { parent: 'p', threeD: true, transform: { x: 10, y: 20, z: 7, scale: 1, rotation: 0, opacity: 1 } });
  const child2d = img('d', { parent: 'p', transform: { x: 10, y: 20, scale: 1, rotation: 0, opacity: 1 } });
  const p = project([parent, child3d, child2d]);

  it('only a real 3d clip with a parent takes the parent frame', () => {
    expect(usesParentFrame(child3d)).toBe(true);
    expect(usesParentFrame(child2d)).toBe(false);
    expect(usesParentFrame(parent)).toBe(false);
    // the scene view draws a 2d clip as a flat plane: it still is a 2d clip
    expect(usesParentFrame(asScenePlane(child2d))).toBe(false);
  });

  it('puts the center of a 3d child through the parent: offset turned, scaled, and z scaled', () => {
    // parent center (600, 300), child offset (10, 20) turned a quarter turn and doubled = (-40, 20), z 7 doubled
    close(worldCenter3d(p, child3d, 0), [560, 320, 14]);
    close(sceneCenter(p, child3d, 0)!, [560, 320, 14]);
  });

  it('keeps the flat composition for a 2d child', () => {
    const c = sceneCenter(p, child2d, 0)!;
    close(c, [560, 320, 0]);
  });
});

describe('ring axes under a parent', () => {
  const box = { cx: 500, cy: 300, width: 200, height: 100, rotation: 0 };
  const eye: Vec3 = [0, 0, -1000];

  it('follow the parent turn: the tilt ring turns around the parent x axis', () => {
    const parent = mul(rotationZ(Math.PI / 2), scaling(2, 2, 2));
    const [x, y, z] = ringAxes(box, { x: 0, y: 0, z: 0 }, undefined, eye, parent);
    const o = transformPoint(parent, 0, 0, 0);
    const px = transformPoint(parent, 1, 0, 0);
    const py = transformPoint(parent, 0, 1, 0);
    close(x, normalize([px[0] - o[0], px[1] - o[1], px[2] - o[2]]));
    close(y, normalize([py[0] - o[0], py[1] - o[1], py[2] - o[2]]));
    close(z, [0, 0, 1]);
  });

  it('are the world axes without a parent, like before', () => {
    const [x, y, z] = ringAxes(box, { z: 0 }, undefined, eye, null);
    close(x, [1, 0, 0]);
    close(y, [0, 1, 0]);
    close(z, [0, 0, 1]);
  });
});
