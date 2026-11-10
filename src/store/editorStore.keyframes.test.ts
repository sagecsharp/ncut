import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioClip, CameraClip, Clip, EffectClip, ImageClip, Keyframe, Project, TextClip, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createProject } from '../lib/factory';
import { valueAt } from '../lib/anim';
import { useEditor } from './editorStore';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = (id: string): Clip => proj().clips.find((c) => c.id === id)!;
const vid = (id: string) => clipOf(id) as VideoClip;
const k = (t: number, v: number, ease: Keyframe['ease'] = 'linear'): Keyframe => ({ t, v, ease });

let seq = 0;
function mkVideo(trackId: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip {
  return {
    id: `kv${++seq}`,
    type: 'video',
    trackId,
    start,
    duration,
    name: 'v',
    fadeIn: 0,
    fadeOut: 0,
    assetId: 'vid10',
    trimStart: 0,
    speed: 1,
    volume: 1,
    muted: false,
    transform: { ...DEFAULT_TRANSFORM },
    ...over,
  };
}
function mkImage(trackId: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip {
  return {
    id: `ki${++seq}`,
    type: 'image',
    trackId,
    start,
    duration,
    name: 'i',
    fadeIn: 0,
    fadeOut: 0,
    assetId: 'img',
    transform: { ...DEFAULT_TRANSFORM },
    ...over,
  };
}
function mkText(trackId: string, start: number, duration: number): TextClip {
  return {
    id: `kt${++seq}`,
    type: 'text',
    trackId,
    start,
    duration,
    name: 't',
    fadeIn: 0,
    fadeOut: 0,
    text: 'hello',
    fontFamily: 'Kode Mono',
    fontSize: 80,
    fontWeight: 400,
    italic: false,
    color: '#ffffff',
    background: null,
    align: 'center',
    transform: { ...DEFAULT_TRANSFORM },
  };
}
function mkAudio(trackId: string, start: number, duration: number): AudioClip {
  return {
    id: `ka${++seq}`,
    type: 'audio',
    trackId,
    start,
    duration,
    name: 'a',
    fadeIn: 0,
    fadeOut: 0,
    assetId: 'aud10',
    trimStart: 0,
    speed: 1,
    volume: 1,
    muted: false,
  };
}

const ASSETS = [
  { id: 'vid10', name: 'vid10', kind: 'video' as const, mime: 'video/mp4', size: 1, duration: 10, width: 1920, height: 1080, hasAudio: true, createdAt: 0 },
  { id: 'aud10', name: 'aud10', kind: 'audio' as const, mime: 'audio/mpeg', size: 1, duration: 10, width: 0, height: 0, hasAudio: true, createdAt: 0 },
  { id: 'img', name: 'img', kind: 'image' as const, mime: 'image/png', size: 1, duration: 0, width: 100, height: 100, hasAudio: false, createdAt: 0 },
];

/** open a project with the given clips (built from the video track id) */
function open(make: (v: string, a: string) => Clip[], fps = 30): { v: string; a: string; ids: string[] } {
  useEditor.setState({ clipboard: [] });
  const p = createProject('kf', undefined, fps);
  const v = p.tracks[0]!.id;
  const a = p.tracks[1]!.id;
  const clips = make(v, a);
  ed().openProject({ ...p, assets: [...ASSETS], clips });
  return { v, a, ids: clips.map((c) => c.id) };
}
const keysOf = (id: string, prop: string) => clipOf(id).keyframes?.[prop];
const times = (id: string, prop: string) => keysOf(id, prop)?.map((x) => x.t);

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
});

