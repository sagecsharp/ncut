import { describe, expect, it } from 'vitest';
import { evalKeys } from '../../lib/anim';
import type { AudioClip, Clip, ImageClip, Keyframe, Keyframes, TextClip, VideoClip } from '../../types';
import { flyPlan, orderClips, soundOf } from './cascade';
import type { FlyOpts } from './cascade';

const tracks = [{ id: 't0' }, { id: 't1' }, { id: 'a0' }];
const base: FlyOpts = { kind: 'rise', direction: 'in', amount: 1, duration: 0.5, seed: 3, width: 1920, height: 1080 };

const text = (id: string, duration: number, x = 0, y = 0, extra: Partial<TextClip> = {}): TextClip =>
  ({ id, trackId: 't0', start: 0, duration, name: id, fadeIn: 0, fadeOut: 0, type: 'text', transform: { x, y, scale: 1, rotation: 0, opacity: 1 }, ...extra }) as unknown as TextClip;
const video = (id: string, assetId: string, extra: Partial<VideoClip> = {}): VideoClip =>
  ({ id, trackId: 't1', start: 0, duration: 4, name: id, fadeIn: 0, fadeOut: 0, type: 'video', assetId, trimStart: 0, speed: 1, volume: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, ...extra }) as unknown as VideoClip;
const image = (id: string, extra: Partial<ImageClip> = {}): ImageClip =>
  ({ id, trackId: 't1', start: 0, duration: 4, name: id, fadeIn: 0, fadeOut: 0, type: 'image', assetId: 'img', transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, ...extra }) as unknown as ImageClip;
const audio = (id: string, assetId: string, extra: Partial<AudioClip> = {}): AudioClip =>
  ({ id, trackId: 'a0', start: 0, duration: 4, name: id, fadeIn: 0, fadeOut: 0, type: 'audio', assetId, trimStart: 0, speed: 1, volume: 1, ...extra }) as unknown as AudioClip;
const k = (t: number, v: number, ease: Keyframe['ease'] = 'linear'): Keyframe => ({ t, v, ease });
const apply = <T extends Clip>(clip: T, keys: Keyframes): T => {
  const merged: Keyframes = { ...(clip.keyframes ?? {}), ...keys };
  for (const p of Object.keys(merged)) if (merged[p]!.length === 0) delete merged[p];
  return { ...clip, keyframes: merged };
};
const fly = <T extends Clip>(clip: T, over: Partial<FlyOpts>): T => apply(clip, flyPlan(clip, 0, 1, { ...base, ...over }));
const times = (c: Clip, prop: string) => c.keyframes![prop]!.map((q) => +q.t.toFixed(4));

describe('round 20: a shorter fly next to one on the other side', () => {
  it('fly in again, shorter: the fly out keeps its start and its length', () => {
    let c = text('a', 1, 0, 10);
    c = fly(c, { direction: 'in', duration: 0.5 });
    c = fly(c, { direction: 'out', duration: 0.5 });
    expect(times(c, 'y')).toEqual([0, 0.5, 1]);
    c = fly(c, { direction: 'in', duration: 0.3 });
    expect(times(c, 'y')).toEqual([0, 0.3, 0.5, 1]);
    expect(times(c, 'opacity')).toEqual([0, 0.3, 0.5, 1]);
    // at rest between the two, exactly
    expect(evalKeys(c.keyframes!.y!, 0.3)).toBeCloseTo(10, 6);
    expect(evalKeys(c.keyframes!.y!, 0.4)).toBeCloseTo(10, 6);
    expect(evalKeys(c.keyframes!.y!, 0.5)).toBeCloseTo(10, 6);
    expect(evalKeys(c.keyframes!.opacity!, 0.4)).toBeCloseTo(1, 6);
    // the fly out still eases in from 0.5
    expect(c.keyframes!.y!.find((q) => Math.abs(q.t - 0.5) < 1e-6)!.ease).toBe('ease-in');
  });

  it('fly out again, shorter: the fly in keeps its end', () => {
    let c = text('a', 1, 0, 10);
    c = fly(c, { direction: 'in', duration: 0.5 });
    c = fly(c, { direction: 'out', duration: 0.5 });
    c = fly(c, { direction: 'out', duration: 0.3 });
    expect(times(c, 'y')).toEqual([0, 0.5, 0.7, 1]);
    expect(evalKeys(c.keyframes!.y!, 0.5)).toBeCloseTo(10, 6);
    expect(evalKeys(c.keyframes!.y!, 0.6)).toBeCloseTo(10, 6);
    expect(evalKeys(c.keyframes!.opacity!, 0.6)).toBeCloseTo(1, 6);
    expect(c.keyframes!.y![0]!.ease).toBe('ease-out');
  });
});

