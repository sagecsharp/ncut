import { describe, expect, it } from 'vitest';
import type { AudioClip, EffectClip, ImageClip, Project, Track, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { buildTargetIndex, clampIntoClip, effectsOnClip, fxRuns, isMixingFx, isTargetedEffect, targetIndex } from './clipFx';
import type { EffectDef, EffectPass } from './effects/types';

let seq = 0;
function video(trackId: string, start: number, duration: number): VideoClip {
  return { id: `v${++seq}`, type: 'video', trackId, start, duration, name: 'v', fadeIn: 0, fadeOut: 0, assetId: 'a', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM } };
}
function image(trackId: string, start: number, duration: number): ImageClip {
  return { id: `i${++seq}`, type: 'image', trackId, start, duration, name: 'i', fadeIn: 0, fadeOut: 0, assetId: 'a', transform: { ...DEFAULT_TRANSFORM } };
}
function audio(trackId: string): AudioClip {
  return { id: `a${++seq}`, type: 'audio', trackId, start: 0, duration: 5, name: 'a', fadeIn: 0, fadeOut: 0, assetId: 'a', trimStart: 0, speed: 1, volume: 1, muted: false };
}
function fx(trackId: string, start: number, duration: number, target: string | null | undefined): EffectClip {
  return { id: `e${++seq}`, type: 'effect', trackId, start, duration, name: 'fx', fadeIn: 0, fadeOut: 0, effect: 'x', amount: 1, params: {}, seed: 0, target };
}
function track(id: string, kind: 'video' | 'audio' = 'video', hidden = false): Track {
  return { id, kind, name: id, muted: false, hidden, locked: false };
}
function project(clips: Project['clips'], tracks: Track[]): Project {
  return { id: 'p', name: 'p', createdAt: 0, updatedAt: 0, width: 100, height: 100, fps: 30, background: '#000', assets: [], tracks, clips };
}

describe('isTargetedEffect', () => {
  it('is true only for an effect with a target', () => {
    expect(isTargetedEffect(fx('t', 0, 1, 'x'))).toBe(true);
    expect(isTargetedEffect(fx('t', 0, 1, null))).toBe(false);
    expect(isTargetedEffect(fx('t', 0, 1, undefined))).toBe(false);
    expect(isTargetedEffect(fx('t', 0, 1, ''))).toBe(false);
    expect(isTargetedEffect(video('t', 0, 1))).toBe(false);
  });
});

describe('buildTargetIndex', () => {
  const tracks = [track('top'), track('bot'), track('au', 'audio')];

  it('is null without a targeted effect', () => {
    const v = video('bot', 0, 5);
    expect(buildTargetIndex(project([v, fx('top', 0, 5, null)], tracks))).toBeNull();
  });

  it('ignores an unknown target', () => {
    expect(buildTargetIndex(project([video('bot', 0, 5), fx('top', 0, 5, 'nope')], tracks))).toBeNull();
  });

  it('ignores a target that is not a visual clip', () => {
    const au = audio('au');
    const other = fx('top', 0, 5, null);
    expect(buildTargetIndex(project([au, other, fx('top', 0, 5, au.id), fx('top', 0, 5, other.id)], tracks))).toBeNull();
  });

  it('ignores an effect that targets itself', () => {
    const e = fx('top', 0, 5, null);
    e.target = e.id;
    expect(buildTargetIndex(project([e, video('bot', 0, 5)], tracks))).toBeNull();
  });

  it('ignores an effect on an audio track', () => {
    const v = video('bot', 0, 5);
    expect(buildTargetIndex(project([v, fx('au', 0, 5, v.id)], tracks))).toBeNull();
  });

  it('groups by target', () => {
    const a = video('bot', 0, 5);
    const b = image('bot', 5, 5);
    const ea = fx('top', 0, 5, a.id);
    const eb = fx('top', 5, 5, b.id);
    const idx = buildTargetIndex(project([a, b, ea, eb], tracks))!;
    expect(idx.get(a.id)).toEqual([ea]);
    expect(idx.get(b.id)).toEqual([eb]);
  });

  it('orders by track from bottom to top, then by start', () => {
    const t = [track('t1'), track('t2'), track('t3')];
    const v = video('t3', 0, 10);
    const hi = fx('t1', 0, 10, v.id);
    const lo = fx('t2', 5, 5, v.id);
    const lo2 = fx('t2', 1, 5, v.id);
    const idx = buildTargetIndex(project([hi, lo, v, lo2], t))!;
    // t2 is lower in the stack than t1 (higher index = lower), so it runs first
    expect(idx.get(v.id)!.map((e) => e.id)).toEqual([lo2.id, lo.id, hi.id]);
  });
});

