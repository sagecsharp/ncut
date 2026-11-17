import { describe, expect, it } from 'vitest';
import { cameraAt, cameraRig } from '../../engine/scene3d/camera';
import type { Vec3 } from '../../engine/scene3d/math';
import { createCameraClip, createEffectClip, createProject, createShapeClip } from '../../lib/factory';
import type { Clip, Keyframes, Pivot, Project, ShapeClip, Transform, VisualClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { clipSpots } from '../preview/pivotMath';
import { type PivotPlan, meetSpot, pivotPlan } from './pivotPlan';

const tf = (o: Partial<Transform> = {}): Transform => ({ ...DEFAULT_TRANSFORM, ...o });

/** a small deterministic random source */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function setup(build: (track: string) => Clip[]): Project {
  const p = createProject();
  p.clips = build(p.tracks[0]!.id);
  return p;
}
const sh = (track: string, id: string, o: Partial<ShapeClip> = {}): ShapeClip => ({ ...createShapeClip(track, 0, { duration: 10, width: 300, height: 120 }), id, ...o });
const eyeOf = (p: Project, t: number): Vec3 => cameraRig(cameraAt(p, t), p.width, p.height).eye;
const spotsOf = (p: Project, id: string, t: number): Vec3[] => clipSpots(p, p.clips.find((c) => c.id === id) as VisualClip, t, eyeOf(p, t)).spots;

/** add d to x / y / z of a clip: every key of a keyed property, the plain value of the others */
function shift(c: VisualClip, d: readonly number[]): VisualClip {
  const out = { ...c, transform: { ...c.transform } } as VisualClip;
  const kf: Keyframes | undefined = c.keyframes ? { ...c.keyframes } : undefined;
  (['x', 'y', 'z'] as const).forEach((prop, i) => {
    const v = d[i]!;
    if (v === 0) return;
    if (kf?.[prop]?.length) kf[prop] = kf[prop]!.map((k) => ({ ...k, v: k.v + v }));
    else (out.transform as unknown as Record<string, number>)[prop] = ((c.transform as unknown as Record<string, number | undefined>)[prop] ?? 0) + v;
  });
  if (kf) out.keyframes = kf;
  return out;
}

/** the project as the store would have it after the plan */
function applyPlan(p: Project, id: string, plan: PivotPlan): Project {
  return {
    ...p,
    clips: p.clips.map((c) => {
      const v = c as VisualClip;
      if (c.id === id) return { ...shift(v, plan.dt), pivot: plan.pivot } as VisualClip;
      const kid = plan.children.find((k) => k.id === c.id);
      return kid ? shift(v, kid.dv) : c;
    }),
  };
}

function close(a: readonly Vec3[], b: readonly Vec3[], digits: number) {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) for (let k = 0; k < 3; k++) expect(a[i]![k]).toBeCloseTo(b[i]![k]!, digits);
}

const rp = (r: () => number): Pivot => ({ x: Math.round((r() * 3 - 1.5) * 100) / 100, y: Math.round((r() * 3 - 1.5) * 100) / 100 });