describe('round 20: a fly whose keys were moved by a trim or a split is still that fly', () => {
  it('tail cut inside a fly out: another kind replaces it instead of stacking', () => {
    let c = text('a', 4, 0, 10);
    c = fly(c, { direction: 'out', duration: 0.5 });
    // what a split at 3.8 leaves on the left half: the keys stay, the far key now lies behind the end
    const left = { ...c, duration: 3.8 };
    const out = fly(left, { direction: 'out', kind: 'zoom', duration: 0.5 });
    // y no longer moves
    const y = out.keyframes?.y ?? [];
    for (const t of [3.3, 3.5, 3.7, 3.8]) expect(y.length ? evalKeys(y, t) : 10).toBeCloseTo(10, 6);
    expect(times(out, 'scale')).toEqual([3.3, 3.8]);
    expect(times(out, 'opacity')).toEqual([3.3, 3.8]);
  });

  it('head trim inside a fly in: the rest pose is the real rest, not a point on the old curve', () => {
    let c = text('a', 4, 0, 10);
    c = fly(c, { direction: 'in', duration: 1 });
    // a head trim of 0.2 s shifts every key by -0.2
    const shifted: Keyframes = {};
    for (const [p, list] of Object.entries(c.keyframes!)) shifted[p] = list.map((q) => ({ ...q, t: q.t - 0.2 }));
    const trimmed = { ...c, duration: 3.8, keyframes: shifted };
    const out = fly(trimmed, { direction: 'in', duration: 0.5 });
    expect(times(out, 'y')).toEqual([0, 0.5]);
    expect(out.keyframes!.y![1]!.v).toBeCloseTo(10, 6);
    expect(times(out, 'opacity')).toEqual([0, 0.5]);
    expect(out.keyframes!.opacity![1]!.v).toBeCloseTo(1, 6);
  });

  it('a hand made slide that starts before the clip is still not a fly', () => {
    const c = text('a', 6, 0, 0, { keyframes: { x: [k(-1, -200, 'ease-out'), k(5, 0)] } });
    const out = flyPlan(c, 0, 1, { ...base, kind: 'left' });
    expect(out.x!.map((q) => q.t)).toEqual([-1, 0, 0.5, 5]);
  });
});

describe('round 20: keys between two flies never end up inside one', () => {
  it('the key the user put before the fly out goes when that fly is moved to the middle', () => {
    let c = text('a', 2, 0, 10);
    c = fly(c, { direction: 'out', kind: 'left', duration: 0.5 });
    // the user adds a key on x at 1.2, before the fly out (rest key at 1.5)
    const x = [...c.keyframes!.x!, k(1.2, 0)].sort((p, q) => p.t - q.t);
    c = { ...c, keyframes: { ...c.keyframes!, x } };
    const out = fly(c, { direction: 'in', kind: 'rise', duration: 1.8 });
    const ts = times(out, 'x');
    // the out fly on x now runs from the middle: rest key at 1, far key at 2, nothing in between
    expect(ts.filter((t) => t > 1 + 1e-6 && t < 2 - 1e-6)).toEqual([]);
    expect(ts).toContain(1);
    expect(ts).toContain(2);
  });
});

describe('round 20: what gets a sound', () => {
  it('music grouped with letters stays a member of its own', () => {
    const clips: Clip[] = [text('l1', 4, 0, 0, { group: 'g' }), text('l2', 4, 100, 0, { group: 'g' }), audio('music', 'm', { group: 'g' })];
    expect(soundOf(clips).size).toBe(0);
  });
  it('a video keeps its sound, also next to texts of the same group', () => {
    const clips: Clip[] = [text('l1', 4, 0, 0, { group: 'g' }), video('v', 'a1', { group: 'g' }), audio('s', 'a1', { group: 'g' })];
    expect(soundOf(clips).get('s')?.id).toBe('v');
  });
  it('one lone still grouped with a sound takes it along, two stills do not', () => {
    expect(soundOf([image('i', { group: 'g' }), audio('s', 'voice', { group: 'g' })]).get('s')?.id).toBe('i');
    expect(soundOf([image('i', { group: 'g' }), image('j', { group: 'g' }), audio('s', 'voice', { group: 'g' })]).size).toBe(0);
  });
});

describe('round 20: a sound has no place on the canvas', () => {
  const clips: Clip[] = [text('right', 4, 300, 0), text('left', 4, -300, 0), text('far', 4, 900, 0), audio('snd', 'm')];
  it('left to right: the sound goes first, the texts keep their order', () => {
    expect(orderClips(clips, 'left', 1, tracks).map((c) => c.id)).toEqual(['snd', 'left', 'right', 'far']);
    expect(orderClips(clips, 'right', 1, tracks).map((c) => c.id)).toEqual(['snd', 'far', 'right', 'left']);
  });
  it('middle outwards: the middle is the middle of the pictures', () => {
    // box of the texts: -300 .. 900, middle 300 = 'right'. with the sound counted at 0 it would not change here,
    // so move the texts away from 0: the middle must follow them
    const off: Clip[] = [text('a', 4, 1000, 0), text('b', 4, 1400, 0), text('c', 4, 2000, 0), audio('snd', 'm')];
    // box 1000 .. 2000, middle 1500: b (100 away), then a and c (500 away each, layer order)
    expect(orderClips(off, 'center', 1, tracks).map((c) => c.id)).toEqual(['snd', 'b', 'a', 'c']);
    expect(orderClips(off, 'edges', 1, tracks).map((c) => c.id).slice(0, 1)).toEqual(['snd']);
    expect(orderClips(off, 'edges', 1, tracks).map((c) => c.id).at(-1)).toBe('b');
  });
  it('only sounds: the layer order', () => {
    const only: Clip[] = [audio('x', 'm'), audio('y', 'm', { start: 1 })];
    expect(orderClips(only, 'left', 1, tracks).map((c) => c.id)).toEqual(['x', 'y']);
  });
});
