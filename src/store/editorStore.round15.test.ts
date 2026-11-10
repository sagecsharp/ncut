import { beforeEach, describe, expect, it } from 'vitest';
import type { CameraClip, Clip, EffectClip, ImageClip, MediaAsset, Project } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createProject } from '../lib/factory';
import { useEditor } from './editorStore';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = <T extends Clip>(id: string): T => proj().clips.find((c) => c.id === id) as T;

const asset = (id: string): MediaAsset => ({ id, name: id, kind: 'image', mime: 'image/png', size: 1, duration: 0, width: 100, height: 100, hasAudio: false, createdAt: 0 });
const image = (trackId: string, id: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const fx = (trackId: string, id: string, target: string | null, start: number, duration: number): EffectClip => ({
  id, type: 'effect', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, effect: 'shake', params: {}, amount: 1, seed: 1, target,
});
const cam = (trackId: string, id: string, target: string | null, start: number, duration: number): CameraClip =>
  ({ id, type: 'camera', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, x: 0, y: 0, z: 0, pan: 0, tilt: 0, roll: 0, fov: 50, target }) as unknown as CameraClip;

/** tracks[0] = top. returns ids top to bottom */
function open(make: (t: string[]) => Clip[], extraTracks = 3): string[] {
  const p = createProject('r15');
  ed().openProject({ ...p, assets: [asset('img1')], clips: [] });
  for (let i = 0; i < extraTracks; i++) ed().addTrack('video');
  const ids = proj().tracks.map((t) => t.id);
  useEditor.setState({ project: { ...proj(), clips: make(ids) }, past: [], future: [] });
  return ids;
}
const lock = (trackId: string, locked = true) => ed().updateTrack(trackId, { locked });

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
});

describe('ripple delete and auto-deleted effects', () => {
  it('an effect that goes with its clip does not shift later clips on its own track', () => {
    open((t) => [image(t[1]!, 'a', 0, 2), image(t[2]!, 'b', 0, 4), fx(t[0]!, 'e', 'a', 0, 3), image(t[0]!, 'later', 6, 2)]);
    ed().deleteClips(['a'], { ripple: true });
    expect(proj().clips.find((c) => c.id === 'e')).toBeUndefined();
    expect(clipOf('later').start).toBe(6);
  });
  it('the deleted clip still closes its own gap', () => {
    open((t) => [image(t[0]!, 'a', 0, 2), image(t[0]!, 'b', 2, 2), fx(t[1]!, 'e', 'a', 0, 2)]);
    ed().deleteClips(['a'], { ripple: true });
    expect(clipOf('b').start).toBe(0);
  });
  it('a clip asked for on the effect track still closes the gap there', () => {
    open((t) => [image(t[0]!, 'a', 0, 2), fx(t[1]!, 'e', 'a', 0, 2), image(t[1]!, 'later', 2, 2)]);
    ed().deleteClips(['a', 'e'], { ripple: true });
    expect(clipOf('later').start).toBe(0);
  });
});

