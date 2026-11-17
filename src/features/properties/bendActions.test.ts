import { beforeEach, describe, expect, it } from 'vitest';
import { createEffectClip, createProject, createShapeClip } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import type { Clip, Keyframe, Project, ShapeClip, Transform } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { bendAlone, bendEach, bendLeader, bendMates, bendTargets, bendTogether, flattenBends, matchBendKeys } from './bendActions';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = (id: string) => proj().clips.find((c) => c.id === id) as ShapeClip;
const k = (t: number, v: number): Keyframe => ({ t, v, ease: 'linear' });

let seq = 0;
function card(trackId: string, x: number, start = 0, over: Partial<ShapeClip> & { tf?: Partial<Transform> } = {}): ShapeClip {
  const { tf, ...rest } = over;
  return createShapeClip(trackId, start, { id: `ba${++seq}`, width: 100, height: 100, duration: 4, ...rest, transform: { ...DEFAULT_TRANSFORM, x, ...tf } });
}

/** a project with a track of five cards (x -400..400, 100 wide) unless made otherwise */
function open(make: (v: string, v2: string) => Clip[], lockSecond = false): string[] {
  const p = createProject('bend');
  const v = p.tracks[0]!.id;
  const v2 = 'v2';
  const tracks = [...p.tracks, { ...p.tracks[0]!, id: v2, name: 'video 2', locked: lockSecond }];
  const clips = make(v, v2);
  ed().openProject({ ...p, tracks, clips });
  return clips.map((c) => c.id);
}

const FIVE = (v: string) => [-400, -200, 0, 200, 400].map((x) => card(v, x));

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
});

