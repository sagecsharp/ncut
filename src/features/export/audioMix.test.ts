import { describe, expect, it } from 'vitest';
import type { AudioClip } from '../../types';
import { createProject } from '../../lib/factory';
import { MIX_CHUNK_SECONDS, MIX_SAMPLE_RATE, clipSchedule, clipWindow, createAudioMixer, gainPoints, planMixChunks, soundWindow, trimGainPoints } from './audioMix';

describe('clipWindow', () => {
  it('a clip fully inside the range lands at its offset', () => {
    const w = clipWindow(5, 2, 1, 4, 10)!;
    expect(w.when).toBeCloseTo(1);
    expect(w.skip).toBe(0);
    expect(w.span).toBeCloseTo(2);
  });
  it('a clip that starts before the range is cut at the head, in source seconds', () => {
    // timeline 2..6 at speed 2, range starts at 3: 1 timeline second is skipped = 2 source seconds
    const w = clipWindow(2, 4, 2, 3, 10)!;
    expect(w.when).toBe(0);
    expect(w.skip).toBeCloseTo(2);
    expect(w.span).toBeCloseTo(6);
    expect(w.localFrom).toBeCloseTo(1);
  });
  it('a clip that runs past the range end is cut at the tail', () => {
    const w = clipWindow(8, 4, 1, 5, 5)!;
    expect(w.when).toBeCloseTo(3);
    expect(w.span).toBeCloseTo(2);
  });
  it('is null outside the range', () => {
    expect(clipWindow(0, 2, 1, 2, 5)).toBeNull();
    expect(clipWindow(7, 2, 1, 2, 5)).toBeNull();
  });
});

describe('trimGainPoints', () => {
  const env: Array<[number, number]> = [
    [0, 0],
    [1, 1],
    [3, 1],
    [4, 0],
  ];
  it('keeps the whole envelope when nothing is cut', () => {
    expect(trimGainPoints(env, 0, 4)).toEqual(env);
  });
  it('cuts the head inside a fade and re-bases the time', () => {
    const t = trimGainPoints(env, 0.5, 4);
    expect(t[0]).toEqual([0, 0.5]);
    expect(t[1]).toEqual([0.5, 1]);
    expect(t[t.length - 1]).toEqual([3.5, 0]);
  });
  it('cuts the tail inside the fade out', () => {
    const t = trimGainPoints(env, 0, 3.5);
    expect(t[t.length - 1]![0]).toBeCloseTo(3.5);
    expect(t[t.length - 1]![1]).toBeCloseTo(0.5);
  });
  it('never returns negative times', () => {
    for (const p of trimGainPoints(env, 2, 3.5)) expect(p[0]).toBeGreaterThanOrEqual(0);
  });
});

describe('planMixChunks', () => {
  it('cuts the mix in pieces that cover it exactly, the last one is the rest', () => {
    const chunks = planMixChunks(100, 40);
    expect(chunks).toEqual([
      { startFrame: 0, frames: 40 },
      { startFrame: 40, frames: 40 },
      { startFrame: 80, frames: 20 },
    ]);
  });
  it('one chunk when it fits, none for an empty mix', () => {
    expect(planMixChunks(10, 40)).toEqual([{ startFrame: 0, frames: 10 }]);
    expect(planMixChunks(0, 40)).toEqual([]);
  });
  it('a 90 minute project is 180 chunks of 30 s, each far below the old 2 gb buffer', () => {
    const total = 90 * 60 * MIX_SAMPLE_RATE;
    const chunks = planMixChunks(total, MIX_CHUNK_SECONDS * MIX_SAMPLE_RATE);
    expect(chunks.length).toBe(180);
    expect(chunks.reduce((n, c) => n + c.frames, 0)).toBe(total);
    expect(Math.max(...chunks.map((c) => c.frames)) * 2 * 4).toBeLessThan(12 * 1024 * 1024);
  });
  it('a clip crossing a chunk border is split into two windows that tile it', () => {
    const [a, b] = planMixChunks(60 * MIX_SAMPLE_RATE, MIX_CHUNK_SECONDS * MIX_SAMPLE_RATE);
    // clip 20..40 s at speed 1.5
    const wa = clipWindow(20, 20, 1.5, a!.startFrame / MIX_SAMPLE_RATE, a!.frames / MIX_SAMPLE_RATE)!;
    const wb = clipWindow(20, 20, 1.5, b!.startFrame / MIX_SAMPLE_RATE, b!.frames / MIX_SAMPLE_RATE)!;
    expect(wa.when).toBeCloseTo(20);
    expect(wb.when).toBeCloseTo(0);
    // the second piece resumes exactly where the first stopped, in source seconds
    expect(wa.skip + wa.span).toBeCloseTo(wb.skip);
    expect(wa.localTo).toBeCloseTo(wb.localFrom);
    expect(wa.span + wb.span).toBeCloseTo(20 * 1.5);
  });
});

