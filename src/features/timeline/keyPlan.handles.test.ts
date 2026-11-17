import { describe, expect, it } from 'vitest';
import type { AudioClip, Clip, ImageClip, Keyframe, Project, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { evalKeys } from '../../lib/anim';
import type { KeyRef } from '../../store/ui';
import { captureKeyCopy } from '../properties/keyClipboard';
import type { KeyCopy } from '../properties/keyClipboard';
import { planKeyDelete, planKeyEase, planKeyMove, planKeyNudge, planKeyPaste, planKeyScale } from './keyPlan';

const image = (id: string, trackId: string, start: number, duration: number, keyframes?: ImageClip['keyframes']): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM }, ...(keyframes ? { keyframes } : {}),
});
const video = (id: string, trackId: string, start: number, duration: number, group?: string): VideoClip => ({
  id, type: 'video', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'vid1', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...(group ? { group } : {}),
});
const sound = (id: string, trackId: string, start: number, duration: number, group?: string): AudioClip => ({
  id, type: 'audio', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'vid1', trimStart: 0, speed: 1, volume: 1, muted: false, ...(group ? { group } : {}),
});
function make(clips: (v: string, a: string) => Clip[]): Project {
  const p = createProject('keys', undefined, 30);
  return { ...p, clips: clips(p.tracks[0]!.id, p.tracks[1]!.id) };
}
const ref = (clipId: string, prop: string, t: number): KeyRef => ({ clipId, prop, t });
const samples = (from: number, to: number, n = 100): number[] => Array.from({ length: n }, (_, i) => from + ((to - from) * (i + 0.5)) / n);

/** a custom curve over 4 s */
const curve = (): Keyframe[] => [
  { t: 0, v: 0, ease: 'bezier', out: { speed: 30, influence: 0.4 } },
  { t: 2, v: 80, ease: 'bezier', in: { speed: -10, influence: 0.3 }, out: { speed: 15, influence: 0.45 } },
  { t: 4, v: 50, ease: 'linear', in: { speed: 5, influence: 0.4 } },
];
const keysOf = (plan: { writes: { id: string; keyframes: Record<string, Keyframe[]> }[] }, id: string, prop: string): Keyframe[] =>
  plan.writes.find((w) => w.id === id)!.keyframes[prop]!;

describe('key planners keep custom curves', () => {
  it('move and nudge carry handles', () => {
    const p = make((v) => [image('a', v, 0, 10, { x: curve() })]);
    const sel = [ref('a', 'x', 0), ref('a', 'x', 2), ref('a', 'x', 4)];
    const moved = keysOf(planKeyMove(p, sel, 1.5), 'a', 'x');
    expect(moved.map((k) => k.t)).toEqual([1.5, 3.5, 5.5]);
    expect(moved.map((k) => k.in)).toEqual(curve().map((k) => k.in));
    expect(moved.map((k) => k.out)).toEqual(curve().map((k) => k.out));
    for (const t of samples(1.5, 5.5)) expect(evalKeys(moved, t)).toBeCloseTo(evalKeys(curve(), t - 1.5), 9);
    // one key by frames: it keeps its own handles
    const nudged = keysOf(planKeyNudge(p, [ref('a', 'x', 2)], 3), 'a', 'x');
    expect(nudged[1]!.t).toBeCloseTo(2.1, 9);
    expect(nudged[1]!.in).toEqual({ speed: -10, influence: 0.3 });
    expect(nudged[1]!.out).toEqual({ speed: 15, influence: 0.45 });
  });

  it('scale divides speeds by the factor', () => {
    const p = make((v) => [image('a', v, 0, 10, { x: curve() })]);
    const sel = [ref('a', 'x', 0), ref('a', 'x', 2), ref('a', 'x', 4)];
    const out = keysOf(planKeyScale(p, sel, 0, 2), 'a', 'x');
    expect(out.map((k) => k.t)).toEqual([0, 4, 8]);
    expect(out[0]!.out).toEqual({ speed: 15, influence: 0.4 });
    expect(out[1]!.in).toEqual({ speed: -5, influence: 0.3 });
    expect(out[1]!.out).toEqual({ speed: 7.5, influence: 0.45 });
    expect(out[2]!.in).toEqual({ speed: 2.5, influence: 0.4 });
    for (const t of samples(0, 8)) expect(evalKeys(out, t)).toBeCloseTo(evalKeys(curve(), t / 2), 9);
  });

  it('delete keeps the handles of the keys that stay', () => {
    const p = make((v) => [image('a', v, 0, 10, { x: curve() })]);
    const rest = keysOf(planKeyDelete(p, [ref('a', 'x', 2)]), 'a', 'x');
    expect(rest).toHaveLength(2);
    expect(rest[0]).toStrictEqual(curve()[0]);
    expect(rest[1]).toStrictEqual(curve()[2]);
  });

  it('a named ease drops the handles of that part', () => {
    const p = make((v) => [image('a', v, 0, 10, { x: curve() })]);
    const out = keysOf(planKeyEase(p, [ref('a', 'x', 2)], 'linear'), 'a', 'x');
    // the part 2 .. 4 is named now: no out on the key, no in on the next one. the part before it is still custom
    expect(out[1]!.ease).toBe('linear');
    expect(out[1]!.out).toBeUndefined();
    expect(out[2]!.in).toBeUndefined();
    expect(out[0]!.ease).toBe('bezier');
    expect(out[0]!.out).toEqual({ speed: 30, influence: 0.4 });
    expect(out[1]!.in).toEqual({ speed: -10, influence: 0.3 });
  });

  it('paste carries handles', () => {
    const p = make((v, a) => [image('a', v, 0, 10, { x: curve() }), image('b', a, 0, 10)]);
    const copy = captureKeyCopy(p, [ref('a', 'x', 0), ref('a', 'x', 2), ref('a', 'x', 4)])!;
    const plan = planKeyPaste(p, copy, ['b'], 3);
    const out = keysOf(plan, 'b', 'x');
    expect(out.map((k) => k.t)).toEqual([3, 5, 7]);
    expect(out.map((k) => k.in)).toEqual(curve().map((k) => k.in));
    expect(out.map((k) => k.out)).toEqual(curve().map((k) => k.out));
    for (const t of samples(3, 7)) expect(evalKeys(out, t)).toBeCloseTo(evalKeys(curve(), t - 3), 9);
  });

  it('paste lists the left out values in the order they were copied', () => {
    const p = make((v, a) => [video('v', v, 0, 10, 'g'), sound('s', a, 0, 10, 'g')]);
    const k = (t: number): Keyframe => ({ t, v: 1, ease: 'linear' });
    const copy: KeyCopy = { items: [{ clipId: 'q', keys: { 'p.zz': [k(0)], volume: [k(0)], x: [k(0)], pan: [k(0)] } }] };
    expect(planKeyPaste(p, copy, ['v'], 1).leftOut).toEqual(['p.zz', 'volume', 'pan']);
  });
});
