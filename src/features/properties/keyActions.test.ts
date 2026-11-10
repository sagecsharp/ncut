import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioClip, Clip, EffectClip, ImageClip, Keyframe, MediaAsset, Project, ShapeClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject, createShapeClip } from '../../lib/factory';
import { evalKeys } from '../../lib/anim';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { copyKeysAction, fitKeysAction, pasteKeysAction, repeatKeysAction, reverseKeysAction, wiggleAction } from './keyActions';
import { setKeyClip } from './keyClipboard';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = <T extends Clip>(id: string): T => proj().clips.find((c) => c.id === id) as T;
const keysOf = (id: string, prop: string): Keyframe[] => clipOf(id).keyframes?.[prop] ?? [];
const lastToast = (): string => useUi.getState().toasts.at(-1)?.message ?? '';
const lin = (...pairs: [number, number][]): Keyframe[] => pairs.map(([t, v]) => ({ t, v, ease: 'linear' as const }));
const at = (time: number) => usePlayback.setState({ time });

const asset = (id: string): MediaAsset => ({ id, name: id, kind: 'image', mime: 'image/png', size: 1, duration: 0, width: 100, height: 100, hasAudio: false, createdAt: 0 });
const image = (trackId: string, id: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const audio = (trackId: string, id: string, start: number, duration: number): AudioClip => ({
  id, type: 'audio', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', trimStart: 0, speed: 1, volume: 1, muted: false,
});
const fx = (trackId: string, id: string, start: number, duration: number): EffectClip => ({
  id, type: 'effect', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, effect: 'shake', params: {}, amount: 1, seed: 1, target: null,
});

function open(make: (t: string[]) => Clip[]): string[] {
  const p = createProject('r17');
  ed().openProject({ ...p, assets: [asset('img1')], clips: [] });
  for (let i = 0; i < 2; i++) ed().addTrack('video');
  const ids = proj().tracks.map((t) => t.id);
  useEditor.setState({ project: { ...proj(), clips: make(ids) }, past: [], future: [] });
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
  usePlayback.setState({ time: 0 });
  setKeyClip(null);
});

describe('reverse / fit / repeat', () => {
  it('reverse plays the keys backwards, one undo step', () => {
    open((t) => [image(t[0]!, 'a', 0, 4, { keyframes: { x: lin([0, 0], [1, 100], [2, 300]) } })]);
    oneStep(() => reverseKeysAction('a'));
    expect(keysOf('a', 'x').map((k) => [k.t, k.v])).toEqual([[0, 300], [1, 100], [2, 0]]);
    expect(lastToast()).toBe('keyframes reversed');
  });

  it('reverse on a curve that is its own mirror changes nothing', () => {
    open((t) => [image(t[0]!, 'a', 0, 4, { keyframes: { x: lin([0, 0], [1, 100], [2, 0]) } })]);
    noStep(() => reverseKeysAction('a'));
    expect(lastToast()).toBe('nothing changed');
  });

  it('fit stretches the keys over the whole clip', () => {
    open((t) => [image(t[0]!, 'a', 0, 4, { keyframes: { x: lin([1, 0], [2, 100]) } })]);
    oneStep(() => fitKeysAction('a'));
    expect(keysOf('a', 'x').map((k) => k.t)).toEqual([0, 4]);
  });

  it('repeat doubles the pattern inside the same span, ping pong plays the second pass backwards', () => {
    open((t) => [image(t[0]!, 'a', 0, 4, { keyframes: { x: lin([0, 0], [2, 100]) } })]);
    oneStep(() => repeatKeysAction('a', false));
    const plain = keysOf('a', 'x');
    expect(plain[0]!.t).toBe(0);
    expect(plain.at(-1)!.t).toBeCloseTo(2, 6);
    expect(plain.at(-1)!.v).toBe(100);
    expect(evalKeys(plain, 0.5)).toBeCloseTo(50, 0);
    expect(evalKeys(plain, 1.5)).toBeCloseTo(50, 0);
    expect(lastToast()).toBe('keyframes repeated x2');

    open((t) => [image(t[0]!, 'a', 0, 4, { keyframes: { x: lin([0, 0], [2, 100]) } })]);
    oneStep(() => repeatKeysAction('a', true));
    const pp = keysOf('a', 'x');
    expect(evalKeys(pp, 1)).toBeCloseTo(100, 3);
    expect(pp.at(-1)!.v).toBe(0);
    expect(lastToast()).toBe('keyframes repeated, ping pong');
  });

  it('repeat on a property that has too many keys already: a toast, no step', () => {
    const many = lin(...Array.from({ length: 150 }, (_, i): [number, number] => [i * 0.02, i]));
    open((t) => [image(t[0]!, 'a', 0, 4, { keyframes: { x: many } })]);
    noStep(() => repeatKeysAction('a', false));
    expect(lastToast()).toBe('too many keyframes to repeat again');
  });

  it('a clip without keys: a toast, no step', () => {
    open((t) => [image(t[0]!, 'a', 0, 4)]);
    for (const run of [() => reverseKeysAction('a'), () => fitKeysAction('a'), () => repeatKeysAction('a', true)]) {
      noStep(run);
      expect(lastToast()).toBe('no keyframes to change');
    }
  });

  it('a locked track: nothing changes', () => {
    const t = open((t) => [image(t[0]!, 'a', 0, 4, { keyframes: { x: lin([0, 0], [1, 100], [2, 300]) } })]);
    lock(t[0]!);
    for (const run of [() => reverseKeysAction('a'), () => fitKeysAction('a'), () => repeatKeysAction('a', false), () => wiggleAction('a', 'x', 10, 4), () => pasteKeysAction('a')]) {
      setKeyClip({ x: lin([0, 1]) });
      noStep(run);
      expect(lastToast()).toBe('this track is locked');
    }
  });
});