describe('setClipValue', () => {
  it('writes the static value when the prop is not animated', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10)]);
    ed().setClipValue(ids[0]!, 'x', 3, 120);
    expect(vid(ids[0]!).transform.x).toBe(120);
    expect(vid(ids[0]!).keyframes).toBeUndefined();
  });
  it('writes a key at the (clip-local) time when the prop is animated', () => {
    const { ids } = open((v) => [mkVideo(v, 5, 10, { keyframes: { x: [k(0, 0), k(10, 100)] } })]);
    ed().setClipValue(ids[0]!, 'x', 10, 777);
    expect(keysOf(ids[0]!, 'x')!.map((q) => [q.t, q.v])).toEqual([
      [0, 0],
      [5, 777],
      [10, 100],
    ]);
    expect(vid(ids[0]!).transform.x).toBe(0);
  });
  it('replaces the key already at that time', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: { x: [k(0, 0), k(4, 40)] } })]);
    ed().setClipValue(ids[0]!, 'x', 4, 1);
    expect(keysOf(ids[0]!, 'x')).toHaveLength(2);
    expect(valueAt(clipOf(ids[0]!), 'x', 4)).toBe(1);
  });
  it('handles the 3d fields (z, rotX, rotY)', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10)]);
    ed().setClipValue(ids[0]!, 'z', 0, 250);
    ed().setClipValue(ids[0]!, 'rotX', 0, 15);
    ed().setClipValue(ids[0]!, 'rotY', 0, -30);
    expect(vid(ids[0]!).transform).toMatchObject({ z: 250, rotX: 15, rotY: -30 });
  });
  it('clamps to the prop range', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10)]);
    ed().setClipValue(ids[0]!, 'opacity', 0, 5);
    expect(vid(ids[0]!).transform.opacity).toBe(1);
    ed().setClipValue(ids[0]!, 'opacity', 0, -5);
    expect(vid(ids[0]!).transform.opacity).toBe(0);
    ed().setClipValue(ids[0]!, 'volume', 0, 9);
    expect(vid(ids[0]!).volume).toBe(2);
    ed().setClipValue(ids[0]!, 'scale', 0, 0);
    expect(vid(ids[0]!).transform.scale).toBeGreaterThan(0);
  });
  it('clamps animated keys too', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: { opacity: [k(0, 1)] } })]);
    ed().setClipValue(ids[0]!, 'opacity', 2, 4);
    expect(keysOf(ids[0]!, 'opacity')!.find((q) => q.t === 2)!.v).toBe(1);
  });
  it('ignores unknown props, props the clip does not have, and non finite values', () => {
    const { ids } = open((v, a) => [mkVideo(v, 0, 10), mkAudio(a, 0, 5)]);
    const before = proj();
    ed().setClipValue(ids[0]!, 'nope', 0, 5);
    ed().setClipValue(ids[1]!, 'x', 0, 5);
    ed().setClipValue(ids[0]!, 'x', 0, NaN);
    ed().setClipValue(ids[0]!, 'x', 0, Infinity);
    ed().setClipValue('missing', 'x', 0, 1);
    expect(proj()).toBe(before);
    expect(ed().past).toHaveLength(0);
  });
  it('is a no-op (no history) when the value does not change', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10)]);
    ed().setClipValue(ids[0]!, 'x', 0, 0);
    expect(ed().past).toHaveLength(0);
  });
  it('is a no-op when an animated prop already has exactly that key', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: { x: [k(2, 50)] } })]);
    ed().setClipValue(ids[0]!, 'x', 2, 50);
    expect(ed().past).toHaveLength(0);
  });
  it('adds a key when the animated value equals the curve but no key exists there', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: { x: [k(0, 0), k(10, 100)] } })]);
    ed().setClipValue(ids[0]!, 'x', 5, 50);
    expect(times(ids[0]!, 'x')).toEqual([0, 5, 10]);
  });
  it('records one undo step per call, skipHistory records none', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10)]);
    ed().setClipValue(ids[0]!, 'x', 0, 10);
    expect(ed().past).toHaveLength(1);
    ed().setClipValue(ids[0]!, 'x', 0, 20, { skipHistory: true });
    expect(ed().past).toHaveLength(1);
    expect(vid(ids[0]!).transform.x).toBe(20);
  });
  it('works for effect amount and params', () => {
    const { v } = open((v) => [mkVideo(v, 0, 10)]);
    const id = ed().addEffect('shake', { trackId: v, start: 0, duration: 4 })!;
    ed().setClipValue(id, 'amount', 0, 0.4);
    ed().setClipValue(id, 'p.strength', 0, 500);
    const c = clipOf(id) as EffectClip;
    expect(c.amount).toBe(0.4);
    expect(c.params.strength).toBe(100);
    ed().setClipValue(id, 'p.nope', 0, 1);
    expect(c.params.nope).toBeUndefined();
    expect((clipOf(id) as EffectClip).params.nope).toBeUndefined();
  });
  it('works for camera clips', () => {
    open(() => []);
    const id = ed().addCamera({ start: 0, duration: 5 });
    ed().setClipValue(id, 'pan', 0, 25);
    ed().setClipValue(id, 'fov', 0, 1000);
    ed().setClipValue(id, 'fov', 0, 1);
    const c = clipOf(id) as CameraClip;
    expect(c.pan).toBe(25);
    expect(c.fov).toBe(5);
  });
  it('is ignored on a locked track', () => {
    const { v, ids } = open((v) => [mkVideo(v, 0, 10)]);
    ed().updateTrack(v, { locked: true });
    const before = proj();
    ed().setClipValue(ids[0]!, 'x', 0, 99);
    expect(proj()).toBe(before);
  });
});

describe('toggleKeyframe', () => {
  it('adds a key holding the current value, then removes it', () => {
    const { ids } = open((v) => [mkVideo(v, 2, 10, { transform: { ...DEFAULT_TRANSFORM, x: 33 } })]);
    ed().toggleKeyframe(ids[0]!, 'x', 5);
    expect(keysOf(ids[0]!, 'x')).toEqual([{ t: 3, v: 33, ease: 'ease' }]);
    ed().toggleKeyframe(ids[0]!, 'x', 5);
    expect(vid(ids[0]!).keyframes).toBeUndefined();
    expect(vid(ids[0]!).transform.x).toBe(33);
  });
  it('captures the animated value in the middle of a curve', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: { x: [k(0, 0), k(10, 100)] } })]);
    ed().toggleKeyframe(ids[0]!, 'x', 5);
    expect(keysOf(ids[0]!, 'x')!.find((q) => q.t === 5)!.v).toBeCloseTo(50, 9);
  });
  it('removing the only key leaves the value static', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: { x: [k(1, 77)] } })]);
    ed().toggleKeyframe(ids[0]!, 'x', 1);
    expect(vid(ids[0]!).keyframes).toBeUndefined();
    expect(vid(ids[0]!).transform.x).toBe(77);
  });
  it('treats a time within half a frame as the same key', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: { x: [k(1, 7), k(3, 9)] } })], 30);
    ed().toggleKeyframe(ids[0]!, 'x', 1 + 0.4 / 30);
    expect(times(ids[0]!, 'x')).toEqual([3]);
  });
  it('a time more than half a frame away adds a new key', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: { x: [k(1, 7), k(3, 9)] } })], 30);
    ed().toggleKeyframe(ids[0]!, 'x', 1 + 0.8 / 30);
    expect(times(ids[0]!, 'x')).toHaveLength(3);
  });
  it('uses the effect default for an unset effect param', () => {
    const { v } = open((v) => [mkVideo(v, 0, 10)]);
    const id = ed().addEffect('shake', { trackId: v, start: 0, duration: 4 })!;
    ed().toggleKeyframe(id, 'p.strength', 1);
    expect(keysOf(id, 'p.strength')![0]!.v).toBe(25);
  });
  it('ignores unknown props', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10)]);
    ed().toggleKeyframe(ids[0]!, 'nope', 1);
    expect(vid(ids[0]!).keyframes).toBeUndefined();
    expect(ed().past).toHaveLength(0);
  });
  it('ignored on a locked track', () => {
    const { v, ids } = open((v) => [mkVideo(v, 0, 10)]);
    ed().updateTrack(v, { locked: true });
    ed().toggleKeyframe(ids[0]!, 'x', 1);
    expect(vid(ids[0]!).keyframes).toBeUndefined();
  });
  it('is one undo step', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10)]);
    ed().toggleKeyframe(ids[0]!, 'scale', 1);
    expect(ed().past).toHaveLength(1);
    ed().undo();
    expect(vid(ids[0]!).keyframes).toBeUndefined();
  });
});

