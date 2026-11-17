import { describe, expect, it, vi } from 'vitest';
import { LoudnessMeter, TP_L1, TP_PHASES, gatedLoudness, kWeighting, loudnessRange, measureSamples, toLufs, truePeakOf, truePeakPhases } from './loudness';

const RATE = 48000;

vi.setConfig({ testTimeout: 30000 });

/** a raised cosine fade over 20 ms at both ends (a hard start is a step, and a step overshoots between the samples) */
function fadeEnds(x: Float32Array, rate: number): void {
  const f = Math.round(rate * 0.02);
  for (let i = 0; i < f && i < x.length; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / f);
    x[i] = x[i]! * g;
    x[x.length - 1 - i] = x[x.length - 1 - i]! * g;
  }
}

/** one sine, peak level dbfs in both channels */
function sine(dbfs: number, seconds: number, hz = 1000, rate = RATE, phase = 0, fade = false): { l: Float32Array; r: Float32Array } {
  const n = Math.round(seconds * rate);
  const a = 10 ** (dbfs / 20);
  const l = new Float32Array(n);
  for (let i = 0; i < n; i++) l[i] = a * Math.sin(2 * Math.PI * hz * (i / rate) + phase);
  if (fade) fadeEnds(l, rate);
  return { l, r: l.slice() };
}

/** the levels one after the other, [dbfs, seconds] */
function steps(parts: Array<[number, number]>, rate = RATE): { l: Float32Array; r: Float32Array } {
  const total = parts.reduce((s, p) => s + Math.round(p[1] * rate), 0);
  const l = new Float32Array(total);
  let at = 0;
  for (const [db, sec] of parts) {
    const n = Math.round(sec * rate);
    const a = 10 ** (db / 20);
    for (let i = 0; i < n; i++) l[at + i] = a * Math.sin(2 * Math.PI * 1000 * ((at + i) / rate));
    at += n;
  }
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

function noise(seconds: number, amp: number, seed: number, rate = RATE): { l: Float32Array; r: Float32Array } {
  const rnd = mulberry32(seed);
  const n = Math.round(seconds * rate);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = amp * (rnd() * 2 - 1);
    r[i] = amp * (rnd() * 2 - 1);
  }
  return { l, r };
}

function run(s: { l: Float32Array; r: Float32Array }, rate = RATE): LoudnessMeter {
  const m = new LoudnessMeter(rate);
  m.push(s.l, s.r, 0, s.l.length);
  m.finish();
  return m;
}

/** the power of a block at this loudness */
const powerOf = (lufs: number): number => 10 ** ((lufs + 0.691) / 10);

describe('k weighting', () => {
  it('k weighting matches the bs.1770 table', () => {
    const [s1, s2] = kWeighting(48000);
    expect(s1.b0).toBeCloseTo(1.53512485958697, 6);
    expect(s1.b1).toBeCloseTo(-2.69169618940638, 6);
    expect(s1.b2).toBeCloseTo(1.19839281085285, 6);
    expect(s1.a1).toBeCloseTo(-1.69065929318241, 6);
    expect(s1.a2).toBeCloseTo(0.73248077421585, 6);
    expect([s2.b0, s2.b1, s2.b2]).toEqual([1, -2, 1]);
    expect(s2.a1).toBeCloseTo(-1.99004745483398, 6);
    expect(s2.a2).toBeCloseTo(0.99007225036621, 6);
  });

  it('k weighting adds 0.691 db at 1 khz at any rate', () => {
    for (const rate of [44100, 48000, 96000]) {
      const [s1, s2] = kWeighting(rate);
      const w = (2 * Math.PI * 1000) / rate;
      const mag2 = (b: { b0: number; b1: number; b2: number; a1: number; a2: number }): number => {
        const c = (k: number): [number, number] => [Math.cos(k * w), -Math.sin(k * w)];
        const num = [b.b0 + b.b1 * c(1)[0] + b.b2 * c(2)[0], b.b1 * c(1)[1] + b.b2 * c(2)[1]];
        const den = [1 + b.a1 * c(1)[0] + b.a2 * c(2)[0], b.a1 * c(1)[1] + b.a2 * c(2)[1]];
        return (num[0]! ** 2 + num[1]! ** 2) / (den[0]! ** 2 + den[1]! ** 2);
      };
      const db = 10 * Math.log10(mag2(s1) * mag2(s2));
      expect(Math.abs(db - 0.691)).toBeLessThan(0.03);
    }
  });
});

