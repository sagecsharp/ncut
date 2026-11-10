import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioClip, CameraClip, Clip, EffectClip, ImageClip, MediaAsset, Project, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject, createTextClip } from '../../lib/factory';
import { evalKeys } from '../../lib/anim';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import { flySelection, staggerSelection } from './cascadeActions';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = <T extends Clip>(id: string): T => proj().clips.find((c) => c.id === id) as T;
const lastToast = (): string => useUi.getState().toasts.at(-1)?.message ?? '';
const select = (...ids: string[]) => useEditor.setState({ selection: ids });

const asset = (id: string, kind: 'image' | 'video' | 'audio' = 'image'): MediaAsset => ({
  id, name: id, kind, mime: kind + '/x', size: 1, duration: kind === 'image' ? 0 : 60, width: 100, height: 100, hasAudio: kind !== 'image', createdAt: 0,
});
const image = (trackId: string, id: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const video = (trackId: string, id: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'vid1', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const audio = (trackId: string, id: string, start: number, duration: number): AudioClip => ({
  id, type: 'audio', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'aud1', trimStart: 0, speed: 1, volume: 1, muted: false,
});
const fx = (trackId: string, id: string, target: string | null, start: number, duration: number): EffectClip => ({
  id, type: 'effect', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, effect: 'shake', params: {}, amount: 1, seed: 1, target,
});
const cam = (trackId: string, id: string, start: number, duration: number): CameraClip =>
  ({ id, type: 'camera', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, x: 0, y: 0, z: 0, pan: 0, tilt: 0, roll: 0, fov: 50, target: null }) as unknown as CameraClip;
const lin = (...pairs: [number, number][]) => pairs.map(([t, v]) => ({ t, v, ease: 'linear' as const }));

/** ids top to bottom: t[0..2] video tracks (t[0] is the top layer), the last one is audio */
function open(make: (t: string[]) => Clip[]): string[] {
  const p = createProject('r17');
  ed().openProject({ ...p, assets: [asset('img1'), asset('vid1', 'video'), asset('aud1', 'audio')], clips: [] });
  for (let i = 0; i < 3; i++) ed().addTrack('video');
  const ids = proj().tracks.map((t) => t.id);
  useEditor.setState({ project: { ...proj(), clips: make(ids) }, past: [], future: [] });
  return ids;
}
const lock = (trackId: string) => ed().updateTrack(trackId, { locked: true }, { skipHistory: true });

/** run an action and check that it is exactly one undo step that undoes and redoes cleanly */
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

describe('staggerSelection', () => {
  it('layer order: the bottom track starts first, the others follow one step apart', () => {
    open((t) => [image(t[0]!, 'top', 0, 2), image(t[1]!, 'mid', 0, 2), image(t[2]!, 'low', 0, 2)]);
    select('top', 'mid', 'low');
    oneStep(() => staggerSelection('layer', 6, 'move'));
    expect(clipOf('low').start).toBe(0);
    expect(clipOf('mid').start).toBeCloseTo(0.2, 6);
    expect(clipOf('top').start).toBeCloseTo(0.4, 6);
    expect(clipOf('top').duration).toBe(2);
    expect(ed().selection).toEqual(['top', 'mid', 'low']);
    expect(lastToast()).toBe('2 clips staggered');
  });

  it('left / right / top orders use the position on the canvas', () => {
    const at = (x: number, y: number) => ({ transform: { ...DEFAULT_TRANSFORM, x, y } });
    const mk = () => open((t) => [image(t[0]!, 'a', 0, 2, at(300, 50)), image(t[1]!, 'b', 0, 2, at(-300, 200)), image(t[2]!, 'c', 0, 2, at(0, -100))]);
    mk();
    select('a', 'b', 'c');
    staggerSelection('left', 30, 'move');
    expect([clipOf('b').start, clipOf('c').start, clipOf('a').start]).toEqual([0, 1, 2]);
    mk();
    select('a', 'b', 'c');
    staggerSelection('right', 30, 'move');
    expect([clipOf('a').start, clipOf('c').start, clipOf('b').start]).toEqual([0, 1, 2]);
    mk();
    select('a', 'b', 'c');
    staggerSelection('top', 30, 'move');
    expect([clipOf('c').start, clipOf('a').start, clipOf('b').start]).toEqual([0, 1, 2]);
  });

  it('center / edges / random put every clip on its own start', () => {
    const at = (x: number) => ({ transform: { ...DEFAULT_TRANSFORM, x } });
    for (const order of ['center', 'edges', 'random'] as const) {
      open((t) => [image(t[0]!, 'a', 0, 2, at(-300)), image(t[1]!, 'b', 0, 2, at(0)), image(t[2]!, 'c', 0, 2, at(300))]);
      select('a', 'b', 'c');
      staggerSelection(order, 15, 'move', 7);
      const starts = ['a', 'b', 'c'].map((id) => clipOf(id).start).sort((x, y) => x - y);
      expect(starts).toEqual([0, 0.5, 1]);
      if (order === 'center') expect(clipOf('b').start).toBe(0);
      if (order === 'edges') expect(clipOf('b').start).toBe(1);
    }
  });

  it('step 0 lines the clips up at the earliest start', () => {
    open((t) => [image(t[0]!, 'a', 3, 2), image(t[1]!, 'b', 1, 2), image(t[2]!, 'c', 2, 2)]);
    select('a', 'b', 'c');
    oneStep(() => staggerSelection('layer', 0, 'move'));
    expect(['a', 'b', 'c'].map((id) => clipOf(id).start)).toEqual([1, 1, 1]);
  });

  it('trim mode on an image keeps the ends and cuts the heads', () => {
    open((t) => [image(t[0]!, 'a', 0, 4), image(t[1]!, 'b', 0, 4), image(t[2]!, 'c', 0, 4)]);
    select('a', 'b', 'c');
    oneStep(() => staggerSelection('layer', 30, 'trim'));
    expect(clipOf('c')).toMatchObject({ start: 0, duration: 4 });
    expect(clipOf('b').start).toBeCloseTo(1, 6);
    expect(clipOf('b').start + clipOf('b').duration).toBeCloseTo(4, 6);
    expect(clipOf('a').start).toBeCloseTo(2, 6);
    expect(clipOf('a').start + clipOf('a').duration).toBeCloseTo(4, 6);
  });

  it('trim mode on a text clip works the same', () => {
    open((t) => [createTextClip(t[0]!, 0, { id: 'tx', duration: 4 }), image(t[1]!, 'b', 0, 4)]);
    select('tx', 'b');
    // layer order: b (lower track) first, so the text is the one that is cut
    staggerSelection('layer', 30, 'trim');
    expect(clipOf('tx').start).toBeCloseTo(1, 6);
    expect(clipOf('tx').duration).toBeCloseTo(3, 6);
    expect(ed().past.length).toBe(1);
  });

  it('trim mode on a video moves the source offset by the cut head times the speed', () => {
    open((t) => [video(t[0]!, 'v', 0, 4, { trimStart: 2, speed: 2 }), image(t[1]!, 'b', 0, 4)]);
    select('v', 'b');
    oneStep(() => staggerSelection('layer', 30, 'trim'));
    const v = clipOf<VideoClip>('v');
    expect(v.start).toBeCloseTo(1, 6);
    expect(v.trimStart).toBeCloseTo(4, 6);
    expect(v.speed).toBe(2);
  });

  it('trim leaves out a clip that would get too short', () => {
    open((t) => [image(t[0]!, 'a', 0, 1), image(t[1]!, 'b', 0, 4)]);
    select('a', 'b');
    noStep(() => staggerSelection('layer', 30, 'trim'));
    expect(lastToast()).toBe('nothing changed, 1 clip would get too short');
  });

  it('a clip that runs into another clip on its track rolls everything back', () => {
    open((t) => [image(t[0]!, 'a', 0, 2), image(t[0]!, 'blocker', 2, 2), image(t[1]!, 'b', 0, 2), image(t[2]!, 'c', 0, 2)]);
    select('a', 'b', 'c');
    noStep(() => staggerSelection('layer', 30, 'move'));
    expect(lastToast()).toBe('a clip would run into another clip on its track, nothing moved');
    expect(useUi.getState().toasts.at(-1)!.kind).toBe('error');
  });

  it('the effects put on a clip follow it', () => {
    open((t) => [image(t[1]!, 'a', 0, 2), image(t[2]!, 'b', 0, 2), fx(t[0]!, 'e', 'a', 0, 2)]);
    select('a', 'b');
    oneStep(() => staggerSelection('layer', 30, 'move'));
    expect(clipOf('a').start).toBe(1);
    expect(clipOf('e').start).toBe(1);
  });

  it('camera and audio clips are staggered with the rest (the audio track is the bottom layer, so it goes first)', () => {
    open((t) => [image(t[1]!, 'a', 0, 2), cam(t[0]!, 'cam', 0, 2), audio(t[t.length - 1]!, 'au', 0, 2)]);
    select('a', 'cam', 'au');
    oneStep(() => staggerSelection('layer', 30, 'move'));
    expect([clipOf('au').start, clipOf('a').start, clipOf('cam').start]).toEqual([0, 1, 2]);
    expect(clipOf('au').trackId).toBe(proj().tracks.at(-1)!.id);
  });

  it('a locked track: its clips are left out and the rest still moves', () => {
    const t = open((t) => [image(t[0]!, 'a', 0, 2), image(t[1]!, 'b', 0, 2), image(t[2]!, 'c', 0, 2)]);
    lock(t[0]!);
    select('a', 'b', 'c');
    oneStep(() => staggerSelection('layer', 30, 'move'));
    expect(clipOf('a').start).toBe(0);
    expect(clipOf('b').start).toBe(1);
    expect(lastToast()).toBe('1 clip staggered, 1 on locked tracks left out');
  });

  it('only locked clips: a toast, no step', () => {
    const t = open((t) => [image(t[0]!, 'a', 0, 2), image(t[1]!, 'b', 0, 2)]);
    lock(t[0]!);
    lock(t[1]!);
    select('a', 'b');
    noStep(() => staggerSelection('layer', 30, 'move'));
    expect(lastToast()).toBe('those clips are on locked tracks');
  });

  it('nothing to do: one clip selected, or already like that', () => {
    open((t) => [image(t[0]!, 'a', 0, 2), image(t[1]!, 'b', 0, 2)]);
    select('a');
    noStep(() => staggerSelection('layer', 30, 'move'));
    expect(lastToast()).toBe('select 2 or more clips');
    select('a', 'b');
    noStep(() => staggerSelection('layer', 0, 'move'));
    expect(lastToast()).toBe('already like that');
  });
});

describe('flySelection', () => {
  it('fly in: keys at 0 and the duration, one undo step, the selection stays', () => {
    open((t) => [image(t[0]!, 'a', 1, 4), image(t[1]!, 'b', 0, 4)]);
    select('a', 'b');
    oneStep(() => flySelection('left', 'in', 1, 1, 5));
    const a = clipOf('a');
    expect(a.keyframes!.x!.map((k) => k.t)).toEqual([0, 1]);
    expect(a.keyframes!.x![0]!.v).toBeLessThan(0);
    expect(a.keyframes!.x![1]!.v).toBe(0);
    expect(a.keyframes!.opacity!.map((k) => k.v)).toEqual([0, 1]);
    expect(ed().selection).toEqual(['a', 'b']);
    expect(lastToast()).toBe('2 clips fly in');
  });

  it('fly out: keys at length - duration and length', () => {
    open((t) => [image(t[0]!, 'a', 0, 4)]);
    select('a');
    flySelection('rise', 'out', 1, 1, 5);
    expect(clipOf('a').keyframes!.y!.map((k) => k.t)).toEqual([3, 4]);
    expect(lastToast()).toBe('1 clip flies out');
  });

  it('a clip with keys on x: keys outside the span stay and the curve is continuous at the seam', () => {
    const old = lin([0, 100], [3, 400]);
    open((t) => [image(t[0]!, 'a', 0, 4, { keyframes: { x: old } })]);
    select('a');
    flySelection('left', 'in', 1, 1, 5);
    const x = clipOf('a').keyframes!.x!;
    expect(x.map((k) => k.t)).toEqual([0, 1, 3]);
    expect(x[2]).toEqual(old[1]);
    // at the seam the new curve equals the old one, and so does everything after it
    expect(evalKeys(x, 1)).toBeCloseTo(evalKeys(old, 1), 6);
    expect(evalKeys(x, 2)).toBeCloseTo(evalKeys(old, 2), 6);
    expect(evalKeys(x, 0)).toBeLessThan(evalKeys(old, 0));
  });

  it('fly out on a clip with keys: the curve before the span is untouched and the seam matches', () => {
    const old = lin([0, 100], [3, 400]);
    open((t) => [image(t[0]!, 'a', 0, 4, { keyframes: { x: old } })]);
    select('a');
    flySelection('right', 'out', 1, 1, 5);
    const x = clipOf('a').keyframes!.x!;
    expect(x.map((k) => k.t)).toEqual([0, 3, 4]);
    expect(x[0]).toEqual(old[0]);
    expect(x[1]!.v).toBe(400);
    expect(evalKeys(x, 1.5)).toBeCloseTo(evalKeys(old, 1.5), 6);
    expect(x[2]!.v).toBeGreaterThan(400);
  });

  it('fly out then fly in on the same clip: both flights are kept', () => {
    open((t) => [image(t[0]!, 'a', 0, 6)]);
    select('a');
    flySelection('left', 'out', 1, 1, 5);
    flySelection('left', 'in', 1, 1, 5);
    expect(ed().past.length).toBe(2);
    const a = clipOf('a');
    expect(a.keyframes!.x!.map((k) => k.t)).toEqual([0, 1, 5, 6]);
    expect(a.keyframes!.opacity!.map((k) => k.v)).toEqual([0, 1, 1, 0]);
  });

  it('a duration longer than the clip flies over the whole clip', () => {
    open((t) => [image(t[0]!, 'a', 0, 2)]);
    select('a');
    flySelection('zoom', 'in', 1, 10, 5);
    expect(clipOf('a').keyframes!.scale!.map((k) => k.t)).toEqual([0, 2]);
  });

  it('depth moves a 3d clip in z, a flat clip zooms instead', () => {
    open((t) => [image(t[0]!, 'd3', 0, 4, { threeD: true }), image(t[1]!, 'flat', 0, 4)]);
    select('d3', 'flat');
    flySelection('depth', 'in', 1, 1, 5);
    expect(clipOf('d3').keyframes!.z![0]!.v).toBeGreaterThan(0);
    expect(clipOf('d3').keyframes!.scale).toBeUndefined();
    expect(clipOf('flat').keyframes!.z).toBeUndefined();
    expect(clipOf('flat').keyframes!.scale![0]!.v).toBeLessThan(1);
  });

  it('camera and audio clips in the selection are left out and counted', () => {
    open((t) => [image(t[0]!, 'a', 0, 4), cam(t[1]!, 'cam', 0, 4), audio(t[t.length - 1]!, 'au', 0, 4)]);
    select('a', 'cam', 'au');
    oneStep(() => flySelection('left', 'in', 1, 1, 5));
    expect(clipOf('cam').keyframes).toBeUndefined();
    expect(clipOf('au').keyframes).toBeUndefined();
    expect(lastToast()).toBe('1 clip flies in, 2 not pictures left out');
  });

  it('a locked track: left out, or a toast when nothing else is left', () => {
    const t = open((t) => [image(t[0]!, 'a', 0, 4), image(t[1]!, 'b', 0, 4)]);
    lock(t[0]!);
    select('a', 'b');
    oneStep(() => flySelection('left', 'in', 1, 1, 5));
    expect(clipOf('a').keyframes).toBeUndefined();
    expect(lastToast()).toBe('1 clip flies in, 1 on locked tracks left out');
    ed().undo();
    lock(t[1]!);
    select('a', 'b');
    noStep(() => flySelection('left', 'in', 1, 1, 5));
    expect(lastToast()).toBe('those clips are on locked tracks');
  });

  it('nothing to do: no visual clip selected, or a length of 0', () => {
    open((t) => [image(t[0]!, 'a', 0, 4), audio(t[t.length - 1]!, 'au', 0, 4)]);
    select('au');
    noStep(() => flySelection('left', 'in', 1, 1, 5));
    expect(lastToast()).toBe('select pictures, text or shapes to fly');
    select('a');
    noStep(() => flySelection('left', 'in', 1, 0, 5));
    expect(lastToast()).toBe('nothing to change, the clips are too short for that length');
  });
});