describe('setKeyframe', () => {
  it('writes a key with the given value and ease', () => {
    const { ids } = open((v) => [mkVideo(v, 1, 10)]);
    ed().setKeyframe(ids[0]!, 'x', 3, 50, 'bounce');
    expect(keysOf(ids[0]!, 'x')).toEqual([{ t: 2, v: 50, ease: 'bounce' }]);
  });
  it('without a value uses the current one', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10, { transform: { ...DEFAULT_TRANSFORM, y: 12 } })]);
    ed().setKeyframe(ids[0]!, 'y', 4);
    expect(keysOf(ids[0]!, 'y')![0]!.v).toBe(12);
  });
  it('replaces a key at the same time', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: { x: [k(2, 5, 'hold')] } })]);
    ed().setKeyframe(ids[0]!, 'x', 2, 9);
    expect(keysOf(ids[0]!, 'x')).toEqual([{ t: 2, v: 9, ease: 'hold' }]);
  });
  it('clamps values to the prop range', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10)]);
    ed().setKeyframe(ids[0]!, 'opacity', 0, 3);
    expect(keysOf(ids[0]!, 'opacity')![0]!.v).toBe(1);
  });
  it('rejects unknown props and non finite values', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10)]);
    ed().setKeyframe(ids[0]!, 'nope', 0, 1);
    ed().setKeyframe(ids[0]!, 'x', 0, NaN);
    expect(vid(ids[0]!).keyframes).toBeUndefined();
  });
  it('keeps keys sorted when set out of order', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10)]);
    for (const t of [5, 1, 9, 3]) ed().setKeyframe(ids[0]!, 'x', t, t);
    expect(times(ids[0]!, 'x')).toEqual([1, 3, 5, 9]);
  });
  it('ignored on a locked track', () => {
    const { v, ids } = open((v) => [mkVideo(v, 0, 10)]);
    ed().updateTrack(v, { locked: true });
    ed().setKeyframe(ids[0]!, 'x', 0, 5);
    expect(vid(ids[0]!).keyframes).toBeUndefined();
  });
  it('works on text, image and camera clips', () => {
    const { ids } = open((v) => [mkText(v, 0, 5), mkImage(v, 5, 5)]);
    ed().setKeyframe(ids[0]!, 'rotation', 1, 45);
    ed().setKeyframe(ids[1]!, 'z', 1, 300);
    const cam = ed().addCamera({ start: 20, duration: 4 });
    ed().setKeyframe(cam, 'tilt', 21, 10);
    expect(keysOf(ids[0]!, 'rotation')![0]!.v).toBe(45);
    expect(keysOf(ids[1]!, 'z')![0]).toMatchObject({ t: -4, v: 300 });
    expect(keysOf(cam, 'tilt')![0]).toMatchObject({ t: 1, v: 10 });
  });
});

describe('removeKeyframe', () => {
  it('removes the key at the time', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: { x: [k(0, 0), k(2, 2), k(4, 4)] } })]);
    ed().removeKeyframe(ids[0]!, 'x', 2);
    expect(times(ids[0]!, 'x')).toEqual([0, 4]);
  });
  it('removing the last key freezes the value', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: { x: [k(2, 55)] } })]);
    ed().removeKeyframe(ids[0]!, 'x', 2);
    expect(vid(ids[0]!).keyframes).toBeUndefined();
    expect(vid(ids[0]!).transform.x).toBe(55);
  });
  it('no key at that time: nothing changes and no history', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: { x: [k(2, 55)] } })]);
    const before = proj();
    ed().removeKeyframe(ids[0]!, 'x', 7);
    ed().removeKeyframe(ids[0]!, 'y', 2);
    expect(proj()).toBe(before);
    expect(ed().past).toHaveLength(0);
  });
  it('takes timeline time (clip.start offset)', () => {
    const { ids } = open((v) => [mkVideo(v, 4, 10, { keyframes: { x: [k(1, 1), k(3, 3)] } })]);
    ed().removeKeyframe(ids[0]!, 'x', 5);
    expect(times(ids[0]!, 'x')).toEqual([3]);
  });
  it('honours the tolerance argument', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: { x: [k(1, 1), k(3, 3)] } })]);
    ed().removeKeyframe(ids[0]!, 'x', 1.2, 0.05);
    expect(times(ids[0]!, 'x')).toEqual([1, 3]);
    ed().removeKeyframe(ids[0]!, 'x', 1.2, 0.5);
    expect(times(ids[0]!, 'x')).toEqual([3]);
  });
  it('ignored on a locked track', () => {
    const { v, ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: { x: [k(1, 1), k(3, 3)] } })]);
    ed().updateTrack(v, { locked: true });
    ed().removeKeyframe(ids[0]!, 'x', 1);
    expect(times(ids[0]!, 'x')).toEqual([1, 3]);
  });
});

