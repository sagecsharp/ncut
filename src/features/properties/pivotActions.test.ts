import { beforeEach, describe, expect, it } from 'vitest';
import { cameraAt, cameraRig } from '../../engine/scene3d/camera';
import type { Vec3 } from '../../engine/scene3d/math';
import { createProject, createShapeClip } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import type { Clip, Keyframe, Project, ShapeClip, VisualClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { clipSpots } from '../preview/pivotMath';
import { pivotWhereTheyMeet, setPivot, setPivotMany } from './pivotActions';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = (id: string) => proj().clips.find((c) => c.id === id) as ShapeClip;
const k = (t: number, v: number): Keyframe => ({ t, v, ease: 'linear' });
const middle = (id: string, t: number): Vec3 => {
  const p = proj();
  const eye = cameraRig(cameraAt(p, t), p.width, p.height).eye;
  return clipSpots(p, clipOf(id) as VisualClip, t, eye).spots[4]!;
};
const near = (a: Vec3, b: Vec3) => expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(0.01);

function open(make: (track: string) => Clip[], lock = false): void {
  const p = createProject('pivot');
  const clips = make(p.tracks[0]!.id);
  ed().openProject({ ...p, clips, tracks: p.tracks.map((t) => ({ ...t, locked: lock })) });
}
const sh = (track: string, id: string, o: Partial<ShapeClip> = {}): ShapeClip => ({ ...createShapeClip(track, 0, { duration: 10, width: 300, height: 120 }), id, ...o });

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  useUi.setState({ toasts: [] });
  usePlayback.getState().seek(1);
});

describe('setPivot', () => {
  it('keeps a keyed clip in place: every x key moves by the same step, rotation stays, one undo step', () => {
    open((t) => [
      sh(t, 'a', {
        transform: { ...DEFAULT_TRANSFORM, x: 10, rotation: 30 },
        keyframes: { x: [k(0, 10), k(2, 50), k(5, -20)] },
      }),
    ]);
    const before = middle('a', 1);
    const keys0 = clipOf('a').keyframes!.x!.map((q) => q.v);
    expect(setPivot('a', { x: -0.5, y: 0 })).toBe(true);
    near(middle('a', 1), before);
    const keys1 = clipOf('a').keyframes!.x!.map((q) => q.v);
    const d = keys1[0]! - keys0[0]!;
    expect(Math.abs(d)).toBeGreaterThan(1);
    keys1.forEach((v, i) => expect(v - keys0[i]!).toBeCloseTo(d));
    expect(clipOf('a').transform.rotation).toBe(30);
    expect(ed().past).toHaveLength(1);
    ed().undo();
    expect(clipOf('a').keyframes!.x!.map((q) => q.v)).toEqual(keys0);
    expect(clipOf('a').pivot).toBeUndefined();
  });
});

describe('setPivotMany', () => {
  it('a parent and its child both stay put, in either id order, in one undo step', () => {
    for (const order of [['par', 'kid'], ['kid', 'par']]) {
      open((t) => [sh(t, 'par', { transform: { ...DEFAULT_TRANSFORM, x: 40, rotation: 20, scale: 1.5 } }), sh(t, 'kid', { parent: 'par', transform: { ...DEFAULT_TRANSFORM, x: 100, y: 30 } })]);
      const a = middle('par', 1);
      const b = middle('kid', 1);
      expect(setPivotMany(order, { id: 'left', label: 'left', x: -0.5, y: 0 } as never)).toBe(2);
      near(middle('par', 1), a);
      near(middle('kid', 1), b);
      expect(ed().past).toHaveLength(1);
    }
  });

  it('a clip on a locked track is counted in a toast, nothing changes', () => {
    open((t) => [sh(t, 'a')], true);
    expect(setPivotMany(['a'], { id: 'left', label: 'left', x: -0.5, y: 0 } as never)).toBe(0);
    expect(useUi.getState().toasts.some((x) => x.message === '1 clip is on a locked track')).toBe(true);
  });

  it('a child on a locked track stops the plan and says so', () => {
    const p = createProject('pivot');
    const t = p.tracks[0]!.id;
    ed().openProject({ ...p, tracks: [...p.tracks, { ...p.tracks[0]!, id: 'v2', locked: true }], clips: [sh(t, 'par'), { ...sh('v2', 'kid'), parent: 'par' } as ShapeClip] });
    expect(setPivotMany(['par'], { id: 'left', label: 'left', x: -0.5, y: 0 } as never)).toBe(0);
    expect(useUi.getState().toasts.length).toBeGreaterThan(0);
    expect(clipOf('par').pivot).toBeUndefined();
  });
});

describe('pivotWhereTheyMeet', () => {
  it('says the track is locked instead of doing nothing', () => {
    open((t) => [sh(t, 'par'), sh(t, 'kid', { parent: 'par', transform: { ...DEFAULT_TRANSFORM, x: 200 } })], true);
    expect(pivotWhereTheyMeet('kid')).toBe(false);
    expect(useUi.getState().toasts.some((x) => x.message === 'this track is locked')).toBe(true);
  });
});
