import { describe, expect, it } from 'vitest';
import type { AudioClip, Clip, Easing, ImageClip, Keyframe, Project, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import type { KeyRef } from '../../store/ui';
import { MAX_KEYS_PER_PROP } from '../properties/keyTools';
import type { KeyCopy } from '../properties/keyClipboard';
import { EMPTY_PLAN, keyMoveRange, planKeyDelete, planKeyEase, planKeyMove, planKeyNudge, planKeyPaste, planKeyScale, resolveKeySel } from './keyPlan';

const k = (t: number, v: number, ease: Easing = 'linear'): Keyframe => ({ t, v, ease });
const image = (id: string, trackId: string, start: number, duration: number, keyframes?: ImageClip['keyframes']): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM }, ...(keyframes ? { keyframes } : {}),
});
const video = (id: string, trackId: string, start: number, duration: number, group?: string): VideoClip => ({
  id, type: 'video', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'vid1', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...(group ? { group } : {}),
});
const sound = (id: string, trackId: string, start: number, duration: number, group?: string): AudioClip => ({
  id, type: 'audio', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'vid1', trimStart: 0, speed: 1, volume: 1, muted: false, ...(group ? { group } : {}),
});
function make(clips: (v: string, a: string) => Clip[], locked: 'video' | 'audio' | null = null): Project {
  const p = createProject('keys', undefined, 30);
  const v = p.tracks[0]!.id;
  const a = p.tracks[1]!.id;
  return { ...p, tracks: p.tracks.map((t) => (t.kind === locked ? { ...t, locked: true } : t)), clips: clips(v, a) };
}
const ref = (clipId: string, prop: string, t: number): KeyRef => ({ clipId, prop, t });
const keysOf = (p: Project, plan: { writes: { id: string; keyframes: Record<string, Keyframe[]> }[] }, id: string, prop: string): Keyframe[] =>
  plan.writes.find((w) => w.id === id)!.keyframes[prop]!;
const times = (keys: Keyframe[]) => keys.map((x) => x.t);