describe('moveKeyframe', () => {
  const kfs = { x: [k(1, 10), k(3, 30)], y: [k(1, 100), k(5, 500)], scale: [k(2, 2)] };
  it('moves one prop only', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: structuredClone(kfs) })]);
    ed().moveKeyframe(ids[0]!, 'x', 1, 2);
    expect(times(ids[0]!, 'x')).toEqual([2, 3]);
    expect(times(ids[0]!, 'y')).toEqual([1, 5]);
    expect(keysOf(ids[0]!, 'x')![0]!.v).toBe(10);
  });
  it('null moves every prop that has a key there', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: structuredClone(kfs) })]);
    ed().moveKeyframe(ids[0]!, null, 1, 4);
    expect(times(ids[0]!, 'x')).toEqual([3, 4]);
    expect(times(ids[0]!, 'y')).toEqual([4, 5]);
    expect(times(ids[0]!, 'scale')).toEqual([2]);
  });
  it('times are TIMELINE seconds', () => {
    const { ids } = open((v) => [mkVideo(v, 10, 10, { keyframes: structuredClone(kfs) })]);
    ed().moveKeyframe(ids[0]!, 'x', 11, 13);
    expect(times(ids[0]!, 'x')).toEqual([3]);
  });
  it('a key moved onto another replaces it', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: { x: [k(1, 10), k(3, 30)] } })]);
    ed().moveKeyframe(ids[0]!, 'x', 1, 3);
    expect(keysOf(ids[0]!, 'x')).toEqual([{ t: 3, v: 10, ease: 'linear' }]);
  });
  it('keeps the list sorted when moving past a neighbour', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: { x: [k(1, 1), k(3, 3), k(5, 5)] } })]);
    ed().moveKeyframe(ids[0]!, 'x', 1, 4);
    expect(keysOf(ids[0]!, 'x')!.map((q) => [q.t, q.v])).toEqual([
      [3, 3],
      [4, 1],
      [5, 5],
    ]);
  });
  it('clamps inside the clip (before the start)', () => {
    const { ids } = open((v) => [mkVideo(v, 5, 10, { keyframes: { x: [k(2, 1)] } })]);
    ed().moveKeyframe(ids[0]!, 'x', 7, -100);
    expect(times(ids[0]!, 'x')).toEqual([0]);
  });
  it('clamps inside the clip (after the end)', () => {
    const { ids } = open((v) => [mkVideo(v, 5, 10, { keyframes: { x: [k(2, 1)] } })]);
    ed().moveKeyframe(ids[0]!, 'x', 7, 999);
    expect(times(ids[0]!, 'x')).toEqual([10]);
  });
  it('null clamps every moved prop', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 4, { keyframes: { x: [k(1, 1)], y: [k(1, 2)] } })]);
    ed().moveKeyframe(ids[0]!, null, 1, 50);
    expect(times(ids[0]!, 'x')).toEqual([4]);
    expect(times(ids[0]!, 'y')).toEqual([4]);
  });
  it('does nothing when no key is there, when from = to, or without keyframes', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: { x: [k(1, 1)] } }), mkVideo(v, 10, 5)]);
    const before = proj();
    ed().moveKeyframe(ids[0]!, 'x', 5, 6);
    ed().moveKeyframe(ids[0]!, 'x', 1, 1);
    ed().moveKeyframe(ids[0]!, 'y', 1, 2);
    ed().moveKeyframe(ids[1]!, null, 1, 2);
    expect(proj()).toBe(before);
    expect(ed().past).toHaveLength(0);
  });
  it('honours the tolerance when finding the key', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: { x: [k(1, 1)] } })], 30);
    ed().moveKeyframe(ids[0]!, 'x', 1.3, 2);
    expect(times(ids[0]!, 'x')).toEqual([1]);
    ed().moveKeyframe(ids[0]!, 'x', 1.01, 2);
    expect(times(ids[0]!, 'x')).toEqual([2]);
  });
  it('ignored on a locked track', () => {
    const { v, ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: { x: [k(1, 1)] } })]);
    ed().updateTrack(v, { locked: true });
    ed().moveKeyframe(ids[0]!, 'x', 1, 5);
    expect(times(ids[0]!, 'x')).toEqual([1]);
  });
  it('with skipHistory records nothing (drag updates)', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: { x: [k(1, 1)] } })]);
    ed().moveKeyframe(ids[0]!, 'x', 1, 2, undefined, { skipHistory: true });
    expect(times(ids[0]!, 'x')).toEqual([2]);
    expect(ed().past).toHaveLength(0);
  });
});

