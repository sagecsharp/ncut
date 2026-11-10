import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioClip, Clip, EffectClip, ImageClip, MediaAsset, Project } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import { MAX_REPEAT } from './repeat';
import { repeatClip } from './repeatActions';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = <T extends Clip>(id: string): T => proj().clips.find((c) => c.id === id) as T;
const lastToast = (): string => useUi.getState().toasts.at(-1)?.message ?? '';
const layerOf = (id: string): number => proj().tracks.findIndex((t) => t.id === clipOf(id).trackId);

const asset = (id: string): MediaAsset => ({ id, name: id, kind: 'image', mime: 'image/png', size: 1, duration: 0, width: 100, height: 100, hasAudio: false, createdAt: 0 });
const image = (trackId: string, id: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const fx = (trackId: string, id: string, target: string | null, start: number, duration: number): EffectClip => ({
  id, type: 'effect', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, effect: 'shake', params: {}, amount: 1, seed: 1, target,
});

/** ids top to bottom: t[0..1] video tracks, then video 1, then audio 1 */
function open(make: (t: string[]) => Clip[]): string[] {
  const p = createProject('r17');
  ed().openProject({ ...p, assets: [asset('img1')], clips: [] });
  for (let i = 0; i < 2; i++) ed().addTrack('video');
  const ids = proj().tracks.map((t) => t.id);
  useEditor.setState({ project: { ...proj(), clips: make(ids) }, past: [], future: [] });
  return ids;
}

function oneStep(run: () => string[]): string[] {
  const before = proj();
  const ids = run();
  const after = proj();
  expect(ed().past.length).toBe(1);
  ed().undo();
  expect(proj()).toEqual(before);
  ed().redo();
  expect(proj()).toEqual(after);
  return ids;
}

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  useUi.setState({ toasts: [] });
});

