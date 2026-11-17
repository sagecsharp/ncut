/**
 * the true peak limiter and the output stage the export puts the mix through. pure, no dom, no web audio.
 * one gain for both channels, true peak aware, a lookahead brickwall.
 */
import { LoudnessMeter, TP_HALF, TP_L1, intervalPeak } from './loudness';
import type { LoudnessNumbers } from './loudness';

export const LIMIT_ATTACK_S = 0.005;
export const LIMIT_RELEASE_S = 0.08;
export const TP_MARGIN_DB = 0.1;

export interface Limiter {
  readonly latency: number;
  /** writes the frames that come out at `at` of the outputs (gain applied first), returns how many it wrote */
  process(l: Float32Array, r: Float32Array, from: number, n: number, gain: number, outL: Float32Array, outR: Float32Array, at: number): number;
  /** the tail of the delay (latency steps of silence), returns how many frames it wrote. call it once */
  flush(outL: Float32Array, outR: Float32Array, at: number): number;
  maxReductionDb(): number;
  limitedFrames(): number;
  framesOut(): number;
}

export function createLimiter(rate: number, ceilingDb: number): Limiter {
  const A = Math.max(1, Math.round(LIMIT_ATTACK_S * rate));
  const W = A + 2 * TP_HALF;
  const latency = A + 2 * TP_HALF - 1;
  const c = 10 ** ((ceilingDb - TP_MARGIN_DB) / 20);
  const skip = c / TP_L1;
  const rel = Math.exp(-1 / (LIMIT_RELEASE_S * rate));
  const hl = new Float64Array(16), hr = new Float64Array(16);
  const dl = new Float32Array(latency), dr = new Float32Array(latency); // read x[t - latency], then write x[t]
  const CAP = W + 3; // W + 1 in the window, one more between push and pop, one free slot
  const qi = new Float64Array(CAP), qv = new Float64Array(CAP); // (interval, r), smallest r at head
  const ring = new Float64Array(A).fill(1);
  let hpos = 0, dpos = 0, head = 0, tail = 0, rpos = 0, sum = A, notOne = 0;
  let q = 1, t = 0, lastLoud = -1e9, minS = 1, limited = 0, out = 0;

  const step = (xl: number, xr: number, oL: Float32Array, oR: Float32Array, at: number): boolean => {
    hl[hpos] = xl; hr[hpos] = xr; hpos = (hpos + 1) & 15;
    if (Math.abs(xl) > skip || Math.abs(xr) > skip) lastLoud = t;
    let r = 1;
    if (t - lastLoud <= 15) {
      const p = Math.max(intervalPeak(hl, hpos), intervalPeak(hr, hpos));
      if (p > c) r = c / p;
    }
    const n = t - (TP_HALF - 1);
    while (tail !== head && qv[(tail - 1 + CAP) % CAP]! >= r) tail = (tail - 1 + CAP) % CAP;
    qi[tail] = n; qv[tail] = r; tail = (tail + 1) % CAP;
    while (qi[head]! < n - W) head = (head + 1) % CAP;
    q = Math.min(qv[head]!, 1 - (1 - q) * rel);
    if (1 - q < 1e-9) q = 1;
    const old = ring[rpos]!;
    ring[rpos] = q; rpos = (rpos + 1) % A;
    if (old !== 1) notOne--;
    if (q !== 1) notOne++;
    let s = 1;
    if (notOne === 0) sum = A; // the float drift leaves with the last gain under 1
    else { sum += q - old; s = sum / A; }
    const yl = dl[dpos]!, yr = dr[dpos]!;
    dl[dpos] = xl; dr[dpos] = xr; dpos = (dpos + 1) % latency;
    t++;
    if (t <= latency) return false; // x[t - latency] is before the start: dropped
    oL[at] = yl * s; oR[at] = yr * s;
    if (s < minS) minS = s;
    if (s < 0.99999) limited++;
    out++;
    return true;
  };

  return {
    latency,
    process(l, r, from, n, gain, outL, outR, at) {
      let w = 0;
      for (let i = 0; i < n; i++) {
        if (step(Math.fround(l[from + i]! * gain), Math.fround(r[from + i]! * gain), outL, outR, at + w)) w++;
      }
      return w;
    },
    flush(outL, outR, at) {
      let w = 0;
      for (let i = 0; i < latency; i++) {
        if (step(0, 0, outL, outR, at + w)) w++;
      }
      return w;
    },
    maxReductionDb: () => (minS === 1 ? 0 : -20 * Math.log10(minS)),
    limitedFrames: () => limited,
    framesOut: () => out,
  };
}

export interface OutputPlan { rate: number; gain: number; ceiling: number | null }
/** limitDb = the most the limiter took off (0 = never), limitShare = the share of frames it acted on, after = what came out (null = not measured) */
export interface StageReport { limitDb: number; limitShare: number; after: LoudnessNumbers | null }
export interface OutputStage {
  readonly latency: number;
  /** the frames written, shorter by the latency the first time */
  process(l: Float32Array, r: Float32Array): { l: Float32Array; r: Float32Array };
  /** the tail, once */
  flush(): { l: Float32Array; r: Float32Array };
  report(): StageReport;
}

export function createOutputStage(plan: OutputPlan): OutputStage {
  if (plan.ceiling === null) {
    return {
      latency: 0,
      process(l, r) {
        const outL = new Float32Array(l.length);
        const outR = new Float32Array(r.length);
        for (let i = 0; i < l.length; i++) outL[i] = l[i]! * plan.gain;
        for (let i = 0; i < r.length; i++) outR[i] = r[i]! * plan.gain;
        return { l: outL, r: outR };
      },
      flush: () => ({ l: new Float32Array(0), r: new Float32Array(0) }),
      report: () => ({ limitDb: 0, limitShare: 0, after: null }),
    };
  }
  const lim = createLimiter(plan.rate, plan.ceiling);
  const meter = new LoudnessMeter(plan.rate);
  let flushed = false;
  return {
    latency: lim.latency,
    process(l, r) {
      const n = Math.min(l.length, r.length);
      const outL = new Float32Array(n);
      const outR = new Float32Array(n);
      const w = lim.process(l, r, 0, n, plan.gain, outL, outR, 0);
      meter.push(outL, outR, 0, w);
      return w === n ? { l: outL, r: outR } : { l: outL.slice(0, w), r: outR.slice(0, w) };
    },
    flush() {
      if (flushed) return { l: new Float32Array(0), r: new Float32Array(0) };
      flushed = true;
      const outL = new Float32Array(lim.latency);
      const outR = new Float32Array(lim.latency);
      const w = lim.flush(outL, outR, 0);
      meter.push(outL, outR, 0, w);
      meter.finish();
      return { l: outL.slice(0, w), r: outR.slice(0, w) };
    },
    report() {
      const out = lim.framesOut();
      return { limitDb: lim.maxReductionDb(), limitShare: out ? lim.limitedFrames() / out : 0, after: meter.numbers() };
    },
  };
}
