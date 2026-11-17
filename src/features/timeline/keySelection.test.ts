import { describe, expect, it } from 'vitest';
import type { Clip, ImageClip, Keyframe, Project } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject, createTrack } from '../../lib/factory';
import { sameKeyRefs } from '../../store/ui';
import type { KeyRef } from '../../store/ui';
import { allKeyRefs, hasRef, keyRefsAt, keySelFor, laneId, liveKeySel, pickKeys, refIndex, rememberKeySel, selByLane, shownKeyClips } from './keySelection';

const k = (t: number, v = 0): Keyframe => ({ t, v, ease: 'linear' });
const image = (id: string, trackId: string, start: number, duration: number, keyframes?: ImageClip['keyframes']): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM }, ...(keyframes ? { keyframes } : {}),
});
const ref = (clipId: string, prop: string, t: number): KeyRef => ({ clipId, prop, t });

/** three video tracks, the second one locked */
function make(clips: (t: string[]) => Clip[]): Project {
  const p = createProject('keys', undefined, 30);
  const tracks = [createTrack('video', 'v1'), { ...createTrack('video', 'v2'), locked: true }, createTrack('video', 'v3')];
  return { ...p, tracks, clips: clips(tracks.map((t) => t.id)) };
}

describe('keySelection', () => {
  it('sameKeyRefs ignores order and tiny t', () => {
    const a = [ref('a', 'x', 1), ref('b', 'y', 2)];
    expect(sameKeyRefs(a, [ref('b', 'y', 2 + 5e-5), ref('a', 'x', 1 - 5e-5)])).toBe(true);
    expect(sameKeyRefs(a, [ref('a', 'x', 1), ref('b', 'y', 2.001)])).toBe(false);
    expect(sameKeyRefs(a, [ref('a', 'x', 1)])).toBe(false);
    expect(sameKeyRefs([], [])).toBe(true);
    expect(laneId('a', 'x')).toBe('a\u0000x');
  });

  it('shownKeyClips by track then start, no locked', () => {
    const p = make((t) => [image('late', t[0]!, 5, 2), image('early', t[0]!, 1, 2), image('locked', t[1]!, 0, 2), image('top', t[2]!, 0, 2), image('out', t[0]!, 9, 1)]);
    expect(shownKeyClips(p, ['top', 'late', 'locked', 'early', 'gone']).map((c) => c.id)).toEqual(['early', 'late', 'top']);
    expect(shownKeyClips(p, [])).toEqual([]);
  });

  it('refIndex within 1e-4, not outside', () => {
    const p = make((t) => [image('a', t[0]!, 0, 4, { x: [k(-1), k(0), k(2), k(4), k(6)] })]);
    const a = p.clips[0]!;
    expect(refIndex(a, ref('a', 'x', 2))).toBe(2);
    expect(refIndex(a, ref('a', 'x', 2 + 9e-5))).toBe(2);
    expect(refIndex(a, ref('a', 'x', 2 + 2e-4))).toBe(-1);
    expect(refIndex(a, ref('a', 'x', 0))).toBe(1);
    expect(refIndex(a, ref('a', 'x', 4))).toBe(3);
    // outside keys are never named, a gone value or an empty list gives -1
    expect(refIndex(a, ref('a', 'x', -1))).toBe(-1);
    expect(refIndex(a, ref('a', 'x', 6))).toBe(-1);
    expect(refIndex(a, ref('a', 'y', 2))).toBe(-1);
    expect(refIndex({ ...a, keyframes: { x: [] } }, ref('a', 'x', 2))).toBe(-1);
  });

  it('liveKeySel drops gone, outside, unshown, locked', () => {
    const p = make((t) => [image('a', t[0]!, 0, 4, { x: [k(-1), k(1), k(2), k(9)] }), image('b', t[1]!, 0, 4, { x: [k(1)] }), image('c', t[2]!, 0, 4, { x: [k(1)] })]);
    const sel = [ref('a', 'x', 1), ref('a', 'x', 1.5), ref('a', 'x', -1), ref('a', 'x', 9), ref('b', 'x', 1), ref('c', 'x', 1), ref('zz', 'x', 1), ref('a', 'y', 1)];
    expect(liveKeySel(p, sel)).toEqual([ref('a', 'x', 1), ref('c', 'x', 1)]);
    expect(liveKeySel(p, sel, new Set(['a']))).toEqual([ref('a', 'x', 1)]);
    expect(liveKeySel(p, sel, new Set())).toEqual([]);
  });

  it('liveKeySel keeps the same array', () => {
    const p = make((t) => [image('a', t[0]!, 0, 4, { x: [k(1), k(2)] })]);
    const sel = [ref('a', 'x', 1), ref('a', 'x', 2)];
    expect(liveKeySel(p, sel)).toBe(sel);
    expect(liveKeySel(p, sel, new Set(['a']))).toBe(sel);
    expect(liveKeySel(p, sel, new Set(['b']))).not.toBe(sel);
    const none: KeyRef[] = [];
    expect(liveKeySel(p, none)).toBe(none);
  });

  it('pickKeys modes', () => {
    const a = ref('a', 'x', 1);
    const b = ref('a', 'x', 2);
    const c = ref('b', 'y', 3);
    const sel = [a, b];
    expect(pickKeys(sel, [c], 'replace')).toEqual([c]);
    expect(pickKeys(sel, [b, c], 'add')).toEqual([a, b, c]);
    // toggle: all selected they go, else the missing come
    expect(pickKeys(sel, [a, b], 'toggle')).toEqual([]);
    expect(pickKeys(sel, [b], 'toggle')).toEqual([a]);
    expect(pickKeys(sel, [b, c], 'toggle')).toEqual([a, b, c]);
    expect(pickKeys(sel, [ref('a', 'x', 1 + 5e-5)], 'toggle')).toEqual([b]);
    const out = pickKeys(sel, [], 'replace');
    expect(out).toEqual([]);
    expect(pickKeys(sel, [c], 'add')).not.toBe(sel);
    expect(hasRef(sel, ref('a', 'x', 2 + 5e-5))).toBe(true);
    expect(hasRef(sel, ref('a', 'y', 2))).toBe(false);
  });

  it('allKeyRefs inside only', () => {
    const p = make((t) => [image('a', t[0]!, 0, 4, { x: [k(-1), k(0), k(4), k(5)], y: [k(2)] }), image('b', t[1]!, 0, 4, { x: [k(1)] }), image('c', t[2]!, 0, 4)]);
    expect(allKeyRefs(p, ['a', 'b', 'c'])).toEqual([ref('a', 'x', 0), ref('a', 'x', 4), ref('a', 'y', 2)]);
    expect(allKeyRefs(p, ['c', 'zz'])).toEqual([]);
  });

  it('keyRefsAt every value', () => {
    const p = make((t) => [image('a', t[0]!, 10, 4, { x: [k(1), k(2)], y: [k(1.00004)], opacity: [k(3)] }), image('b', t[2]!, 11, 4, { x: [k(0), k(1)] })]);
    expect(keyRefsAt(p, ['a', 'b'], 11, 1e-3)).toEqual([ref('a', 'x', 1), ref('a', 'y', 1.00004), ref('b', 'x', 0)]);
    expect(keyRefsAt(p, ['a'], 11, 1e-3)).toHaveLength(2);
    expect(keyRefsAt(p, ['a', 'b'], 20, 1e-3)).toEqual([]);
    expect(keyRefsAt(p, ['a', 'b'], 12.2, 0.3).map((r) => r.clipId + r.prop)).toEqual(['ax', 'bx']);
  });

  it('keySelFor by clips array', () => {
    const p = make((t) => [image('a', t[0]!, 0, 4)]);
    const sel = [ref('a', 'x', 1)];
    expect(keySelFor(p.clips)).toBeUndefined();
    rememberKeySel(p.clips, sel);
    expect(keySelFor(p.clips)).toEqual(sel);
    // a copy: later changes to the passed list do not reach it
    sel.push(ref('a', 'x', 2));
    expect(keySelFor(p.clips)).toHaveLength(1);
    expect(keySelFor([...p.clips])).toBeUndefined();
    const lanes = selByLane([ref('a', 'x', 3), ref('a', 'x', 1), ref('a', 'y', 2)]);
    expect([...lanes.get(laneId('a', 'x'))!]).toEqual([1, 3]);
    expect([...lanes.keys()]).toEqual([laneId('a', 'x'), laneId('a', 'y')]);
  });
});