describe('bendTogether', () => {
  it('bendTogether groups and fits on the first bend, in one undo step', () => {
    const ids = open(FIVE);
    const r = bendTogether(ids, { angle: 90 }, 0, {})!;
    expect(r.bent).toEqual(ids);
    expect(r.skipped).toEqual([]);
    expect(r.onePlane).toBe(true);
    expect(r.angle).toBe(90);
    const x = [-400, -200, 0, 200, 400];
    ids.forEach((id, i) => {
      const b = clipOf(id).bend!;
      expect(b.angle).toBe(90);
      expect(b.span).toBeCloseTo(900);
      expect(b.center ?? 0).toBeCloseTo(-x[i]! / 900);
    });
    const groups = new Set(ids.map((id) => clipOf(id).group));
    expect(groups.size).toBe(1);
    expect(r.group).toBe([...groups][0]);
    expect(ed().past).toHaveLength(1);
    ed().undo();
    for (const id of ids) {
      expect('bend' in clipOf(id)).toBe(false);
      expect(clipOf(id).group).toBeUndefined();
    }
  });

  it('an angle change on clips already together does not refit', () => {
    const ids = open(FIVE);
    bendTogether(ids, { angle: 90 }, 0, {});
    // a card scaled alone: a refit would make the span 1000, so no refit keeps it at 900
    ed().updateClip(ids[4]!, { transform: { ...clipOf(ids[4]!).transform, scale: 3 } });
    const before = ids.map((id) => ({ ...clipOf(id).bend! }));
    const r = bendTogether(ids, { angle: 45 }, 0, {})!;
    expect(r.angle).toBe(45);
    ids.forEach((id, i) => {
      expect(clipOf(id).bend).toEqual({ ...before[i]!, angle: 45 });
      expect(clipOf(id).bend!.span).toBeCloseTo(900);
    });
  });

  it('fit again keeps where the row is flat', () => {
    const ids = open(FIVE);
    bendTogether(ids, { angle: 90, middle: -0.5 }, 0, {});
    ed().updateClip(ids[2]!, { transform: { ...clipOf(ids[2]!).transform, x: 40 } });
    bendTogether(ids, { fit: true }, 0, {});
    // the leader sits at -400 of a 900 row: flat at -50% is -0.5 * 900 from the row middle
    const lead = clipOf(ids[0]!).bend!;
    expect(lead.center ?? 0).toBeCloseTo(-0.056, 2);
  });

  it('a group with a clip that cannot bend stays one group', () => {
    const ids = open((v) => [card(v, -100), card(v, 100), card(v, 300, 0, { threeD: true, shape: 'box' })]);
    ed().groupClips(ids);
    const g = clipOf(ids[0]!).group;
    bendTogether(ids, { angle: 90 }, 0, {});
    expect(clipOf(ids[2]!).group).toBe(g);
    expect(clipOf(ids[0]!).group).toBe(g);
  });

  it('along refits', () => {
    const ids = open(FIVE);
    bendTogether(ids, { angle: 90 }, 0, {});
    const r = bendTogether(ids, { along: 'height' }, 0, {})!;
    expect(r.along).toBe('height');
    for (const id of ids) {
      const b = clipOf(id).bend!;
      expect(b.along).toBe('height');
      // the row is one card high now
      expect(b.span).toBeCloseTo(100);
      expect(b.angle).toBe(90);
    }
  });

  it('a key at the playhead goes to every member at the same timeline time', () => {
    const ids = open((v) => [card(v, -100, 0), card(v, 100, 1)]);
    bendTogether(ids, { angle: 60, key: 'add' }, 2, {});
    expect(clipOf(ids[0]!).keyframes!['bend.angle']!.map((q) => [q.t, q.v])).toEqual([[2, 60]]);
    expect(clipOf(ids[1]!).keyframes!['bend.angle']!.map((q) => [q.t, q.v])).toEqual([[1, 60]]);
    // the same key again with 'toggle' takes it off for everyone
    bendTogether(ids, { key: 'toggle' }, 2, {});
    expect(clipOf(ids[0]!).keyframes).toBeUndefined();
    expect(clipOf(ids[1]!).keyframes).toBeUndefined();
    expect(clipOf(ids[1]!).bend!.angle).toBe(60);
  });
  it('an angle change keeps every member on one tube: the angle goes by span times scale', () => {
    // 0 leads (span 900), 1 has a longer span (a split text piece at the edge), 2 sits under a parent scaled 2 (span 450 in its own px)
    const ids = open((v) => [card(v, -100), card(v, 100), card(v, 300, 0, { parent: 'ba-par' }), card(v, 0, 0, { id: 'ba-par', tf: { scale: 2 } })]);
    const three = ids.slice(0, 3);
    ed().updateClip(three[0]!, { bend: { angle: 90, span: 900 } });
    ed().updateClip(three[1]!, { bend: { angle: 180, span: 1800 } });
    ed().updateClip(three[2]!, { bend: { angle: 90, span: 450 } });
    ed().groupClips(three);
    bendTogether(three, { angle: 60 }, 0, {});
    expect(clipOf(three[0]!).bend!.angle).toBeCloseTo(60);
    expect(clipOf(three[1]!).bend!.angle).toBeCloseTo(120);
    // the scaled parent doubles its length: same world length as the leader, so the same angle
    expect(clipOf(three[2]!).bend!.angle).toBeCloseTo(60);
    expect(clipOf(three[1]!).bend!.span).toBe(1800);
    expect(clipOf(three[2]!).bend!.span).toBe(450);
  });

  it('bendMates leaves out clips on a locked track', () => {
    const ids = open((v, v2) => [card(v, -100), card(v, 100), card(v2, 300)], false);
    bendTogether(ids, { angle: 90 }, 0, {});
    expect(bendMates(proj(), clipOf(ids[0]!)).map((c) => c.id)).toEqual([ids[1]!, ids[2]!]);
    ed().updateTrack('v2', { locked: true });
    expect(bendMates(proj(), clipOf(ids[0]!)).map((c) => c.id)).toEqual([ids[1]!]);
  });
});