describe('ebu 3341', () => {
  it('ebu 3341 case 1', () => {
    const m = run(steps([[-23, 20]]));
    expect(Math.abs(m.integrated() + 23)).toBeLessThan(0.1);
    expect(Math.abs(m.momentary() + 23)).toBeLessThan(0.1);
    expect(Math.abs(m.shortTerm() + 23)).toBeLessThan(0.1);
  });
  it('ebu 3341 case 2', () => {
    const m = run(steps([[-33, 20]]));
    expect(Math.abs(m.integrated() + 33)).toBeLessThan(0.1);
    expect(Math.abs(m.momentary() + 33)).toBeLessThan(0.1);
    expect(Math.abs(m.shortTerm() + 33)).toBeLessThan(0.1);
  });
  it('ebu 3341 case 3', () => {
    expect(Math.abs(run(steps([[-36, 10], [-23, 60], [-36, 10]])).integrated() + 23)).toBeLessThan(0.1);
  });
  it('ebu 3341 case 4', () => {
    expect(Math.abs(run(steps([[-72, 10], [-36, 10], [-23, 60], [-36, 10], [-72, 10]])).integrated() + 23)).toBeLessThan(0.1);
  });
  it('ebu 3341 case 5', () => {
    expect(Math.abs(run(steps([[-26, 20], [-20, 20.1], [-26, 20]])).integrated() + 23)).toBeLessThan(0.1);
  });
});

describe('ebu 3342', () => {
  const lra = (levels: number[]): number => run(steps(levels.map((l) => [l, 20] as [number, number]))).range();
  it('ebu 3342 cases 1 to 4', () => {
    expect(Math.abs(lra([-20, -30]) - 10)).toBeLessThan(1);
    expect(Math.abs(lra([-20, -15]) - 5)).toBeLessThan(1);
    expect(Math.abs(lra([-40, -20]) - 20)).toBeLessThan(1);
    expect(Math.abs(lra([-50, -35, -20, -35, -50]) - 15)).toBeLessThan(1);
  });
});

describe('the meter', () => {
  it('the same numbers at 44.1 khz', () => {
    const r = 44100;
    expect(Math.abs(run(steps([[-23, 20]], r), r).integrated() + 23)).toBeLessThan(0.1);
    expect(Math.abs(run(steps([[-36, 10], [-23, 60], [-36, 10]], r), r).integrated() + 23)).toBeLessThan(0.1);
    const lra = run(steps([[-20, 20], [-30, 20]], r), r).range();
    expect(Math.abs(lra - 10)).toBeLessThan(1);
  });

  it('too short and silent', () => {
    const short = run(sine(-20, 0.3));
    expect(short.momentary()).toBe(-Infinity);
    expect(short.integrated()).toBe(-Infinity);
    const z = new Float32Array(48000 * 5);
    const s = run({ l: z, r: z });
    expect(s.integrated()).toBe(-Infinity);
    expect(s.range()).toBe(0);
    expect(s.truePeak()).toBe(-Infinity);
    expect(s.numbers().seconds).toBe(5);
  });

  it('slice sizes change nothing', () => {
    const sig = steps([[-36, 10], [-23, 60], [-36, 10]]);
    const whole = run(sig);
    for (const size of [1, 7, 4800, 13333]) {
      const m = new LoudnessMeter(RATE);
      for (let at = 0; at < sig.l.length; at += size) m.push(sig.l, sig.r, at, Math.min(size, sig.l.length - at));
      m.finish();
      expect(m.numbers()).toEqual(whole.numbers());
      expect(m.trace()).toEqual(whole.trace());
    }
  }, 60000);

  it('pushWeighted matches push', () => {
    const sig = noise(10, 0.3, 11);
    const [s1, s2] = kWeighting(RATE);
    const weigh = (x: Float32Array): Float32Array => {
      const out = new Float64Array(x.length);
      let a1 = 0, a2 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < x.length; i++) {
        const v = x[i]!;
        const y = s1.b0 * v + a1;
        a1 = s1.b1 * v - s1.a1 * y + a2;
        a2 = s1.b2 * v - s1.a2 * y;
        const w = s2.b0 * y + b1;
        b1 = s2.b1 * y - s2.a1 * w + b2;
        b2 = s2.b2 * y - s2.a2 * w;
        out[i] = w;
      }
      return Float32Array.from(out);
    };
    const kl = weigh(sig.l);
    const kr = weigh(sig.r);
    const a = new LoudnessMeter(RATE);
    a.push(sig.l, sig.r, 0, sig.l.length);
    const b = new LoudnessMeter(RATE);
    b.pushWeighted(kl, kr, 0, kl.length);
    expect(Math.abs(a.integrated() - b.integrated())).toBeLessThan(1e-9);
    expect(b.numbers().seconds).toBe(10);
  });

  it('trace lengths and its integrated', () => {
    const sig = steps([[-36, 10], [-23, 20], [-36, 10]]);
    const m = run(sig);
    const sub = 4800;
    const subs = Math.floor(sig.l.length / sub);
    const t = m.trace();
    expect(t.blocks.length).toBe(subs - 3);
    expect(t.shorts.length).toBe(subs - 29);
    expect(gatedLoudness(t.blocks)).toBe(m.integrated());
    t.blocks[0] = 99;
    expect(m.trace().blocks[0]).not.toBe(99);
  });

  it('gates move with the gain', () => {
    const blocks = new Float64Array(1000).fill(powerOf(-71));
    blocks[500] = powerOf(-40);
    expect(Math.abs(gatedLoudness(blocks, 1) + 40)).toBeLessThan(0.01);
    expect(Math.abs(gatedLoudness(blocks, 10 ** 0.4) + 63.46)).toBeLessThan(0.01);
    const sig = steps([[-50, 20], [-35, 20], [-20, 20], [-35, 20], [-50, 20]]);
    const up = steps([[-30, 20], [-15, 20], [0, 20], [-15, 20], [-30, 20]]);
    expect(Math.abs(loudnessRange(run(sig).trace().shorts, 100) - run(up).range())).toBeLessThan(0.01);
    expect(toLufs(0)).toBe(-Infinity);
  }, 30000);
});