describe('keyPlan', () => {
  it('move only the selected keys', () => {
    const p = make((v) => [image('a', v, 0, 10, { x: [k(0, 0), k(1, 10), k(2, 20), k(6, 60)] })]);
    const plan = planKeyMove(p, [ref('a', 'x', 1), ref('a', 'x', 2)], 2);
    expect(plan.stop).toBeNull();
    expect(plan.amount).toBeCloseTo(2, 9);
    const keys = keysOf(p, plan, 'a', 'x');
    expect(times(keys)).toEqual([0, 3, 4, 6]);
    expect(keys.map((x) => x.v)).toEqual([0, 10, 20, 60]);
    expect(plan.sel.map((r) => r.t)).toEqual([3, 4]);
    expect(planKeyMove(p, [], 1)).toBe(EMPTY_PLAN);
  });

  it('spacing across clips', () => {
    const p = make((v, a) => [image('a', v, 0, 4, { x: [k(1, 0), k(3, 1)] }), image('b', a, 10, 6, { x: [k(2, 0), k(5, 1)] })]);
    const sel = [ref('a', 'x', 1), ref('a', 'x', 3), ref('b', 'x', 2), ref('b', 'x', 5)];
    expect(keyMoveRange(p, sel)).toEqual({ lo: -1, hi: 1 });
    const plan = planKeyMove(p, sel, 0.5);
    expect(times(keysOf(p, plan, 'a', 'x'))).toEqual([1.5, 3.5]);
    expect(times(keysOf(p, plan, 'b', 'x'))).toEqual([2.5, 5.5]);
    expect(keyMoveRange(p, [])).toEqual({ lo: 0, hi: 0 });
    expect(keyMoveRange(p, [ref('a', 'x', 0)])).toEqual({ lo: 0, hi: 0 });
  });

  it('clamp says which edge', () => {
    const p = make((v, a) => [image('a', v, 0, 4, { x: [k(1, 0), k(3, 1)] }), image('b', a, 10, 6, { x: [k(5, 0)] })]);
    const sel = [ref('a', 'x', 1), ref('a', 'x', 3), ref('b', 'x', 5)];
    const end = planKeyMove(p, sel, 5);
    expect(end.stop).toEqual({ kind: 'end', clipId: 'a' });
    expect(end.amount).toBeCloseTo(1, 9);
    expect(times(keysOf(p, end, 'a', 'x'))).toEqual([2, 4]);
    expect(times(keysOf(p, end, 'b', 'x'))).toEqual([6]);
    const start = planKeyMove(p, sel, -5);
    expect(start.stop).toEqual({ kind: 'start', clipId: 'a' });
    expect(start.amount).toBeCloseTo(-1, 9);
    expect(times(keysOf(p, start, 'a', 'x'))).toEqual([0, 2]);
  });

  it('refuse', () => {
    const p = make((v) => [image('a', v, 0, 4, { x: [k(1, 0), k(3, 1)] })]);
    const sel = [ref('a', 'x', 1), ref('a', 'x', 3)];
    const no = planKeyMove(p, sel, 5, 'refuse');
    expect(no.writes).toEqual([]);
    expect(no.stop).toEqual({ kind: 'end', clipId: 'a' });
    expect(no.sel).toEqual(sel);
    expect(planKeyMove(p, sel, 1, 'refuse').stop).toBeNull();
    expect(planKeyMove(p, sel, 1, 'refuse').writes).toHaveLength(1);
  });

  it('never replaces a key', () => {
    const p = make((v) => [image('a', v, 5, 10, { x: [k(1, 0), k(2, 1), k(4, 2)] })]);
    const plan = planKeyMove(p, [ref('a', 'x', 1)], 1.01);
    expect(plan.writes).toEqual([]);
    expect(plan.stop).toEqual({ kind: 'inTheWay', clipId: 'a', prop: 'x', t: 7 });
    // within half a frame (1/60 s) is in the way, a tenth of a second off is free
    expect(planKeyMove(p, [ref('a', 'x', 1)], 0.99).stop?.kind).toBe('inTheWay');
    expect(planKeyMove(p, [ref('a', 'x', 1)], 0.9).stop).toBeNull();
    expect(planKeyMove(p, [ref('a', 'x', 1)], 2.9).stop).toBeNull();
    // passing a key that stays is fine
    const over = planKeyMove(p, [ref('a', 'x', 1)], 2);
    expect(times(keysOf(p, over, 'a', 'x'))).toEqual([2, 3, 4]);
    expect(keysOf(p, over, 'a', 'x').map((x) => x.v)).toEqual([1, 0, 2]);
    // select both: they move together, nothing is in the way
    expect(planKeyMove(p, [ref('a', 'x', 1), ref('a', 'x', 2)], 1).stop).toBeNull();
    expect(planKeyNudge(p, [ref('a', 'x', 1)], 30).stop?.kind).toBe('inTheWay');
  });

  it('passes keys with their eases', () => {
    const keys: Keyframe[] = [
      { t: 0, v: 0, ease: 'ease' },
      { t: 1, v: 5, ease: 'bezier', out: { speed: 2, influence: 30 } },
      { t: 2, v: 9, ease: 'hold', in: { speed: 1, influence: 40 } },
      { t: 3, v: 1, ease: 'linear' },
    ];
    const p = make((v) => [image('a', v, 0, 10, { x: keys })]);
    const plan = planKeyMove(p, [ref('a', 'x', 1)], 0.5);
    const out = keysOf(p, plan, 'a', 'x');
    expect(out.map((x) => x.ease)).toEqual(['ease', 'bezier', 'hold', 'linear']);
    expect(out[1]).toEqual({ ...keys[1]!, t: 1.5 });
    expect(out[2]).toBe(keys[2]);
  });

  it('carries outside keys', () => {
    const p = make((v) => [image('a', v, 0, 4, { x: [k(-2, 7), k(1, 0), k(2, 1), k(9, 8)] })]);
    // the outside keys are neither shown nor selectable
    expect(resolveKeySel(p, [ref('a', 'x', -2), ref('a', 'x', 9)]).size).toBe(0);
    const plan = planKeyMove(p, [ref('a', 'x', 1)], 0.5);
    expect(times(keysOf(p, plan, 'a', 'x'))).toEqual([-2, 1.5, 2, 9]);
    expect(keysOf(p, plan, 'a', 'x').map((x) => x.v)).toEqual([7, 0, 1, 8]);
    // the block never reaches the outside keys either: they are not in the range
    expect(keyMoveRange(p, [ref('a', 'x', 1)])).toEqual({ lo: -1, hi: 3 });
  });

  it('skips locked', () => {
    const p = make((v, a) => [image('a', v, 0, 4, { x: [k(1, 0)] }), image('b', a, 0, 4, { x: [k(1, 0)] })], 'audio');
    const plan = planKeyMove(p, [ref('a', 'x', 1), ref('b', 'x', 1)], 1);
    expect(plan.writes.map((w) => w.id)).toEqual(['a']);
    expect(plan.sel.map((r) => r.clipId)).toEqual(['a']);
    expect(planKeyMove(p, [ref('b', 'x', 1)], 1)).toBe(EMPTY_PLAN);
    expect(planKeyDelete(p, [ref('b', 'x', 1)])).toBe(EMPTY_PLAN);
  });

  it('scale around a pivot', () => {
    const p = make((v) => [image('a', v, 2, 10, { x: [k(1, 0), k(2, 1), k(4, 2)] })]);
    const sel = [ref('a', 'x', 1), ref('a', 'x', 2), ref('a', 'x', 4)];
    // the pivot is the timeline time 4, the middle key (local 2)
    const plan = planKeyScale(p, sel, 4, 2);
    expect(plan.stop).toBeNull();
    expect(plan.amount).toBe(2);
    const keys = keysOf(p, plan, 'a', 'x');
    expect(keys.map((x) => x.t)).toEqual([0, 2, 6]);
    expect(keys.map((x) => x.v)).toEqual([0, 1, 2]);
    expect(plan.sel.map((r) => r.t)).toEqual([0, 2, 6]);
    expect(planKeyScale(p, sel, 4, Number.NaN)).toEqual({ ...EMPTY_PLAN, sel });
    expect(planKeyScale(p, [], 4, 2)).toBe(EMPTY_PLAN);
  });

  it('scale limits', () => {
    const p = make((v, a) => [image('a', v, 0, 10, { x: [k(2, 0), k(4, 1)] }), image('b', a, 20, 4, { x: [k(1, 0), k(2, 1)] })]);
    const one = [ref('a', 'x', 2), ref('a', 'x', 4)];
    // pivot at 2 (timeline): the key at 4 may go as far as 10 s: s up to 4
    const hi = planKeyScale(p, one, 2, 50);
    expect(hi.stop).toEqual({ kind: 'end', clipId: 'a' });
    expect(hi.amount).toBeCloseTo(4, 9);
    expect(times(keysOf(p, hi, 'a', 'x'))[1]).toBeCloseTo(10, 9);
    // the bounds of the whole scale: gap 2 at MIN_GAP, then 0.01 / 100
    expect(planKeyScale(p, one, 2, 0.0001).amount).toBeCloseTo(0.01, 9);
    expect(planKeyScale(p, one, 2, 0.0001).stop).toEqual({ kind: 'start', clipId: 'a' });
    // two clips: the tighter one names its clip
    const both = [...one, ref('b', 'x', 1), ref('b', 'x', 2)];
    const tight = planKeyScale(p, both, 2, 100);
    expect(tight.stop?.kind).toBe('end');
    expect(tight.stop?.clipId).toBe('b');
    expect(tight.amount).toBeCloseTo(1.1, 9);
    // a refused scale writes nothing
    const no = planKeyScale(p, one, 2, 50, 'refuse');
    expect(no.writes).toEqual([]);
    expect(no.stop?.kind).toBe('end');
    // the range at s 0.01 and 100 with clamp is the amount
    expect(planKeyScale(p, one, 2, 100).amount).toBeCloseTo(4, 9);
    // a key on the pivot is never a limit
    const on = make((v) => [image('a', v, 0, 4, { x: [k(2, 0)] })]);
    expect(planKeyScale(on, [ref('a', 'x', 2)], 2, 100).amount).toBe(100);
  });

  it('keys keep their handles', () => {
    const keys: Keyframe[] = [
      { t: 1, v: 0, ease: 'bezier', out: { speed: 4, influence: 30 } },
      { t: 3, v: 8, ease: 'linear', in: { speed: 2, influence: 50 } },
    ];
    const p = make((v) => [image('a', v, 0, 10, { x: keys })]);
    const plan = planKeyScale(p, [ref('a', 'x', 1), ref('a', 'x', 3)], 1, 2);
    const out = keysOf(p, plan, 'a', 'x');
    expect(out[0]).toEqual({ t: 1, v: 0, ease: 'bezier', out: { speed: 2, influence: 30 } });
    expect(out[1]!.t).toBeCloseTo(5, 9);
    expect(out[1]!.in).toEqual({ speed: 1, influence: 50 });
    // a move changes no handle
    expect(keysOf(p, planKeyMove(p, [ref('a', 'x', 1)], 1), 'a', 'x')[0]).toEqual({ ...keys[0]!, t: 2 });
  });

  it('nudge refused at the edge', () => {
    const p = make((v) => [image('a', v, 0, 4, { x: [k(0, 0), k(2, 1)] })]);
    const no = planKeyNudge(p, [ref('a', 'x', 0), ref('a', 'x', 2)], -1);
    expect(no.writes).toEqual([]);
    expect(no.stop).toEqual({ kind: 'start', clipId: 'a' });
    const ok = planKeyNudge(p, [ref('a', 'x', 0), ref('a', 'x', 2)], 3);
    expect(ok.stop).toBeNull();
    expect(keysOf(p, ok, 'a', 'x')[0]!.t).toBeCloseTo(0.1, 9);
    expect(planKeyNudge(p, [ref('a', 'x', 2)], 61).stop).toEqual({ kind: 'end', clipId: 'a' });
    // a key at 0 gives lo 0, not -0
    expect(keyMoveRange(p, [ref('a', 'x', 0)])).toEqual({ lo: 0, hi: 4 });
  });

  it('delete takes outside keys along', () => {
    const p = make((v) => [image('a', v, 0, 4, { x: [k(-1, 5), k(1, 0), k(2, 1), k(9, 3)], y: [k(1, 0), k(8, 2)] })]);
    const one = planKeyDelete(p, [ref('a', 'x', 1)]);
    expect(times(keysOf(p, one, 'a', 'x'))).toEqual([-1, 2, 9]);
    expect(one.amount).toBe(1);
    expect(one.sel).toEqual([]);
    // the last inside key goes: the value loses all its keys, the outside ones too
    const all = planKeyDelete(p, [ref('a', 'x', 1), ref('a', 'x', 2)]);
    expect(all.writes[0]!.keyframes.x).toBeUndefined();
    expect(all.writes[0]!.keyframes.y).toBeDefined();
    expect(all.amount).toBe(2);
    expect(planKeyDelete(p, [ref('a', 'x', 5)])).toBe(EMPTY_PLAN);
  });

  it('ease counts', () => {
    const p = make((v) => [image('a', v, 0, 4, { x: [k(0, 0, 'ease'), k(1, 1), k(2, 2), k(3, 3)] })]);
    const sel = [ref('a', 'x', 0), ref('a', 'x', 1), ref('a', 'x', 2)];
    const plan = planKeyEase(p, sel, 'ease');
    expect(plan.amount).toBe(2);
    expect(plan.sel).toEqual(sel);
    expect(keysOf(p, plan, 'a', 'x').map((x) => x.ease)).toEqual(['ease', 'ease', 'ease', 'linear']);
    expect(planKeyEase(p, [sel[0]!], 'ease').amount).toBe(0);
    expect(planKeyEase(p, [], 'ease')).toBe(EMPTY_PLAN);
  });

  it('paste onto own clips', () => {
    const p = make((v, a) => [image('a', v, 0, 10, {}), image('b', a, 0, 10, {})]);
    const copy: KeyCopy = { items: [{ clipId: 'a', keys: { x: [k(0, 1), k(1, 2)] } }, { clipId: 'b', keys: { y: [k(0.5, 4)] } }] };
    // a copy of one clip with its own clip among the targets goes onto that clip only
    const own = planKeyPaste(p, { items: [copy.items[0]!] }, ['a', 'b'], 3);
    expect(own.writes.map((w) => w.id)).toEqual(['a']);
    const plan = planKeyPaste(p, copy, ['b', 'a'], 3);
    expect(plan.writes.map((w) => w.id)).toEqual(['a', 'b']);
    expect(times(keysOf(p, plan, 'a', 'x'))).toEqual([3, 4]);
    expect(times(keysOf(p, plan, 'b', 'y'))).toEqual([3.5]);
    expect(plan.pasted).toBe(3);
    expect(plan.amount).toBe(3);
    expect(plan.clips).toBe(2);
    expect(plan.sel).toEqual([ref('a', 'x', 3), ref('a', 'x', 4), ref('b', 'y', 3.5)]);
    expect(plan.outside).toBe(false);
    expect(plan.capped).toBe(false);
  });

  it('paste one onto many', () => {
    const p = make((v, a) => [image('a', v, 0, 10, {}), image('b', a, 1, 10, {})]);
    const plan = planKeyPaste(p, { items: [{ clipId: 'gone', keys: { x: [k(0, 1), k(1, 2)] } }] }, ['a', 'b'], 4);
    expect(plan.clips).toBe(2);
    expect(times(keysOf(p, plan, 'a', 'x'))).toEqual([4, 5]);
    expect(times(keysOf(p, plan, 'b', 'x'))).toEqual([3, 4]);
    expect(plan.pasted).toBe(4);
  });

  it('paste pairs in order', () => {
    const p = make((v, a) => [image('a', v, 0, 10, {}), image('b', a, 0, 10, {}), image('c', v, 20, 10, {})]);
    const copy: KeyCopy = { items: [{ clipId: 'x1', keys: { x: [k(0, 1)] } }, { clipId: 'x2', keys: { y: [k(0, 2)] } }] };
    const plan = planKeyPaste(p, copy, ['a', 'b', 'c'], 2);
    expect(plan.writes.map((w) => w.id)).toEqual(['a', 'b']);
    expect(keysOf(p, plan, 'a', 'x')[0]!.v).toBe(1);
    expect(keysOf(p, plan, 'b', 'y')[0]!.v).toBe(2);
    // more copied clips than targets: the shorter list
    const few = planKeyPaste(p, copy, ['a'], 2);
    expect(few.writes.map((w) => w.id)).toEqual(['a']);
  });

  it('paste replaces its span only', () => {
    const p = make((v) => [image('a', v, 0, 10, { x: [k(0, 0), k(2, 5), k(3, 6), k(5, 7), k(8, 9)] })]);
    const plan = planKeyPaste(p, { items: [{ clipId: 'a', keys: { x: [k(0, 100), k(2, 200)] } }] }, ['a'], 2);
    const keys = keysOf(p, plan, 'a', 'x');
    expect(times(keys)).toEqual([0, 2, 4, 5, 8]);
    expect(keys.map((x) => x.v)).toEqual([0, 100, 200, 7, 9]);
    expect(plan.sel.map((r) => r.t)).toEqual([2, 4]);
  });

  it('paste left out values', () => {
    const p = make((v) => [image('a', v, 0, 10, {})]);
    const plan = planKeyPaste(p, { items: [{ clipId: 'a', keys: { x: [k(0, 1)], volume: [k(0, 1)], 'p.nothing': [k(0, 1)], pan: [k(0, 0)] } }] }, ['a'], 1);
    expect(plan.leftOut).toEqual(['volume', 'p.nothing', 'pan']);
    expect(Object.keys(plan.writes[0]!.keyframes)).toEqual(['x']);
    expect(plan.pasted).toBe(1);
    // a copy nothing fits gives no write
    const none = planKeyPaste(p, { items: [{ clipId: 'a', keys: { volume: [k(0, 1)] } }] }, ['a'], 1);
    expect(none.pasted).toBe(0);
    expect(none.writes).toEqual([]);
    expect(none.leftOut).toEqual(['volume']);
  });

  it('paste volume and pan off a picture with its sound apart', () => {
    const p = make((v, a) => [video('v', v, 0, 10, 'g'), sound('s', a, 0, 10, 'g'), video('lone', v, 20, 10)]);
    const copy: KeyCopy = { items: [{ clipId: 'q', keys: { x: [k(0, 1)], volume: [k(0, 0.5)], pan: [k(0, 1)] } }] };
    const apart = planKeyPaste(p, copy, ['v'], 1);
    expect(apart.leftOut).toEqual(['volume', 'pan']);
    expect(Object.keys(apart.writes[0]!.keyframes).sort()).toEqual(['x']);
    // the sound clip itself takes them, a lone picture too
    const snd = planKeyPaste(p, copy, ['s'], 1);
    expect(Object.keys(snd.writes[0]!.keyframes).sort()).toEqual(['pan', 'volume']);
    expect(snd.leftOut).toEqual(['x']);
    const lone = planKeyPaste(p, copy, ['lone'], 21);
    expect(Object.keys(lone.writes[0]!.keyframes).sort()).toEqual(['pan', 'volume', 'x']);
    expect(lone.leftOut).toEqual([]);
  });

  it('paste caps at 240', () => {
    const old: Keyframe[] = [];
    for (let i = 0; i < 150; i++) old.push(k(10 + i * 0.01, i));
    const p = make((v) => [image('a', v, 0, 30, { x: old })]);
    const mk = (n: number) => Array.from({ length: n }, (_, i) => k(i * 0.01, 1000 + i));
    // 150 old + 100 new: the first 240 stay, the pasted keys are all before the old ones
    const some = planKeyPaste(p, { items: [{ clipId: 'a', keys: { x: mk(100) } }] }, ['a'], 0);
    expect(some.capped).toBe(true);
    expect(keysOf(p, some, 'a', 'x')).toHaveLength(MAX_KEYS_PER_PROP);
    expect(some.pasted).toBe(100);
    expect(some.sel).toHaveLength(100);
    // 300 new keys: only the first 240 of them are kept
    const big = planKeyPaste(p, { items: [{ clipId: 'a', keys: { x: mk(300) } }] }, ['a'], 0);
    expect(big.capped).toBe(true);
    expect(keysOf(p, big, 'a', 'x')).toHaveLength(MAX_KEYS_PER_PROP);
    expect(big.pasted).toBe(MAX_KEYS_PER_PROP);
    expect(big.sel).toHaveLength(MAX_KEYS_PER_PROP);
    const fits = planKeyPaste(p, { items: [{ clipId: 'a', keys: { x: mk(50) } }] }, ['a'], 0);
    expect(fits.capped).toBe(false);
  });

  it('paste outside', () => {
    const p = make((v, a) => [image('a', v, 0, 4, {}), image('b', a, 10, 4, {})], 'audio');
    const copy: KeyCopy = { items: [{ clipId: 'a', keys: { x: [k(0, 1)] } }] };
    const out = planKeyPaste(p, copy, ['a'], 6);
    expect(out.outside).toBe(true);
    expect(out.writes).toEqual([]);
    expect(out.pasted).toBe(0);
    expect(planKeyPaste(p, copy, ['a'], 4 + 1e-7).outside).toBe(false);
    expect(planKeyPaste(p, copy, [], 1).outside).toBe(true);
    // every target locked: a locked stop
    const locked = planKeyPaste(p, { items: [{ clipId: 'b', keys: { x: [k(0, 1)] } }] }, ['b'], 11);
    expect(locked.stop).toEqual({ kind: 'locked', clipId: 'b' });
    expect(locked.writes).toEqual([]);
  });

  it('one write per clip', () => {
    const p = make((v) => [image('a', v, 0, 10, { x: [k(1, 0), k(5, 1)], y: [k(1, 0), k(5, 1)], opacity: [k(1, 0), k(5, 1)] })]);
    const sel = [ref('a', 'x', 1), ref('a', 'y', 5), ref('a', 'opacity', 1)];
    for (const plan of [planKeyMove(p, sel, 0.5), planKeyScale(p, sel, 0, 2), planKeyDelete(p, sel), planKeyEase(p, sel, 'ease'), planKeyPaste(p, { items: [{ clipId: 'a', keys: { x: [k(0, 1)], y: [k(0, 2)] } }] }, ['a'], 4)]) {
      expect(plan.writes).toHaveLength(1);
      expect(plan.writes[0]!.id).toBe('a');
    }
  });

  it('a paste the cap cuts entirely does not count its clip', () => {
    const full = Array.from({ length: MAX_KEYS_PER_PROP }, (_, i) => k(i * 0.01, i));
    const p = make((v) => [image('a', v, 0, 20, { x: full }), image('b', v, 0, 20)]);
    const plan = planKeyPaste(p, { items: [{ clipId: 'gone', keys: { x: [k(0, 1)] } }] }, ['a', 'b'], 10);
    expect(plan.pasted).toBe(1);
    expect(plan.clips).toBe(1);
    expect(plan.writes.map((w) => w.id)).toEqual(['b']);
  });

  it('a scale refused for a key in the way still gives the clamped amount', () => {
    const p = make((v) => [image('a', v, 0, 10, { x: [k(2, 0), k(3, 1), k(4, 2)] })]);
    const sel = [ref('a', 'x', 2), ref('a', 'x', 4)];
    const plan = planKeyScale(p, sel, 3, 0.01);
    expect(plan.stop?.kind).toBe('inTheWay');
    expect(plan.writes).toEqual([]);
    expect(plan.amount).toBeGreaterThan(0.01 - 1e-9);
    expect(planKeyScale(p, sel, 3, 100).amount).toBeCloseTo(3, 9);
  });

  it('the same project and selection plan the same', () => {
    const p = make((v) => [image('a', v, 0, 10, { x: [k(1, 0), k(2, 1)] })]);
    const sel = [ref('a', 'x', 1)];
    expect(planKeyMove(p, sel, 0.5)).toEqual(planKeyMove(p, sel, 0.5));
    expect(times(keysOf(p, planKeyMove(p, sel, 0.25), 'a', 'x'))).toEqual([1.25, 2]);
  });
});