describe('bendEach and bendAlone', () => {
  it('bendEach drops center and span', () => {
    const ids = open(FIVE);
    bendTogether(ids, { angle: 90 }, 0, {});
    const r = bendEach(ids, { angle: 30 }, 0, {})!;
    expect(r.group).toBeNull();
    expect(r.bent).toEqual(ids);
    for (const id of ids) expect(clipOf(id).bend).toEqual({ angle: 30 });
  });

  it('bendAlone keeps how much it bends', () => {
    const ids = open(FIVE);
    bendTogether(ids, { angle: 90 }, 0, {});
    const id = ids[1]!;
    expect(bendMates(proj(), clipOf(id)).map((c) => c.id)).toEqual(ids.filter((x) => x !== id));
    expect(bendAlone(id, 0, {})).toBe(true);
    // 100 px of a 900 px row of 90 degrees is 10 degrees over its own length
    expect(clipOf(id).bend!.angle).toBeCloseTo(10);
    expect(clipOf(id).bend!.span).toBeUndefined();
    expect(clipOf(id).bend!.center).toBeUndefined();
    expect(bendMates(proj(), clipOf(ids[0]!)).map((c) => c.id)).toEqual(ids.slice(2));
    expect(bendMates(proj(), clipOf(id))).toEqual([]);
    expect(bendAlone(id, 0, {})).toBe(false);
  });
});

describe('flattenBends and matchBendKeys', () => {
  it('flattenBends removes bends and keys', () => {
    const ids = open((v) => [card(v, -100, 0, { bend: { angle: 20 }, keyframes: { 'bend.angle': [k(0, 0), k(1, 20)], opacity: [k(0, 1), k(1, 0)] } }), card(v, 100, 0)]);
    expect(flattenBends(ids, {})).toBe(1);
    expect('bend' in clipOf(ids[0]!)).toBe(false);
    expect(clipOf(ids[0]!).keyframes).toEqual({ opacity: [k(0, 1), k(1, 0)] });
    expect(ed().past).toHaveLength(1);
    expect(flattenBends(ids, {})).toBe(0);
    expect(ed().past).toHaveLength(1);
  });

  it('matchBendKeys copies the leader keys shifted', () => {
    const ids = open((v) => [card(v, -100, 0, { bend: { angle: 0 }, keyframes: { 'bend.angle': [k(0, 0), k(1, 90)] } }), card(v, 100, 2, { bend: { angle: 0 } })]);
    expect(bendLeader(proj(), ids)!.id).toBe(ids[0]);
    expect(matchBendKeys(ids, {})).toBe(1);
    // the leader starts at 0 and the member at 2: the same timeline moments are -2 and -1 for the member
    expect(clipOf(ids[1]!).keyframes!['bend.angle']!.map((q) => [q.t, q.v])).toEqual([
      [-2, 0],
      [-1, 90],
    ]);
    expect(matchBendKeys(ids, {})).toBe(0);
  });
});

describe('skipped clips', () => {
  it('solids and locked clips are skipped with a reason', () => {
    const effect = createEffectClip('blur', 'blur', 'v', 0);
    const ids = open((v, v2) => [card(v, -100), card(v, 100), card(v, 300, 0, { threeD: true, shape: 'box' }), card(v2, 500), effect], true);
    const [a, b, solid, locked] = ids as [string, string, string, string];
    const targets = bendTargets(proj(), ids);
    expect(targets.clips.map((c) => c.id)).toEqual([a, b]);
    expect(targets.solids.map((c) => c.id)).toEqual([solid]);
    const r = bendTogether(ids, { angle: 90 }, 0, {})!;
    expect(r.bent).toEqual([a, b]);
    expect(r.skipped).toEqual([
      { id: solid, why: 'a 3d shape other than plane does not bend' },
      { id: locked, why: 'its track is locked' },
      { id: effect.id, why: 'only picture clips bend' },
    ]);
    expect('bend' in clipOf(solid)).toBe(false);
    expect('bend' in clipOf(locked)).toBe(false);
  });

  it('a locked track gives its reason', () => {
    const ids = open((v, v2) => [card(v, -100), card(v, 100), card(v2, 300)], true);
    const r = bendTogether(ids, { angle: 90 }, 0, {})!;
    expect(r.skipped).toEqual([{ id: ids[2]!, why: 'its track is locked' }]);
    expect(bendTogether([ids[0]!, ids[2]!], { angle: 90 }, 0, {})).toBeNull();
  });
});