describe('deleting a parent keeps the children where they are', () => {
  it('a child with local x 100 under a parent at x 500 stays at 600', () => {
    open((t) => [
      image(t[0]!, 'p', 0, 5, { transform: { ...DEFAULT_TRANSFORM, x: 500 } }),
      image(t[1]!, 'c', 0, 5, { parent: 'p', transform: { ...DEFAULT_TRANSFORM, x: 100 } }),
    ]);
    ed().deleteClips(['p']);
    const c = clipOf<ImageClip>('c');
    expect(c.parent).toBeNull();
    expect(c.transform.x).toBeCloseTo(600, 3);
  });
  it('follows the parent scale and rotation', () => {
    open((t) => [
      image(t[0]!, 'p', 0, 5, { transform: { ...DEFAULT_TRANSFORM, x: 0, y: 0, scale: 2, rotation: 90 } }),
      image(t[1]!, 'c', 0, 5, { parent: 'p', transform: { ...DEFAULT_TRANSFORM, x: 100, y: 0, scale: 1, rotation: 0 } }),
    ]);
    const before = clipOf<ImageClip>('c').transform;
    ed().deleteClips(['p']);
    const c = clipOf<ImageClip>('c');
    expect(c.transform.scale).toBeCloseTo(2, 3);
    expect(c.transform.rotation).toBeCloseTo(90, 3);
    expect(c.transform.x === before.x && c.transform.y === before.y).toBe(false);
    expect(Math.hypot(c.transform.x, c.transform.y)).toBeGreaterThan(0);
  });
  it('a child with a keyed pose keeps its keys and its transform, only the parent goes', () => {
    open((t) => [
      image(t[0]!, 'p', 0, 5, { transform: { ...DEFAULT_TRANSFORM, x: 500 } }),
      image(t[1]!, 'c', 0, 5, {
        parent: 'p',
        transform: { ...DEFAULT_TRANSFORM, x: 100 },
        keyframes: { x: [{ t: 0, v: 100, ease: 'linear' }, { t: 2, v: 200, ease: 'linear' }] },
      }),
    ]);
    ed().deleteClips(['p']);
    const c = clipOf<ImageClip>('c');
    expect(c.parent).toBeNull();
    expect(c.transform.x).toBe(100);
    expect(c.keyframes!.x).toHaveLength(2);
  });
  it('a child that starts after the parent ended uses the parent end', () => {
    open((t) => [
      image(t[0]!, 'p', 0, 2, { transform: { ...DEFAULT_TRANSFORM, x: 500 } }),
      image(t[1]!, 'c', 4, 2, { parent: 'p', transform: { ...DEFAULT_TRANSFORM, x: 100 } }),
    ]);
    ed().deleteClips(['p']);
    expect(clipOf<ImageClip>('c').transform.x).toBeCloseTo(600, 3);
  });
  it('removeTrack takes the same path', () => {
    const t = open((t) => [
      image(t[0]!, 'p', 0, 5, { transform: { ...DEFAULT_TRANSFORM, x: 500 } }),
      image(t[1]!, 'c', 0, 5, { parent: 'p', transform: { ...DEFAULT_TRANSFORM, x: 100 } }),
    ]);
    ed().removeTrack(t[0]!);
    expect(clipOf<ImageClip>('c').transform.x).toBeCloseTo(600, 3);
    expect(clipOf<ImageClip>('c').parent).toBeNull();
  });
  it('removeAsset takes the same path', () => {
    const base = createProject('r15');
    ed().openProject({ ...base, assets: [asset('img1'), asset('img2')], clips: [] });
    ed().addTrack('video');
    ed().addTrack('video');
    const t = proj().tracks.map((x) => x.id);
    useEditor.setState({
      project: {
        ...proj(),
        clips: [
          image(t[0]!, 'p', 0, 5, { assetId: 'img2', transform: { ...DEFAULT_TRANSFORM, x: 500 } }),
          image(t[1]!, 'c', 0, 5, { parent: 'p', transform: { ...DEFAULT_TRANSFORM, x: 100 } }),
        ],
      },
    });
    ed().removeAsset('img2');
    expect(clipOf<ImageClip>('c').transform.x).toBeCloseTo(600, 3);
    expect(clipOf<ImageClip>('c').parent).toBeNull();
  });
  it('a child of a removed camera is detached with a finite world pose', () => {
    open((t) => [
      cam(t[0]!, 'cam', null, 0, 5),
      image(t[1]!, 'c', 0, 5, { parent: 'cam', threeD: true, transform: { ...DEFAULT_TRANSFORM, x: 0, y: 0, z: 100 } }),
    ]);
    ed().deleteClips(['cam']);
    const c = clipOf<ImageClip>('c');
    expect(c.parent).toBeNull();
    expect(c.threeD).toBe(true);
    expect(Number.isFinite(c.transform.x) && Number.isFinite(c.transform.z ?? 0)).toBe(true);
  });
  it('is one undo step and undo brings the parent link back', () => {
    open((t) => [
      image(t[0]!, 'p', 0, 5, { transform: { ...DEFAULT_TRANSFORM, x: 500 } }),
      image(t[1]!, 'c', 0, 5, { parent: 'p', transform: { ...DEFAULT_TRANSFORM, x: 100 } }),
    ]);
    ed().deleteClips(['p']);
    expect(ed().past).toHaveLength(1);
    ed().undo();
    expect(clipOf<ImageClip>('c').parent).toBe('p');
    expect(clipOf<ImageClip>('c').transform.x).toBe(100);
  });
});