describe('effectsOnClip', () => {
  const tracks = [track('top'), track('hid', 'video', true), track('bot')];

  it('is null with no index or an unknown clip', () => {
    const v = video('bot', 0, 5);
    const p = project([v], tracks);
    expect(effectsOnClip(null, p, v.id, 1)).toBeNull();
    const w = video('bot', 0, 5);
    const e = fx('top', 0, 5, w.id);
    const p2 = project([v, w, e], tracks);
    expect(effectsOnClip(buildTargetIndex(p2), p2, v.id, 1)).toBeNull();
  });

  it('uses the half open time range of the effect', () => {
    const v = video('bot', 0, 10);
    const e = fx('top', 1, 2, v.id);
    const p = project([v, e], tracks);
    const idx = buildTargetIndex(p);
    expect(effectsOnClip(idx, p, v.id, 0.99)).toBeNull();
    expect(effectsOnClip(idx, p, v.id, 1)).toEqual([e]);
    expect(effectsOnClip(idx, p, v.id, 2.999)).toEqual([e]);
    expect(effectsOnClip(idx, p, v.id, 3)).toBeNull();
  });

  it('skips an effect on a hidden track', () => {
    const v = video('bot', 0, 10);
    const hidden = fx('hid', 0, 10, v.id);
    const shown = fx('top', 0, 10, v.id);
    const p = project([v, hidden, shown], tracks);
    expect(effectsOnClip(buildTargetIndex(p), p, v.id, 1)).toEqual([shown]);
  });

  it('keeps the effects that are on and drops the ones that are over', () => {
    const v = video('bot', 0, 10);
    const early = fx('top', 0, 2, v.id);
    const late = fx('top', 5, 2, v.id);
    const p = project([v, early, late], tracks);
    const idx = buildTargetIndex(p);
    expect(effectsOnClip(idx, p, v.id, 1)).toEqual([early]);
    expect(effectsOnClip(idx, p, v.id, 6)).toEqual([late]);
  });
});

describe('targetIndex cache', () => {
  it('returns the same index for the same clips array and rebuilds for a new one', () => {
    const v = video('bot', 0, 5);
    const e = fx('top', 0, 5, v.id);
    const p = project([v, e], [track('top'), track('bot')]);
    expect(targetIndex(p)).toBe(targetIndex(p));
    const p2 = { ...p, clips: [v] };
    expect(targetIndex(p2)).toBeNull();
    expect(targetIndex(p)).not.toBeNull();
  });
});

describe('clampIntoClip', () => {
  it('keeps a time inside the clip and clamps the others to its first and last frame', () => {
    const v = video('t', 2, 3);
    expect(clampIntoClip(v, 3)).toBe(3);
    expect(clampIntoClip(v, 0)).toBe(2);
    expect(clampIntoClip(v, 2)).toBe(2);
    const last = clampIntoClip(v, 99);
    expect(last).toBeLessThan(5);
    expect(last).toBeGreaterThan(4.99);
  });
  it('a time clamped before the start finds the effect that starts with the clip', () => {
    const v = video('bot', 2, 3);
    const e = fx('top', 2, 3, v.id);
    const p = project([v, e], [track('top'), track('bot')]);
    const idx = buildTargetIndex(p);
    expect(effectsOnClip(idx, p, v.id, 1.9)).toBeNull();
    expect(effectsOnClip(idx, p, v.id, clampIntoClip(v, 1.9))).toEqual([e]);
  });
  it('a time clamped after the end finds the effect that ends with the clip', () => {
    const v = video('bot', 2, 3);
    const e = fx('top', 2, 3, v.id);
    const p = project([v, e], [track('top'), track('bot')]);
    const idx = buildTargetIndex(p);
    expect(effectsOnClip(idx, p, v.id, 5.02)).toBeNull();
    expect(effectsOnClip(idx, p, v.id, clampIntoClip(v, 5.02))).toEqual([e]);
  });
  it('an effect that does not cover the edge frame stays off there', () => {
    const v = video('bot', 2, 3);
    const e = fx('top', 3, 2, v.id);
    const p = project([v, e], [track('top'), track('bot')]);
    expect(effectsOnClip(buildTargetIndex(p), p, v.id, clampIntoClip(v, 1.9))).toBeNull();
  });
});

describe('isMixingFx and fxRuns', () => {
  const pass = (category: string): EffectPass => ({
    def: { id: category, name: category, category: category as EffectDef['category'], description: '', params: [], glsl: '' },
    time: 0,
    duration: 1,
    amount: 1,
    seed: 0,
    params: {},
  });
  it('only blur and distort mix pixels', () => {
    expect(isMixingFx('blur')).toBe(true);
    expect(isMixingFx('distort')).toBe(true);
    for (const c of ['color', 'stylize', 'overlay', 'motion']) expect(isMixingFx(c)).toBe(false);
  });
  it('no passes, no runs', () => {
    expect(fxRuns([])).toEqual([]);
  });
  it('one kind stays one run', () => {
    const runs = fxRuns([pass('blur'), pass('distort')]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.mixing).toBe(true);
    expect(runs[0]!.passes).toHaveLength(2);
  });
  it('a mixed chain splits in order, neighbours of a kind join', () => {
    const runs = fxRuns([pass('color'), pass('blur'), pass('blur'), pass('stylize'), pass('overlay'), pass('distort')]);
    expect(runs.map((r) => [r.mixing, r.passes.length])).toEqual([
      [false, 1],
      [true, 2],
      [false, 2],
      [true, 1],
    ]);
  });
  it('every effect in the registry is sorted by its declared category', async () => {
    const { EFFECTS } = await import('./effects/registry');
    for (const def of EFFECTS) {
      const runs = fxRuns([{ ...pass('x'), def }]);
      expect(runs[0]!.mixing).toBe(def.category === 'blur' || def.category === 'distort');
    }
  });
});
