import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, EffectClip, ImageClip, Keyframe, Project } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { evalKeys } from '../../lib/anim';
import type { KeyRef } from '../../store/ui';
import { captureKeyCopy, captureKeys, getKeyClip, getKeyCopy, hasKeyCopy, placeKeyCopy, setKeyClip, setKeyCopy } from './keyClipboard';
import type { KeyClip } from './keyClipboard';

const k = (t: number, v = 0, ease: Keyframe['ease'] = 'linear'): Keyframe => ({ t, v, ease });
const image = (id: string, trackId: string, start: number, duration: number, keyframes?: ImageClip['keyframes']): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM }, ...(keyframes ? { keyframes } : {}),
});
const effect = (id: string, trackId: string, duration: number): EffectClip => ({
  id, type: 'effect', trackId, start: 0, duration, name: id, fadeIn: 0, fadeOut: 0, effect: 'shake', params: {}, amount: 1, seed: 1, target: null,
});
const ref = (clipId: string, prop: string, t: number): KeyRef => ({ clipId, prop, t });
function make(clips: (v: string, a: string) => Clip[]): Project {
  const p = createProject('keys', undefined, 30);
  return { ...p, clips: clips(p.tracks[0]!.id, p.tracks[1]!.id) };
}

beforeEach(() => setKeyCopy(null));

describe('captureKeyCopy', () => {
  it('captureKeyCopy offsets from the earliest key', () => {
    const p = make((v, a) => [image('late', a, 10, 6, { x: [k(1, 5), k(3, 6)] }), image('early', v, 4, 8, { x: [k(2, 1, 'ease'), k(5, 2)], y: [k(4, 9)] })]);
    const sel = [ref('late', 'x', 3), ref('early', 'x', 2), ref('early', 'y', 4), ref('early', 'x', 5), ref('late', 'x', 1)];
    const copy = captureKeyCopy(p, sel)!;
    // the earliest key is early x at 4 + 2 = 6 on the timeline. items follow the shown order: track, start
    expect(copy.items.map((i) => i.clipId)).toEqual(['early', 'late']);
    expect(copy.items[0]!.keys).toEqual({ x: [k(0, 1, 'ease'), k(3, 2)], y: [k(2, 9)] });
    expect(copy.items[1]!.keys).toEqual({ x: [k(5, 5), k(7, 6)] });
    // a key with handles keeps them
    const h: Keyframe = { t: 1, v: 2, ease: 'bezier', out: { speed: 1, influence: 30 } };
    const q = make((v) => [image('a', v, 0, 4, { x: [h, k(2, 3)] })]);
    expect(captureKeyCopy(q, [ref('a', 'x', 1)])!.items[0]!.keys.x![0]).toEqual({ ...h, t: 0 });
  });

  it('nothing live gives null', () => {
    const p = make((v) => [image('a', v, 0, 4, { x: [k(-1), k(1)] })]);
    expect(captureKeyCopy(p, [])).toBeNull();
    expect(captureKeyCopy(p, [ref('a', 'x', 3), ref('a', 'x', -1), ref('gone', 'x', 1)])).toBeNull();
  });
});

