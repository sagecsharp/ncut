import { describe, expect, it } from 'vitest';
import { evalKeys } from '../../lib/anim';
import type { Clip, Keyframes, TextClip, VideoClip } from '../../types';
import { flyPlan, orderClips, staggerPlan } from './cascade';
import type { FlyOpts } from './cascade';

const tracks = [{ id: 't0' }, { id: 't1' }, { id: 't2' }];

function text(id: string, trackId: string, start: number, duration: number, x = 0, y = 0, extra: Partial<TextClip> = {}): TextClip {
  return {
    id,
    trackId,
    start,
    duration,
    name: id,
    fadeIn: 0,
    fadeOut: 0,
    type: 'text',
    transform: { x, y, scale: 1, rotation: 0, opacity: 1 },
    ...extra,
  } as unknown as TextClip;
}

function video(id: string, start: number, duration: number, trimStart: number, speed: number): VideoClip {
  return {
    id,
    trackId: 't0',
    start,
    duration,
    name: id,
    fadeIn: 0,
    fadeOut: 0,
    type: 'video',
    assetId: 'a',
    trimStart,
    speed,
    volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  } as unknown as VideoClip;
}

const ids = (cs: readonly Clip[]) => cs.map((c) => c.id);

describe('orderClips', () => {
  const cs = [text('a', 't0', 0, 1, 100, 50), text('b', 't2', 0, 1, -200, 0), text('c', 't1', 0, 1, 0, -80), text('d', 't1', 2, 1, 300, 10)];

  it('layer: bottom track first, same track by start', () => {
    expect(ids(orderClips(cs, 'layer', 1, tracks))).toEqual(['b', 'c', 'd', 'a']);
  });
  it('left / right / top', () => {
    expect(ids(orderClips(cs, 'left', 1, tracks))).toEqual(['b', 'c', 'a', 'd']);
    expect(ids(orderClips(cs, 'right', 1, tracks))).toEqual(['d', 'a', 'c', 'b']);
    expect(ids(orderClips(cs, 'top', 1, tracks))).toEqual(['c', 'b', 'd', 'a']);
  });
  it('ties keep the layer order', () => {
    const same = [text('a', 't0', 0, 1, 5), text('b', 't2', 0, 1, 5), text('c', 't1', 0, 1, 5)];
    expect(ids(orderClips(same, 'left', 1, tracks))).toEqual(['b', 'c', 'a']);
  });
  it('center runs outwards, edges inwards', () => {
    const row = [text('l', 't0', 0, 1, -100), text('m', 't0', 1, 1, 0), text('r', 't0', 2, 1, 100)];
    expect(orderClips(row, 'center', 1, tracks)[0]!.id).toBe('m');
    expect(orderClips(row, 'edges', 1, tracks)[2]!.id).toBe('m');
  });
  it('reads x from the keys at the start of the clip', () => {
    const k: Keyframes = { x: [{ t: 0, v: 500, ease: 'linear' }, { t: 1, v: 0, ease: 'linear' }] };
    const keyed = text('k', 't0', 0, 1, 0, 0, { keyframes: k });
    const plain = text('p', 't1', 0, 1, 10);
    expect(ids(orderClips([keyed, plain], 'left', 1, tracks))).toEqual(['p', 'k']);
  });
  it('random is stable for the same seed, whatever the input order', () => {
    const many = Array.from({ length: 12 }, (_, i) => text('c' + i, 't0', i, 1));
    const a = ids(orderClips(many, 'random', 7, tracks));
    const b = ids(orderClips([...many].reverse(), 'random', 7, tracks));
    expect(a).toEqual(b);
    expect(ids(orderClips(many, 'random', 8, tracks))).not.toEqual(a);
  });
});

