import { describe, expect, it } from 'vitest';
import type { AudioClip, EffectClip, ImageClip, Project, Track, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { effectPassAt, hasEffectsAt, paintListAt, renderFrame, temporalReach } from './draw';
import type { DrawSource } from './draw';
import { EFFECTS, getEffect } from './effects/registry';

let seq = 0;
const FX = EFFECTS[0]!.id;

function video(trackId: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip {
  return {
    id: `v${++seq}`,
    type: 'video',
    trackId,
    start,
    duration,
    name: 'v',
    fadeIn: 0,
    fadeOut: 0,
    assetId: 'vid',
    trimStart: 0,
    speed: 1,
    volume: 1,
    muted: false,
    transform: { ...DEFAULT_TRANSFORM },
    ...over,
  };
}
function image(trackId: string, start: number, duration: number): ImageClip {
  return {
    id: `i${++seq}`,
    type: 'image',
    trackId,
    start,
    duration,
    name: 'i',
    fadeIn: 0,
    fadeOut: 0,
    assetId: 'img',
    transform: { ...DEFAULT_TRANSFORM },
  };
}
function audio(trackId: string, start: number, duration: number): AudioClip {
  return {
    id: `a${++seq}`,
    type: 'audio',
    trackId,
    start,
    duration,
    name: 'a',
    fadeIn: 0,
    fadeOut: 0,
    assetId: 'aud',
    trimStart: 0,
    speed: 1,
    volume: 1,
    muted: false,
  };
}
function effect(trackId: string, start: number, duration: number, over: Partial<EffectClip> = {}): EffectClip {
  return {
    id: `e${++seq}`,
    type: 'effect',
    trackId,
    start,
    duration,
    name: 'fx',
    fadeIn: 0,
    fadeOut: 0,
    effect: FX,
    amount: 1,
    params: {},
    seed: 7,
    ...over,
  };
}
function track(id: string, kind: 'video' | 'audio', hidden = false): Track {
  return { id, kind, name: id, muted: false, hidden, locked: false };
}
function project(clips: Project['clips'], tracks: Track[]): Project {
  return {
    id: 'p',
    name: 'p',
    createdAt: 0,
    updatedAt: 0,
    width: 1920,
    height: 1080,
    fps: 30,
    background: '#123456',
    assets: [
      { id: 'vid', name: 'vid', kind: 'video', mime: 'video/mp4', size: 1, duration: 10, width: 1920, height: 1080, hasAudio: true, createdAt: 0 },
      { id: 'img', name: 'img', kind: 'image', mime: 'image/png', size: 1, duration: 0, width: 0, height: 0, hasAudio: false, createdAt: 0 },
    ],
    tracks,
    clips,
  };
}

describe('paintListAt', () => {
  it('lists visual and effect clips bottom track first', () => {
    const tracks = [track('t3', 'video'), track('t2', 'video'), track('t1', 'video')];
    const top = effect('t3', 0, 5);
    const mid = image('t2', 0, 5);
    const bot = video('t1', 0, 5);
    const p = project([top, mid, bot], tracks);
    expect(paintListAt(p, 1).map((c) => c.id)).toEqual([bot.id, mid.id, top.id]);
  });

  it('keeps the effect between the pictures it sits between', () => {
    const tracks = [track('a', 'video'), track('b', 'video'), track('c', 'video')];
    const above = image('a', 0, 5);
    const fx = effect('b', 0, 5);
    const below = video('c', 0, 5);
    const p = project([above, fx, below], tracks);
    expect(paintListAt(p, 2).map((c) => c.type)).toEqual(['video', 'effect', 'image']);
  });

  it('skips hidden tracks, also for effect clips', () => {
    const tracks = [track('a', 'video', true), track('b', 'video'), track('c', 'video', true)];
    const fxHidden = effect('a', 0, 5);
    const vis = video('b', 0, 5);
    const imgHidden = image('c', 0, 5);
    const p = project([fxHidden, vis, imgHidden], tracks);
    expect(paintListAt(p, 1).map((c) => c.id)).toEqual([vis.id]);
  });

  it('skips audio tracks and audio clips', () => {
    const tracks = [track('v', 'video'), track('a', 'audio')];
    const fx = effect('v', 0, 5);
    const au = audio('a', 0, 5);
    const p = project([fx, au], tracks);
    expect(paintListAt(p, 1).map((c) => c.id)).toEqual([fx.id]);
  });

  it('uses a half-open time range', () => {
    const tracks = [track('t', 'video')];
    const fx = effect('t', 1, 2);
    const p = project([fx], tracks);
    expect(paintListAt(p, 0.99)).toHaveLength(0);
    expect(paintListAt(p, 1)).toHaveLength(1);
    expect(paintListAt(p, 2.999)).toHaveLength(1);
    expect(paintListAt(p, 3)).toHaveLength(0);
  });

  it('is empty for an empty project', () => {
    expect(paintListAt(project([], [track('t', 'video')]), 0)).toEqual([]);
  });
});

describe('hasEffectsAt', () => {
  const tracks = [track('t', 'video'), track('h', 'video', true), track('b', 'video')];
  it('is true while an effect clip is active', () => {
    const p = project([effect('t', 1, 2)], tracks);
    expect(hasEffectsAt(p, 1)).toBe(true);
    expect(hasEffectsAt(p, 2.5)).toBe(true);
  });
  it('is false outside the clip (half-open)', () => {
    const p = project([effect('t', 1, 2)], tracks);
    expect(hasEffectsAt(p, 0.5)).toBe(false);
    expect(hasEffectsAt(p, 3)).toBe(false);
  });
  it('is false when the effect sits on a hidden track', () => {
    const p = project([effect('h', 0, 5)], tracks);
    expect(hasEffectsAt(p, 1)).toBe(false);
  });
  it('is false with only pictures', () => {
    const p = project([video('b', 0, 5), image('t', 0, 5)], tracks);
    expect(hasEffectsAt(p, 1)).toBe(false);
  });
  it('is true when one of several effects is on a visible track', () => {
    const p = project([effect('h', 0, 5), effect('b', 0, 5)], tracks);
    expect(hasEffectsAt(p, 1)).toBe(true);
  });
});

describe('effectPassAt', () => {
  it('adds timeOffset to the look time but not to fades', () => {
    const clip = effect('t', 2, 4, { timeOffset: 3, fadeIn: 2 });
    const pass = effectPassAt(clip, 3)!;
    expect(pass.time).toBeCloseTo(4, 9);
    expect(pass.amount).toBeCloseTo(0.5, 9);
  });
  it('builds a pass with clip-local time', () => {
    const clip = effect('t', 2, 4, { amount: 0.8, seed: 123, params: { strength: 50 } });
    const pass = effectPassAt(clip, 3.5)!;
    expect(pass.def).toBe(getEffect(FX));
    expect(pass.time).toBeCloseTo(1.5, 9);
    expect(pass.duration).toBe(4);
    expect(pass.amount).toBeCloseTo(0.8, 9);
    expect(pass.seed).toBe(123);
    expect(pass.params).toEqual({ strength: 50 });
  });
  it('multiplies amount with the fade', () => {
    const clip = effect('t', 0, 10, { amount: 0.5, fadeIn: 2, fadeOut: 2 });
    expect(effectPassAt(clip, 1)!.amount).toBeCloseTo(0.25, 9);
    expect(effectPassAt(clip, 5)!.amount).toBeCloseTo(0.5, 9);
    expect(effectPassAt(clip, 9)!.amount).toBeCloseTo(0.25, 9);
  });
  it('is null for an unknown effect', () => {
    expect(effectPassAt(effect('t', 0, 5, { effect: 'does-not-exist' }), 1)).toBeNull();
  });
  it('is null when the amount is 0', () => {
    expect(effectPassAt(effect('t', 0, 5, { amount: 0 }), 1)).toBeNull();
  });
  it('is null when the fade brings it to nothing', () => {
    const clip = effect('t', 0, 10, { fadeIn: 2 });
    expect(effectPassAt(clip, 0)).toBeNull();
    expect(effectPassAt(clip, 0.0005)).toBeNull();
    expect(effectPassAt(clip, 0.5)).not.toBeNull();
  });
  it('never gives a negative time', () => {
    const clip = effect('t', 5, 3);
    expect(effectPassAt(clip, 4)!.time).toBe(0);
    expect(effectPassAt(clip, 0)!.time).toBe(0);
    expect(effectPassAt(clip, 5)!.time).toBe(0);
  });
});

/* ---------- renderFrame with effect clips ---------- */

class FakeCtx {
  ops: string[] = [];
  drawn: string[] = [];
  globalAlpha = 1;
  fillStyle: unknown = '#000';
  globalCompositeOperation = 'source-over';
  font = '';
  textBaseline = 'alphabetic';
  textAlign = 'start';
  canvas: unknown;
  private depth = 0;
  constructor(canvas?: unknown) {
    this.canvas = canvas;
  }
  save(): void {
    this.depth++;
    this.ops.push('save');
  }
  restore(): void {
    this.depth--;
    this.ops.push('restore');
  }
  get open(): number {
    return this.depth;
  }
  translate(): void {}
  rotate(): void {}
  scale(): void {}
  setTransform(): void {}
  fillRect(): void {
    this.ops.push('fillRect');
  }
  fillText(): void {}
  drawImage(img: unknown): void {
    this.ops.push('drawImage');
    this.drawn.push((img as { tag: string }).tag);
  }
}

const asCtx = (f: FakeCtx) => f as unknown as CanvasRenderingContext2D;
const mkSource = (tag: string): DrawSource => ({ image: { tag } as unknown as CanvasImageSource, width: 1920, height: 1080 });

describe('renderFrame with effect clips', () => {
  const tracks = [track('top', 'video'), track('mid', 'video'), track('bot', 'video')];

  it('does not throw and still draws the visual clips (context without a canvas)', () => {
    const fx = effect('mid', 0, 5);
    const a = video('bot', 0, 5);
    const b = image('top', 0, 5);
    const p = project([fx, a, b], tracks);
    const ctx = new FakeCtx();
    expect(() => renderFrame(asCtx(ctx), p, 1, (clip) => mkSource(clip.id))).not.toThrow();
    expect(ctx.drawn).toEqual([a.id, b.id]);
    expect(ctx.open).toBe(0);
    expect(ctx.globalAlpha).toBe(1);
  });

  it('does not throw with a canvas but no webgl (effects are skipped, nothing copied back)', () => {
    const fx = effect('top', 0, 5);
    const a = video('bot', 0, 5);
    const p = project([a, fx], tracks);
    const ctx = new FakeCtx({ width: 1920, height: 1080 });
    expect(() => renderFrame(asCtx(ctx), p, 1, (clip) => mkSource(clip.id))).not.toThrow();
    expect(ctx.drawn).toEqual([a.id]);
    expect(ctx.open).toBe(0);
  });

  it('draws only the pictures when the effect is unknown or faded out', () => {
    const bad = effect('mid', 0, 5, { effect: 'nope' });
    const zero = effect('top', 0, 5, { amount: 0 });
    const a = video('bot', 0, 5);
    const p = project([bad, zero, a], tracks);
    const ctx = new FakeCtx({ width: 1920, height: 1080 });
    renderFrame(asCtx(ctx), p, 1, (clip) => mkSource(clip.id));
    expect(ctx.drawn).toEqual([a.id]);
  });

  it('works with effects only (no pictures)', () => {
    const p = project([effect('top', 0, 5), effect('mid', 0, 5)], tracks);
    const ctx = new FakeCtx({ width: 1920, height: 1080 });
    expect(() => renderFrame(asCtx(ctx), p, 1, () => null)).not.toThrow();
    expect(ctx.drawn).toEqual([]);
    expect(ctx.open).toBe(0);
  });

  it('does not resolve sources for effect clips', () => {
    const fx = effect('top', 0, 5);
    const p = project([fx], tracks);
    const ctx = new FakeCtx();
    const seen: string[] = [];
    renderFrame(asCtx(ctx), p, 1, (clip) => {
      seen.push(clip.id);
      return mkSource('x');
    });
    expect(seen).toEqual([]);
  });
});

describe('temporalReach', () => {
  const tr: Track = { id: 'tv', kind: 'video', name: 'v', muted: false, hidden: false, locked: false };
  const top: Track = { id: 'tf', kind: 'video', name: 'fx', muted: false, hidden: false, locked: false };
  it('is null without a temporal effect', () => {
    const p = project([video('tv', 0, 4), effect('tf', 0, 4)], [top, tr]);
    expect(temporalReach(p, 1)).toBeNull();
  });
  it('covers the moments a motion blur and an echo mix in, only while they run', () => {
    const p = project([video('tv', 0, 4), effect('tf', 1, 2, { effect: 'motion-blur' })], [top, tr]);
    expect(temporalReach(p, 0.5)).toBeNull();
    const r = temporalReach(p, 2)!;
    expect(r.back + r.ahead).toBeGreaterThan(0);
    expect(r.back).toBeGreaterThanOrEqual(0);
    expect(r.ahead).toBeGreaterThanOrEqual(0);
    // within about a frame for a shutter
    expect(r.back + r.ahead).toBeLessThan(0.2);
    const e = temporalReach(project([video('tv', 0, 4), effect('tf', 0, 4, { effect: 'echo' })], [top, tr]), 2)!;
    expect(e.back).toBeGreaterThan(0);
    expect(e.ahead).toBe(0);
  });
  it('ignores hidden tracks', () => {
    const p = project([video('tv', 0, 4), effect('tf', 0, 4, { effect: 'motion-blur' })], [{ ...top, hidden: true }, tr]);
    expect(temporalReach(p, 2)).toBeNull();
  });
});
