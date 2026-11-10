import { describe, expect, it } from 'vitest';
import { createCameraClip, createProject, createShapeClip } from '../lib/factory';
import type { CameraClip, Project, ShapeClip, Transform } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { clipModelMatrix } from './scene3d/model';
import { type CameraRig, cameraRig, cameraWorldMatrix, projectPoint } from './scene3d/camera';
import { mul, transformPoint, translation, type Mat4 } from './scene3d/math';
import { invertMatrix, parentModelMatrix, reparentTransform, worldDeltaToLocal, worldTransform, worldTransformOf } from './parent';

const tf = (o: Partial<Transform> = {}): Transform => ({ ...DEFAULT_TRANSFORM, ...o });

function setup(build: (track: string) => (ShapeClip | CameraClip)[]): Project {
  const p = createProject();
  const track = p.tracks[0]!.id;
  p.clips = build(track);
  return p;
}
const sh = (track: string, id: string, o: Partial<ShapeClip> = {}): ShapeClip => ({ ...createShapeClip(track, 0, { duration: 10 }), id, ...o });

function near(a: Transform, b: Transform, d = 6) {
  expect(a.x).toBeCloseTo(b.x, d);
  expect(a.y).toBeCloseTo(b.y, d);
  expect(a.scale).toBeCloseTo(b.scale, d);
  expect(a.rotation).toBeCloseTo(b.rotation, d);
}

describe('worldTransform 2d', () => {
  it('no parent: the own transform, same object when resolved', () => {
    const p = setup((t) => [sh(t, 'a', { transform: tf({ x: 5 }) })]);
    const a = p.clips[0] as ShapeClip;
    expect(worldTransformOf(p, a, 1)).toBe(a.transform);
    expect(worldTransform(p, a, 1).x).toBe(5);
  });
  it('child offset turns and scales with the parent', () => {
    const p = setup((t) => [
      sh(t, 'par', { transform: tf({ x: 100, y: 50, rotation: 90, scale: 2 }) }),
      sh(t, 'kid', { parent: 'par', transform: tf({ x: 10, y: 0, rotation: 15, scale: 0.5, opacity: 0.4 }) }),
    ]);
    const w = worldTransform(p, p.clips[1] as ShapeClip, 1);
    // (10, 0) turned 90 degrees clockwise on screen = (0, 10), times 2
    expect(w.x).toBeCloseTo(100, 6);
    expect(w.y).toBeCloseTo(70, 6);
    expect(w.rotation).toBeCloseTo(105, 6);
    expect(w.scale).toBeCloseTo(1, 6);
    expect(w.opacity).toBe(0.4);
  });
  it('a parent outside its range counts as its nearest edge', () => {
    const p = setup((t) => [
      sh(t, 'par', {
        duration: 2,
        transform: tf(),
        keyframes: {
          x: [
            { t: 0, v: 0, ease: 'linear' },
            { t: 2, v: 200, ease: 'linear' },
          ],
        },
      }),
      sh(t, 'kid', { parent: 'par', transform: tf() }),
    ]);
    const kid = p.clips[1] as ShapeClip;
    expect(worldTransform(p, kid, 1).x).toBeCloseTo(100, 3);
    expect(worldTransform(p, kid, 8).x).toBeCloseTo(200, 1);
  });
  it('a loop in the data does not hang', () => {
    const p = setup((t) => [sh(t, 'a', { parent: 'b' }), sh(t, 'b', { parent: 'a' }), sh(t, 'c', { parent: 'c' })]);
    for (const c of p.clips) expect(Number.isFinite(worldTransform(p, c as ShapeClip, 1).x)).toBe(true);
  });
  it('an unknown parent id counts as no parent', () => {
    const p = setup((t) => [sh(t, 'a', { parent: 'nope', transform: tf({ x: 3 }) })]);
    expect(worldTransform(p, p.clips[0] as ShapeClip, 1).x).toBe(3);
  });
});