describe('pivotPlan', () => {
  it('keeps the picture of a 2d clip', () => {
    const r = rng(1);
    for (let i = 0; i < 20; i++) {
      const from = i % 3 === 0 ? undefined : rp(r);
      const p = setup((t) => [sh(t, 'a', { pivot: from, transform: tf({ x: r() * 400 - 200, y: r() * 300 - 150, rotation: r() * 360 - 180, scale: 0.4 + r() * 2, scaleX: 0.5 + r(), scaleY: 0.5 + r() }) })]);
      const plan = pivotPlan(p, 'a', rp(r), 1)!;
      expect(plan).not.toBeNull();
      const q = applyPlan(p, 'a', plan);
      close(spotsOf(p, 'a', 1), spotsOf(q, 'a', 1), 6);
    }
  });

  it('keeps the picture of a 3d clip', () => {
    const r = rng(2);
    for (let i = 0; i < 20; i++) {
      const p = setup((t) => [sh(t, 'a', { threeD: true, pivot: i % 2 ? rp(r) : undefined, transform: tf({ x: r() * 200 - 100, y: r() * 200 - 100, z: r() * 400 - 200, rotation: r() * 360 - 180, rotX: r() * 120 - 60, rotY: r() * 120 - 60, scale: 0.5 + r() }) })]);
      const plan = pivotPlan(p, 'a', rp(r), 1)!;
      const q = applyPlan(p, 'a', plan);
      close(spotsOf(p, 'a', 1), spotsOf(q, 'a', 1), 3);
    }
  });

  it('keeps the picture of a clip that has a parent', () => {
    const cases: [boolean, boolean, Partial<Transform>][] = [
      [true, true, { rotX: 25, rotY: -30, rotation: 20, scale: 1.7, scaleX: 1.3 }],
      [false, false, { rotation: 40, scale: 1.4, scaleX: 0.8 }],
    ];
    for (const [pd, kd, pt] of cases) {
      const p = setup((t) => [sh(t, 'par', { threeD: pd, transform: tf({ x: 80, y: -40, ...pt }) }), sh(t, 'kid', { parent: 'par', threeD: kd, transform: tf({ x: 120, y: 60, rotation: 15, ...(kd ? { z: 50 } : {}) }) })]);
      const plan = pivotPlan(p, 'kid', { x: 0.5, y: -0.5 }, 1)!;
      expect(plan).not.toBeNull();
      close(spotsOf(p, 'kid', 1), spotsOf(applyPlan(p, 'kid', plan), 'kid', 1), 3);
    }
  });

  it('keeps the middle of a looking clip on a scaled 3d parent within 0.01 px', () => {
    const p = setup((t) => [
      sh(t, 'par', { threeD: true, transform: tf({ x: 60, y: 20, z: 100, rotY: 20, scale: 2 }) }),
      sh(t, 'kid', { parent: 'par', threeD: true, lookAt: 'camera', transform: tf({ x: 40, y: 30, z: 20 }) }),
    ]);
    const plan = pivotPlan(p, 'kid', { x: 0.4, y: 0.3 }, 1)!;
    const a = spotsOf(p, 'kid', 1)[4]!;
    const b = spotsOf(applyPlan(p, 'kid', plan), 'kid', 1)[4]!;
    expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(0.01);
  });

  it('a looking billboard keeps its middle within 5 px', () => {
    const p = setup((t) => [sh(t, 'a', { threeD: true, lookAt: 'camera', width: 300, height: 120 } as Partial<ShapeClip>)]);
    const plan = pivotPlan(p, 'a', { x: 0.5, y: 0.5 }, 1)!;
    const a = spotsOf(p, 'a', 1)[4]!;
    const b = spotsOf(applyPlan(p, 'a', plan), 'a', 1)[4]!;
    expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(5);
  });

  // a big picture can not keep its middle: the look aims from the pivot, so it turns. the plan is still finite
  it('a looking big picture never ends worse than the closed form', () => {
    const p = setup((t) => [sh(t, 'a', { threeD: true, lookAt: 'camera', width: 1920, height: 1080 } as Partial<ShapeClip>)]);
    const plan = pivotPlan(p, 'a', { x: 0.5, y: 0.5 }, 1)!;
    expect(plan).not.toBeNull();
    expect(plan.dt.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('keeps the picture of a 3d clip that looks at the camera within 0.01 px', () => {
    const r = rng(3);
    for (const look of ['camera', 'cameraY'] as const) {
      for (let i = 0; i < 8; i++) {
        const p = setup((t) => [sh(t, 'a', { threeD: true, lookAt: look, transform: tf({ x: r() * 400 - 200, y: r() * 200 - 100, z: r() * 300, rotation: r() * 60 - 30, rotX: r() * 40 - 20, rotY: r() * 40 - 20 }) })]);
        const plan = pivotPlan(p, 'a', rp(r), 1)!;
        const q = applyPlan(p, 'a', plan);
        const a = spotsOf(p, 'a', 1)[4]!;
        const b = spotsOf(q, 'a', 1)[4]!;
        expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(0.01);
      }
    }
  });

  it('keeps attached clips where they are', () => {
    const r = rng(4);
    for (const [pd, kd] of [
      [false, false],
      [true, true],
      [false, true],
      [true, false],
    ] as const) {
      for (let i = 0; i < 6; i++) {
        const turn = pd ? { rotX: r() * 60 - 30, rotY: r() * 60 - 30 } : {};
        const p = setup((t) => [
          sh(t, 'par', { threeD: pd, transform: tf({ x: r() * 200 - 100, y: r() * 100, rotation: r() * 200 - 100, scale: 0.6 + r(), ...turn }) }),
          sh(t, 'kid', { parent: 'par', threeD: kd, transform: tf({ x: r() * 300 - 150, y: r() * 200 - 100, rotation: r() * 90 }) }),
        ]);
        const plan = pivotPlan(p, 'par', rp(r), 1)!;
        expect(plan.children.map((c) => c.id)).toEqual(['kid']);
        const q = applyPlan(p, 'par', plan);
        close(spotsOf(p, 'kid', 1), spotsOf(q, 'kid', 1), 3);
        close(spotsOf(p, 'par', 1), spotsOf(q, 'par', 1), 3);
      }
    }
  });

  it('children stay on the picture at other times while the rotation is keyed', () => {
    const rot: Keyframes = {
      rotation: [
        { t: 0, v: 0, ease: 'linear' },
        { t: 4, v: 90, ease: 'linear' },
      ],
    };
    const p = setup((t) => [sh(t, 'par', { keyframes: rot, transform: tf({ x: 50, y: -20 }) }), sh(t, 'kid', { parent: 'par', transform: tf({ x: 200, y: 30 }) })]);
    const plan = pivotPlan(p, 'par', { x: -0.5, y: 0.25 }, 1)!;
    const q = applyPlan(p, 'par', plan);
    for (const t of [0, 2, 3.5]) {
      const parentShift = spotsOf(q, 'par', t)[4]!.map((v, i) => v - spotsOf(p, 'par', t)[4]![i]!);
      const kidShift = spotsOf(q, 'kid', t)[4]!.map((v, i) => v - spotsOf(p, 'kid', t)[4]![i]!);
      expect(kidShift[0]).toBeCloseTo(parentShift[0]!, 6);
      expect(kidShift[1]).toBeCloseTo(parentShift[1]!, 6);
    }
  });

  it('position keys all move by dt and rotation keys stay', () => {
    const kf: Keyframes = {
      x: [
        { t: 0, v: -100, ease: 'linear' },
        { t: 2, v: 100, ease: 'linear' },
      ],
      rotation: [
        { t: 0, v: 10, ease: 'linear' },
        { t: 2, v: 10, ease: 'linear' },
      ],
    };
    const p = setup((t) => [sh(t, 'a', { keyframes: kf, transform: tf({ rotation: 10 }) })]);
    const plan = pivotPlan(p, 'a', { x: 0.5, y: 0 }, 1)!;
    const q = applyPlan(p, 'a', plan);
    const a = q.clips[0] as ShapeClip;
    expect(a.keyframes!.x!.map((k) => k.v)).toEqual([-100 + plan.dt[0], 100 + plan.dt[0]]);
    expect(a.keyframes!.rotation).toEqual(kf.rotation);
    // only position keys: the picture is where it was at every time
    for (const t of [0, 0.5, 1, 2]) close(spotsOf(p, 'a', t), spotsOf(q, 'a', t), 6);
  });

  it('a child on a locked track is listed in locked', () => {
    const p = setup((t) => [sh(t, 'par'), sh(t, 'kid', { parent: 'par' })]);
    expect(pivotPlan(p, 'par', { x: 0.5, y: 0 }, 1)!.locked).toEqual([]);
    p.tracks[0]!.locked = true;
    const plan = pivotPlan(p, 'par', { x: 0.5, y: 0 }, 1)!;
    expect(plan.locked).toEqual(['kid']);
    expect(plan.children.map((c) => c.id)).toEqual(['kid']);
  });

  it('setting then clearing a pivot gives the start transform back', () => {
    const r = rng(5);
    for (let i = 0; i < 10; i++) {
      const start = tf({ x: r() * 200, y: r() * 200, rotation: r() * 360, scale: 0.5 + r() * 2 });
      const p = setup((t) => [sh(t, 'a', { transform: start })]);
      const q = applyPlan(p, 'a', pivotPlan(p, 'a', rp(r), 1)!);
      const plan = pivotPlan(q, 'a', null, 1)!;
      expect(plan.pivot).toBeNull();
      const back = (applyPlan(q, 'a', plan).clips[0] as ShapeClip).transform;
      expect(back.x).toBeCloseTo(start.x, 9);
      expect(back.y).toBeCloseTo(start.y, 9);
    }
  });

  it('the place under the motions is kept, not the moved one', () => {
    const base = (motion: boolean) =>
      setup((t) => [
        sh(t, 'par', { transform: tf({ x: 40, rotation: 25 }), ...(motion ? { motionIn: { id: 'slide-left', duration: 1 } } : {}) }),
        sh(t, 'kid', { parent: 'par', transform: tf({ x: 100 }) }),
      ]);
    const a = pivotPlan(base(true), 'par', { x: -0.5, y: 0 }, 0.2)!;
    const b = pivotPlan(base(false), 'par', { x: -0.5, y: 0 }, 0.2)!;
    expect(a.dt).toEqual(b.dt);
    expect(a.children).toEqual(b.children);
  });

  it('null for the same pivot, for audio and effect clips', () => {
    const p = setup((t) => [sh(t, 'a', { pivot: { x: 0.5, y: 0 } }), sh(t, 'm'), createEffectClip('blur', 'blur', t, 0, { id: 'e' }), { id: 'au', type: 'audio', trackId: t, start: 0, duration: 4 } as unknown as Clip]);
    expect(pivotPlan(p, 'a', { x: 0.5, y: 0 }, 1)).toBeNull();
    expect(pivotPlan(p, 'm', null, 1)).toBeNull();
    expect(pivotPlan(p, 'm', { x: 0, y: 0 }, 1)).toBeNull();
    expect(pivotPlan(p, 'e', { x: 0.5, y: 0 }, 1)).toBeNull();
    expect(pivotPlan(p, 'au', { x: 0.5, y: 0 }, 1)).toBeNull();
    expect(pivotPlan(p, 'nope', { x: 0.5, y: 0 }, 1)).toBeNull();
  });
});

describe('meetSpot', () => {
  it('an upper arm right of a body gets left, a forearm on its end gets left, a clock hand from the face middle gets bottom', () => {
    const body = setup((t) => [sh(t, 'body', { width: 200, height: 200 }), sh(t, 'arm', { parent: 'body', width: 300, height: 40, transform: tf({ x: 250 }) })]);
    expect(meetSpot(body, 'arm', 1)!.id).toBe('left');
    const arm = setup((t) => [
      sh(t, 'up', { width: 300, height: 40, pivot: { x: -0.5, y: 0 } }),
      sh(t, 'fore', { parent: 'up', width: 250, height: 40, transform: tf({ x: 425 }) }),
    ]);
    expect(meetSpot(arm, 'fore', 1)!.id).toBe('left');
    const clock = setup((t) => [sh(t, 'face', { kind: 'ellipse', width: 400, height: 400 }), sh(t, 'hand', { parent: 'face', width: 20, height: 180, transform: tf({ y: -90 }) })]);
    expect(meetSpot(clock, 'hand', 1)!.id).toBe('bottom');
  });

  it('meetSpot ties go to edge middles first', () => {
    // a 1 x 1 clip just right of the parent's right edge: its middle is the nearest, its left and top are within half a px
    const p = setup((t) => [sh(t, 'par', { width: 200, height: 200 }), sh(t, 'kid', { parent: 'par', width: 1, height: 1, transform: tf({ x: 100.2 }) })]);
    expect(meetSpot(p, 'kid', 1)!.id).toBe('left');
  });

  it('meetSpot is null for a camera parent and for no parent', () => {
    const p = setup((t) => [sh(t, 'a'), createCameraClip(t, 0, { id: 'cam' }), sh(t, 'b', { parent: 'cam', threeD: true })]);
    expect(meetSpot(p, 'a', 1)).toBeNull();
    expect(meetSpot(p, 'b', 1)).toBeNull();
  });

  it('the arm stays joined: for 20 rotations and scales of the upper arm the forearm position is the upper arm right end', () => {
    const r = rng(6);
    for (let i = 0; i < 20; i++) {
      const p = setup((t) => [
        sh(t, 'up', { width: 300, height: 40, pivot: { x: -0.5, y: 0 }, transform: tf({ x: r() * 200 - 100, y: r() * 200 - 100, rotation: r() * 360 - 180, scale: 0.3 + r() * 2 }) }),
        sh(t, 'fore', { parent: 'up', width: 250, height: 40, pivot: { x: -0.5, y: 0 }, transform: tf({ x: 300, rotation: r() * 90 }) }),
      ]);
      const end = spotsOf(p, 'up', 1)[5]!;
      const at = clipSpots(p, p.clips[1] as VisualClip, 1, eyeOf(p, 1)).pivot;
      expect(at[0]).toBeCloseTo(end[0], 6);
      expect(at[1]).toBeCloseTo(end[1], 6);
    }
  });
});
