import { describe, expect, it } from 'vitest';
import { reparentTransform } from '../../engine/parent';
import { cameraAt, cameraRig } from '../../engine/scene3d/camera';
import type { Vec3 } from '../../engine/scene3d/math';
import { createCameraClip, createProject, createShapeClip } from '../../lib/factory';
import type { Clip, Keyframes, Project, ShapeClip, Transform, VisualClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { clipSpots } from '../preview/pivotMath';
import { attachPlan } from './attachPlan';

const tf = (o: Partial<Transform> = {}): Transform => ({ ...DEFAULT_TRANSFORM, ...o });
const sh = (track: string, id: string, o: Partial<ShapeClip> = {}): ShapeClip => ({ ...createShapeClip(track, 0, { duration: 10, width: 300, height: 120 }), id, ...o });

function setup(build: (track: string) => Clip[]): Project {
  const p = createProject();
  p.clips = build(p.tracks[0]!.id);
  return p;
}

/** the project after a plan, the way attachActions writes it */
function apply(p: Project, plans: ReturnType<typeof attachPlan>): Project {
  return {
    ...p,
    clips: p.clips.map((c) => {
      const plan = plans.find((x) => x.id === c.id);
      if (!plan) return c;
      const next = { ...c, ...plan.patch } as VisualClip;
      return plan.transform ? ({ ...next, transform: { ...next.transform, ...plan.transform } } as VisualClip) : next;
    }),
  };
}
const spots = (p: Project, id: string, t: number): Vec3[] => clipSpots(p, p.clips.find((c) => c.id === id) as VisualClip, t, cameraRig(cameraAt(p, t), p.width, p.height).eye).spots;

describe('attachPlan', () => {
  it('attaching keeps the world place and keeps keys of a keyed pose', () => {
    const keys: Keyframes = {
      x: [
        { t: 0, v: 0, ease: 'linear' },
        { t: 2, v: 100, ease: 'linear' },
      ],
    };
    const p = setup((t) => [
      sh(t, 'par', { transform: tf({ x: 80, y: -30, rotation: 20, scale: 1.5 }) }),
      sh(t, 'kid', { transform: tf({ x: 200, y: 100, rotation: 33 }) }),
      sh(t, 'keyed', { keyframes: keys }),
      sh(t, 'same', { parent: 'par' }),
    ]);
    const plans = attachPlan(p, ['kid', 'keyed', 'same'], 'par', 1);
    // the clip that already hangs on it is left out
    expect(plans.map((x) => x.id)).toEqual(['kid', 'keyed']);
    const kid = plans.find((x) => x.id === 'kid')!;
    expect(kid.patch).toEqual({ parent: 'par' });
    expect(kid.transform).toEqual(reparentTransform(p, p.clips[1] as VisualClip, 'par', 1));
    expect(plans.find((x) => x.id === 'keyed')!.transform).toBeNull();
    const q = apply(p, [kid]);
    for (let i = 0; i < 9; i++) for (let k = 0; k < 3; k++) expect(spots(q, 'kid', 1)[i]![k]).toBeCloseTo(spots(p, 'kid', 1)[i]![k]!, 6);
    expect(attachPlan(p, ['kid'], 'nope', 1)).toEqual([]);
  });

  it('a 2d clip attached to a camera becomes 3d', () => {
    const p = setup((t) => [sh(t, 'a'), createCameraClip(t, 0, { id: 'cam', duration: 10 })]);
    const plans = attachPlan(p, ['a'], 'cam', 1);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.patch).toEqual({ parent: 'cam', threeD: true });
  });

  it('a pivoted clip keeps its picture when attached and detached', () => {
    const p = setup((t) => [
      sh(t, 'par', { transform: tf({ x: 120, y: 40, rotation: 35, scale: 1.3 }), pivot: { x: -0.5, y: 0.2 } }),
      sh(t, 'kid', { transform: tf({ x: -60, y: 90, rotation: 12 }), pivot: { x: 0.5, y: -0.5 } }),
    ]);
    const before = spots(p, 'kid', 1);
    const q = apply(p, attachPlan(p, ['kid'], 'par', 1));
    expect((q.clips[1] as VisualClip).parent).toBe('par');
    for (let i = 0; i < 9; i++) for (let k = 0; k < 3; k++) expect(spots(q, 'kid', 1)[i]![k]).toBeCloseTo(before[i]![k]!, 6);
    const r = apply(q, attachPlan(q, ['kid'], null, 1));
    expect((r.clips[1] as VisualClip).parent).toBeNull();
    for (let i = 0; i < 9; i++) for (let k = 0; k < 3; k++) expect(spots(r, 'kid', 1)[i]![k]).toBeCloseTo(before[i]![k]!, 6);
  });
});