describe('staggerPlan', () => {
  const row = [text('a', 't0', 1, 2), text('b', 't1', 1, 2), text('c', 't2', 1, 2)];
  const opts = { mode: 'move' as const, tracks };

  it('move: first keeps its start, each next one a step later, lengths kept', () => {
    const p = staggerPlan(row, 'layer', 3, 30, opts);
    expect(p.order).toEqual(['c', 'b', 'a']);
    expect(p.places.map((x) => x.id)).toEqual(['b', 'a']);
    expect(p.places[0]!.start).toBeCloseTo(1.1);
    expect(p.places[1]!.start).toBeCloseTo(1.2);
    expect(p.places.every((x) => x.duration === 2)).toBe(true);
  });
  it('step 0 lines everything up at the earliest start', () => {
    const spread = [text('a', 't0', 4, 1), text('b', 't1', 2, 1), text('c', 't2', 6, 1)];
    const p = staggerPlan(spread, 'layer', 0, 30, opts);
    expect(p.places.every((x) => x.start === 2)).toBe(true);
    expect(p.places.map((x) => x.id).sort()).toEqual(['a', 'c']);
  });
  it('trim keeps the end and cuts the head', () => {
    const p = staggerPlan(row, 'layer', 6, 30, { ...opts, mode: 'trim' });
    const b = p.places.find((x) => x.id === 'b')!;
    expect(b.start).toBeCloseTo(1.2);
    expect(b.start + b.duration).toBeCloseTo(3);
  });
  it('trim leaves out a clip that would get shorter than 2 frames', () => {
    const p = staggerPlan(row, 'layer', 60, 30, { ...opts, mode: 'trim' });
    // b would start exactly at its end, a 2 s after it
    expect(p.left.map((x) => x.id).sort()).toEqual(['a', 'b']);
    expect(p.places).toEqual([]);
  });
  it('trim never starts a clip earlier than it did', () => {
    const late = [text('a', 't0', 0, 5), text('b', 't1', 3, 2)];
    const p = staggerPlan(late, 'layer', 3, 30, { ...opts, mode: 'trim' });
    // b is first (lower track) and keeps 3, a would start at 3.1
    expect(p.places.find((x) => x.id === 'b')).toBeUndefined();
    expect(p.places.find((x) => x.id === 'a')!.start).toBeCloseTo(3.1);
  });
  it('trim moves the source offset of media by the head that is cut (with speed)', () => {
    const v = [video('v1', 0, 4, 2, 2), video('v2', 0, 4, 2, 2)];
    const p = staggerPlan(v, 'layer', 15, 30, { ...opts, mode: 'trim' });
    const second = p.places[0]!;
    expect(second.start).toBeCloseTo(0.5);
    expect(second.trimStart).toBeCloseTo(2 + 0.5 * 2);
    expect(second.duration).toBeCloseTo(3.5);
  });
  it('nothing to change gives an empty plan', () => {
    const p = staggerPlan([text('a', 't0', 1, 1)], 'layer', 2, 30, opts);
    expect(p.places).toEqual([]);
  });
});

