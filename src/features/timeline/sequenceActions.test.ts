import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioClip, Clip, EffectClip, ImageClip, MediaAsset, Project, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import { cutAtMarkers, fitToMarkers, makeRow } from './sequenceActions';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = <T extends Clip>(id: string): T => proj().clips.find((c) => c.id === id) as T;
const end = (id: string): number => clipOf(id).start + clipOf(id).duration;
const lastToast = (): string => useUi.getState().toasts.at(-1)?.message ?? '';

const asset = (id: string, kind: 'image' | 'video' | 'audio' = 'image', duration = 0): MediaAsset => ({
  id, name: id, kind, mime: kind + '/x', size: 1, duration, width: 100, height: 100, hasAudio: kind !== 'image', createdAt: 0,
});
const image = (trackId: string, id: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const video = (trackId: string, id: string, start: number, duration: number): VideoClip => ({
  id, type: 'video', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'vid1', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM },
});
const audio = (trackId: string, id: string, start: number, duration: number): AudioClip => ({
  id, type: 'audio', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'aud1', trimStart: 0, speed: 1, volume: 1, muted: false,
});
const fx = (trackId: string, id: string, target: string | null, start: number, duration: number): EffectClip => ({
  id, type: 'effect', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, effect: 'shake', params: {}, amount: 1, seed: 1, target,
});

/** ids top to bottom: t[0..2] video tracks, the last one is audio. markers are times in seconds. */
function open(make: (t: string[]) => Clip[], markers: number[] = []): string[] {
  const p = createProject('r17');
  ed().openProject({ ...p, assets: [asset('img1'), asset('vid1', 'video', 1), asset('aud1', 'audio', 60)], clips: [] });
  for (let i = 0; i < 3; i++) ed().addTrack('video');
  const ids = proj().tracks.map((t) => t.id);
  const list = markers.map((time, i) => ({ id: 'm' + i, time, name: '' }));
  useEditor.setState({ project: { ...proj(), clips: make(ids), markers: list }, past: [], future: [] });
  return ids;
}
const lock = (trackId: string) => ed().updateTrack(trackId, { locked: true }, { skipHistory: true });

function oneStep(run: () => void): void {
  const before = proj();
  run();
  const after = proj();
  expect(ed().past.length).toBe(1);
  expect(after).not.toEqual(before);
  ed().undo();
  expect(proj()).toEqual(before);
  ed().redo();
  expect(proj()).toEqual(after);
}
function noStep(run: () => void): void {
  const before = proj();
  run();
  expect(ed().past.length).toBe(0);
  expect(proj()).toBe(before);
}

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  useUi.setState({ toasts: [] });
});

describe('makeRow', () => {
  it('puts the clips end to end on the track of the first one, in order of their start', () => {
    const t = open((t) => [image(t[0]!, 'a', 0, 2), image(t[1]!, 'b', 5, 2), image(t[2]!, 'c', 3, 1)]);
    oneStep(() => makeRow(['a', 'b', 'c']));
    expect([clipOf('a').start, clipOf('c').start, clipOf('b').start]).toEqual([0, 2, 3]);
    expect(proj().clips.every((c) => c.trackId === t[0])).toBe(true);
    expect(clipOf('b').duration).toBe(2);
    expect(lastToast()).toBe('3 clips in a row');
  });

  it('a clip in the way on that track: the row goes on a new track above it', () => {
    const t = open((t) => [image(t[0]!, 'a', 0, 2), image(t[0]!, 'blocker', 2, 2), image(t[1]!, 'b', 5, 2)]);
    const tracks = proj().tracks.length;
    oneStep(() => makeRow(['a', 'b']));
    expect(proj().tracks).toHaveLength(tracks + 1);
    expect(clipOf('a').trackId).not.toBe(t[0]);
    expect(clipOf('b').trackId).toBe(clipOf('a').trackId);
    expect(proj().tracks[0]!.id).toBe(clipOf('a').trackId);
    expect(clipOf('blocker').trackId).toBe(t[0]);
    expect(clipOf('b').start).toBe(2);
  });

  it('the effects put on a clip follow it', () => {
    open((t) => [image(t[1]!, 'a', 0, 2), image(t[2]!, 'b', 5, 2), fx(t[0]!, 'e', 'b', 5, 2)]);
    oneStep(() => makeRow(['a', 'b']));
    expect(clipOf('b').start).toBe(2);
    expect(clipOf('e').start).toBe(2);
    expect(clipOf('e').duration).toBe(2);
  });

  it('a clip on a locked track stays out and is counted', () => {
    const t = open((t) => [image(t[0]!, 'a', 0, 2), image(t[1]!, 'b', 5, 2), image(t[2]!, 'c', 9, 2)]);
    lock(t[2]!);
    oneStep(() => makeRow(['a', 'b', 'c']));
    expect(clipOf('c').start).toBe(9);
    expect(clipOf('b').start).toBe(2);
    expect(lastToast()).toBe('2 clips in a row, 1 on locked tracks left out');
  });

  it('only locked clips: a toast, no step', () => {
    const t = open((t) => [image(t[0]!, 'a', 0, 2), image(t[1]!, 'b', 5, 2)]);
    lock(t[0]!);
    lock(t[1]!);
    noStep(() => makeRow(['a', 'b']));
    expect(lastToast()).toBe('those clips are on locked tracks');
  });

  it('nothing to do: one clip, pictures and audio mixed, or already in a row', () => {
    open((t) => [image(t[0]!, 'a', 0, 2), image(t[0]!, 'b', 2, 2), audio(t[t.length - 1]!, 'au', 0, 2), fx(t[1]!, 'e', null, 0, 2)]);
    noStep(() => makeRow(['a']));
    expect(lastToast()).toBe('select 2 or more clips');
    noStep(() => makeRow(['a', 'e']));
    expect(lastToast()).toBe('select 2 or more clips');
    noStep(() => makeRow(['a', 'au']));
    expect(lastToast()).toBe('pick pictures or audio, not both');
    noStep(() => makeRow(['a', 'b']));
    expect(lastToast()).toBe('already like that');
  });
});

