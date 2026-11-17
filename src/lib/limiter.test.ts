import { describe, expect, it, vi } from 'vitest';
import { LoudnessMeter } from './loudness';
import { createLimiter, createOutputStage } from './limiter';

const RATE = 48000;

vi.setConfig({ testTimeout: 30000 });
type Stereo = { l: Float32Array; r: Float32Array };

/** a raised cosine fade over 20 ms at both ends: a hard start is a step, and a step overshoots between the samples */
function fadeEnds(x: Float32Array, rate: number, ms = 20): void {
  const f = Math.round((rate * ms) / 1000);
  for (let i = 0; i < f && i < x.length; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / f);
    x[i] = x[i]! * g;
    x[x.length - 1 - i] = x[x.length - 1 - i]! * g;
  }
}

function sine(db: number, seconds: number, hz = 1000, rate = RATE, phase = 0, fadeMs = 20): Stereo {
  const n = Math.round(seconds * rate);
  const a = 10 ** (db / 20);
  const l = new Float32Array(n);
  for (let i = 0; i < n; i++) l[i] = a * Math.sin(2 * Math.PI * hz * (i / rate) + phase);
  fadeEnds(l, rate, fadeMs);
  return { l, r: l.slice() };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noise(db: number, seconds: number, seed: number, rate = RATE): Stereo {
  const rnd = mulberry32(seed);
  const n = Math.round(seconds * rate);
  const a = 10 ** (db / 20);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = a * (rnd() * 2 - 1);
    r[i] = a * (rnd() * 2 - 1);
  }
  fadeEnds(l, rate);
  fadeEnds(r, rate);
  return { l, r };
}

function join(parts: Stereo[]): Stereo {
  const n = parts.reduce((s, p) => s + p.l.length, 0);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  let at = 0;
  for (const p of parts) {
    l.set(p.l, at);
    r.set(p.r, at);
    at += p.l.length;
  }
  return { l, r };
}

/** the input with a stretch laid over it */
function over(base: Stereo, patch: Stereo, at: number): Stereo {
  const l = base.l.slice();
  const r = base.r.slice();
  l.set(patch.l, at);
  r.set(patch.r, at);
  return { l, r };
}

function limit(sig: Stereo, size: number, ceiling = -1, rate = RATE, gain = 1) {
  const lim = createLimiter(rate, ceiling);
  const n = sig.l.length;
  const outL = new Float32Array(n + lim.latency);
  const outR = new Float32Array(n + lim.latency);
  let pos = 0;
  for (let at = 0; at < n; at += size) pos += lim.process(sig.l, sig.r, at, Math.min(size, n - at), gain, outL, outR, pos);
  pos += lim.flush(outL, outR, pos);
  return { lim, l: outL.subarray(0, pos), r: outR.subarray(0, pos), count: pos };
}

function peakOf(l: Float32Array, r: Float32Array, rate = RATE): number {
  const m = new LoudnessMeter(rate);
  m.push(l, r, 0, l.length);
  m.finish();
  return m.truePeak();
}