describe('clearKeyframes', () => {
  it('clears every prop and freezes the values at that time', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: { x: [k(0, 0), k(10, 100)], opacity: [k(0, 1), k(10, 0)] } })]);
    ed().clearKeyframes(ids[0]!, 5);
    expect(vid(ids[0]!).keyframes).toBeUndefined();
    expect(vid(ids[0]!).transform.x).toBeCloseTo(50, 9);
    expect(vid(ids[0]!).transform.opacity).toBeCloseTo(0.5, 9);
  });
  it('clears one prop only', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: { x: [k(0, 0), k(10, 100)], y: [k(0, 1), k(10, 2)] } })]);
    ed().clearKeyframes(ids[0]!, 10, 'x');
    expect(keysOf(ids[0]!, 'x')).toBeUndefined();
    expect(vid(ids[0]!).transform.x).toBe(100);
    expect(keysOf(ids[0]!, 'y')).toHaveLength(2);
  });
  it('does nothing for a clip without keyframes', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10)]);
    ed().clearKeyframes(ids[0]!, 1);
    expect(ed().past).toHaveLength(0);
  });
  it('ignored on a locked track', () => {
    const { v, ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: { x: [k(0, 0)] } })]);
    ed().updateTrack(v, { locked: true });
    ed().clearKeyframes(ids[0]!, 1);
    expect(keysOf(ids[0]!, 'x')).toHaveLength(1);
  });
});

describe('undo / redo', () => {
  it('restores keyframes step by step', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10)]);
    ed().setKeyframe(ids[0]!, 'x', 1, 10);
    ed().setKeyframe(ids[0]!, 'x', 5, 50);
    ed().moveKeyframe(ids[0]!, 'x', 5, 6);
    expect(times(ids[0]!, 'x')).toEqual([1, 6]);
    ed().undo();
    expect(times(ids[0]!, 'x')).toEqual([1, 5]);
    ed().undo();
    expect(times(ids[0]!, 'x')).toEqual([1]);
    ed().undo();
    expect(vid(ids[0]!).keyframes).toBeUndefined();
    ed().redo();
    ed().redo();
    ed().redo();
    expect(keysOf(ids[0]!, 'x')!.map((q) => [q.t, q.v])).toEqual([
      [1, 10],
      [6, 50],
    ]);
  });
  it('undoing a clear brings the animation back', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: { x: [k(0, 0), k(10, 100)] } })]);
    ed().clearKeyframes(ids[0]!, 3);
    expect(vid(ids[0]!).keyframes).toBeUndefined();
    ed().undo();
    expect(keysOf(ids[0]!, 'x')).toHaveLength(2);
    expect(vid(ids[0]!).transform.x).toBe(0);
  });
  it('a new action clears the redo stack', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10)]);
    ed().setKeyframe(ids[0]!, 'x', 1, 1);
    ed().undo();
    expect(ed().future).toHaveLength(1);
    ed().setKeyframe(ids[0]!, 'y', 1, 1);
    expect(ed().future).toHaveLength(0);
  });
});

describe('split / trim keep the motion in place', () => {
  const motion = { x: [k(0, 0), k(10, 1000)] };
  it('split: both halves give the same values at the same timeline times', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: structuredClone(motion) })]);
    const orig = clipOf(ids[0]!);
    const [rightId] = ed().splitClips(4, ids);
    const left = clipOf(ids[0]!);
    const right = clipOf(rightId!);
    for (const t of [0, 1, 2.5, 3.9]) expect(valueAt(left, 'x', t), `left ${t}`).toBeCloseTo(valueAt(orig, 'x', t)!, 9);
    for (const t of [4, 5, 7.5, 9.99]) expect(valueAt(right, 'x', t), `right ${t}`).toBeCloseTo(valueAt(orig, 'x', t)!, 9);
  });
  it('split: the right half keys are shifted to its own start', () => {
    const { ids } = open((v) => [mkVideo(v, 2, 10, { keyframes: structuredClone(motion) })]);
    const [rightId] = ed().splitClips(6, ids);
    expect(clipOf(rightId!).start).toBe(6);
    expect(times(rightId!, 'x')).toEqual([-4, 6]);
  });
  it('split: keeps animations of several props', () => {
    const { ids } = open((v) => [
      mkVideo(v, 0, 10, {
        keyframes: { x: [k(0, 0), k(10, 100)], opacity: [k(0, 1), k(10, 0)], z: [k(2, 0), k(8, 600)] },
      }),
    ]);
    const orig = clipOf(ids[0]!);
    const [rightId] = ed().splitClips(5, ids);
    for (const prop of ['x', 'opacity', 'z']) {
      expect(valueAt(clipOf(ids[0]!), prop, 3)).toBeCloseTo(valueAt(orig, prop, 3)!, 9);
      expect(valueAt(clipOf(rightId!), prop, 7)).toBeCloseTo(valueAt(orig, prop, 7)!, 9);
    }
  });
  it('split: the halves do not share key objects (editing one leaves the other)', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: structuredClone(motion) })]);
    const [rightId] = ed().splitClips(4, ids);
    ed().setClipValue(rightId!, 'x', 8, 5);
    expect(valueAt(clipOf(ids[0]!), 'x', 3)).toBeCloseTo(300, 9);
  });
  it('split of a clip without keyframes leaves both halves without', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10)]);
    const [rightId] = ed().splitClips(4, ids);
    expect(clipOf(ids[0]!).keyframes).toBeUndefined();
    expect(clipOf(rightId!).keyframes).toBeUndefined();
  });
  it('split a camera clip: motion is continuous', () => {
    open(() => []);
    const id = ed().addCamera({ start: 0, duration: 8 });
    ed().setKeyframe(id, 'pan', 0, 0);
    ed().setKeyframe(id, 'pan', 8, 40);
    const orig = clipOf(id);
    const [rightId] = ed().splitClips(4, [id]);
    expect(valueAt(clipOf(rightId!), 'pan', 6)).toBeCloseTo(valueAt(orig, 'pan', 6)!, 9);
    expect(valueAt(clipOf(id), 'pan', 2)).toBeCloseTo(valueAt(orig, 'pan', 2)!, 9);
  });
  it('trim head: keys stay at the same timeline times', () => {
    const { ids } = open((v) => [mkVideo(v, 2, 8, { keyframes: structuredClone(motion) })]);
    const orig = clipOf(ids[0]!);
    ed().trimClip(ids[0]!, 'start', 5);
    const c = clipOf(ids[0]!);
    expect(c.start).toBe(5);
    expect(c.duration).toBe(5);
    for (const t of [5, 6, 8, 9.9]) expect(valueAt(c, 'x', t), String(t)).toBeCloseTo(valueAt(orig, 'x', t)!, 9);
    expect(times(ids[0]!, 'x')).toEqual([-3, 7]);
  });
  it('trim head of an image clip shifts keys too', () => {
    const { ids } = open((v) => [mkImage(v, 0, 10, { keyframes: { scale: [k(2, 1), k(6, 3)] } })]);
    const orig = clipOf(ids[0]!);
    ed().trimClip(ids[0]!, 'start', 3);
    for (const t of [3, 4, 5, 6, 8]) expect(valueAt(clipOf(ids[0]!), 'scale', t)).toBeCloseTo(valueAt(orig, 'scale', t)!, 9);
  });
  it('trimming the tail leaves the keys alone', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 10, { keyframes: structuredClone(motion) })]);
    ed().trimClip(ids[0]!, 'end', 6);
    expect(times(ids[0]!, 'x')).toEqual([0, 10]);
    expect(clipOf(ids[0]!).duration).toBe(6);
  });
  it('moving a clip moves its animation with it (keys are clip-local)', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 5, { keyframes: { x: [k(0, 0), k(5, 100)] } })]);
    const track = clipOf(ids[0]!).trackId;
    ed().moveClips([{ id: ids[0]!, trackId: track, start: 10 }]);
    expect(valueAt(clipOf(ids[0]!), 'x', 12.5)).toBeCloseTo(50, 9);
    expect(times(ids[0]!, 'x')).toEqual([0, 5]);
  });
});

