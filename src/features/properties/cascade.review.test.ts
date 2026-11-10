import { describe, expect, it } from 'vitest';
import { evalKeys } from '../../lib/anim';
import type { Clip, Keyframes, TextClip } from '../../types';
import { flyPlan, orderClips, soundOf, staggerPlan } from './cascade';
import type { FlyOpts } from './cascade';

const tracks = [{ id: 't0' }, { id: 't1' }, { id: 't2' }, { id: 'a0' }];

const text = (id: string, trackId: string, start: number, duration: number, x = 0, extra: Partial<TextClip> = {}): TextClip =>
  ({ id, trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, type: 'text', transform: { x, y: 0, scale: 1, rotation: 0, opacity: 1 }, ...extra }) as unknown as TextClip;
const media = (id: string, type: 'video' | 'audio', trackId: string, start: number, duration: number, group?: string): Clip =>
  ({ id, type, trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'a', trimStart: 0, speed: 1, volume: 1, group, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 } }) as unknown as Clip;

const startOf = (plan: ReturnType<typeof staggerPlan>, clips: readonly Clip[], id: string) => plan.places.find((p) => p.id === id)?.start ?? clips.find((c) => c.id === id)!.start;

describe('stagger keeps a video and its sound together', () => {
  const clips = [
    media('v1', 'video', 't0', 0, 4, 'g1'),
    media('v2', 'video', 't1', 0, 4, 'g2'),
    media('v3', 'video', 't2', 0, 4, 'g3'),
    media('a1', 'audio', 'a0', 0, 4, 'g1'),
    media('a2', 'audio', 'a0', 0, 4, 'g2'),
    media('a3', 'audio', 'a0', 0, 4, 'g3'),
  ];

  it('the sound is no member of the cascade', () => {
    const lead = soundOf(clips);
    expect([...lead.keys()].sort()).toEqual(['a1', 'a2', 'a3']);
    expect(lead.get('a2')!.id).toBe('v2');
  });

  it('every sound starts where its picture starts', () => {
    const plan = staggerPlan(clips, 'layer', 3, 30, { mode: 'move', tracks });
    for (const n of [1, 2, 3]) expect(startOf(plan, clips, 'a' + n)).toBeCloseTo(startOf(plan, clips, 'v' + n), 9);
    const starts = [1, 2, 3].map((n) => startOf(plan, clips, 'v' + n)).sort((a, b) => a - b);
    expect(starts[1]! - starts[0]!).toBeCloseTo(0.1, 9);
    expect(starts[2]! - starts[1]!).toBeCloseTo(0.1, 9);
  });

  it('keep end cuts the same head off both', () => {
    const plan = staggerPlan(clips, 'layer', 6, 30, { mode: 'trim', tracks });
    for (const n of [1, 2, 3]) {
      const v = plan.places.find((p) => p.id === 'v' + n);
      const a = plan.places.find((p) => p.id === 'a' + n);
      expect(a?.start).toBe(v?.start);
      expect(a?.trimStart).toBe(v?.trimStart);
    }
  });

  it('letters of a split text share a group but are all members', () => {
    const letters = [text('l1', 't0', 0, 4, -100, { group: 'g' }), text('l2', 't1', 0, 4, 0, { group: 'g' }), text('l3', 't2', 0, 4, 100, { group: 'g' })];
    expect(soundOf(letters).size).toBe(0);
    const plan = staggerPlan(letters, 'left', 2, 30, { mode: 'move', tracks });
    expect(plan.places.map((p) => p.id)).toEqual(['l2', 'l3']);
  });
});

describe('stagger limits', () => {
  it('a clip the store would refuse to make that short is left out, at any frame rate', () => {
    const clips = [text('a', 't0', 0, 1), text('b', 't1', 0, 1)];
    // 58 frames at 60 fps leaves 0.033 s: under the store's shortest clip
    const plan = staggerPlan(clips, 'layer', 58, 60, { mode: 'trim', tracks });
    expect(plan.places).toEqual([]);
    expect(plan.left.map((l) => l.id)).toHaveLength(1);
  });

  it('line up with keep end cuts every head to the latest start', () => {
    const clips = [text('a', 't0', 0, 5), text('b', 't1', 1, 4), text('c', 't2', 2, 3)];
    const plan = staggerPlan(clips, 'layer', 0, 30, { mode: 'trim', tracks });
    expect(plan.places.map((p) => [p.id, p.start, p.duration]).sort()).toEqual([
      ['a', 2, 3],
      ['b', 2, 3],
    ]);
    // keep length lines up on the earliest start as before
    const moved = staggerPlan(clips, 'layer', 0, 30, { mode: 'move', tracks });
    expect(moved.places.map((p) => p.start)).toEqual([0, 0]);
  });
});