describe('worldDeltaToLocal', () => {
  it('is the inverse of the parent rotation and scale', () => {
    const p = setup((t) => [sh(t, 'par', { transform: tf({ rotation: 30, scale: 2 }) }), sh(t, 'kid', { parent: 'par' })]);
    const kid = p.clips[1] as ShapeClip;
    const d = worldDeltaToLocal(p, kid, 1, 40, -25);
    const moved = { ...kid, transform: tf({ x: d.x, y: d.y }) };
    const w = worldTransform(p, moved, 1);
    expect(w.x).toBeCloseTo(40, 6);
    expect(w.y).toBeCloseTo(-25, 6);
  });
  it('no parent: unchanged. scale 0: no nan', () => {
    const p = setup((t) => [sh(t, 'par', { transform: tf({ scale: 0 }) }), sh(t, 'kid', { parent: 'par' }), sh(t, 'solo')]);
    expect(worldDeltaToLocal(p, p.clips[2] as ShapeClip, 1, 3, 4)).toEqual({ x: 3, y: 4 });
    const d = worldDeltaToLocal(p, p.clips[1] as ShapeClip, 1, 3, 4);
    expect(Number.isFinite(d.x) && Number.isFinite(d.y)).toBe(true);
  });
});

describe('reparentTransform', () => {
  const nested = () =>
    setup((t) => [
      sh(t, 'g', { transform: tf({ x: -80, y: 30, rotation: 20, scale: 1.5 }) }),
      sh(t, 'par', { parent: 'g', transform: tf({ x: 60, y: -20, rotation: -50, scale: 0.8 }) }),
      sh(t, 'kid', { transform: tf({ x: 200, y: 100, rotation: 33, scale: 1.2 }) }),
    ]);
  it('keeps the world pose when attaching to a nested parent', () => {
    const p = nested();
    const kid = p.clips[2] as ShapeClip;
    const before = worldTransform(p, kid, 2);
    const next = reparentTransform(p, kid, 'par', 2);
    const attached = { ...kid, parent: 'par', transform: next };
    p.clips = [p.clips[0]!, p.clips[1]!, attached];
    near(worldTransform(p, attached, 2), before);
  });
  it('detaching gives the world pose', () => {
    const p = nested();
    const par = p.clips[1] as ShapeClip;
    const before = worldTransform(p, par, 2);
    near(reparentTransform(p, par, null, 2), before);
  });
  it('re-attaching a child to another parent', () => {
    const p = nested();
    const kid = { ...(p.clips[2] as ShapeClip), parent: 'g' };
    p.clips = [p.clips[0]!, p.clips[1]!, kid];
    const before = worldTransform(p, kid, 2);
    const next = reparentTransform(p, kid, 'par', 2);
    const att = { ...kid, parent: 'par', transform: next };
    p.clips = [p.clips[0]!, p.clips[1]!, att];
    near(worldTransform(p, att, 2), before);
  });
  it('refuses a loop and keeps the transform', () => {
    const p = nested();
    const g = p.clips[0] as ShapeClip;
    expect(reparentTransform(p, g, 'par', 1)).toBe(g.transform);
  });
});

const homeRig = (p: Project): CameraRig => cameraRig({ x: 0, y: 0, z: 0, pan: 0, tilt: 0, roll: 0, fov: 50 }, p.width, p.height);

/** world center of a 100x100 plane of the clip, and where it lands on screen through a rig */
function centerOf(p: Project, clip: ShapeClip, time: number, rig: CameraRig = homeRig(p)) {
  const box = { cx: p.width / 2 + clip.transform.x, cy: p.height / 2 + clip.transform.y, width: 100 * clip.transform.scale, height: 100 * clip.transform.scale, rotation: clip.transform.rotation };
  const m = clipModelMatrix(box, clip.transform, clip.lookAt, rig.eye, clip.parent ? parentModelMatrix(p, clip, time) : null);
  const c = transformPoint(m, 0, 0, 0);
  return { world: [c[0], c[1], c[2]] as const, screen: projectPoint(rig, c[0], c[1], c[2], p.width, p.height) };
}
function cornerOf(p: Project, clip: ShapeClip, time: number) {
  const box = { cx: p.width / 2 + clip.transform.x, cy: p.height / 2 + clip.transform.y, width: 100 * clip.transform.scale, height: 100 * clip.transform.scale, rotation: clip.transform.rotation };
  const m = clipModelMatrix(box, clip.transform, undefined, [0, 0, 0], clip.parent ? parentModelMatrix(p, clip, time) : null);
  return transformPoint(m, 0.5, -0.5, 0);
}