describe('true peak', () => {
  it('true peak phases sum to 1 and mirror', () => {
    const p = truePeakPhases();
    for (const c of p) expect(Math.abs(c.reduce((s, v) => s + v, 0) - 1)).toBeLessThan(1e-12);
    for (let i = 0; i < 16; i++) {
      expect(Math.abs(p[0]![i]! - p[2]![15 - i]!)).toBeLessThan(1e-14);
      expect(Math.abs(p[1]![i]! - p[1]![15 - i]!)).toBeLessThan(1e-14);
    }
    expect(TP_PHASES.length).toBe(3);
    expect(TP_L1).toBeGreaterThan(1.5);
    expect(TP_L1).toBeLessThan(3);
  });

  it('true peak of dc and the quarter rate sine', () => {
    const dc = new Float32Array(RATE).fill(0.5);
    fadeEnds(dc, RATE);
    expect(Math.abs(measureSamples(dc, dc, RATE).truePeak + 6.02)).toBeLessThan(0.01);
    const q = sine(-6.0206, 1, RATE / 4, RATE, Math.PI / 4, true);
    const n = measureSamples(q.l, q.r, RATE);
    expect(Math.abs(n.samplePeak + 9.03)).toBeLessThan(0.01);
    expect(Math.abs(n.truePeak + 6.02)).toBeLessThan(0.05);
  });

  it('true peak of sines to 15 khz', () => {
    for (const rate of [44100, 48000]) {
      for (const hz of [997, 5000, 10000, 15000]) {
        const s = sine(-6.0206, 1, hz, rate, 0.3, true);
        const n = measureSamples(s.l, s.r, rate);
        expect(n.truePeak).toBeGreaterThan(-6.02 - 0.4);
        expect(n.truePeak).toBeLessThan(-6.02 + 0.2);
        expect(n.truePeak).toBeGreaterThanOrEqual(n.samplePeak);
      }
    }
  });

  it('true peak over noise is truePeakOf', () => {
    const s = noise(2, 0.2, 7);
    for (let b = 0; b < 6; b++) {
      const at = 10000 + b * 13000;
      for (let i = 0; i < 40; i++) {
        s.l[at + i] = 0.9 * Math.sin((Math.PI * i) / 40) * (i % 2 ? 1 : -1);
        s.r[at + i] = 0.6 * Math.sin((Math.PI * i) / 40);
      }
    }
    const n = s.l.length;
    const pad = (x: Float32Array): Float32Array => {
      const out = new Float32Array(n + 16);
      out.set(x, 8);
      return out;
    };
    let sp = 0;
    for (let i = 0; i < n; i++) sp = Math.max(sp, Math.abs(s.l[i]!), Math.abs(s.r[i]!));
    const want = 20 * Math.log10(Math.max(sp, truePeakOf(pad(s.l), 8, n + 8), truePeakOf(pad(s.r), 8, n + 8)));
    expect(run(s).truePeak()).toBe(want);
    expect(truePeakOf(new Float32Array(4), 0, 4)).toBe(0);
  });
});