describe('placeKeyCopy', () => {
  const clip = image('a', 't', 0, 4);
  const keys = (n: number[]): KeyClip => ({ x: n.map((t, i) => k(t, i + 1)) });

  it('placeKeyCopy edge keys at both ends', () => {
    // the first key lands at -1: the key at 0 holds the value of the full animation there, with the ease of the key before it
    const start = placeKeyCopy({ x: [k(0, 0, 'ease'), k(2, 10, 'bounce'), k(3, 20)] }, clip, -1);
    const s = start.keys.x!;
    expect(s[0]).toEqual({ t: 0, v: evalKeys([k(-1, 0, 'ease'), k(1, 10, 'bounce'), k(2, 20)], 0), ease: 'ease' });
    expect(s.map((x) => x.t)).toEqual([0, 1, 2]);
    expect(start.leftOut).toEqual([]);
    // cut after the end: an end key with the curve value, straight
    const end = placeKeyCopy({ x: [k(0, 0), k(1, 10), k(6, 60)] }, clip, 2);
    const e = end.keys.x!;
    expect(e.map((x) => x.t)).toEqual([2, 3, 4]);
    expect(e[2]).toEqual({ t: 4, v: evalKeys([k(2, 0), k(3, 10), k(8, 60)], 4), ease: 'linear' });
    // both: edge keys at both ends, middle keys between
    const both = placeKeyCopy({ x: [k(0, 0), k(2, 10), k(5, 50), k(9, 90)] }, clip, -1);
    expect(both.keys.x!.map((x) => x.t)).toEqual([0, 1, 4]);
    // a key within a millisecond of the start needs no edge key
    const near = placeKeyCopy({ x: [k(0, 1), k(1, 2)] }, clip, -0.9995);
    expect(near.keys.x!).toHaveLength(1);
    expect(near.keys.x![0]!.t).toBeCloseTo(0.0005, 9);
    // a key a hair past the end counts as inside, its time clamped to the end
    const edge = placeKeyCopy({ x: [k(0, 1), k(2, 2)] }, clip, 4.0000005);
    expect(edge.keys.x!.map((x) => x.t)).toEqual([4]);
  });

  it('placeKeyCopy no key inside', () => {
    // keys on one side only: nothing, and not left out
    for (const at of [-10, 10]) {
      const r = placeKeyCopy(keys([0, 1]), clip, at);
      expect(r.keys).toEqual({});
      expect(r.leftOut).toEqual([]);
    }
    // keys on both sides: keys at 0 and at the end
    const r = placeKeyCopy(keys([0, 10]), clip, -3);
    expect(r.keys.x).toEqual([
      { t: 0, v: evalKeys([k(-3, 1), k(7, 2)], 0), ease: 'linear' },
      { t: 4, v: evalKeys([k(-3, 1), k(7, 2)], 4), ease: 'linear' },
    ]);
    expect(r.leftOut).toEqual([]);
  });

  it('placeKeyCopy leaves out what canKey refuses', () => {
    const r = placeKeyCopy({ x: [k(0, 1)], volume: [k(0, 1)], 'p.speed': [k(0, 2)], mask: [k(0, 1)] }, clip, 1);
    expect(Object.keys(r.keys)).toEqual(['x']);
    expect(r.leftOut).toEqual(['volume', 'p.speed', 'mask']);
    // an effect takes its own settings and amount, not a position
    const fx = effect('f', 't', 4);
    const q = placeKeyCopy({ amount: [k(0, 1)], x: [k(0, 1)], 'p.speed': [k(0, 3)], 'p.nothing': [k(0, 3)] }, fx, 1);
    expect(Object.keys(q.keys).sort()).toEqual(['amount', 'p.speed']);
    expect(q.leftOut).toEqual(['x', 'p.nothing']);
    // keys go by spread: a handle rides along
    const withHandle = placeKeyCopy({ x: [{ t: 0, v: 1, ease: 'bezier', out: { speed: 2, influence: 30 } }, k(1, 2)] }, clip, 1);
    expect(withHandle.keys.x![0]).toEqual({ t: 1, v: 1, ease: 'bezier', out: { speed: 2, influence: 30 } });
  });
});

describe('the clipboard', () => {
  it('setKeyClip and getKeyClip keep the object', () => {
    expect(getKeyClip()).toBeNull();
    expect(hasKeyCopy()).toBe(false);
    const data = captureKeys({ x: [k(2, 1), k(3, 2)] })!;
    setKeyClip(data);
    expect(getKeyClip()).toBe(data);
    expect(getKeyClip()).toBe(getKeyClip());
    expect(getKeyCopy()).toEqual({ items: [{ clipId: '', keys: data }] });
    expect(hasKeyCopy()).toBe(true);
    setKeyClip(null);
    expect(getKeyClip()).toBeNull();
    expect(getKeyCopy()).toBeNull();
    expect(hasKeyCopy()).toBe(false);
    // an empty copy is no copy
    setKeyCopy({ items: [] });
    expect(hasKeyCopy()).toBe(false);
    expect(getKeyClip()).toBeNull();
  });

  it('getKeyClip is item 0 rebased', () => {
    const own: KeyClip = { x: [k(0, 1), k(2, 2)] };
    setKeyCopy({ items: [{ clipId: 'a', keys: own }] });
    expect(getKeyClip()).toBe(own);
    // item 0 does not start at its own 0: a rebased copy, made once
    const late: KeyClip = { x: [k(3, 1), k(5, 2)], y: [k(4, 9)] };
    setKeyCopy({ items: [{ clipId: 'a', keys: late }, { clipId: 'b', keys: { x: [k(0, 5)] } }] });
    const first = getKeyClip()!;
    expect(first).not.toBe(late);
    expect(first).toEqual({ x: [k(0, 1), k(2, 2)], y: [k(1, 9)] });
    expect(getKeyClip()).toBe(first);
    expect(late.x![0]!.t).toBe(3);
    // the copy keeps its own offsets
    expect(getKeyCopy()!.items[0]!.keys).toBe(late);
  });
});