describe('3d parents', () => {
  it('a 2d parent lies in the canvas plane: child offset turns with it', () => {
    const p = setup((t) => [
      sh(t, 'par', { transform: tf({ x: 100, rotation: 90 }) }),
      sh(t, 'kid', { parent: 'par', threeD: true, transform: tf({ x: 10, z: 30 }) }),
    ]);
    const w = centerOf(p, p.clips[1] as ShapeClip, 1).world;
    expect(w[0]).toBeCloseTo(p.width / 2 + 100, 3);
    expect(w[1]).toBeCloseTo(p.height / 2 + 10, 3);
    expect(w[2]).toBeCloseTo(30, 3);
  });
  it('a 3d parent turned around y moves the child in depth', () => {
    const p = setup((t) => [
      sh(t, 'par', { threeD: true, transform: tf({ rotY: 90 }) }),
      sh(t, 'kid', { parent: 'par', threeD: true, transform: tf({ x: 100 }) }),
    ]);
    const w = centerOf(p, p.clips[1] as ShapeClip, 1).world;
    expect(w[0]).toBeCloseTo(p.width / 2, 2);
    expect(Math.abs(w[2])).toBeCloseTo(100, 2);
  });
  it('parent matrix has no size: uniform scale and the canvas center only', () => {
    const p = setup((t) => [sh(t, 'par', { transform: tf({ scale: 2 }) }), sh(t, 'kid', { parent: 'par' })]);
    const m = parentModelMatrix(p, p.clips[1] as ShapeClip, 1)!;
    expect(m[0]).toBeCloseTo(2, 6);
    expect(m[5]).toBeCloseTo(2, 6);
    expect(m[10]).toBeCloseTo(2, 6);
    expect(m[12]).toBeCloseTo(p.width / 2, 3);
  });
  it('no parent gives null', () => {
    const p = setup((t) => [sh(t, 'a')]);
    expect(parentModelMatrix(p, p.clips[0] as ShapeClip, 1)).toBeNull();
  });
  it('3d reparent keeps the world pose (nested, rotated, scaled)', () => {
    const p = setup((t) => [
      sh(t, 'g', { threeD: true, transform: tf({ x: 40, y: -30, z: 120, rotX: 20, rotY: 35, rotation: 15, scale: 1.4 }) }),
      sh(t, 'par', { parent: 'g', threeD: true, transform: tf({ x: 60, z: -50, rotY: -25, rotation: 10, scale: 0.7 }) }),
      sh(t, 'kid', { threeD: true, transform: tf({ x: 200, y: 80, z: 30, rotX: -15, rotY: 40, rotation: 25, scale: 1.1 }) }),
    ]);
    const kid = p.clips[2] as ShapeClip;
    const before = centerOf(p, kid, 1).world;
    const beforeCorner = cornerOf(p, kid, 1);
    const att = { ...kid, parent: 'par', transform: reparentTransform(p, kid, 'par', 1) };
    p.clips = [p.clips[0]!, p.clips[1]!, att];
    const after = centerOf(p, att, 1).world;
    const afterCorner = cornerOf(p, att, 1);
    for (let i = 0; i < 3; i++) {
      expect(after[i]).toBeCloseTo(before[i]!, 2);
      expect(afterCorner[i]).toBeCloseTo(beforeCorner[i]!, 2);
    }
  });
  it('invertMatrix inverts and rejects singular', () => {
    const s = new Float32Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]);
    const m = mul(translation(5, 6, 7), s);
    const inv = invertMatrix(m)!;
    const id = mul(inv as unknown as Mat4, m);
    for (let i = 0; i < 16; i++) expect(id[i]).toBeCloseTo(i % 5 === 0 ? 1 : 0, 5);
    expect(invertMatrix(new Float32Array(16))).toBeNull();
  });
});