describe('undo / redo / rollback drop clips of locked tracks from the selection', () => {
  /** a project like the open one with the first track locked, unknown to the selection bookkeeping */
  const lockedTwin = (t: string[]): Project => ({ ...proj(), tracks: proj().tracks.map((x) => (x.id === t[0] ? { ...x, locked: true } : x)) });
  it('undo into a project where the track is locked', () => {
    const t = open((t) => [image(t[0]!, 'a', 0, 2), image(t[1]!, 'b', 0, 2)]);
    useEditor.setState({ past: [lockedTwin(t)], selection: ['a', 'b'] });
    ed().undo();
    expect(proj().tracks.find((x) => x.id === t[0])!.locked).toBe(true);
    expect(ed().selection).toEqual(['b']);
  });
  it('redo into a project where the track is locked', () => {
    const t = open((t) => [image(t[0]!, 'a', 0, 2), image(t[1]!, 'b', 0, 2)]);
    useEditor.setState({ future: [lockedTwin(t)], selection: ['a', 'b'] });
    ed().redo();
    expect(proj().tracks.find((x) => x.id === t[0])!.locked).toBe(true);
    expect(ed().selection).toEqual(['b']);
  });
  it('rollback into a project where the track is locked', () => {
    const t = open((t) => [image(t[0]!, 'a', 0, 2), image(t[1]!, 'b', 0, 2)]);
    useEditor.setState({ past: [lockedTwin(t)], selection: ['a', 'b'] });
    ed().rollback();
    expect(proj().tracks.find((x) => x.id === t[0])!.locked).toBe(true);
    expect(ed().selection).toEqual(['b']);
  });
  it('a normal undo keeps the selection it was made with', () => {
    const t = open((t) => [image(t[0]!, 'a', 0, 2), image(t[1]!, 'b', 0, 2)]);
    ed().select(['a', 'b']);
    ed().updateTrack(t[0]!, { locked: true });
    expect(ed().selection).toEqual(['b']);
    ed().undo();
    expect(ed().selection).toEqual(['a', 'b']);
  });
});

describe('duplicate keeps the effects put on the clip', () => {
  it('copies the effect, relinked to the copy, and returns only the asked ids', () => {
    open((t) => [fx(t[0]!, 'e', 'v', 0, 2), image(t[1]!, 'v', 0, 2)]);
    const ids = ed().duplicateClips(['v']);
    expect(ids).toHaveLength(1);
    expect(ed().selection).toEqual(ids);
    const effects = proj().clips.filter((c): c is EffectClip => c.type === 'effect');
    expect(effects).toHaveLength(2);
    const copy = effects.find((e) => e.id !== 'e')!;
    expect(copy.target).toBe(ids[0]);
    expect(clipOf<EffectClip>('e').target).toBe('v');
    expect(clipOf(ids[0]!).start).toBe(2);
    expect(copy.start).toBe(2);
  });
  it('is one undo step', () => {
    open((t) => [fx(t[0]!, 'e', 'v', 0, 2), image(t[1]!, 'v', 0, 2)]);
    ed().duplicateClips(['v']);
    expect(ed().past).toHaveLength(1);
    ed().undo();
    expect(proj().clips).toHaveLength(2);
  });
  it('skips effects on locked tracks and effects that are among the ids', () => {
    const t = open((t) => [fx(t[0]!, 'e', 'v', 0, 2), image(t[1]!, 'v', 0, 2), fx(t[2]!, 'e2', 'v', 0, 2)]);
    useEditor.setState({ project: { ...proj(), tracks: proj().tracks.map((x) => (x.id === t[0] ? { ...x, locked: true } : x)) } });
    const ids = ed().duplicateClips(['v', 'e2']);
    expect(ids).toHaveLength(2);
    // e (locked track) is not copied, e2 is copied once (as asked)
    expect(proj().clips.filter((c) => c.type === 'effect')).toHaveLength(3);
  });
  it('sameTime: the effect copy keeps its time on a free track above', () => {
    const t = open((t) => [fx(t[0]!, 'e', 'v', 0, 2), image(t[1]!, 'v', 0, 2)]);
    const ids = ed().duplicateClips(['v'], { sameTime: true });
    expect(ids).toHaveLength(1);
    const copyFx = proj().clips.find((c): c is EffectClip => c.type === 'effect' && c.id !== 'e')!;
    expect(copyFx.target).toBe(ids[0]);
    expect(copyFx.start).toBe(0);
    const order = proj().tracks.map((x) => x.id);
    expect(order.indexOf(copyFx.trackId)).toBeLessThan(order.indexOf(clipOf(ids[0]!).trackId));
    expect(copyFx.trackId).not.toBe(t[0]);
  });
});