describe('order by where a clip is on the canvas', () => {
  it('uses the position it is given instead of the clip\'s own x', () => {
    const clips = [text('a', 't0', 0, 4, 300), text('b', 't1', 0, 4, 200), text('c', 't2', 0, 4, 100)];
    expect(orderClips(clips, 'left', 1, tracks).map((c) => c.id)).toEqual(['c', 'b', 'a']);
    // under a turned parent the local x says nothing: the world position does
    const world: Record<string, number> = { a: -50, b: 0, c: 50 };
    expect(orderClips(clips, 'left', 1, tracks, (c) => ({ x: world[c.id]!, y: 0 })).map((c) => c.id)).toEqual(['a', 'b', 'c']);
    // no answer for a clip: its own x / y
    expect(orderClips(clips, 'left', 1, tracks, () => null).map((c) => c.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('a new fly replaces the old one', () => {
  const base: FlyOpts = { kind: 'scatter', direction: 'in', amount: 0.6, duration: 0.5, seed: 3, width: 1920, height: 1080 };
  const apply = (clip: TextClip, keys: Keyframes): TextClip => {
    const merged: Keyframes = { ...(clip.keyframes ?? {}), ...keys };
    for (const p of Object.keys(merged)) if (merged[p]!.length === 0) delete merged[p];
    return { ...clip, keyframes: merged };
  };

  it('a shorter fly in ends at the rest pose, nothing of the old flight is left', () => {
    let clip = text('a', 't0', 0, 4, 120);
    clip = apply(clip, flyPlan(clip, 0, 1, base));
    clip = apply(clip, flyPlan(clip, 0, 1, { ...base, duration: 0.3, seed: 9 }));
    for (const prop of ['x', 'y', 'rotation', 'opacity']) {
      const keys = clip.keyframes![prop]!;
      expect(keys.map((k) => k.t)).toEqual([0, 0.3]);
    }
    expect(evalKeys(clip.keyframes!.x!, 0.3)).toBeCloseTo(120, 6);
    expect(evalKeys(clip.keyframes!.opacity!, 0.3)).toBeCloseTo(1, 6);
    expect(evalKeys(clip.keyframes!.opacity!, 0)).toBeCloseTo(0, 6);
  });

  it('a rise after a scatter only rises', () => {
    let clip = text('a', 't0', 0, 4, 120);
    clip = apply(clip, flyPlan(clip, 0, 1, base));
    clip = apply(clip, flyPlan(clip, 0, 1, { ...base, kind: 'rise' }));
    // x and the turn rest from the first frame on
    expect(evalKeys(clip.keyframes!.x!, 0)).toBeCloseTo(120, 6);
    expect(evalKeys(clip.keyframes!.rotation!, 0)).toBeCloseTo(0, 6);
    expect(clip.keyframes!.y![0]!.v).toBeGreaterThan(0);
    expect(evalKeys(clip.keyframes!.y!, 0.5)).toBeCloseTo(0, 6);
  });

  it('fly out twice, and a fly in next to a fly out, stay apart', () => {
    let clip = text('a', 't0', 0, 4, 0);
    clip = apply(clip, flyPlan(clip, 0, 1, { ...base, kind: 'fall', direction: 'out' }));
    clip = apply(clip, flyPlan(clip, 0, 1, { ...base, kind: 'fall', direction: 'out', duration: 0.25 }));
    expect(clip.keyframes!.y!.map((k) => k.t)).toEqual([3.75, 4]);
    expect(evalKeys(clip.keyframes!.y!, 3.75)).toBeCloseTo(0, 6);
    clip = apply(clip, flyPlan(clip, 0, 1, { ...base, kind: 'rise' }));
    expect(clip.keyframes!.y!.map((k) => k.t)).toEqual([0, 0.5, 3.75, 4]);
    expect(evalKeys(clip.keyframes!.y!, 2)).toBeCloseTo(0, 6);
  });

  it('an animation of the user that only passes through is kept', () => {
    const own = [
      { t: 0, v: 0, ease: 'linear' as const },
      { t: 4, v: 400, ease: 'linear' as const },
    ];
    const clip = text('a', 't0', 0, 4, 0, { keyframes: { x: own } });
    const k = flyPlan(clip, 0, 1, { ...base, kind: 'left' });
    // the fly ends on the user's curve and the far key of the curve stays
    expect(k.x!.map((q) => q.t)).toEqual([0, 0.5, 4]);
    expect(k.x![1]!.v).toBeCloseTo(50, 6);
  });
});