describe('camera parent', () => {
  const camClip = (t: string, o: Partial<CameraClip>): CameraClip => ({ ...createCameraClip(t, 0, { duration: 10, ...o }), id: 'cam' });
  const rigOf = (p: Project) => {
    const c = p.clips[0] as CameraClip;
    return cameraRig({ x: c.x, y: c.y, z: c.z, pan: c.pan, tilt: c.tilt, roll: c.roll, fov: c.fov }, p.width, p.height);
  };
  it('the child keeps its place on screen when the camera moves', () => {
    const poses: Partial<CameraClip>[] = [{}, { x: 150, y: -60, z: 200, pan: 20, tilt: -10, roll: 8 }, { z: -300, pan: -35, tilt: 12 }];
    const screens = poses.map((pose) => {
      const p = setup((t) => [camClip(t, pose), sh(t, 'kid', { parent: 'cam', threeD: true, transform: tf({ x: 120, y: -40, z: 250, rotY: 15 }) })]);
      const s = centerOf(p, p.clips[1] as ShapeClip, 1, rigOf(p)).screen;
      expect(s.visible).toBe(true);
      return s;
    });
    for (const s of screens) {
      expect(s.x).toBeCloseTo(screens[0]!.x, 1);
      expect(s.y).toBeCloseTo(screens[0]!.y, 1);
    }
  });
  it('at the home pose it is the plain placement', () => {
    const p = setup((t) => [camClip(t, {}), sh(t, 'kid', { parent: 'cam', threeD: true, transform: tf({ x: 50, z: 10 }) })]);
    const w = centerOf(p, p.clips[1] as ShapeClip, 1).world;
    expect(w[0]).toBeCloseTo(p.width / 2 + 50, 2);
    expect(w[1]).toBeCloseTo(p.height / 2, 2);
    expect(w[2]).toBeCloseTo(10, 2);
  });
  it('a clip under a clip under the camera follows too', () => {
    const mk = (pose: Partial<CameraClip>) =>
      setup((t) => [
        camClip(t, pose),
        sh(t, 'mid', { parent: 'cam', threeD: true, transform: tf({ x: 80, z: 100, rotY: 30 }) }),
        sh(t, 'kid', { parent: 'mid', threeD: true, transform: tf({ x: 40, y: 20 }) }),
      ]);
    const a = mk({});
    const b = mk({ x: -200, pan: 15, z: 120 });
    const sa = centerOf(a, a.clips[2] as ShapeClip, 1, rigOf(a)).screen;
    const sb = centerOf(b, b.clips[2] as ShapeClip, 1, rigOf(b)).screen;
    expect(sb.x).toBeCloseTo(sa.x, 1);
    expect(sb.y).toBeCloseTo(sa.y, 1);
  });
  it('a 2d child ignores a camera parent', () => {
    const p = setup((t) => [camClip(t, { x: 300 }), sh(t, 'kid', { parent: 'cam', transform: tf({ x: 7 }) })]);
    expect(worldTransform(p, p.clips[1] as ShapeClip, 1).x).toBe(7);
  });
  it('reparent onto a camera keeps the world pose of a 3d clip', () => {
    const p = setup((t) => [camClip(t, { x: 90, pan: 25, z: 100 }), sh(t, 'kid', { threeD: true, transform: tf({ x: 30, z: 80, rotY: 20 }) })]);
    const kid = p.clips[1] as ShapeClip;
    const before = centerOf(p, kid, 1).world;
    const att = { ...kid, parent: 'cam', transform: reparentTransform(p, kid, 'cam', 1) };
    p.clips = [p.clips[0]!, att];
    const after = centerOf(p, att, 1).world;
    for (let i = 0; i < 3; i++) expect(after[i]).toBeCloseTo(before[i]!, 2);
  });
  it('cameraWorldMatrix is the inverse of the view', () => {
    const rig = cameraRig({ x: 10, y: 20, z: 30, pan: 20, tilt: 10, roll: 5, fov: 50 }, 1920, 1080);
    const w = cameraWorldMatrix(rig);
    const id = mul(rig.view, Float32Array.from(w));
    for (let i = 0; i < 16; i++) expect(id[i]).toBeCloseTo(i % 5 === 0 ? 1 : 0, 3);
  });
});
