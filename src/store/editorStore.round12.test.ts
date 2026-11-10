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
  const p = createProject('r12');
  ed().openProject({ ...p, assets: [asset('img1')], clips: [] });
  for (let i = 0; i < extraTracks; i++) ed().addTrack('video');
  const ids = proj().tracks.map((t) => t.id);
  useEditor.setState({ project: { ...proj(), clips: make(ids) }, past: [], future: [] });
  return ids;
}

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
});

describe('split re-points dependents that start after the cut', () => {
  const scene = (t: string[]) => [
    image(t[0]!, 'v', 0, 10),
    image(t[1]!, 'txt', 6, 3, { parent: 'v', lookTarget: 'v' }),
    cam(t[2]!, 'cam', 'v', 7, 2),
    fx(t[3]!, 'e', 'v', 6, 3),
  ];
  it('moves parent, look target, camera target and effect target to the right half', () => {
    open(scene);
    const [right] = ed().splitClips(5, ['v']);
    expect(right).toBeTruthy();
    expect(clipOf<ImageClip>('txt').parent).toBe(right);
    expect(clipOf<ImageClip>('txt').lookTarget).toBe(right);
    expect(clipOf<CameraClip>('cam').target).toBe(right);
    expect(clipOf<EffectClip>('e').target).toBe(right);
    expect(proj().clips).toHaveLength(5);
  });
  it('keeps a dependent that ends before the cut on the left half', () => {
    open((t) => [image(t[0]!, 'v', 0, 10), image(t[1]!, 'early', 1, 2, { parent: 'v' }), fx(t[2]!, 'e', 'v', 0, 3)]);
    ed().splitClips(5, ['v']);
    expect(clipOf<ImageClip>('early').parent).toBe('v');
    expect(clipOf<EffectClip>('e').target).toBe('v');
  });
  it('leaves the child of a child alone', () => {
    open((t) => [image(t[0]!, 'v', 0, 10), image(t[1]!, 'a', 6, 3, { parent: 'v' }), image(t[2]!, 'b', 6, 3, { parent: 'a' })]);
    const [right] = ed().splitClips(5, ['v']);
    expect(clipOf<ImageClip>('a').parent).toBe(right);
    expect(clipOf<ImageClip>('b').parent).toBe('a');
  });
  it('a locked straddler goes to the half that covers more of it', () => {
    const t = open((t) => [image(t[0]!, 'v', 0, 10), image(t[1]!, 'lk', 4, 6, { parent: 'v' }), image(t[2]!, 'lk2', 1, 6, { parent: 'v' })]);
    useEditor.setState({ project: { ...proj(), tracks: proj().tracks.map((x) => (x.id === t[1] || x.id === t[2] ? { ...x, locked: true } : x)) } });
    const [right] = ed().splitClips(5, ['v']);
    expect(clipOf<ImageClip>('lk').parent).toBe(right);
    expect(clipOf<ImageClip>('lk2').parent).toBe('v');
  });
  it('is one undo step', () => {
    open(scene);
    ed().splitClips(5, ['v']);
    ed().undo();
    expect(clipOf<EffectClip>('e').target).toBe('v');
    expect(proj().clips).toHaveLength(4);
  });
});

describe('duplicateClips sameTime', () => {
  it('puts one copy over the original on the nearest free track above', () => {
    const t = open((t) => [image(t[2]!, 'a', 2, 3)]);
    const [id] = ed().duplicateClips(['a'], { sameTime: true });
    const c = clipOf<ImageClip>(id!);
    expect(c.start).toBe(2);
    expect(c.trackId).toBe(t[1]);
    expect(ed().selection).toEqual([id]);
  });
  it('inserts a new track right above when nothing above is free', () => {
    const t = open((t) => [image(t[0]!, 'a', 2, 3)]);
    const [id] = ed().duplicateClips(['a'], { sameTime: true });
    expect(proj().tracks).toHaveLength(t.length + 1);
    expect(proj().tracks[1]!.id).toBe(t[0]);
    expect(clipOf(id!).trackId).toBe(proj().tracks[0]!.id);
    expect(clipOf(id!).trackId).not.toBe(t[0]);
  });
  it('two clips on the same track share the track above', () => {
    const t = open((t) => [image(t[1]!, 'a', 0, 2), image(t[1]!, 'b', 3, 2)]);
    const ids = ed().duplicateClips(['a', 'b'], { sameTime: true });
    expect(ids).toHaveLength(2);
    expect(clipOf(ids[0]!).trackId).toBe(t[0]);
    expect(clipOf(ids[1]!).trackId).toBe(t[0]);
    expect(clipOf(ids[0]!).start).toBe(0);
    expect(clipOf(ids[1]!).start).toBe(3);
  });
  it('skips a busy track above', () => {
    const t = open((t) => [image(t[1]!, 'x', 0, 10), image(t[2]!, 'a', 2, 3)]);
    const [id] = ed().duplicateClips(['a'], { sameTime: true });
    expect(clipOf(id!).trackId).toBe(t[0]);
  });
  it('skips a locked track above', () => {
    const t = open((t) => [image(t[2]!, 'a', 2, 3)]);
    useEditor.setState({ project: { ...proj(), tracks: proj().tracks.map((x) => (x.id === t[1] ? { ...x, locked: true } : x)) } });
    const [id] = ed().duplicateClips(['a'], { sameTime: true });
    expect(clipOf(id!).trackId).toBe(t[0]);
  });
  it('relinks copied clips and effects', () => {
    open((t) => [image(t[3]!, 'p', 0, 4), image(t[2]!, 'kid', 0, 4, { parent: 'p' }), fx(t[1]!, 'e', 'p', 0, 4)]);
    const ids = ed().duplicateClips(['p', 'kid', 'e'], { sameTime: true });
    const byId = (orig: string) => ids.find((i) => {
      const c = clipOf(i);
      return c.name === orig;
    })!;
    expect(clipOf<ImageClip>(byId('kid')).parent).toBe(byId('p'));
    expect(clipOf<EffectClip>(byId('e')).target).toBe(byId('p'));
    expect(clipOf<ImageClip>('kid').parent).toBe('p');
  });
  it('an effect copy keeps the old target when the target was not copied', () => {
    open((t) => [image(t[3]!, 'p', 0, 4), fx(t[2]!, 'e', 'p', 0, 4)]);
    const [e2] = ed().duplicateClips(['e'], { sameTime: true });
    expect(clipOf<EffectClip>(e2!).target).toBe('p');
  });
  it('honours skipHistory inside a pushed step', () => {
    open((t) => [image(t[2]!, 'a', 2, 3)]);
    ed().pushHistory();
    const n = ed().past.length;
    ed().duplicateClips(['a'], { sameTime: true, skipHistory: true });
    expect(ed().past.length).toBe(n);
    ed().undo();
    expect(proj().clips).toHaveLength(1);
  });
  it('is one undo step and the default path is unchanged', () => {
    open((t) => [image(t[2]!, 'a', 2, 3)]);
    ed().duplicateClips(['a'], { sameTime: true });
    ed().undo();
    expect(proj().clips).toHaveLength(1);
    const [n] = ed().duplicateClips(['a']);
    expect(clipOf(n!).start).toBe(5);
    expect(clipOf(n!).trackId).toBe(clipOf('a').trackId);
  });
});
