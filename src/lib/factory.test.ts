import { describe, expect, it } from 'vitest';
import type { MediaAsset } from '../types';
import { DEFAULT_EFFECT_DURATION, FPS_OPTIONS, MAX_FPS, clipRange, clipTypeFor, createClipFromAsset, createEffectClip } from './factory';

describe('FPS_OPTIONS', () => {
  it('is strictly ascending', () => {
    for (let i = 1; i < FPS_OPTIONS.length; i++) expect(FPS_OPTIONS[i]!).toBeGreaterThan(FPS_OPTIONS[i - 1]!);
  });
  it('holds positive whole numbers', () => {
    for (const f of FPS_OPTIONS) {
      expect(Number.isInteger(f)).toBe(true);
      expect(f).toBeGreaterThan(0);
    }
  });
  it('includes the usual rates and 240', () => {
    for (const f of [24, 30, 60, 120, 144, 165, 240]) expect(FPS_OPTIONS).toContain(f);
  });
  it('MAX_FPS is 240 and the largest option', () => {
    expect(MAX_FPS).toBe(240);
    expect(Math.max(...FPS_OPTIONS)).toBe(MAX_FPS);
    expect(FPS_OPTIONS[FPS_OPTIONS.length - 1]).toBe(MAX_FPS);
  });
});

describe('createEffectClip', () => {
  it('fills in the defaults', () => {
    const c = createEffectClip('shake', 'shake', 'trk1', 2.5);
    expect(c.type).toBe('effect');
    expect(c.effect).toBe('shake');
    expect(c.name).toBe('shake');
    expect(c.trackId).toBe('trk1');
    expect(c.start).toBe(2.5);
    expect(c.duration).toBe(DEFAULT_EFFECT_DURATION);
    expect(c.fadeIn).toBe(0);
    expect(c.fadeOut).toBe(0);
    expect(c.amount).toBe(1);
    expect(c.params).toEqual({});
    expect(c.id).toMatch(/^clp_/);
  });
  it('gives an integer seed in 0..999', () => {
    for (let i = 0; i < 50; i++) {
      const c = createEffectClip('shake', 'shake', 't', 0);
      expect(Number.isInteger(c.seed)).toBe(true);
      expect(c.seed).toBeGreaterThanOrEqual(0);
      expect(c.seed).toBeLessThanOrEqual(999);
    }
  });
  it('makes unique ids and separate params objects', () => {
    const a = createEffectClip('shake', 'shake', 't', 0);
    const b = createEffectClip('shake', 'shake', 't', 0);
    expect(a.id).not.toBe(b.id);
    expect(a.params).not.toBe(b.params);
  });
  it('has no fields of media clips', () => {
    const c = createEffectClip('shake', 'shake', 't', 0) as unknown as Record<string, unknown>;
    for (const k of ['assetId', 'trimStart', 'speed', 'volume', 'transform']) expect(k in c).toBe(false);
  });
  it('applies overrides last', () => {
    const c = createEffectClip('shake', 'shake', 't', 0, { duration: 9, amount: 0.5, seed: 4, params: { strength: 1 }, fadeIn: 1 });
    expect(c.duration).toBe(9);
    expect(c.amount).toBe(0.5);
    expect(c.seed).toBe(4);
    expect(c.params).toEqual({ strength: 1 });
    expect(c.fadeIn).toBe(1);
    expect(c.type).toBe('effect');
  });
  it('default duration is 3 seconds', () => {
    expect(DEFAULT_EFFECT_DURATION).toBe(3);
  });
});

const media = (kind: MediaAsset['kind'], duration: number, hasAudio = kind !== 'image'): MediaAsset => ({
  id: 'm1',
  name: 'file',
  kind,
  mime: '',
  size: 0,
  duration,
  width: 0,
  height: 0,
  hasAudio,
  createdAt: 0,
});
/** the clip without its generated id */
const bare = (c: object): Record<string, unknown> => {
  const { id: _id, ...rest } = c as Record<string, unknown>;
  return rest;
};