describe('duplicate / copy / paste', () => {
  const kf = () => ({ x: [k(0, 0), k(4, 80)], volume: [k(1, 0.5)] });
  it('duplicate keeps keyframes (deep copy)', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 5, { keyframes: kf() })]);
    const [copyId] = ed().duplicateClips(ids);
    expect(clipOf(copyId!).keyframes).toEqual(kf());
    expect(clipOf(copyId!).keyframes).not.toBe(clipOf(ids[0]!).keyframes);
    ed().setClipValue(copyId!, 'x', clipOf(copyId!).start + 2, 999);
    expect(times(ids[0]!, 'x')).toEqual([0, 4]);
  });
  it('duplicate keeps the motion relative to the new start', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 5, { keyframes: kf() })]);
    const [copyId] = ed().duplicateClips(ids);
    const c = clipOf(copyId!);
    expect(c.start).toBeGreaterThanOrEqual(5);
    expect(valueAt(c, 'x', c.start + 2)).toBeCloseTo(40, 9);
  });
  it('copy + paste keep keyframes of every clip', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 5, { keyframes: kf() }), mkImage(v, 5, 5, { keyframes: { rotY: [k(1, 20)] } })]);
    ed().select(ids);
    ed().copySelection();
    const made = ed().paste(20);
    expect(made).toHaveLength(2);
    const kfs = made.map((id) => clipOf(id).keyframes);
    expect(kfs).toContainEqual(kf());
    expect(kfs).toContainEqual({ rotY: [k(1, 20)] });
  });
  it('the clipboard copy is independent of later edits', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 5, { keyframes: kf() })]);
    ed().select(ids);
    ed().copySelection();
    ed().setClipValue(ids[0]!, 'x', 1, 12345);
    const [pasted] = ed().paste(30);
    expect(keysOf(pasted!, 'x')!.some((q) => q.v === 12345)).toBe(false);
  });
  it('cut + paste keeps keyframes', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 5, { keyframes: kf() })]);
    ed().select(ids);
    ed().cutSelection();
    expect(proj().clips).toHaveLength(0);
    const [pasted] = ed().paste(0);
    expect(clipOf(pasted!).keyframes).toEqual(kf());
  });
  it('duplicating a camera clip keeps its keys', () => {
    open(() => []);
    const id = ed().addCamera({ start: 0, duration: 4 });
    ed().setKeyframe(id, 'fov', 1, 30);
    const [copyId] = ed().duplicateClips([id]);
    expect(keysOf(copyId!, 'fov')).toEqual([{ t: 1, v: 30, ease: 'ease' }]);
    expect(clipOf(copyId!).type).toBe('camera');
  });
});