describe('flyPlan', () => {
  const base: FlyOpts = { kind: 'rise', direction: 'in', amount: 1, duration: 0.5, seed: 3, width: 1920, height: 1080 };
  const clip = text('a', 't0', 2, 3, 40, 10);

  it('in: keys at 0 and duration, rest pose at the end, fades opacity from 0', () => {
    const k = flyPlan(clip, 0, 1, base);
    expect(k.y!.map((x) => x.t)).toEqual([0, 0.5]);
    expect(k.y![1]!.v).toBe(10);
    expect(k.y![0]!.v).toBeGreaterThan(10);
    expect(k.y![0]!.ease).toBe('ease-out');
    expect(k.opacity!.map((x) => x.v)).toEqual([0, 1]);
    expect(k.x).toBeUndefined();
  });
  it('out mirrors it at the end of the clip', () => {
    const k = flyPlan(clip, 0, 1, { ...base, direction: 'out' });
    expect(k.y!.map((x) => x.t)).toEqual([2.5, 3]);
    expect(k.y![0]!.v).toBe(10);
    expect(k.y![0]!.ease).toBe('ease-in');
    expect(k.opacity!.map((x) => x.v)).toEqual([1, 0]);
  });
  it('clamps the length to the clip', () => {
    const k = flyPlan(clip, 0, 1, { ...base, duration: 99 });
    expect(k.y!.map((x) => x.t)).toEqual([0, 3]);
  });
  it('distances scale with the project size', () => {
    const big = flyPlan(clip, 0, 1, base).y![0]!.v - 10;
    const small = flyPlan(clip, 0, 1, { ...base, width: 960, height: 540 }).y![0]!.v - 10;
    expect(big).toBeCloseTo(small * 2);
  });
  it('strength 0 only fades', () => {
    const k = flyPlan(clip, 0, 1, { ...base, amount: 0 });
    expect(Object.keys(k)).toEqual(['opacity']);
  });
  it('left / right / fall / zoom / spin go the right way', () => {
    expect(flyPlan(clip, 0, 1, { ...base, kind: 'left' }).x![0]!.v).toBeLessThan(40);
    expect(flyPlan(clip, 0, 1, { ...base, kind: 'right' }).x![0]!.v).toBeGreaterThan(40);
    expect(flyPlan(clip, 0, 1, { ...base, kind: 'fall' }).y![0]!.v).toBeLessThan(10);
    expect(flyPlan(clip, 0, 1, { ...base, kind: 'zoom' }).scale![0]!.v).toBeCloseTo(0.01);
    expect(flyPlan(clip, 0, 1, { ...base, kind: 'spin' }).rotation![0]!.v).toBe(-360);
  });
  it('scatter is stable per id + seed and differs between clips', () => {
    const a1 = flyPlan(clip, 0, 2, { ...base, kind: 'scatter' });
    const a2 = flyPlan(clip, 1, 2, { ...base, kind: 'scatter' });
    const b = flyPlan(text('b', 't0', 2, 3, 40, 10), 0, 2, { ...base, kind: 'scatter' });
    expect(a1).toEqual(a2);
    expect(b.x![0]!.v).not.toBe(a1.x![0]!.v);
    expect(flyPlan(clip, 0, 2, { ...base, kind: 'scatter', seed: 4 }).x![0]!.v).not.toBe(a1.x![0]!.v);
    expect(a1.rotation).toBeDefined();
  });
  it('depth: z on a 3d clip, zoom on a flat one', () => {
    const flat = flyPlan(clip, 0, 1, { ...base, kind: 'depth' });
    expect(flat.z).toBeUndefined();
    expect(flat.scale).toBeDefined();
    const k = flyPlan(text('d', 't0', 0, 3, 0, 0, { threeD: true }), 0, 1, { ...base, kind: 'depth' });
    expect(k.z![0]!.v).toBeGreaterThan(0);
    expect(k.z![1]!.v).toBe(0);
    expect(k.scale).toBeUndefined();
  });
  it('replaces keys inside the span, keeps the ones outside, stays continuous at the seam', () => {
    const keyed = text('k', 't0', 0, 4, 0, 0, {
      keyframes: {
        y: [
          { t: 0.2, v: 999, ease: 'linear' },
          { t: 1, v: 0, ease: 'linear' },
          { t: 3, v: 100, ease: 'ease' },
        ],
      },
    });
    const k = flyPlan(keyed, 0, 1, { ...base, duration: 1.5 });
    const ys = k.y!;
    expect(ys.map((x) => x.t)).toEqual([0, 1.5, 3]);
    // the rest pose at 1.5 is what the old keys gave there
    expect(ys[1]!.v).toBeCloseTo(evalKeys(keyed.keyframes!.y!, 1.5));
    expect(ys[2]!.v).toBe(100);
    // the key at 1.5 keeps the ease the old curve had there
    expect(ys[1]!.ease).toBe('linear');
  });
  it('out keeps earlier keys and reads the rest pose at its start', () => {
    const keyed = text('k', 't0', 0, 4, 0, 0, { keyframes: { y: [{ t: 0, v: 0, ease: 'linear' }, { t: 4, v: 80, ease: 'linear' }] } });
    const k = flyPlan(keyed, 0, 1, { ...base, direction: 'out', duration: 1 });
    expect(k.y!.map((x) => x.t)).toEqual([0, 3, 4]);
    expect(k.y![1]!.v).toBeCloseTo(60);
  });
  it('audio clips do not fly', () => {
    const audio = { id: 'x', trackId: 't0', start: 0, duration: 2, type: 'audio', volume: 1 } as unknown as Clip;
    expect(flyPlan(audio, 0, 1, base)).toEqual({});
  });
});