describe('fitToMarkers', () => {
  const MARKS = [0, 2, 4, 6];

  it('every clip starts on a marker and ends on the next one, one undo step', () => {
    open((t) => [image(t[0]!, 'a', 0, 1.5), image(t[1]!, 'b', 3, 1), image(t[2]!, 'c', 5, 0.5)], MARKS);
    oneStep(() => fitToMarkers(['a', 'b', 'c']));
    expect([clipOf('a').start, end('a')]).toEqual([0, 2]);
    expect([clipOf('b').start, end('b')]).toEqual([2, 4]);
    expect([clipOf('c').start, end('c')]).toEqual([4, 6]);
    expect(lastToast()).toBe('3 clips on the markers');
  });

  it('span 2 spans two beats', () => {
    open((t) => [image(t[0]!, 'a', 0, 1), image(t[1]!, 'b', 1, 1)], [0, 2, 4, 6, 8]);
    oneStep(() => fitToMarkers(['a', 'b'], 2));
    expect([clipOf('a').start, end('a')]).toEqual([0, 4]);
    expect([clipOf('b').start, end('b')]).toEqual([4, 8]);
  });

  it('clips after the last marker are counted', () => {
    open((t) => [image(t[0]!, 'a', 0, 1), image(t[1]!, 'b', 1, 1), image(t[2]!, 'c', 2, 1)], [0, 2, 4]);
    oneStep(() => fitToMarkers(['a', 'b', 'c']));
    expect(lastToast()).toBe('2 clips on the markers');
    // a and b fit between 0 / 2 / 4, c follows after the last marker
    expect(clipOf('c').start).toBe(4);
  });

  it('a clip whose source is shorter than its beat is counted', () => {
    open((t) => [video(t[0]!, 'v', 0, 1), image(t[1]!, 'b', 1, 1)], [0, 2, 4]);
    oneStep(() => fitToMarkers(['v', 'b']));
    expect(clipOf('v').duration).toBe(1);
    expect(clipOf('b').start).toBe(2);
    expect(lastToast()).toBe('1 clip on the markers, 1 clip is shorter than its beat');
  });

  it('the effects put on a clip follow it', () => {
    open((t) => [image(t[1]!, 'a', 0, 1), image(t[2]!, 'b', 1, 1), fx(t[0]!, 'e', 'b', 1, 1)], MARKS);
    oneStep(() => fitToMarkers(['a', 'b']));
    expect([clipOf('e').start, end('e')]).toEqual([2, 4]);
  });

  it('a clip on a locked track stays out and is counted', () => {
    const t = open((t) => [image(t[0]!, 'a', 0, 1), image(t[1]!, 'b', 1, 1), image(t[2]!, 'c', 2, 1)], MARKS);
    lock(t[2]!);
    oneStep(() => fitToMarkers(['a', 'b', 'c']));
    expect(clipOf('c').start).toBe(2);
    expect(end('c')).toBe(3);
    expect(lastToast()).toBe('2 clips on the markers, 1 on locked tracks left out');
  });

  it('without markers: a toast, no step', () => {
    open((t) => [image(t[0]!, 'a', 0, 1), image(t[1]!, 'b', 1, 1)]);
    noStep(() => fitToMarkers(['a', 'b']));
    expect(lastToast()).toBe('no markers on the timeline, mark the beats first');
  });

  it('only markers before the clips: a toast, no step', () => {
    open((t) => [image(t[0]!, 'a', 3, 1), image(t[1]!, 'b', 4, 1)], [1, 2]);
    noStep(() => fitToMarkers(['a', 'b']));
    expect(lastToast()).toBe('no markers after the first clip');
  });

  it('already on the markers: a toast, no step', () => {
    open((t) => [image(t[0]!, 'a', 0, 2), image(t[0]!, 'b', 2, 2)], MARKS);
    noStep(() => fitToMarkers(['a', 'b']));
    expect(lastToast()).toBe('already like that');
  });
});