describe('addCamera', () => {
  it('places a camera clip on the top video track', () => {
    const { v } = open(() => []);
    const id = ed().addCamera();
    const c = clipOf(id) as CameraClip;
    expect(c.type).toBe('camera');
    expect(c.trackId).toBe(v);
    expect(c.start).toBe(0);
    expect(c.duration).toBeGreaterThan(0);
    expect(ed().selection).toEqual([id]);
  });
  it('starts with the home pose', () => {
    open(() => []);
    const c = clipOf(ed().addCamera()) as CameraClip;
    expect([c.x, c.y, c.z, c.pan, c.tilt, c.roll, c.fov]).toEqual([0, 0, 0, 0, 0, 0, 50]);
  });
  it('honours start and duration', () => {
    open(() => []);
    const c = clipOf(ed().addCamera({ start: 3, duration: 2 })) as CameraClip;
    expect(c.start).toBe(3);
    expect(c.duration).toBe(2);
  });
  it('uses a given video track', () => {
    const { v } = open(() => []);
    const second = ed().addTrack('video');
    const id = ed().addCamera({ trackId: second, start: 1 });
    expect(clipOf(id).trackId).toBe(second);
    expect(second).not.toBe(v);
  });
  it('makes a new top track when the top one is busy at that time', () => {
    const { v } = open((v) => [mkVideo(v, 0, 10)]);
    const id = ed().addCamera({ start: 2, duration: 3 });
    const c = clipOf(id);
    expect(c.trackId).not.toBe(v);
    expect(proj().tracks[0]!.id).toBe(c.trackId);
    expect(proj().tracks[0]!.kind).toBe('video');
  });
  it('never puts a camera on an audio track', () => {
    const { a } = open(() => []);
    const id = ed().addCamera({ trackId: a });
    const track = proj().tracks.find((t) => t.id === clipOf(id).trackId)!;
    expect(track.kind).toBe('video');
  });
  it('does not overlap other clips on a requested track', () => {
    const { v } = open((v) => [mkVideo(v, 0, 10)]);
    const id = ed().addCamera({ trackId: v, start: 2, duration: 3 });
    const sameTrack = proj().clips.filter((c) => c.trackId === clipOf(id).trackId).sort((x, y) => x.start - y.start);
    for (let i = 1; i < sameTrack.length; i++) {
      expect(sameTrack[i]!.start).toBeGreaterThanOrEqual(sameTrack[i - 1]!.start + sameTrack[i - 1]!.duration - 1e-6);
    }
  });
  it('is undoable', () => {
    open(() => []);
    const id = ed().addCamera();
    ed().undo();
    expect(proj().clips.find((c) => c.id === id)).toBeUndefined();
  });
  it('a locked top track is skipped', () => {
    const { v } = open(() => []);
    ed().updateTrack(v, { locked: true });
    const id = ed().addCamera();
    expect(clipOf(id).trackId).not.toBe(v);
  });
});

describe('updateClip (3d, transition, text style)', () => {
  it('sets threeD, lookAt, shape, shapeDepth on video / image / text', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 3), mkImage(v, 3, 3), mkText(v, 6, 3)]);
    for (const id of ids) {
      ed().updateClip(id, { threeD: true, lookAt: 'cameraY', shape: 'box', shapeDepth: 120 });
      expect(clipOf(id)).toMatchObject({ threeD: true, lookAt: 'cameraY', shape: 'box', shapeDepth: 120 });
    }
  });
  it('can turn 3d off again', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 3)]);
    ed().updateClip(ids[0]!, { threeD: true });
    ed().updateClip(ids[0]!, { threeD: false });
    expect(vid(ids[0]!).threeD).toBe(false);
  });
  it('sets and removes a transition', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 3), mkVideo(v, 3, 3)]);
    ed().updateClip(ids[1]!, { transition: { id: 'fade', duration: 1 } });
    expect(vid(ids[1]!).transition).toEqual({ id: 'fade', duration: 1 });
    ed().updateClip(ids[1]!, { transition: null });
    expect(vid(ids[1]!).transition).toBeNull();
  });
  it('sets text style keys', () => {
    const { ids } = open((v) => [mkText(v, 0, 3)]);
    ed().updateClip(ids[0]!, {
      letterSpacing: 0.1,
      lineHeight: 1.5,
      uppercase: true,
      stroke: { color: '#000', width: 0.1 },
      shadow: { color: '#000', opacity: 0.5, blur: 0.1, distance: 0.1, angle: 45 },
      backgroundRadius: 0.5,
      backgroundPadding: 0.4,
      animIn: { id: 'fade', duration: 0.5 },
      animOut: { id: 'fade', duration: 0.5 },
      animLoop: { id: 'pulse', duration: 2 },
    });
    expect(clipOf(ids[0]!)).toMatchObject({
      letterSpacing: 0.1,
      lineHeight: 1.5,
      uppercase: true,
      stroke: { color: '#000', width: 0.1 },
      shadow: { angle: 45, opacity: 0.5 },
      backgroundRadius: 0.5,
      backgroundPadding: 0.4,
      animIn: { id: 'fade', duration: 0.5 },
      animOut: { id: 'fade', duration: 0.5 },
      animLoop: { id: 'pulse', duration: 2 },
    });
  });
  it('null removes optional text style objects', () => {
    const { ids } = open((v) => [mkText(v, 0, 3)]);
    ed().updateClip(ids[0]!, { stroke: { color: '#000', width: 0.1 }, animIn: { id: 'fade', duration: 1 } });
    ed().updateClip(ids[0]!, { stroke: null, animIn: null });
    const c = clipOf(ids[0]!) as TextClip;
    expect(c.stroke).toBeNull();
    expect(c.animIn).toBeNull();
  });
  it('text style keys are ignored on other clip types', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 3)]);
    ed().updateClip(ids[0]!, { letterSpacing: 1, uppercase: true } as never);
    expect('letterSpacing' in clipOf(ids[0]!)).toBe(false);
    expect('uppercase' in clipOf(ids[0]!)).toBe(false);
  });
  it('3d keys are ignored on audio, effect and camera clips', () => {
    const { a, v } = open((v, a) => [mkAudio(a, 0, 3), mkVideo(v, 20, 1)]);
    const fx = ed().addEffect('shake', { trackId: v, start: 0, duration: 3 })!;
    const cam = ed().addCamera({ start: 30, duration: 3 });
    const audioId = proj().clips.find((c) => c.type === 'audio')!.id;
    for (const id of [audioId, fx, cam]) {
      ed().updateClip(id, { threeD: true, transition: { id: 'fade', duration: 1 } } as never);
      expect('threeD' in clipOf(id)).toBe(false);
      expect('transition' in clipOf(id)).toBe(false);
    }
    expect(a).toBeTruthy();
  });
  it("ignores 'keyframes' (use the keyframe actions)", () => {
    const { ids } = open((v) => [mkVideo(v, 0, 3, { keyframes: { x: [k(0, 1)] } })]);
    const before = proj();
    ed().updateClip(ids[0]!, { keyframes: { y: [k(0, 9)] } });
    expect(proj()).toBe(before);
    ed().updateClip(ids[0]!, { keyframes: undefined });
    expect(keysOf(ids[0]!, 'x')).toHaveLength(1);
  });
  it('mixed patch: keyframes ignored, the rest applied', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 3)]);
    ed().updateClip(ids[0]!, { keyframes: { y: [k(0, 9)] }, threeD: true });
    expect(vid(ids[0]!).threeD).toBe(true);
    expect(vid(ids[0]!).keyframes).toBeUndefined();
  });
  it('cannot change id, type, trackId, start or duration', () => {
    const { ids, v } = open((vv) => [mkVideo(vv, 0, 3)]);
    ed().updateClip(ids[0]!, { id: 'x', type: 'audio', trackId: 'q', start: 9, duration: 9 } as never);
    expect(vid(ids[0]!)).toMatchObject({ id: ids[0], type: 'video', trackId: v, start: 0, duration: 3 });
  });
  it('sets camera values', () => {
    open(() => []);
    const id = ed().addCamera();
    ed().updateClip(id, { fov: 80, roll: 10 });
    expect(clipOf(id)).toMatchObject({ fov: 80, roll: 10 });
  });
  it('same values record no history', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 3)]);
    ed().updateClip(ids[0]!, { threeD: true });
    const n = ed().past.length;
    ed().updateClip(ids[0]!, { threeD: true });
    expect(ed().past).toHaveLength(n);
  });
  it('ignored on a locked track', () => {
    const { v, ids } = open((v) => [mkVideo(v, 0, 3)]);
    ed().updateTrack(v, { locked: true });
    ed().updateClip(ids[0]!, { threeD: true });
    expect(vid(ids[0]!).threeD).toBeUndefined();
  });
  it('keeps animated 3d props and static 3d settings together', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 5)]);
    ed().updateClip(ids[0]!, { threeD: true, lookAt: 'camera' });
    ed().setKeyframe(ids[0]!, 'rotY', 0, 0);
    ed().setKeyframe(ids[0]!, 'rotY', 4, 90);
    expect(vid(ids[0]!)).toMatchObject({ threeD: true, lookAt: 'camera' });
    expect(valueAt(clipOf(ids[0]!), 'rotY', 2)).toBeCloseTo(45, 6);
  });
});