describe('limiter', () => {
  it('latency is the attack plus 15', () => {
    expect(createLimiter(48000, -1).latency).toBe(255);
    expect(createLimiter(44100, -1).latency).toBe(236);
  });

  it('every frame comes out after the flush', () => {
    const sig = sine(-6, 1);
    for (const size of [1, 100, 4800, 48000]) expect(limit(sig, size).count).toBe(sig.l.length);
    const tiny = { l: new Float32Array(100).fill(0.1), r: new Float32Array(100).fill(0.1) };
    expect(limit(tiny, 100).count).toBe(100);
  });

  it('a quiet sine passes bit for bit', () => {
    const sig = sine(-12, 2);
    const o = limit(sig, 4800);
    expect(o.l).toEqual(sig.l);
    expect(o.r).toEqual(sig.r);
    expect(o.lim.maxReductionDb()).toBe(0);
    expect(Object.is(o.lim.maxReductionDb(), 0)).toBe(true);
    expect(o.lim.limitedFrames()).toBe(0);
    expect(o.lim.framesOut()).toBe(sig.l.length);
  });

  it('a quiet sine with a gain is the input times the gain, rounded once', () => {
    const sig = sine(-12, 2);
    const o = limit(sig, 4800, -1, RATE, 0.7);
    expect(o.l).toEqual(Float32Array.from(sig.l, (x) => Math.fround(x * 0.7)));
    expect(o.r).toEqual(Float32Array.from(sig.r, (x) => Math.fround(x * 0.7)));
    expect(o.lim.maxReductionDb()).toBe(0);
    expect(o.lim.limitedFrames()).toBe(0);
  });

  it('a lone burst is held and released', () => {
    const base = sine(-30, 4);
    const burst = sine(0, 0.05, 1000, RATE, 0, 5);
    const sig = over(base, burst, 2 * RATE);
    const o = limit(sig, 4800);
    const tp = peakOf(o.l.subarray(RATE), o.r.subarray(RATE));
    expect(o.lim.maxReductionDb()).toBeGreaterThan(0);
    // the burst region only (the quiet sine is far under)
    const region = o.l.subarray(2 * RATE - 2000, 2 * RATE + 5000);
    const reg = peakOf(region, region);
    expect(reg).toBeGreaterThan(-1.3);
    expect(reg).toBeLessThan(-1.0);
    expect(tp).toBeLessThan(-1.0);
    // one second after the burst the gain is back to 1
    let worst = 0;
    for (let i = 3 * RATE + 100; i < 3 * RATE + 3000; i++) {
      const x = sig.l[i]!;
      if (Math.abs(x) < 0.01) continue;
      worst = Math.max(worst, Math.abs(o.l[i]! / x - 1));
    }
    expect(worst).toBeLessThan(1e-4);
  });

  it('the quarter rate sine stays under the ceiling', () => {
    // samples reach -1.5 dbfs, the peak between them is 1.5 dbtp
    const a = 10 ** (-1.5 / 20) / Math.sin(Math.PI / 4);
    const n = RATE * 2;
    const l = new Float32Array(n);
    for (let i = 0; i < n; i++) l[i] = a * Math.sin((Math.PI / 2) * i + Math.PI / 4);
    fadeEnds(l, RATE);
    const sig = { l, r: l.slice() };
    expect(peakOf(sig.l, sig.r)).toBeGreaterThan(1);
    const o = limit(sig, 4800);
    expect(peakOf(o.l, o.r)).toBeLessThanOrEqual(-1.0);
  });

  it('long limiting stays under the ceiling', () => {
    const bursts: Stereo[] = [];
    for (let i = 0; i < 8; i++) {
      bursts.push(sine(5, 0.3, 997));
      bursts.push(sine(-20, 0.3, 997));
    }
    const sig = join([...bursts, noise(2, 5, 7), sine(-20, 0.5), sine(0, 0.3, 997)]);
    const o = limit(sig, 4800);
    expect(o.lim.maxReductionDb()).toBeGreaterThan(3);
    expect(o.lim.limitedFrames()).toBeGreaterThan(0);
    expect(peakOf(o.l, o.r)).toBeLessThanOrEqual(-1.0);
  }, 30000);

  it('slice sizes change nothing', () => {
    const sig = over(sine(-6, 3), sine(4, 0.2, 800), RATE);
    const whole = limit(sig, sig.l.length);
    expect(whole.lim.maxReductionDb()).toBeGreaterThan(0);
    for (const size of [1, 1000, 48000, 7]) {
      const o = limit(sig, size);
      expect(o.count).toBe(whole.count);
      expect(o.l).toEqual(whole.l);
      expect(o.r).toEqual(whole.r);
      expect(o.lim.maxReductionDb()).toBe(whole.lim.maxReductionDb());
    }
  }, 30000);
});

describe('output stage', () => {
  it('stage with gain only', () => {
    const st = createOutputStage({ rate: RATE, gain: 2, ceiling: null });
    expect(st.latency).toBe(0);
    const sig = sine(-12, 0.5);
    const o = st.process(sig.l, sig.r);
    expect(o.l.length).toBe(sig.l.length);
    for (let i = 0; i < sig.l.length; i += 97) expect(o.l[i]).toBe(Math.fround(sig.l[i]! * 2));
    expect(st.flush().l.length).toBe(0);
    expect(st.report().after).toBeNull();
    expect(st.report().limitDb).toBe(0);
  });

  it('stage with a ceiling reports', () => {
    const st = createOutputStage({ rate: RATE, gain: 2, ceiling: -1 });
    expect(st.latency).toBe(255);
    const sig = over(sine(-12, 3), sine(-3, 0.3, 700), RATE);
    let got = 0;
    for (let at = 0; at < sig.l.length; at += 4800) {
      const n = Math.min(4800, sig.l.length - at);
      const o = st.process(sig.l.subarray(at, at + n), sig.r.subarray(at, at + n));
      if (at === 0) expect(o.l.length).toBe(n - 255);
      got += o.l.length;
    }
    got += st.flush().l.length;
    expect(got).toBe(sig.l.length);
    expect(st.flush().l.length).toBe(0);
    const rep = st.report();
    expect(rep.limitDb).toBeGreaterThanOrEqual(0);
    expect(rep.limitDb).toBeGreaterThan(0);
    expect(rep.limitShare).toBeGreaterThan(0);
    expect(rep.limitShare).toBeLessThanOrEqual(1);
    expect(rep.after!.truePeak).toBeLessThanOrEqual(-1);
    expect(rep.after!.seconds).toBe(3);
  });
});