describe('cutAtMarkers', () => {
  it('splits a clip at every marker inside it, all in one undo step', () => {
    open((t) => [image(t[0]!, 'a', 0, 4)], [1, 2.5]);
    oneStep(() => cutAtMarkers(['a']));
    const pieces = proj().clips.filter((c) => c.type === 'image').sort((x, y) => x.start - y.start);
    expect(pieces.map((c) => [c.start, c.start + c.duration])).toEqual([[0, 1], [1, 2.5], [2.5, 4]]);
    expect(clipOf('a').start).toBe(0);
    expect(lastToast()).toBe('2 cuts');
  });

  it('one marker is one cut', () => {
    open((t) => [image(t[0]!, 'a', 0, 4), image(t[1]!, 'b', 0, 4)], [2]);
    cutAtMarkers(['a', 'b']);
    expect(proj().clips).toHaveLength(4);
    expect(lastToast()).toBe('1 cut');
    expect(ed().past.length).toBe(1);
  });

  it('only the given clips are cut, markers on the edge or outside are not cuts', () => {
    open((t) => [image(t[0]!, 'a', 1, 2), image(t[1]!, 'b', 1, 2)], [1, 3, 0.5, 3.5]);
    noStep(() => cutAtMarkers(['a']));
    expect(lastToast()).toBe('no marker inside the selected clips');
    open((t) => [image(t[0]!, 'a', 0, 4), image(t[1]!, 'b', 0, 4)], [2]);
    cutAtMarkers(['a']);
    expect(proj().clips.filter((c) => c.trackId === clipOf('b').trackId)).toHaveLength(1);
    expect(proj().clips).toHaveLength(3);
  });

  it('a clip on a locked track is not cut, the others are', () => {
    const t = open((t) => [image(t[0]!, 'a', 0, 4), image(t[1]!, 'b', 0, 4)], [2]);
    lock(t[0]!);
    oneStep(() => cutAtMarkers(['a', 'b']));
    expect(proj().clips.filter((c) => c.trackId === t[0])).toHaveLength(1);
    expect(proj().clips.filter((c) => c.trackId === t[1])).toHaveLength(2);
    expect(lastToast()).toBe('1 cut');
  });

  it('only a locked clip: a toast, no step', () => {
    const t = open((t) => [image(t[0]!, 'a', 0, 4)], [2]);
    lock(t[0]!);
    noStep(() => cutAtMarkers(['a']));
    expect(lastToast()).toBe('no marker inside the selected clips');
  });

  it('without markers: a toast, no step', () => {
    open((t) => [image(t[0]!, 'a', 0, 4)]);
    noStep(() => cutAtMarkers(['a']));
    expect(lastToast()).toBe('no marker inside the selected clips');
  });

  it('an effect clip in the selection is not cut by itself', () => {
    open((t) => [image(t[1]!, 'a', 0, 4), fx(t[0]!, 'e', 'a', 0, 4)], [2]);
    cutAtMarkers(['a']);
    // the effect that sits on the cut clip is cut with it (the part on the right follows the right half)
    const effects = proj().clips.filter((c) => c.type === 'effect');
    const images = proj().clips.filter((c) => c.type === 'image');
    expect(images).toHaveLength(2);
    for (const e of effects as EffectClip[]) expect(images.some((i) => i.id === e.target)).toBe(true);
    expect(effects.map((e) => [e.start, e.start + e.duration]).sort((x, y) => x[0]! - y[0]!)).toEqual([[0, 2], [2, 4]]);
  });
});