describe('repeatClip', () => {
  it('copies lie below the original, copy 1 right under it, each on a track of its own', () => {
    open((t) => [image(t[0]!, 'a', 0, 2)]);
    const tracks = proj().tracks.length;
    const ids = oneStep(() => repeatClip('a', { count: 4, dx: 100 }));
    expect(ids).toHaveLength(3);
    expect(proj().tracks).toHaveLength(tracks + 3);
    const layers = [layerOf('a'), ...ids.map(layerOf)];
    expect(layers).toEqual([0, 1, 2, 3]);
    expect(ids.map((id) => clipOf<ImageClip>(id).transform.x)).toEqual([100, 200, 300]);
    expect(ids.every((id) => clipOf(id).start === 0)).toBe(true);
    expect(ed().selection).toEqual(['a', ...ids]);
    expect(lastToast()).toBe('3 copies');
  });

  it('original and copies end up in one group', () => {
    open((t) => [image(t[0]!, 'a', 0, 2)]);
    const ids = repeatClip('a', { count: 3 });
    const g = clipOf('a').group;
    expect(g).toBeTruthy();
    expect(ids.every((id) => clipOf(id).group === g)).toBe(true);
  });

  it('a delay as long as the clip: all copies share the original track', () => {
    open((t) => [image(t[0]!, 'a', 1, 2)]);
    const tracks = proj().tracks.length;
    const ids = oneStep(() => repeatClip('a', { count: 3, delay: 2 }));
    expect(proj().tracks).toHaveLength(tracks);
    expect(ids.map((id) => clipOf(id).start)).toEqual([3, 5]);
    expect(ids.every((id) => clipOf(id).trackId === clipOf('a').trackId)).toBe(true);
  });

  it('a delay as long as the clip, but the track is not free: one new track right under it', () => {
    open((t) => [image(t[0]!, 'a', 0, 2), image(t[0]!, 'blocker', 2, 2)]);
    const tracks = proj().tracks.length;
    const ids = oneStep(() => repeatClip('a', { count: 3, delay: 2 }));
    expect(proj().tracks).toHaveLength(tracks + 1);
    expect(new Set(ids.map((id) => clipOf(id).trackId)).size).toBe(1);
    expect(layerOf(ids[0]!)).toBe(1);
    expect(clipOf('blocker').start).toBe(2);
  });

  it('a shorter delay overlaps in time, so every copy gets its own track', () => {
    open((t) => [image(t[0]!, 'a', 0, 2)]);
    const ids = repeatClip('a', { count: 3, delay: 1 });
    expect(new Set(ids.map((id) => clipOf(id).trackId)).size).toBe(2);
    expect(ids.map((id) => clipOf(id).start)).toEqual([1, 2]);
  });

  it('the delay sits on the frame grid, at least one frame', () => {
    open((t) => [image(t[0]!, 'a', 0, 2)]);
    const ids = repeatClip('a', { count: 3, delay: 0.001 });
    expect(clipOf(ids[0]!).start).toBeCloseTo(1 / 30, 6);
    expect(clipOf(ids[1]!).start).toBeCloseTo(2 / 30, 6);
  });

  it('a grouped original: the group keeps its mates and the copies join them', () => {
    open((t) => [image(t[0]!, 'a', 0, 2, { group: 'g1' }), image(t[1]!, 'mate', 0, 2, { group: 'g1' })]);
    const ids = repeatClip('a', { count: 3 });
    expect(clipOf('mate')).toBeTruthy();
    const g = clipOf('a').group;
    expect(clipOf('mate').group).toBe(g);
    expect(ids.every((id) => clipOf(id).group === g)).toBe(true);
    expect(ed().past.length).toBe(1);
  });

  it('effects on the original are copied to every copy, moved by the same delay', () => {
    open((t) => [image(t[1]!, 'a', 1, 2), fx(t[0]!, 'e', 'a', 1, 2)]);
    const ids = oneStep(() => repeatClip('a', { count: 3, delay: 0.5 }));
    const copies = proj().clips.filter((c): c is EffectClip => c.type === 'effect' && c.id !== 'e');
    expect(copies).toHaveLength(2);
    ids.forEach((id) => {
      const mine = copies.find((e) => e.target === id)!;
      expect(mine).toBeTruthy();
      expect(mine.start).toBeCloseTo(clipOf(id).start, 6);
      expect(mine.duration).toBe(2);
    });
    expect(clipOf<EffectClip>('e').target).toBe('a');
  });

  it('an effect on a locked track is not copied', () => {
    const t = open((t) => [image(t[1]!, 'a', 0, 2), fx(t[0]!, 'e', 'a', 0, 2)]);
    ed().updateTrack(t[0]!, { locked: true }, { skipHistory: true });
    repeatClip('a', { count: 3 });
    expect(proj().clips.filter((c) => c.type === 'effect')).toHaveLength(1);
  });

  it('count limits: 2 gives one copy, a huge count stops at the maximum', () => {
    open((t) => [image(t[0]!, 'a', 0, 2)]);
    expect(repeatClip('a', { count: 2 })).toHaveLength(1);
    expect(lastToast()).toBe('1 copy');
    open((t) => [image(t[0]!, 'a', 0, 2)]);
    const ids = repeatClip('a', { count: 1000 });
    expect(ids).toHaveLength(MAX_REPEAT - 1);
    expect(ed().past.length).toBe(1);
  });

  it('a count below 2 (or not a number) does nothing: a toast, no step', () => {
    open((t) => [image(t[0]!, 'a', 0, 2)]);
    const before = proj();
    for (const count of [1, 0, -3, Number.NaN]) {
      expect(repeatClip('a', { count })).toEqual([]);
      expect(lastToast()).toBe('set copies to 2 or more');
    }
    expect(ed().past.length).toBe(0);
    expect(proj()).toBe(before);
  });

  it('a locked track: no copies, a toast, no step', () => {
    const t = open((t) => [image(t[0]!, 'a', 0, 2)]);
    ed().updateTrack(t[0]!, { locked: true }, { skipHistory: true });
    const before = proj();
    expect(repeatClip('a', { count: 3 })).toEqual([]);
    expect(lastToast()).toBe('this clip is on a locked track: unlock it to make copies');
    expect(proj()).toBe(before);
    expect(ed().past.length).toBe(0);
  });

  it('an audio clip or an unknown id gives nothing and no step', () => {
    const au: AudioClip = { id: 'au', type: 'audio', trackId: '', start: 0, duration: 2, name: 'au', fadeIn: 0, fadeOut: 0, assetId: 'img1', trimStart: 0, speed: 1, volume: 1, muted: false };
    open((t) => [{ ...au, trackId: t[0]! }]);
    expect(repeatClip('au', { count: 3 })).toEqual([]);
    expect(repeatClip('nope', { count: 3 })).toEqual([]);
    expect(ed().past.length).toBe(0);
  });

  it('scale and opacity multiply per copy and stay in range', () => {
    open((t) => [image(t[0]!, 'a', 0, 2)]);
    const ids = repeatClip('a', { count: 4, scale: 0.5, opacity: 0.5 });
    expect(ids.map((id) => clipOf<ImageClip>(id).transform.scale)).toEqual([0.5, 0.25, 0.125]);
    expect(ids.map((id) => clipOf<ImageClip>(id).transform.opacity)).toEqual([0.5, 0.25, 0.125]);
  });
});