describe('updateTransform (3d fields)', () => {
  it('changes z, rotX and rotY', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 3)]);
    ed().updateTransform(ids[0]!, { z: 300, rotX: 20, rotY: -40 });
    expect(vid(ids[0]!).transform).toMatchObject({ z: 300, rotX: 20, rotY: -40, x: 0, scale: 1 });
  });
  it('works on text and image', () => {
    const { ids } = open((v) => [mkText(v, 0, 3), mkImage(v, 3, 3)]);
    for (const id of ids) {
      ed().updateTransform(id, { z: -100 });
      expect((clipOf(id) as TextClip | ImageClip).transform.z).toBe(-100);
    }
  });
  it('a change of only z counts as a change (history)', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 3)]);
    ed().updateTransform(ids[0]!, { z: 1 });
    expect(ed().past).toHaveLength(1);
  });
  it('the same value again is a no-op', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 3)]);
    ed().updateTransform(ids[0]!, { rotX: 10 });
    ed().updateTransform(ids[0]!, { rotX: 10 });
    expect(ed().past).toHaveLength(1);
  });
  it('z = 0 equals a missing z (no change)', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 3)]);
    ed().updateTransform(ids[0]!, { z: 0, rotX: 0, rotY: 0 });
    expect(ed().past).toHaveLength(0);
  });
  it('still clamps opacity and scale', () => {
    const { ids } = open((v) => [mkVideo(v, 0, 3)]);
    ed().updateTransform(ids[0]!, { opacity: 3, scale: 0 });
    expect(vid(ids[0]!).transform.opacity).toBe(1);
    expect(vid(ids[0]!).transform.scale).toBe(0.01);
  });
  it('ignores audio, effect and camera clips', () => {
    const { a } = open((v, a) => [mkAudio(a, 0, 3)]);
    const cam = ed().addCamera({ start: 10 });
    const before = proj();
    ed().updateTransform(proj().clips.find((c) => c.trackId === a)!.id, { z: 5 });
    ed().updateTransform(cam, { z: 5 });
    expect(proj()).toBe(before);
  });
  it('ignored on a locked track', () => {
    const { v, ids } = open((v) => [mkVideo(v, 0, 3)]);
    ed().updateTrack(v, { locked: true });
    ed().updateTransform(ids[0]!, { z: 5 });
    expect(vid(ids[0]!).transform.z).toBeUndefined();
  });
});
