import { describe, expect, it } from 'vitest';
import { DEFAULT_EFFECT_DURATION, FPS_OPTIONS, MAX_FPS, createEffectClip } from './factory';

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