describe('delete drops a transition that now plays from nothing', () => {
  const tr = { id: 'dissolve', duration: 0.5 };
  it('A | B(dissolve), delete A: B loses it', () => {
    open((t) => [image(t[0]!, 'a', 0, 2), image(t[0]!, 'b', 2, 2, { transition: tr })]);
    ed().deleteClips(['a']);
    expect(clipOf<ImageClip>('b').transition).toBeUndefined();
  });
  it('keeps it when the ripple brings another clip up against it', () => {
    open((t) => [image(t[0]!, 'z', 0, 1), image(t[0]!, 'a', 1, 2), image(t[0]!, 'b', 3, 2, { transition: tr })]);
    ed().deleteClips(['a'], { ripple: true });
    expect(clipOf<ImageClip>('b').start).toBe(1);
    expect(clipOf<ImageClip>('b').transition).toEqual(tr);
  });
  it('ripple with nothing before: the transition goes', () => {
    open((t) => [image(t[0]!, 'a', 0, 2), image(t[0]!, 'b', 2, 2, { transition: tr })]);
    ed().deleteClips(['a'], { ripple: true });
    expect(clipOf<ImageClip>('b').start).toBe(0);
    expect(clipOf<ImageClip>('b').transition).toBeUndefined();
  });
  it('leaves a clip alone when its previous neighbour stays', () => {
    open((t) => [image(t[0]!, 'a', 0, 2), image(t[0]!, 'b', 2, 2, { transition: tr }), image(t[0]!, 'c', 4, 2)]);
    ed().deleteClips(['c']);
    expect(clipOf<ImageClip>('b').transition).toEqual(tr);
  });
  it('a clip that never touched the deleted one keeps its transition', () => {
    open((t) => [image(t[0]!, 'a', 0, 2), image(t[0]!, 'b', 3, 2, { transition: tr })]);
    ed().deleteClips(['a']);
    expect(clipOf<ImageClip>('b').transition).toEqual(tr);
  });
});

describe('setClipKeyframes', () => {
  const k = (t: number, v: number) => ({ t, v, ease: 'linear' as const });
  it('replaces the record in one undo step, sorted, clamped, without junk', () => {
    open((t) => [image(t[0]!, 'a', 0, 4)]);
    ed().setClipKeyframes('a', {
      opacity: [k(2, 5), k(0, -1), k(Number.NaN, 1), { t: 1, v: Number.POSITIVE_INFINITY, ease: 'linear' }],
      x: [k(1, 10), k(0, 0)],
      nope: [k(0, 1)],
      rotation: [],
    });
    const kf = clipOf<ImageClip>('a').keyframes!;
    expect(kf.opacity).toEqual([k(0, 0), k(2, 1)]);
    expect(kf.x).toEqual([k(0, 0), k(1, 10)]);
    expect('nope' in kf).toBe(false);
    expect('rotation' in kf).toBe(false);
    expect(ed().past).toHaveLength(1);
    ed().undo();
    expect(clipOf<ImageClip>('a').keyframes).toBeUndefined();
  });
  it('a second key at the same t replaces the first', () => {
    open((t) => [image(t[0]!, 'a', 0, 4)]);
    ed().setClipKeyframes('a', { x: [k(1, 5), k(1, 7)] });
    expect(clipOf<ImageClip>('a').keyframes!.x).toEqual([k(1, 7)]);
  });
  it('is refused on a locked track', () => {
    const t = open((t) => [image(t[0]!, 'a', 0, 4)]);
    lock(t[0]!);
    const before = ed().past.length;
    ed().setClipKeyframes('a', { x: [k(0, 5)] });
    expect(clipOf<ImageClip>('a').keyframes).toBeUndefined();
    expect(ed().past).toHaveLength(before);
  });
  it('lost properties freeze at opts.time, no keys at all removes the field', () => {
    open((t) => [image(t[0]!, 'a', 0, 4, { keyframes: { x: [k(0, 0), k(2, 100)], y: [k(0, 7)] } })]);
    ed().setClipKeyframes('a', { y: [k(0, 7)] }, { time: 1 });
    const c = clipOf<ImageClip>('a');
    expect(c.transform.x).toBe(50);
    expect(Object.keys(c.keyframes!)).toEqual(['y']);
    ed().setClipKeyframes('a', {});
    expect(clipOf<ImageClip>('a').keyframes).toBeUndefined();
  });
  it('freezes at the clip start by default', () => {
    open((t) => [image(t[0]!, 'a', 1, 4, { keyframes: { x: [k(0, 20), k(2, 100)] } })]);
    ed().setClipKeyframes('a', {});
    expect(clipOf<ImageClip>('a').transform.x).toBe(20);
  });
  it('does nothing (no history) when nothing changes', () => {
    open((t) => [image(t[0]!, 'a', 0, 4, { keyframes: { x: [k(0, 0), k(1, 10)] } })]);
    ed().setClipKeyframes('a', { x: [k(0, 0), k(1, 10)] });
    expect(ed().past).toHaveLength(0);
  });
  it('effect values are clamped and unknown params dropped', () => {
    open((t) => [fx(t[0]!, 'e', null, 0, 2)]);
    ed().setClipKeyframes('e', { amount: [k(0, 3)], 'p.nothing': [k(0, 1)] });
    const c = clipOf<EffectClip>('e');
    expect(c.keyframes!.amount![0]!.v).toBe(1);
    expect('p.nothing' in c.keyframes!).toBe(false);
  });
});
