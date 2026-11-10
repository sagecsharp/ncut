import { describe, expect, it } from 'vitest';
import { beatsInClip, detectBeats, snapToOnsets, thinBeats } from './beats';

const PPS = 50;

/** deterministic noise */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** click track: a spike with a short decay at each beat, jitter in seconds, noise floor */
function clicks(bpm: number, seconds: number, opts: { offset?: number; jitter?: number; noise?: number } = {}) {
  const rand = rng(7);
  const n = Math.round(seconds * PPS);
  const peaks = new Float32Array(n);
  const noise = opts.noise ?? 0;
  for (let i = 0; i < n; i++) peaks[i] = rand() * noise;
  const times: number[] = [];
  const period = 60 / bpm;
  for (let t = opts.offset ?? 0; t < seconds - 0.1; t += period) {
    const tj = t + (rand() * 2 - 1) * (opts.jitter ?? 0);
    times.push(tj);
    const i = Math.floor(tj * PPS);
    if (i >= 0 && i < n) {
      peaks[i] = 1;
      if (i + 1 < n) peaks[i + 1] = Math.max(peaks[i + 1]!, 0.5);
    }
  }
  return { peaks, times };
}

/** worst distance from a detected beat to the nearest true click */
function maxErr(beats: number[], truth: number[]) {
  let worst = 0;
  for (const b of beats) {
    let d = Infinity;
    for (const t of truth) d = Math.min(d, Math.abs(t - b));
    worst = Math.max(worst, d);
  }
  return worst;
}

describe('detectBeats', () => {
  it('finds 120 bpm with jitter and noise', () => {
    const { peaks, times } = clicks(120, 40, { jitter: 0.008, noise: 0.08 });
    const r = detectBeats(peaks, PPS);
    expect(r.reason).toBe('ok');
    expect(Math.abs(r.bpm - 120)).toBeLessThan(1);
    expect(r.confidence).toBeGreaterThan(0.5);
    expect(r.beats.length).toBeGreaterThan(70);
    expect(maxErr(r.beats, times)).toBeLessThan(0.03);
  });

  it('finds 90 bpm', () => {
    const { peaks, times } = clicks(90, 40, { jitter: 0.005, noise: 0.05 });
    const r = detectBeats(peaks, PPS);
    expect(r.reason).toBe('ok');
    expect(Math.abs(r.bpm - 90)).toBeLessThan(1);
    expect(maxErr(r.beats, times)).toBeLessThan(0.03);
  });

  it('finds a non integer bpm', () => {
    const { peaks } = clicks(133, 60, { noise: 0.03 });
    const r = detectBeats(peaks, PPS);
    expect(Math.abs(r.bpm - 133)).toBeLessThan(1);
  });

  it('gives nothing for silence', () => {
    const r = detectBeats(new Float32Array(30 * PPS), PPS);
    expect(r.beats).toEqual([]);
    expect(r.reason).toBe('silent');
  });

  it('gives nothing for steady noise', () => {
    const rand = rng(3);
    const p = new Float32Array(60 * PPS);
    for (let i = 0; i < p.length; i++) p[i] = 0.3 + rand() * 0.4;
    const r = detectBeats(p, PPS);
    expect(r.beats).toEqual([]);
    expect(r.reason).toBe('no steady beat');
  });

  it('gives nothing for a very short sound', () => {
    expect(detectBeats(new Float32Array(50).fill(1), PPS).reason).toBe('too short');
  });

  it('gets the phase right after 2 s of silence', () => {
    const { peaks, times } = clicks(120, 30, { offset: 2.13, noise: 0.02 });
    const r = detectBeats(peaks, PPS);
    expect(r.reason).toBe('ok');
    expect(maxErr(r.beats, times)).toBeLessThan(0.03);
    expect(Math.abs(r.beats[0]! - 2.13)).toBeLessThan(0.03);
  });

  it('does not pick half or double tempo', () => {
    for (const bpm of [100, 120, 140]) {
      const { peaks } = clicks(bpm, 40, { jitter: 0.006, noise: 0.06 });
      const r = detectBeats(peaks, PPS);
      expect(Math.abs(r.bpm - bpm)).toBeLessThan(1.5);
    }
  });

  it('is fast on a ten minute song', () => {
    const { peaks } = clicks(128, 600, { jitter: 0.004, noise: 0.05 });
    const t0 = performance.now();
    const r = detectBeats(peaks, PPS);
    const ms = performance.now() - t0;
    expect(r.reason).toBe('ok');
    expect(ms).toBeLessThan(100);
  });
});

describe('beatsInClip', () => {
  const beats = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  it('plain clip', () => {
    expect(beatsInClip(beats, { start: 10, duration: 4, trimStart: 0, speed: 1 })).toEqual([10, 11, 12, 13, 14]);
  });
  it('trimmed clip only has beats inside', () => {
    expect(beatsInClip(beats, { start: 5, duration: 3, trimStart: 2.5, speed: 1 })).toEqual([5.5, 6.5, 7.5]);
  });
  it('speed 2 halves the spacing', () => {
    expect(beatsInClip(beats, { start: 0, duration: 2, trimStart: 0, speed: 2 })).toEqual([0, 0.5, 1, 1.5, 2]);
  });
  it('speed 0.5 doubles the spacing', () => {
    expect(beatsInClip(beats, { start: 1, duration: 4, trimStart: 1, speed: 0.5 })).toEqual([1, 3, 5]);
  });
});

describe('thinBeats', () => {
  it('keeps every nth starting with the first', () => {
    expect(thinBeats([1, 2, 3, 4, 5, 6, 7], 2)).toEqual([1, 3, 5, 7]);
    expect(thinBeats([1, 2, 3, 4, 5, 6, 7], 4)).toEqual([1, 5]);
    expect(thinBeats([1, 2, 3], 1)).toEqual([1, 2, 3]);
  });
});

describe('onset snapping', () => {
  it('lands on hits that wander +-25 ms around the grid', () => {
    const pps = 200;
    const seconds = 40;
    const n = seconds * pps;
    const rand = rng(11);
    const peaks = new Float32Array(n);
    const hits: number[] = [];
    for (let t = 0.5; t < seconds - 0.5; t += 0.5) {
      const tj = t + (rand() * 2 - 1) * 0.025;
      hits.push(tj);
      const i = Math.floor(tj * pps);
      peaks[i] = 1;
      peaks[i + 1] = 0.5;
    }
    const r = detectBeats(peaks, pps);
    expect(r.reason).toBe('ok');
    expect(r.beats.length).toBeGreaterThan(70);
    expect(maxErr(r.beats, hits)).toBeLessThan(0.012);
  });

  it('keeps the grid where there is no clear hit', () => {
    const env = new Float32Array(100);
    for (let i = 0; i < 100; i++) env[i] = 0.1;
    expect(snapToOnsets(env, [20, 60], 40, 50)).toEqual([20, 60]);
  });
});
