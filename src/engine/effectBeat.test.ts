import { describe, expect, it } from 'vitest';
import type { AudioClip, EffectClip, ImageClip, Project, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { LINE_NUDGE, cyclePhase, pulseEnvelope } from '../lib/tempo';
import type { BeatGrid } from '../lib/tempo';
import { beatGridOf, hasBeatLink } from './beatFx';
import { targetIndex } from './clipFx';
import { clipFxPasses, effectPassAt } from './draw';

let seq = 0;

function fx(start: number, duration: number, over: Partial<EffectClip> = {}): EffectClip {
  return {
    id: `e${++seq}`,
    type: 'effect',
    trackId: 'v1',
    start,
    duration,
    name: 'fx',
    fadeIn: 0,
    fadeOut: 0,
    effect: 'flash',
    amount: 1,
    params: { rate: 3 },
    seed: 7,
    ...over,
  };
}
function song(start: number, duration: number, bpm: number | null, over: Partial<AudioClip> = {}): AudioClip {
  return { id: `a${++seq}`, type: 'audio', trackId: 'a1', start, duration, name: 'song', fadeIn: 0, fadeOut: 0, assetId: 'aud', trimStart: 0, speed: 1, volume: 1, muted: false, bpm, ...over };
}
function picture(start: number, duration: number): ImageClip {
  return { id: `i${++seq}`, type: 'image', trackId: 'v2', start, duration, name: 'i', fadeIn: 0, fadeOut: 0, assetId: 'img', transform: { ...DEFAULT_TRANSFORM } };
}
function project(clips: Project['clips']): Project {
  return {
    id: 'p',
    name: 'p',
    createdAt: 0,
    updatedAt: 0,
    width: 1920,
    height: 1080,
    fps: 30,
    background: '#000000',
    assets: [
      { id: 'aud', name: 'aud', kind: 'audio', mime: 'audio/mp3', size: 1, duration: 100, width: 0, height: 0, hasAudio: true, createdAt: 0 },
      { id: 'img', name: 'img', kind: 'image', mime: 'image/png', size: 1, duration: 0, width: 0, height: 0, hasAudio: false, createdAt: 0 },
    ],
    tracks: [
      { id: 'v1', kind: 'video', name: 'v1', muted: false, hidden: false, locked: false },
      { id: 'v2', kind: 'video', name: 'v2', muted: false, hidden: false, locked: false },
      { id: 'a1', kind: 'audio', name: 'a1', muted: false, hidden: false, locked: false },
    ],
    clips,
  };
}

// 120 bpm: a beat every 0.5 s, on the whole seconds
const G: BeatGrid = { origin: 0, step: 0.5 };
const beat = (over: Partial<NonNullable<EffectClip['beat']>> = {}): NonNullable<EffectClip['beat']> => ({ source: null, every: 1, pulse: 0, lock: false, ...over });

describe('effectPassAt without a beat', () => {
  it('gives the numbers it always did, with or without a grid', () => {
    const plain = fx(2, 6, { timeOffset: 0.4, fullDuration: 9 });
    const old = effectPassAt(plain, 3.3)!;
    expect(old.time).toBeCloseTo(1.7, 12);
    expect(old.amount).toBe(1);
    expect(old.params).toEqual({ rate: 3 });
    expect(old.duration).toBe(9);
    expect(effectPassAt(plain, 3.3, G)).toEqual(old);
    expect(effectPassAt(plain, 3.3, null)).toEqual(old);
    // a link without a grid (no tempo anywhere) runs as if it was off
    const linked = fx(2, 6, { timeOffset: 0.4, fullDuration: 9, beat: beat({ pulse: 1, lock: true }) });
    expect(effectPassAt(linked, 3.3, null)).toEqual(old);
    expect(effectPassAt(linked, 3.3)).toEqual(old);
  });

  it('keeps the params object of the clip when nothing is replaced', () => {
    const clip = fx(0, 4, { beat: beat({ pulse: 0.5 }) });
    expect(effectPassAt(clip, 1.1, G)!.params).toEqual({ rate: 3 });
  });
});

describe('pulse', () => {
  it('multiplies the amount by the envelope at the position in the cycle', () => {
    const clip = fx(0, 8, { amount: 0.8, beat: beat({ every: 1, pulse: 0.6 }) });
    // cycle 0.5 s: on a line it is full, a fifth of the way in it has fallen
    expect(effectPassAt(clip, 2, G)!.amount).toBeCloseTo(0.8, 12);
    expect(effectPassAt(clip, 2.1, G)!.amount).toBeCloseTo(0.8 * pulseEnvelope(0.6, 0.2), 12);
    expect(effectPassAt(clip, 2.49, G)!.amount).toBeCloseTo(0.8 * pulseEnvelope(0.6, 0.98), 12);
    expect(effectPassAt(clip, 2.5, G)!.amount).toBeCloseTo(0.8, 12);
  });

  it('comes after the fades', () => {
    const clip = fx(0, 8, { fadeIn: 2, beat: beat({ pulse: 0.5 }) });
    // at 1 s the fade is half in, and 1 s is a line (cycle 0.5)
    expect(effectPassAt(clip, 1, G)!.amount).toBeCloseTo(0.5, 9);
    expect(effectPassAt(clip, 1.25, G)!.amount).toBeCloseTo(0.625 * pulseEnvelope(0.5, 0.5), 9);
  });

  it('a longer cycle: every 4 beats', () => {
    const clip = fx(0, 8, { beat: beat({ every: 4, pulse: 1 }) });
    expect(effectPassAt(clip, 2, G)!.amount).toBeCloseTo(1, 12);
    expect(effectPassAt(clip, 3, G)!.amount).toBeCloseTo(pulseEnvelope(1, 0.5), 12);
  });

  it('works for a static effect, and keeps its time', () => {
    const clip = fx(1, 8, { effect: 'blur', params: {}, timeOffset: 0.3, beat: beat({ pulse: 1 }) });
    const p = effectPassAt(clip, 2.25, G)!;
    expect(p.time).toBeCloseTo(1.55, 12);
    expect(p.amount).toBeCloseTo(pulseEnvelope(1, 0.5), 12);
    expect(p.params).toEqual({});
  });

  it('temporal effects stay without a pass', () => {
    expect(effectPassAt(fx(0, 4, { effect: 'echo', beat: beat({ pulse: 1 }) }), 1, G)).toBeNull();
  });

  it('a clip that starts before the grid origin (negative lines)', () => {
    const grid: BeatGrid = { origin: 10, step: 0.5 };
    const clip = fx(2, 4, { beat: beat({ pulse: 1 }) });
    // 3.25 is between the lines 3.0 and 3.5
    expect(effectPassAt(clip, 3.25, grid)!.amount).toBeCloseTo(pulseEnvelope(1, 0.5), 9);
    expect(effectPassAt(clip, 3, grid)!.amount).toBeCloseTo(1, 12);
  });

  it('with pulse 1 the effect can fall to nothing: the pass stays (it is the identity there)', () => {
    const clip = fx(0, 8, { beat: beat({ pulse: 1 }) });
    const p = effectPassAt(clip, 2.499, G)!;
    expect(p.amount).toBeLessThan(0.001);
  });
});

describe('lock', () => {
  it('restarts the look on every line and replaces the rate of the effect', () => {
    const clip = fx(2, 6, { params: { rate: 3 }, beat: beat({ lock: true }) });
    const cycle = 0.5;
    // flash repeats rate x 1 per second: one flash per cycle
    for (const t of [2.1, 2.3, 4.2, 6.45]) {
      const p = effectPassAt(clip, t, G)!;
      expect(p.params.rate).toBeCloseTo(1 / cycle, 12);
      const line0 = 2; // the last line at or before the clip start
      expect(p.time).toBeCloseTo(t - line0, 9);
      expect((p.time * p.params.rate!) % 1).toBeCloseTo(((t - 2) % cycle) / cycle, 6);
    }
  });

  it('ignores the stored value, the keyframes and the range of the param', () => {
    const clip = fx(0, 8, { params: { rate: 0.2 }, keyframes: { 'p.rate': [{ t: 0, v: 12, ease: 'linear' }] }, beat: beat({ every: 0.25, lock: true }) });
    // cycle = 0.125 s -> 8 hz, no clamping to the param range 0.2..12 (it would be fine here), and 4x2: use a faster one
    expect(effectPassAt(clip, 1.01, G)!.params.rate).toBeCloseTo(8, 12);
    const fast = fx(0, 8, { beat: beat({ every: 1 / 16, lock: true }) });
    expect(effectPassAt(fast, 1.01, G)!.params.rate).toBeCloseTo(32, 12);
  });

  it('uses the cycles of the def: swirl is half a trip per hz', () => {
    const clip = fx(0, 8, { effect: 'swirl', params: { speed: 0.5 }, beat: beat({ every: 2, lock: true }) });
    // cycle 1 s, 0.5 repeats per unit of speed -> speed = 2
    expect(effectPassAt(clip, 1.5, G)!.params.speed).toBeCloseTo(2, 12);
  });

  it('keeps the other params and the duration', () => {
    const clip = fx(0, 8, { params: { rate: 3, strength: 55 }, fullDuration: 20, beat: beat({ lock: true }) });
    const p = effectPassAt(clip, 1.2, G)!;
    expect(p.params.strength).toBe(55);
    expect(p.duration).toBe(20);
  });

  it('an effect without sync metadata only pulses', () => {
    const clip = fx(2, 6, { effect: 'shake', params: { speed: 4 }, timeOffset: 0.5, beat: beat({ lock: true, pulse: 0.5 }) });
    const p = effectPassAt(clip, 3.25, G)!;
    expect(p.params).toEqual({ speed: 4 });
    expect(p.time).toBeCloseTo(1.25 + 0.5, 12);
    expect(p.amount).toBeCloseTo(pulseEnvelope(0.5, 0.5), 12);
  });

  it('timeOffset is ignored only in lock mode', () => {
    const base = { timeOffset: 0.7 };
    const locked = effectPassAt(fx(2, 6, { ...base, beat: beat({ lock: true }) }), 3.25, G)!;
    expect(locked.time).toBeCloseTo(1.25, 12);
    const pulsed = effectPassAt(fx(2, 6, { ...base, beat: beat({ pulse: 0.5 }) }), 3.25, G)!;
    expect(pulsed.time).toBeCloseTo(1.25 + 0.7, 12);
  });

  it('a clip that starts between two lines: the clock runs from the line before it', () => {
    const clip = fx(2.3, 4, { beat: beat({ lock: true }) });
    // lines every 0.5 s: the line before 2.3 is 2.0
    expect(effectPassAt(clip, 2.3, G)!.time).toBeCloseTo(0.3, 12);
    expect(effectPassAt(clip, 2.5, G)!.time).toBeCloseTo(0.5, 3);
    expect(effectPassAt(clip, 2.6, G)!.time).toBeCloseTo(0.6, 12);
  });

  it('a clip that starts before the grid origin', () => {
    const grid: BeatGrid = { origin: 10.2, step: 0.5 };
    const clip = fx(2, 4, { beat: beat({ lock: true }) });
    // 10.2 - 16 * 0.5 = 2.2: the line before 2 is 1.7
    expect(effectPassAt(clip, 2, grid)!.time).toBeCloseTo(0.3, 9);
    expect(effectPassAt(clip, 2.2, grid)!.time).toBeCloseTo(0.5, 3);
  });

  it('a split keeps the look: the right half has the clock of the whole', () => {
    const whole = fx(2, 6, { beat: beat({ lock: true }) });
    const right = fx(4.25, 3.75, { beat: beat({ lock: true }), timeOffset: 2.25, fullDuration: 6 });
    for (const t of [4.3, 5, 5.17, 7.9]) {
      // a cut on a cycle line (4.0) or any other time: the phase at every frame is the same
      const a = effectPassAt(whole, t, G)!;
      const b = effectPassAt(right, t, G)!;
      expect((a.time * a.params.rate!) % 1).toBeCloseTo((b.time * b.params.rate!) % 1, 6);
      expect(a.params.rate).toBe(b.params.rate);
    }
  });

  it('on a line the phase is exactly 0 (a hair past it for the shader), 500 beats at 128 and 174.3 bpm', () => {
    for (const bpm of [128, 174.3]) {
      const grid: BeatGrid = { origin: 0.0371, step: 60 / bpm };
      for (const fps of [24000 / 1001, 30, 60, 240]) {
        const clip = fx(0.5, 400, { beat: beat({ lock: true }) });
        for (let k = 1; k < 500; k++) {
          const line = grid.origin + k * grid.step;
          const t = Math.round(line * fps) / fps;
          if (Math.abs(t - line) > 1e-9) continue;
          const p = effectPassAt(clip, t, grid)!;
          const cycles = p.time * p.params.rate!;
          // what the shader reads: a whole number and a hair, never a whole number minus a hair
          expect(cycles - Math.round(cycles)).toBeGreaterThan(0);
          expect(cycles - Math.round(cycles)).toBeLessThan(LINE_NUDGE * 2);
        }
      }
    }
  });

  it('is the same phase at every frame rate for the same moment', () => {
    const clip = fx(0, 20, { beat: beat({ lock: true }) });
    const grid: BeatGrid = { origin: 0.4, step: 60 / 128 };
    const at = (t: number) => {
      const p = effectPassAt(clip, t, grid)!;
      return (p.time * p.params.rate!) % 1;
    };
    expect(at(7.3)).toBeCloseTo(cyclePhase(grid, 1, 7.3).phase, 6);
  });
});

describe('beatGridOf and the callers that have the project', () => {
  it('finds the sound under the effect, remembers it, and follows a named clip', () => {
    const a = song(0, 4, 120);
    const b = song(4, 10, 90);
    const e = fx(5, 2, { beat: beat({ pulse: 0.5 }) });
    const p = project([a, b, e]);
    expect(beatGridOf(p, e)).toEqual({ origin: 4, step: 60 / 90 });
    expect(beatGridOf(p, e)).toBe(beatGridOf(p, e));
    const named = fx(5, 2, { beat: beat({ pulse: 0.5, source: a.id }) });
    expect(beatGridOf(project([a, b, named]), named)).toEqual({ origin: 0, step: 0.5 });
  });

  it('no link, a link that does nothing, or no tempo: no grid', () => {
    const a = song(0, 4, 120);
    const off = fx(0, 4);
    const idle = fx(0, 4, { beat: beat() });
    const live = fx(0, 4, { beat: beat({ pulse: 1 }) });
    expect(hasBeatLink(off)).toBe(false);
    expect(hasBeatLink(idle)).toBe(false);
    expect(hasBeatLink(live)).toBe(true);
    const p = project([a, off, idle, live]);
    expect(beatGridOf(p, off)).toBeNull();
    expect(beatGridOf(p, idle)).toBeNull();
    expect(beatGridOf(p, live)).not.toBeNull();
    const silent = project([song(0, 4, null), live]);
    expect(beatGridOf(silent, live)).toBeNull();
  });

  it('a deleted source falls back to the sound under the effect', () => {
    const a = song(0, 10, 120);
    const e = fx(1, 2, { beat: beat({ pulse: 1, source: 'gone' }) });
    expect(beatGridOf(project([a, e]), e)).toEqual({ origin: 0, step: 0.5 });
  });

  it('a tempo change makes a new grid (the clips array is new)', () => {
    const a = song(0, 10, 120);
    const e = fx(1, 2, { beat: beat({ pulse: 1 }) });
    const one = project([a, e]);
    const two = project([{ ...a, bpm: 60 }, e]);
    expect(beatGridOf(one, e)!.step).toBe(0.5);
    expect(beatGridOf(two, e)!.step).toBe(1);
  });

  it('clipFxPasses (effects on one clip) use the grid, also at the clamped time of a frozen half', () => {
    const a = song(0, 20, 120);
    const pic = picture(0, 4);
    const e = fx(0, 8, { target: pic.id, beat: beat({ pulse: 1 }) });
    const p = project([a, pic, e]);
    const fxIndex = targetIndex(p);
    const mid = clipFxPasses(p, fxIndex, pic.id, 1.25)!;
    expect(mid).toHaveLength(1);
    expect(mid[0]!.amount).toBeCloseTo(pulseEnvelope(1, 0.5), 9);
    const frozen = clipFxPasses(p, fxIndex, pic.id, 3.9999)!;
    expect(frozen[0]!.amount).toBeCloseTo(pulseEnvelope(1, (3.9999 % 0.5) / 0.5), 6);
    // no tempo in the project: the old pass
    const quiet = project([pic, e]);
    expect(clipFxPasses(quiet, targetIndex(quiet), pic.id, 1.25)![0]!.amount).toBe(1);
  });

  it('a video with sound is a source, a mute one is not', () => {
    const vid: VideoClip = {
      id: 'vv',
      type: 'video',
      trackId: 'v1',
      start: 0,
      duration: 10,
      name: 'v',
      fadeIn: 0,
      fadeOut: 0,
      assetId: 'aud',
      trimStart: 0,
      speed: 1,
      volume: 1,
      muted: false,
      transform: { ...DEFAULT_TRANSFORM },
      bpm: 100,
    };
    const e = fx(1, 2, { beat: beat({ pulse: 1 }) });
    expect(beatGridOf(project([vid, e]), e)!.step).toBeCloseTo(0.6, 12);
    const mute = project([{ ...vid, assetId: 'img' }, e]);
    expect(beatGridOf(mute, e)).toBeNull();
  });
});
