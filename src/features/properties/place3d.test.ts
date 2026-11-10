import { describe, expect, it } from 'vitest';
import { cameraRig } from '../../engine/scene3d/camera';
import type { Camera3D } from '../../engine/scene3d/camera';
import type { Vec3 } from '../../engine/scene3d/math';
import {
  axesOf,
  cameraAngles,
  depthIn,
  fitDistance,
  flatDistance,
  floorCenterY,
  frameCamera,
  frameMatrix,
  placeInFront,
  poseFromWorld,
  tiltedAxes,
  worldMatrix,
} from './place3d';
import type { PoseValues } from './place3d';

const W = 1920;
const H = 1080;
const cam = (c: Partial<Camera3D> = {}): Camera3D => ({ x: 0, y: 0, z: 0, pan: 0, tilt: 0, roll: 0, fov: 50, ...c });
const pose = (p: Partial<PoseValues> = {}): PoseValues => ({ x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotation: 0, scale: 1, ...p });
const near = (a: ArrayLike<number>, b: ArrayLike<number>, d = 4) => {
  for (let i = 0; i < b.length; i++) expect(a[i]).toBeCloseTo(b[i]!, d);
};

describe('flatDistance', () => {
  it('is the home distance at fov 50 and shrinks with a wider lens', () => {
    const rig = cameraRig(cam(), W, H);
    expect(flatDistance(50, H)).toBeCloseTo(-rig.eye[2], 3);
    expect(flatDistance(100, H)).toBeLessThan(flatDistance(50, H));
  });
});

describe('placeInFront', () => {
  it('one flat clip lands centered at the flat distance', () => {
    const rig = cameraRig(cam(), W, H);
    const [p] = placeInFront(rig, [{ center: [W / 2 + 300, H / 2 - 50, 0], keepDepth: false }], flatDistance(50, H));
    near(p!, [W / 2, H / 2, 0], 3);
  });
  it('follows a moved and turned camera', () => {
    const rig = cameraRig(cam({ x: 200, z: 100, pan: 30, tilt: -10 }), W, H);
    const d = flatDistance(50, H);
    const [p] = placeInFront(rig, [{ center: [0, 0, 0], keepDepth: false }], d);
    expect(depthIn(rig, p!)).toBeCloseTo(d, 3);
    const v = [p![0] - rig.eye[0], p![1] - rig.eye[1], p![2] - rig.eye[2]];
    expect(v[0]! * rig.right[0] + v[1]! * rig.right[1] + v[2]! * rig.right[2]).toBeCloseTo(0, 3);
    expect(v[0]! * rig.down[0] + v[1]! * rig.down[1] + v[2]! * rig.down[2]).toBeCloseTo(0, 3);
  });
  it('a 3d clip keeps its distance, one behind the camera falls back', () => {
    const rig = cameraRig(cam(), W, H);
    const a = placeInFront(rig, [{ center: [0, 0, 400], keepDepth: true }], 1000)[0]!;
    const b = placeInFront(rig, [{ center: [0, 0, -5000], keepDepth: true }], 1000)[0]!;
    expect(depthIn(rig, a)).toBeCloseTo(depthIn(rig, [0, 0, 400]), 3);
    expect(depthIn(rig, b)).toBeCloseTo(1000, 3);
  });
  it('several clips keep their offsets', () => {
    const rig = cameraRig(cam(), W, H);
    const items = [
      { center: [100, 0, 0] as Vec3, keepDepth: false },
      { center: [300, 50, 0] as Vec3, keepDepth: false },
    ];
    const out = placeInFront(rig, items, 1000);
    near([out[1]![0] - out[0]![0], out[1]![1] - out[0]![1], out[1]![2] - out[0]![2]], [200, 50, 0], 3);
    expect(placeInFront(rig, [], 1000)).toEqual([]);
  });
});

describe('frame matrices', () => {
  it('poseFromWorld inverts frameMatrix, with and without a parent', () => {
    const p = pose({ x: 30, y: -20, z: 120, rotX: 20, rotY: -35, rotation: 12, scale: 1.5 });
    const parent = frameMatrix(null, W, H, pose({ x: 100, z: 50, rotY: 40, scale: 2 }), true);
    for (const par of [null, parent]) {
      const world = frameMatrix(par, W, H, p, true);
      const back = poseFromWorld(par, W, H, world)!;
      near([back.x, back.y, back.z, back.rotX, back.rotY, back.rotation, back.scale], [p.x, p.y, p.z, p.rotX, p.rotY, p.rotation, p.scale], 3);
    }
  });
  it('facing the camera gives a pose whose axes are the camera axes', () => {
    const rig = cameraRig(cam({ pan: 25, tilt: 15, roll: 10 }), W, H);
    const world = worldMatrix([500, 400, 300], rig.right, rig.down, rig.forward, 1);
    const q = poseFromWorld(null, W, H, world)!;
    const ax = axesOf(frameMatrix(null, W, H, q, true));
    near(ax.right, rig.right, 4);
    near(ax.down, rig.down, 4);
    near(ax.normal, rig.forward, 4);
  });
  it('a degenerate parent gives null', () => {
    expect(poseFromWorld(new Float64Array(16), W, H, frameMatrix(null, W, H, pose(), true))).toBeNull();
  });
});