describe('createClipFromAsset', () => {
  it("no take is today's clip in key order", () => {
    const today = (a: MediaAsset): Record<string, unknown> => {
      const base = { trackId: 't1', start: 4, name: a.name, fadeIn: 0, fadeOut: 0 };
      const transform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
      if (a.kind === 'video') return { ...base, type: 'video', assetId: a.id, duration: Math.max(a.duration, 0.1), trimStart: 0, speed: 1, volume: 1, muted: false, transform };
      if (a.kind === 'audio') return { ...base, type: 'audio', assetId: a.id, duration: Math.max(a.duration, 0.1), trimStart: 0, speed: 1, volume: 1, muted: false };
      return { ...base, type: 'image', assetId: a.id, duration: 5, transform };
    };
    for (const a of [media('video', 12.5), media('video', 0.01), media('audio', 3), media('image', 0)]) {
      const c = bare(createClipFromAsset(a, 't1', 4));
      expect(c).toEqual(today(a));
      expect(Object.keys(c)).toEqual(Object.keys(today(a)));
      expect(bare(createClipFromAsset(a, 't1', 4, {}))).toEqual(today(a));
      expect(Object.keys(bare(createClipFromAsset(a, 't1', 4, { range: null, parts: 'both' })))).toEqual(Object.keys(today(a)));
    }
  });
  it('range clamps', () => {
    const a = media('video', 10);
    expect(clipRange(a, { in: 2, out: 6 })).toEqual({ trimStart: 2, duration: 4 });
    expect(clipRange(a, { in: 2 })).toEqual({ trimStart: 2, duration: 8 });
    expect(clipRange(a, { out: 6 })).toEqual({ trimStart: 0, duration: 6 });
    expect(clipRange(a, { in: 4, out: 60 })).toEqual({ trimStart: 4, duration: 6 });
    expect(clipRange(a, { in: 40, out: 60 }).trimStart).toBeLessThanOrEqual(10 - 0.05 + 1e-9);
    expect(clipRange(a, null)).toEqual({ trimStart: 0, duration: 10 });
    expect(clipRange(media('image', 0), { in: 1, out: 2 })).toEqual({ trimStart: 0, duration: 5 });
    const c = createClipFromAsset(a, 't1', 0, { range: { in: 2, out: 6 } });
    expect(c.type === 'video' && [c.trimStart, c.duration]).toEqual([2, 4]);
  });
  it('under 0.05 widens', () => {
    const a = media('video', 10);
    const r = clipRange(a, { in: 3, out: 3.01 });
    expect(r.duration).toBeCloseTo(0.05, 9);
    expect(r.trimStart).toBe(3);
    // at the end of the file it widens backwards
    const e = clipRange(a, { in: 9.99, out: 10 });
    expect(e.duration).toBeCloseTo(0.05, 9);
    expect(e.trimStart + e.duration).toBeCloseTo(10, 9);
    // a file shorter than the smallest clip is taken whole
    expect(clipRange(media('video', 0.02), { in: 0, out: 0.01 })).toEqual({ trimStart: 0, duration: 0.1 });
  });
  it('picture mutes only with sound', () => {
    const withSound = createClipFromAsset(media('video', 5, true), 't', 0, { parts: 'picture' });
    expect(withSound.type === 'video' && withSound.muted).toBe(true);
    const silent = createClipFromAsset(media('video', 5, false), 't', 0, { parts: 'picture' });
    expect(silent.type === 'video' && silent.muted).toBe(false);
    const both = createClipFromAsset(media('video', 5, true), 't', 0, { parts: 'both' });
    expect(both.type === 'video' && both.muted).toBe(false);
  });
  it('sound is an audio clip of the video', () => {
    const a = media('video', 10, true);
    const c = createClipFromAsset(a, 't', 3, { parts: 'sound', range: { in: 2, out: 5 } });
    expect(bare(c)).toEqual({ trackId: 't', start: 3, name: 'file', fadeIn: 0, fadeOut: 0, type: 'audio', assetId: 'm1', duration: 3, trimStart: 2, speed: 1, volume: 1, muted: false });
    expect(Object.keys(c)).not.toContain('transform');
    // a sound file with parts sound stays the same clip
    expect(createClipFromAsset(media('audio', 4), 't', 0, { parts: 'sound' }).type).toBe('audio');
  });
  it('clipTypeFor nulls', () => {
    expect(clipTypeFor({ kind: 'video', hasAudio: true })).toBe('video');
    expect(clipTypeFor({ kind: 'audio', hasAudio: true })).toBe('audio');
    expect(clipTypeFor({ kind: 'image', hasAudio: false })).toBe('image');
    expect(clipTypeFor({ kind: 'video', hasAudio: true }, 'sound')).toBe('audio');
    expect(clipTypeFor({ kind: 'audio', hasAudio: true }, 'sound')).toBe('audio');
    expect(clipTypeFor({ kind: 'video', hasAudio: false }, 'sound')).toBeNull();
    expect(clipTypeFor({ kind: 'image', hasAudio: false }, 'sound')).toBeNull();
    expect(clipTypeFor({ kind: 'audio', hasAudio: true }, 'picture')).toBeNull();
    expect(clipTypeFor({ kind: 'video', hasAudio: true }, 'picture')).toBe('video');
    expect(clipTypeFor({ kind: 'image', hasAudio: false }, 'picture')).toBe('image');
  });
});

describe('a lut media', () => {
  const lut: MediaAsset = { id: 'l', name: 'look.cube', kind: 'lut', mime: 'application/x-cube', size: 10, duration: 0, width: 0, height: 0, hasAudio: false, createdAt: 0, lut: { size3: 33, size1: 0 } };
  it('clipTypeFor gives null for a lut for every part', () => {
    for (const parts of ['both', 'picture', 'sound'] as const) expect(clipTypeFor(lut, parts)).toBeNull();
    expect(clipTypeFor(lut)).toBeNull();
  });
  it('createClipFromAsset throws for a lut', () => {
    expect(() => createClipFromAsset(lut, 't', 0)).toThrow('a lut is not a clip');
  });
});