describe('clipSchedule', () => {
  const clip = (over: Partial<AudioClip> = {}): AudioClip => ({
    id: 'c', name: 'c', type: 'audio', trackId: 't', assetId: 'a', start: 2, duration: 4, trimStart: 0.25, speed: 1.5, volume: 0.8, muted: false,
    fadeIn: 0.5, fadeOut: 1, keyframes: { volume: [{ t: 0, v: 0.5, ease: 'linear' }, { t: 2, v: 1, ease: 'linear' }] }, ...over,
  });
  it('equals clipWindow + gainPoints + trimGainPoints, timed from the window start', () => {
    const c = clip();
    for (const [offset, length] of [[0, 10], [3, 2], [5, 30]] as const) {
      const win = clipWindow(c.start, c.duration, c.speed, offset, length)!;
      const sch = clipSchedule(c, offset, length)!;
      expect(sch.assetId).toBe('a');
      expect(sch.from).toBe(Math.max(0, c.trimStart) + win.skip);
      expect(sch.span).toBe(win.span);
      expect(sch.when).toBe(win.when);
      expect(sch.rate).toBe(c.speed);
      expect(sch.gain).toEqual(trimGainPoints(gainPoints(c), win.localFrom, win.localTo).map(([t, g]) => [win.when + t, g]));
      expect(sch.win).toEqual(win);
    }
  });
  it('is null outside the window', () => {
    expect(clipSchedule(clip(), 6, 5)).toBeNull();
    expect(clipSchedule(clip(), 0, 2)).toBeNull();
  });
  it('a negative trimStart reads as 0', () => {
    expect(clipSchedule(clip({ trimStart: -3 }), 0, 10)!.from).toBe(0);
  });
});

describe('mix rate', () => {
  it('mixes at 48000 by default', () => {
    const m = createAudioMixer(createProject('x'), 2.5);
    expect(m.sampleRate).toBe(48000);
    expect(m.totalFrames).toBe(120000);
  });
  it('an export can ask for 44100', () => {
    const m = createAudioMixer(createProject('x'), 2.5, undefined, undefined, 0, 44100);
    expect(m.sampleRate).toBe(44100);
    expect(m.totalFrames).toBe(110250);
    expect(m.chunks).toEqual([{ startFrame: 0, frames: 110250 }]);
  });
  it('chunks are cut at the mix rate and cover the mix', () => {
    const m = createAudioMixer(createProject('x'), 70, undefined, undefined, 0, 44100);
    expect(m.chunks.map((c) => c.frames)).toEqual([1323000, 1323000, 441000]);
    expect(m.chunks.reduce((n, c) => n + c.frames, 0)).toBe(m.totalFrames);
  });
});

describe('crossfade hooks without a sound', () => {
  const clip = (over: Partial<AudioClip> = {}): AudioClip => ({
    id: 'c', name: 'c', type: 'audio', trackId: 't', assetId: 'a', start: 2, duration: 4, trimStart: 0.25, speed: 1.5, volume: 0.8, muted: false,
    fadeIn: 0.5, fadeOut: 1, keyframes: { volume: [{ t: 0, v: 0.5, ease: 'linear' }, { t: 2, v: 1, ease: 'linear' }] }, ...over,
  });
  it('soundWindow with no sound is clipWindow', () => {
    const c = clip();
    for (const [offset, length] of [[0, 10], [3, 2], [5, 30]] as const) {
      expect(soundWindow(c, null, offset, length)).toEqual(clipWindow(c.start, c.duration, c.speed, offset, length));
    }
    expect(soundWindow(c, null, 6, 5)).toBeNull();
  });
  it('clipSchedule with a null sound is the old schedule, head 0', () => {
    const c = clip();
    for (const [offset, length] of [[0, 10], [3, 2], [5, 30]] as const) {
      const old = clipSchedule(c, offset, length)!;
      expect(clipSchedule(c, offset, length, null)).toEqual(old);
      expect(old.head).toBe(0);
    }
  });
});