describe('tiltedAxes', () => {
  it('lying flat under a turned parent is flat in the world', () => {
    const parent = frameMatrix(null, W, H, pose({ rotY: 40, rotX: 25, scale: 2 }), true);
    const own = pose({ x: 10, z: 30, rotY: 15 });
    const world = frameMatrix(parent, W, H, own, true);
    const a = axesOf(world);
    const t = tiltedAxes(own, 90);
    const next = poseFromWorld(parent, W, H, worldMatrix(a.center, t.right, t.down, t.normal, 2))!;
    const back = axesOf(frameMatrix(parent, W, H, next, true));
    near(back.normal, t.normal, 4);
    // a floor card: its normal is vertical
    expect(Math.abs(back.normal[1])).toBeCloseTo(1, 4);
    near(back.center, a.center, 3);
  });
  it('standing up (tilt 0) keeps the turn and gives a vertical card', () => {
    const t = tiltedAxes(pose({ rotY: 30, rotX: 70 }), 0);
    expect(t.normal[1]).toBeCloseTo(0, 6);
    expect(t.down[1]).toBeCloseTo(1, 6);
  });
});

describe('frameCamera', () => {
  it('cameraAngles round-trips through cameraRig', () => {
    for (const c of [cam(), cam({ pan: 40, tilt: 20 }), cam({ pan: -70, tilt: -30, roll: 25 }), cam({ roll: 90 })]) {
      const rig = cameraRig(c, W, H);
      const a = cameraAngles(rig.right, rig.down, rig.forward);
      near([a.pan, a.tilt, a.roll], [c.pan, c.tilt, c.roll], 3);
    }
  });
  it('a flat box is framed from the front at 80 percent', () => {
    const v = frameCamera([W / 2, H / 2, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], W, H, 50, W, H);
    expect(v.x).toBeCloseTo(0, 6);
    expect(v.y).toBeCloseTo(0, 6);
    expect(v.pan).toBeCloseTo(0, 6);
    expect(v.tilt).toBeCloseTo(0, 6);
    expect(v.roll).toBeCloseTo(0, 6);
    expect(v.z).toBeCloseTo(-flatDistance(50, H) * (1 / 0.8 - 1), 3);
  });
  it('the box ends up at the asked share of the frame', () => {
    const v = frameCamera([700, 300, 200], [1, 0, 0], [0, 1, 0], [0, 0, 1], 400, 900, 50, W, H);
    const rig = cameraRig(cam(v), W, H);
    const dist = depthIn(rig, [700, 300, 200]);
    expect(900 / (2 * rig.tanHalf * dist)).toBeCloseTo(0.8, 4);
    expect(v.x).toBeCloseTo(700 - W / 2, 3);
    expect(v.y).toBeCloseTo(300 - H / 2, 3);
  });
  it('a wide box is limited by its width', () => {
    expect(fitDistance(4000, 100, 50, W / H)).toBeGreaterThan(fitDistance(100, 100, 50, W / H));
  });
  it('a turned clip is seen straight on', () => {
    const ax = axesOf(frameMatrix(null, W, H, pose({ rotY: 40, rotX: 10 }), true));
    const v = frameCamera(ax.center, ax.right, ax.down, ax.normal, 300, 200, 50, W, H);
    const rig = cameraRig(cam(v), W, H);
    near(rig.forward, ax.normal, 4);
    near(rig.right, ax.right, 4);
    near(rig.down, ax.down, 4);
    const dx = [ax.center[0] - rig.eye[0], ax.center[1] - rig.eye[1], ax.center[2] - rig.eye[2]];
    const len = Math.hypot(dx[0]!, dx[1]!, dx[2]!);
    near(dx.map((q) => q / len), rig.forward, 4);
  });
});

describe('floorCenterY', () => {
  it('an upright clip stands with its bottom on the frame bottom', () => {
    expect(floorCenterY(H, 300, 200, [1, 0, 0], [0, 1, 0])).toBe(H - 100);
  });
  it('a clip lying flat sits on the floor line itself', () => {
    const ax = axesOf(frameMatrix(null, W, H, pose({ rotX: 90 }), true));
    expect(floorCenterY(H, 300, 200, ax.right, ax.down)).toBeCloseTo(H, 6);
  });
  it('a solid standing upright does not sink: its thickness is horizontal', () => {
    const ax = axesOf(frameMatrix(null, W, H, pose(), true));
    expect(floorCenterY(H, 300, 200, ax.right, ax.down, 100, ax.normal)).toBeCloseTo(H - 100, 6);
  });
  it('a solid lying flat counts its thickness', () => {
    const ax = axesOf(frameMatrix(null, W, H, pose({ rotX: 90 }), true));
    expect(floorCenterY(H, 300, 200, ax.right, ax.down, 100, ax.normal)).toBeCloseTo(H - 50, 6);
  });
  it('a tilted solid adds the slanted part of its thickness', () => {
    const ax = axesOf(frameMatrix(null, W, H, pose({ rotX: 45 }), true));
    const flat = floorCenterY(H, 300, 200, ax.right, ax.down);
    const solid = floorCenterY(H, 300, 200, ax.right, ax.down, 100, ax.normal);
    expect(flat - solid).toBeCloseTo((100 * Math.SQRT1_2) / 2, 6);
  });
  it('a clip spun by 90 degrees uses its real vertical reach', () => {
    const ax = axesOf(frameMatrix(null, W, H, pose({ rotation: 90 }), true));
    expect(floorCenterY(H, 300, 200, ax.right, ax.down)).toBeCloseTo(H - 150, 6);
  });
});
