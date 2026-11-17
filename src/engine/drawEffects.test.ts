import { describe, expect, it, vi } from 'vitest';
import type { AudioClip, Clip, EffectClip, ImageClip, Project, Track, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { clipFxPasses, effectPassAt, frameFx, hasEffectsAt, paintListAt, renderFrame, samePose, temporalReach } from './draw';
import { clampIntoClip, targetIndex } from './clipFx';
import type { DrawSource } from './draw';
import { EFFECTS, getEffect } from './effects/registry';
import { TRANSITIONS } from './transitions/registry';

// node has no webgl: the toggle makes renderEffects give a picture, so an effect that runs as a layer would draw it
const gpu = vi.hoisted(() => ({ on: false }));
vi.mock('./effects/runner', async (orig) => {
  const mod = await orig<typeof import('./effects/runner')>();
  return { ...mod, renderEffects: (...a: Parameters<typeof mod.renderEffects>) => (gpu.on ? ({ tag: 'adj' } as never) : mod.renderEffects(...a)) };
});

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
  it('no, neutral or off grade gives no pass', () => {
    expect(effectPassAt(effect('t', 0, 5, { effect: 'grade' }), 1)).toBeNull();
    expect(effectPassAt(effect('t', 0, 5, { effect: 'grade', grade: null }), 1)).toBeNull();
    expect(effectPassAt(effect('t', 0, 5, { effect: 'grade', grade: { liftR: 0, curves: { y: [[0, 0], [1, 1]] } } }), 1)).toBeNull();
    expect(effectPassAt(effect('t', 0, 5, { effect: 'grade', grade: { gainY: 0.4, off: true } }), 1)).toBeNull();
    expect(effectPassAt(effect('t', 0, 5, { effect: 'grade', grade: { gainY: 0.4 }, amount: 0 }), 1)).toBeNull();
  });
  it('an active grade effect carries its grade', () => {
    const pass = effectPassAt(effect('t', 0, 5, { effect: 'grade', grade: { gainY: 0.5, liftB: 0.1 } }), 1)!;
    expect(pass.def.id).toBe('grade');
    expect(pass.grade).toBeDefined();
    expect(pass.grade!.gain).toEqual([1.5, 1.5, 1.5]);
    expect(pass.grade!.lift[2]).toBeCloseTo(0.05, 9);
    expect(pass.grade!.on[0]).toBe(1);
  });
  it('keyed grade wheels resolve', () => {
    const clip = effect('t', 0, 4, { effect: 'grade', keyframes: { 'grade.gainY': [{ t: 0, v: 0, ease: 'linear' }, { t: 4, v: 1, ease: 'linear' }] } });
    expect(effectPassAt(clip, 0)).toBeNull();
    expect(effectPassAt(clip, 2)!.grade!.gain[0]).toBeCloseTo(1.5, 9);
    expect(effectPassAt(clip, 3)!.grade!.gain[1]).toBeCloseTo(1.75, 9);
  });
  it('other effects get no grade key', () => {
    const pass = effectPassAt(effect('t', 0, 5, { grade: { gainY: 0.5 } }), 1)!;
    expect('grade' in pass).toBe(false);
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

describe('effects on one clip', () => {
  const tracks = [track('top', 'video'), track('mid', 'video'), track('bot', 'video')];

  it('a targeted effect is not an adjustment layer and does not stop the picture', () => {
    const a = video('bot', 0, 5);
    const b = image('mid', 0, 5);
    const fx = effect('top', 0, 5, { target: a.id });
    const p = project([a, b, fx], tracks);
    const ctx = new FakeCtx({ width: 1920, height: 1080 });
    expect(() => renderFrame(asCtx(ctx), p, 1, (clip) => mkSource(clip.id))).not.toThrow();
    // no webgl scratch canvas in node: the targeted clip is drawn plain, in its place in the stack
    expect(ctx.drawn).toEqual([a.id, b.id]);
    expect(ctx.open).toBe(0);
  });

  it('a targeted effect with an unknown target or in a lone track draws nothing extra', () => {
    const a = video('bot', 0, 5);
    const fx = effect('top', 0, 5, { target: 'nope' });
    const p = project([a, fx], tracks);
    const ctx = new FakeCtx({ width: 1920, height: 1080 });
    renderFrame(asCtx(ctx), p, 1, (clip) => mkSource(clip.id));
    expect(ctx.drawn).toEqual([a.id]);
  });

  it('does not resolve a source for the effect clip', () => {
    const a = video('bot', 0, 5);
    const fx = effect('top', 0, 5, { target: a.id });
    const p = project([a, fx], tracks);
    const seen: string[] = [];
    renderFrame(asCtx(new FakeCtx({ width: 1920, height: 1080 })), p, 1, (clip) => {
      seen.push(clip.id);
      return mkSource('x');
    });
    expect(seen).toEqual([a.id]);
  });

  it('a targeted temporal effect adds no temporal reach', () => {
    const temporal = EFFECTS.find((e) => e.temporal);
    if (!temporal) return;
    const a = video('bot', 0, 5);
    const params: Record<string, number> = {};
    const adj = effect('top', 0, 5, { effect: temporal.id, params });
    const p1 = project([a, adj], tracks);
    expect(temporalReach(p1, 1)).not.toBeNull();
    const p2 = project([a, { ...adj, target: a.id }], tracks);
    expect(temporalReach(p2, 1)).toBeNull();
  });
});

describe('a chroma key on a track of its own', () => {
  const key = (trackId: string, over: Partial<EffectClip> = {}) => effect(trackId, 0, 5, { effect: 'chroma-key', ...over });
  const text = (trackId: string) => ({ ...image(trackId, 0, 5), type: 'text' }) as unknown as Clip;
  const ids = (p: Project, f: ReturnType<typeof frameFx>, clipId: string, t = 1) => clipFxPasses(p, f.fx, clipId, t)?.map((x) => x.def.id) ?? null;

  it('frameFx is the plain target index when no own effect is on screen', () => {
    const v = video('bot', 0, 5);
    const e = effect('top', 0, 5, { target: v.id });
    const p = project([v, e], [track('top', 'video'), track('bot', 'video')]);
    const f = frameFx(p, 1);
    expect(f.fx).toBe(targetIndex(p));
    expect(f.bound).toBeNull();
    const none = project([v], [track('bot', 'video')]);
    expect(frameFx(none, 1)).toEqual({ fx: null, bound: null });
  });

  it('keys the video right under it', () => {
    const v = video('bot', 0, 5);
    const k = key('top');
    const p = project([k, v], [track('top', 'video'), track('bot', 'video')]);
    const f = frameFx(p, 1);
    expect([...f.bound!]).toEqual([v.id]);
    expect(ids(p, f, v.id)).toEqual(['chroma-key']);
    expect(clipFxPasses(p, f.fx, v.id, 1)).toHaveLength(1);
  });

  it('skips text, shapes and other layers on the way down', () => {
    const v = video('c', 0, 5);
    const t = text('b');
    const adj = effect('b2', 0, 5);
    const k = key('a');
    const p = project([k, adj, t, v], [track('a', 'video'), track('b2', 'video'), track('b', 'video'), track('c', 'video')]);
    const f = frameFx(p, 1);
    expect([...f.bound!]).toEqual([v.id]);
    expect(f.fx!.has((t as { id: string }).id)).toBe(false);
  });

  it('keys the nearest picture, not one further down', () => {
    const lower = video('c', 0, 5);
    const near = image('b', 0, 5);
    const k = key('a');
    const p = project([k, near, lower], [track('a', 'video'), track('b', 'video'), track('c', 'video')]);
    const f = frameFx(p, 1);
    expect([...f.bound!]).toEqual([near.id]);
    expect(ids(p, f, lower.id)).toBeNull();
  });

  it('runs after the effects that sit on the clip', () => {
    const v = video('bot', 0, 5);
    const own = effect('mid', 0, 5, { target: v.id });
    const k = key('top');
    const p = project([k, own, v], [track('top', 'video'), track('mid', 'video'), track('bot', 'video')]);
    const f = frameFx(p, 1);
    expect(ids(p, f, v.id)).toEqual([FX, 'chroma-key']);
    // the cached base index is not changed
    expect(targetIndex(p)!.get(v.id)).toHaveLength(1);
  });

  it('two key layers on one clip run the lower first', () => {
    const v = video('bot', 0, 5);
    const high = key('top');
    const low = key('mid');
    const p = project([high, low, v], [track('top', 'video'), track('mid', 'video'), track('bot', 'video')]);
    const f = frameFx(p, 1);
    expect(f.fx!.get(v.id)!.map((c) => c.id)).toEqual([low.id, high.id]);
  });

  it('does nothing with nothing under it', () => {
    const k = key('top');
    const t = text('bot');
    const p = project([k, t], [track('top', 'video'), track('bot', 'video')]);
    const f = frameFx(p, 1);
    expect(f.bound).toBeNull();
    expect(f.fx).toBeNull();
    const alone = project([k], [track('top', 'video')]);
    expect(frameFx(alone, 1).bound).toBeNull();
  });

  it('does nothing on a hidden track or outside its time', () => {
    const v = video('bot', 0, 5);
    const k = key('top');
    const hidden = project([k, v], [track('top', 'video', true), track('bot', 'video')]);
    expect(frameFx(hidden, 1).bound).toBeNull();
    const late = project([key('top', { start: 10 }), v], [track('top', 'video'), track('bot', 'video')]);
    expect(frameFx(late, 1).bound).toBeNull();
    expect(frameFx(late, 11).bound).toBeNull();
  });

  it('keys both sides of a transition', () => {
    const a = video('bot', 0, 5);
    const b = video('bot', 5, 5, { transition: { id: TRANSITIONS[0]!.id, duration: 1 } });
    const k = key('top', { start: 0, duration: 10 });
    const p = project([k, a, b], [track('top', 'video'), track('bot', 'video')]);
    const f = frameFx(p, 5);
    expect(f.bound).toEqual(new Set([a.id, b.id]));
  });

  it('with a target it is an ordinary targeted effect', () => {
    const v = video('bot', 0, 5);
    const k = key('top', { target: v.id });
    const p = project([k, v], [track('top', 'video'), track('bot', 'video')]);
    const f = frameFx(p, 1);
    expect(f.bound).toBeNull();
    expect(targetIndex(p)!.get(v.id)).toEqual([k]);
    expect(f.fx).toBe(targetIndex(p));
  });

  it('is not an adjustment layer: renderFrame draws the clip once and does not throw', () => {
    const v = video('bot', 0, 5);
    const k = key('top');
    const p = project([k, v], [track('top', 'video'), track('bot', 'video')]);
    const ctx = new FakeCtx({ width: 1920, height: 1080 });
    expect(() => renderFrame(asCtx(ctx), p, 1, (clip) => mkSource(clip.id))).not.toThrow();
    expect(ctx.drawn).toEqual([v.id]);
    expect(ctx.open).toBe(0);
  });

  it('does not run as an adjustment layer even when the gpu gives a picture', () => {
    const v = video('bot', 0, 5);
    const k = key('top');
    const p = project([k, v], [track('top', 'video'), track('bot', 'video')]);
    gpu.on = true;
    try {
      const ctx = new FakeCtx({ width: 1920, height: 1080 });
      renderFrame(asCtx(ctx), p, 1, (clip) => mkSource(clip.id));
      expect(ctx.drawn).toEqual([v.id]);
      const lone = project([key('top'), text('bot')], [track('top', 'video'), track('bot', 'video')]);
      const ctx2 = new FakeCtx({ width: 1920, height: 1080 });
      renderFrame(asCtx(ctx2), lone, 1, (clip) => mkSource(clip.id));
      expect(ctx2.drawn).toEqual([]);
    } finally {
      gpu.on = false;
    }
  });

  it('keeps the plain index object when a layer is off screen or hidden', () => {
    const v = video('bot', 0, 5);
    const e = effect('mid', 0, 5, { target: v.id });
    const tr = [track('top', 'video'), track('mid', 'video'), track('bot', 'video')];
    const late = project([key('top', { start: 10 }), e, v], tr);
    expect(frameFx(late, 1).fx).toBe(targetIndex(late));
    expect(frameFx(late, 1).bound).toBeNull();
    const hidden = project([key('top'), e, v], [track('top', 'video', true), track('mid', 'video'), track('bot', 'video')]);
    expect(frameFx(hidden, 1).fx).toBe(targetIndex(hidden));
  });

  it('a frozen side keeps the key of its edge frame', () => {
    const a = video('bot', 0, 5);
    const b = video('bot', 5, 5, { transition: { id: TRANSITIONS[0]!.id, duration: 1 } });
    // the layer ends at 5 and the transition runs to 5.5: a is frozen on its last frame
    const ends = project([key('top', { start: 0, duration: 5 }), a, b], [track('top', 'video'), track('bot', 'video')]);
    const f = frameFx(ends, 5.2);
    expect(f.bound!.has(a.id)).toBe(true);
    expect(clipFxPasses(ends, f.fx, a.id, clampIntoClip(a, 5.2))).toHaveLength(1);
    expect(clipFxPasses(ends, f.fx, b.id, 5.2)).toBeNull();
    // the layer starts at 5 and the transition starts at 4.5: b is frozen on its first frame
    const starts = project([key('top', { start: 5, duration: 5 }), a, b], [track('top', 'video'), track('bot', 'video')]);
    const g = frameFx(starts, 4.8);
    expect(clipFxPasses(starts, g.fx, b.id, clampIntoClip(b, 4.8))).toHaveLength(1);
    expect(clipFxPasses(starts, g.fx, a.id, 4.8)).toBeNull();
  });
});

describe('effects on the frozen halves of a transition', () => {
  const tracks = [track('top', 'video'), track('mid', 'video'), track('bot', 'video')];

  it('a frozen start keeps the effect of its first frame, a frozen tail the effect of its last frame', () => {
    const a = video('bot', 0, 2);
    const b = video('bot', 2, 3);
    const fa = effect('top', 0, 2, { target: a.id });
    const fb = effect('mid', 2, 3, { target: b.id });
    const p = project([a, b, fa, fb], tracks);
    const idx = targetIndex(p);
    // at frame time 1.9 clip b is frozen on its first frame: the frame time is before its start
    expect(clipFxPasses(p, idx, b.id, 1.9)).toBeNull();
    expect(clipFxPasses(p, idx, b.id, clampIntoClip(b, 1.9))).toHaveLength(1);
    // at 2.1 clip a is frozen on its last frame
    expect(clipFxPasses(p, idx, a.id, 2.1)).toBeNull();
    expect(clipFxPasses(p, idx, a.id, clampIntoClip(a, 2.1))).toHaveLength(1);
  });

  it('the pass is evaluated at the clamped time too', () => {
    const b = video('bot', 2, 3);
    const fb = effect('mid', 2, 3, { target: b.id });
    const p = project([b, fb], tracks);
    const pass = clipFxPasses(p, targetIndex(p), b.id, clampIntoClip(b, 1.5))![0]!;
    expect(pass.time).toBe(0);
  });

  it('a clip without targeted effects gets no passes', () => {
    const b = video('bot', 2, 3);
    const p = project([b], tracks);
    expect(clipFxPasses(p, targetIndex(p), b.id, 3)).toBeNull();
    expect(clipFxPasses(p, null, b.id, 3)).toBeNull();
  });
});

describe('samePose', () => {
  const t = { ...DEFAULT_TRANSFORM };
  it('sees depth and tilt, not only the flat pose', () => {
    expect(samePose(t, 1, { ...t }, 1)).toBe(true);
    expect(samePose(t, 1, { ...t, z: 40 }, 1)).toBe(false);
    expect(samePose(t, 1, { ...t, rotX: 10 }, 1)).toBe(false);
    expect(samePose(t, 1, { ...t, rotY: 10 }, 1)).toBe(false);
    expect(samePose(t, 1, { ...t, z: 0, rotX: 0 }, 1)).toBe(true);
    expect(samePose(t, 1, t, 0.5)).toBe(false);
  });
});