describe('wiggle', () => {
  it('a still property: keys around its value, one undo step', () => {
    open((t) => [image(t[0]!, 'a', 0, 4, { transform: { ...DEFAULT_TRANSFORM, x: 100 } })]);
    oneStep(() => wiggleAction('a', 'x', 20, 4));
    const keys = keysOf('a', 'x');
    expect(keys.length).toBeGreaterThan(4);
    expect(keys[0]!.t).toBe(0);
    expect(keys.at(-1)!.t).toBeCloseTo(4, 3);
    for (const k of keys) expect(Math.abs(k.v - 100)).toBeLessThanOrEqual(20 + 1e-6);
    expect(lastToast()).toBe(`wiggle added, ${keys.length} keys`);
  });

  it('an animated property: the old curve is still visible in the result', () => {
    const old = lin([0, 0], [2, 400]);
    open((t) => [image(t[0]!, 'a', 0, 4, { keyframes: { x: old } })]);
    oneStep(() => wiggleAction('a', 'x', 5, 6));
    const keys = keysOf('a', 'x');
    for (const k of keys) expect(Math.abs(k.v - evalKeys(old, k.t))).toBeLessThanOrEqual(5 + 1e-6);
    // the ramp survived: the end is far away from the start
    expect(evalKeys(keys, 2) - evalKeys(keys, 0)).toBeGreaterThan(300);
    expect(lastToast()).toBe(`wiggle added on top of the animation, ${keys.length} keys`);
  });

  it('other properties keep their keys', () => {
    const opacity = lin([0, 0], [1, 1]);
    open((t) => [image(t[0]!, 'a', 0, 4, { keyframes: { opacity } })]);
    wiggleAction('a', 'rotation', 5, 4);
    expect(keysOf('a', 'opacity')).toEqual(opacity);
    expect(keysOf('a', 'rotation').length).toBeGreaterThan(2);
  });

  it('works with the playhead off the clip', () => {
    open((t) => [image(t[0]!, 'a', 2, 4, { transform: { ...DEFAULT_TRANSFORM, x: 100 } })]);
    at(30);
    wiggleAction('a', 'x', 10, 4);
    expect(keysOf('a', 'x').length).toBeGreaterThan(2);
    expect(ed().past.length).toBe(1);
  });

  it('a property the clip cannot animate, or a bad number: a toast, no step', () => {
    open((t) => [image(t[0]!, 'a', 0, 4), audio(t[3]!, 'au', 0, 4)]);
    noStep(() => wiggleAction('a', 'volume', 1, 4));
    expect(lastToast()).toBe('this clip cannot animate that');
    noStep(() => wiggleAction('au', 'x', 1, 4));
    expect(lastToast()).toBe('this clip cannot animate that');
    noStep(() => wiggleAction('a', 'x', Number.NaN, 4));
    expect(lastToast()).toBe('cannot wiggle that');
    noStep(() => wiggleAction('a', 'x', 5, Number.POSITIVE_INFINITY));
    expect(lastToast()).toBe('cannot wiggle that');
  });
});

