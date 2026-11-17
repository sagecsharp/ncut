import { beforeEach, describe, expect, it } from 'vitest';
import { createProject, createShapeClip } from '../../lib/factory';
import { evalKeys } from '../../lib/anim';
import { useEditor } from '../../store/editorStore';
import type { Clip, Keyframe, Project, ShapeClip, VisualClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { bendAlone, bendTogether, matchBendKeys } from './bendActions';
import { bendMembers, bendState } from './bendGroup';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = (id: string) => proj().clips.find((c) => c.id === id) as ShapeClip;

let seq = 0;
function card(trackId: string, x: number, start = 0, over: Partial<ShapeClip> = {}): ShapeClip {
  return createShapeClip(trackId, start, { id: `bh${++seq}`, width: 100, height: 100, duration: 4, ...over, transform: { ...DEFAULT_TRANSFORM, x } });
}
function open(make: (v: string) => Clip[]): string[] {
  const p = createProject('bend');
  const clips = make(p.tracks[0]!.id);
  ed().openProject({ ...p, clips });
  return clips.map((c) => c.id);
}

/** the angle of a bend over 2 s with a custom part */
const angle = (): Keyframe[] => [
  { t: 0, v: 0, ease: 'bezier', out: { speed: 90, influence: 0.4 } },
  { t: 2, v: 90, ease: 'linear', in: { speed: 18, influence: 0.3 } },
];

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
});

describe('bend keys with handles', () => {
  it('bendAlone scales speeds with the values', () => {
    const ids = open((v) => [-400, -200, 0, 200, 400].map((x) => card(v, x)));
    bendTogether(ids, { angle: 90 }, 0, {});
    const id = ids[1]!;
    // the keys of the angle, set as a user would with the graph
    ed().setClipKeyframes(id, { ...clipOf(id).keyframes, 'bend.angle': angle() }, { skipHistory: true });
    expect(bendAlone(id, 0, {})).toBe(true);
    // 100 px of a 900 px row: the angle is 1/9 of it, in values and in speeds
    const keys = clipOf(id).keyframes!['bend.angle']!;
    expect(keys.map((q) => q.v)).toEqual([0, 10]);
    expect(keys[0]!.out!.speed).toBeCloseTo(10, 9);
    expect(keys[0]!.out!.influence).toBe(0.4);
    expect(keys[1]!.in!.speed).toBeCloseTo(2, 9);
    for (const t of [0.2, 0.7, 1.3, 1.9]) expect(evalKeys(keys, t)).toBeCloseTo(evalKeys(angle(), t) / 9, 9);
  });

  it('sameKeyList sees handles', () => {
    const ids = open((v) => [
      card(v, -100, 0, { bend: { angle: 0 }, keyframes: { 'bend.angle': angle() } }),
      // the same times, values and eases, other handles
      card(v, 100, 0, { bend: { angle: 0 }, keyframes: { 'bend.angle': angle().map((q) => (q.out ? { ...q, out: { speed: 5, influence: 0.4 } } : q)) } }),
    ]);
    expect(matchBendKeys(ids, {})).toBe(1);
    expect(clipOf(ids[1]!).keyframes!['bend.angle']).toStrictEqual(angle());
    expect(matchBendKeys(ids, {})).toBe(0);
    expect(ed().past).toHaveLength(1);
  });

  it('bendState sees a handle as keys apart', () => {
    const base = card('v', -100, 0, { bend: { angle: 0, span: 200 }, keyframes: { 'bend.angle': angle() } });
    const same = card('v', 100, 0, { bend: { angle: 0, span: 200 }, keyframes: { 'bend.angle': angle() } });
    const other = card('v', 100, 0, { bend: { angle: 0, span: 200 }, keyframes: { 'bend.angle': angle().map((q) => (q.out ? { ...q, out: { speed: 91, influence: 0.4 } } : q)) } });
    const state = (second: VisualClip) => {
      const clips = [base, second];
      return bendState(bendMembers({ ...createProject('bend'), clips }, clips, 0), clips);
    };
    expect(state(same).keysApart).toBe(false);
    expect(state(other).keysApart).toBe(true);
  });
});