describe('copy and paste', () => {
  const source = { x: lin([0, 0], [1, 100], [2, 50]), opacity: lin([0, 0], [1, 1]) };

  it('copy makes a toast and no step, a clip without keys has nothing to copy', () => {
    open((t) => [image(t[0]!, 'a', 0, 4, { keyframes: source }), image(t[1]!, 'b', 0, 4)]);
    noStep(() => copyKeysAction('a'));
    expect(lastToast()).toBe('keys copied');
    noStep(() => copyKeysAction('b'));
    expect(lastToast()).toBe('no keyframes to copy');
  });

  it('paste puts the first key at the playhead, one undo step', () => {
    open((t) => [image(t[0]!, 'a', 0, 4, { keyframes: source }), image(t[1]!, 'b', 2, 6)]);
    copyKeysAction('a');
    useEditor.setState({ past: [], future: [] });
    at(3);
    oneStep(() => pasteKeysAction('b'));
    expect(keysOf('b', 'x').map((k) => [k.t, k.v])).toEqual([[1, 0], [2, 100], [3, 50]]);
    expect(keysOf('b', 'opacity').map((k) => k.t)).toEqual([1, 2]);
    expect(lastToast()).toBe('5 keys pasted');
  });

  it('paste replaces what lay in its span and keeps older keys before and after', () => {
    const old = lin([0, 7], [1, 8], [4, 9], [5, 10]);
    open((t) => [image(t[0]!, 'a', 0, 6, { keyframes: source }), image(t[1]!, 'b', 0, 6, { keyframes: { x: old } })]);
    copyKeysAction('a');
    useEditor.setState({ past: [], future: [] });
    at(2);
    pasteKeysAction('b');
    expect(keysOf('b', 'x').map((k) => [k.t, k.v])).toEqual([[0, 7], [1, 8], [2, 0], [3, 100], [4, 50], [5, 10]]);
  });

  it('another clip type: only what that clip can animate is pasted', () => {
    const withShape = { ...source, drawEnd: lin([0, 0], [1, 1]), volume: lin([0, 0], [1, 1]) };
    open((t) => [
      image(t[0]!, 'a', 0, 4, { keyframes: withShape }),
      createShapeClip(t[1]!, 0, { id: 's', duration: 4 }),
      audio(t[3]!, 'au', 0, 4),
      fx(t[2]!, 'e', 0, 4),
    ]);
    copyKeysAction('a');
    useEditor.setState({ past: [], future: [] });
    pasteKeysAction('s');
    expect(Object.keys(clipOf<ShapeClip>('s').keyframes!).sort()).toEqual(['drawEnd', 'opacity', 'x']);
    expect(keysOf('s', 'volume')).toEqual([]);
    pasteKeysAction('au');
    expect(Object.keys(clipOf<AudioClip>('au').keyframes!)).toEqual(['volume']);
    expect(ed().past.length).toBe(2);
    const before = proj();
    pasteKeysAction('e');
    expect(proj()).toBe(before);
    expect(lastToast()).toBe('nothing to paste here');
  });

  it('paste near the clip end: keys past the end are left out, a closing key holds the curve there', () => {
    open((t) => [image(t[0]!, 'a', 0, 4, { keyframes: { x: lin([0, 0], [2, 100]) } }), image(t[1]!, 'b', 0, 4)]);
    copyKeysAction('a');
    useEditor.setState({ past: [], future: [] });
    at(3);
    pasteKeysAction('b');
    const keys = keysOf('b', 'x');
    expect(keys.map((k) => k.t)).toEqual([3, 4]);
    expect(keys[0]!.v).toBe(0);
    // halfway up the ramp at the clip end
    expect(keys[1]!.v).toBeCloseTo(50, 3);
    expect(lastToast()).toBe('2 keys pasted');
  });

  it('paste exactly at the clip end still writes the first key', () => {
    open((t) => [image(t[0]!, 'a', 0, 4, { keyframes: { x: lin([0, 5], [2, 100]) } }), image(t[1]!, 'b', 0, 4)]);
    copyKeysAction('a');
    at(4);
    pasteKeysAction('b');
    expect(keysOf('b', 'x').map((k) => [k.t, k.v])).toEqual([[4, 5]]);
  });

  it('paste with the playhead off the clip: a toast, no step', () => {
    open((t) => [image(t[0]!, 'a', 0, 4, { keyframes: source }), image(t[1]!, 'b', 2, 2)]);
    copyKeysAction('a');
    for (const time of [1, 5]) {
      at(time);
      noStep(() => pasteKeysAction('b'));
      expect(lastToast()).toBe('move the playhead onto the clip first: the keys start there');
    }
  });

  it('nothing copied: a toast, no step', () => {
    open((t) => [image(t[0]!, 'a', 0, 4)]);
    noStep(() => pasteKeysAction('a'));
    expect(lastToast()).toBe('nothing to paste here');
  });

  it('pasting the same keys on the same place twice is one step', () => {
    open((t) => [image(t[0]!, 'a', 0, 4, { keyframes: source }), image(t[1]!, 'b', 0, 4)]);
    copyKeysAction('a');
    at(1);
    pasteKeysAction('b');
    pasteKeysAction('b');
    expect(ed().past.length).toBe(1);
    expect(lastToast()).toBe('these keys are already here');
  });
});
