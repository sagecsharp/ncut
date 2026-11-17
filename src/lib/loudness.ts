/**
 * loudness after itu bs.1770 / ebu r128 / tech 3342 / 3341: k weighting, gated loudness, range and true peak. pure,
 * no dom, no web audio, no imports.
 */

export interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

/** stage 1: the head, a high shelf (+4 db up high). stage 2: the rlb high pass near 38 hz */
export function kWeighting(rate: number): [Biquad, Biquad] {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / rate);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / rate);
  a0 = 1 + K / Q + K * K;
  const high: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, high];
}

const OFFSET = -0.691;
export const ABS_GATE = -70;
export const toLufs = (p: number): number => (p > 0 ? OFFSET + 10 * Math.log10(p) : -Infinity);
const ABS_POWER = 10 ** ((ABS_GATE - OFFSET) / 10);

export interface LoudnessNumbers { integrated: number; lra: number; truePeak: number; samplePeak: number; maxMomentary: number; maxShortTerm: number; seconds: number }
export const NO_NUMBERS: Readonly<LoudnessNumbers> = { integrated: -Infinity, lra: 0, truePeak: -Infinity, samplePeak: -Infinity, maxMomentary: -Infinity, maxShortTerm: -Infinity, seconds: 0 };

/** every 400 ms block power and every 3 s short term power, one each 100 ms */
export interface LoudnessTrace { blocks: Float64Array; shorts: Float64Array }
export const NO_TRACE: Readonly<LoudnessTrace> = { blocks: new Float64Array(0), shorts: new Float64Array(0) };

/** integrated loudness of block powers each times g (a power gain): the gates move with the blocks */
export function gatedLoudness(blocks: Float64Array, g = 1): number {
  let sum = 0, n = 0;
  for (const b of blocks) { const p = b * g; if (p > ABS_POWER) { sum += p; n++; } }
  if (n === 0) return -Infinity;
  const rel = sum / n / 10;
  let s2 = 0, n2 = 0;
  for (const b of blocks) { const p = b * g; if (p > ABS_POWER && p > rel) { s2 += p; n2++; } }
  return n2 ? toLufs(s2 / n2) : -Infinity;
}

export function loudnessRange(shorts: Float64Array, g = 1): number {
  const kept: number[] = [];
  let sum = 0;
  for (const s of shorts) { const p = s * g; if (p > ABS_POWER) { kept.push(p); sum += p; } }
  if (kept.length === 0) return 0;
  const rel = sum / kept.length / 100;
  const k2 = kept.filter((p) => p > rel).sort((a, b) => a - b);
  if (k2.length === 0) return 0;
  const at = (q: number): number => k2[Math.floor((k2.length - 1) * q + 0.5)]!;
  return toLufs(at(0.95)) - toLufs(at(0.1));
}

export const TP_HALF = 8;
const TP_BETA = 5;

function besselI0(x: number): number {
  let sum = 1, term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 64; k++) { term *= q / (k * k); sum += term; if (term < sum * 1e-17) break; }
  return sum;
}

/** phase k (1..3): the value at n - 1 + k/4 is the sum over i of c[i] * x[n - 8 + i] */
export function truePeakPhases(): Float64Array[] {
  const norm = besselI0(TP_BETA);
  const out: Float64Array[] = [];
  for (let k = 1; k <= 3; k++) {
    const c = new Float64Array(2 * TP_HALF);
    let sum = 0;
    for (let i = 0; i < 2 * TP_HALF; i++) {
      const d = i - (TP_HALF - 1) - k / 4; // how far x[n - 8 + i] sits from the point, |d| <= 7.75
      const w = besselI0(TP_BETA * Math.sqrt(1 - (d / TP_HALF) ** 2)) / norm;
      c[i] = (Math.sin(Math.PI * d) / (Math.PI * d)) * w;
      sum += c[i]!;
    }
    for (let i = 0; i < c.length; i++) c[i] = c[i]! / sum;
    out.push(c);
  }
  return out;
}
export const TP_PHASES = truePeakPhases();
/** the largest sum of |taps| (about 2.2): |interpolated| <= TP_L1 * max |x| of its window */
export const TP_L1 = Math.max(...TP_PHASES.map((c) => c.reduce((s, v) => s + Math.abs(v), 0)));

/** peak over (n-1, n] from a ring of the last 16 samples, oldest at pos (x[n] at pos + 8) */
export function intervalPeak(h: Float64Array, pos: number): number {
  let best = Math.abs(h[(pos + 8) & 15]!);
  for (const c of TP_PHASES) {
    let v = 0;
    for (let i = 0; i < 16; i++) v += c[i]! * h[(pos + i) & 15]!;
    if (Math.abs(v) > best) best = Math.abs(v);
  }
  return best;
}

/** the linear true peak of buf over the intervals n in [max(start, 8), min(end, buf.length - 7)), 0 with none */
export function truePeakOf(buf: Float32Array, start: number, end: number): number {
  const lo = Math.max(Math.floor(start), TP_HALF);
  const hi = Math.min(Math.floor(end), buf.length - (TP_HALF - 1));
  let best = 0;
  for (let n = lo; n < hi; n++) {
    const a = Math.abs(buf[n]!);
    if (a > best) best = a;
    for (const c of TP_PHASES) {
      let v = 0;
      for (let i = 0; i < 16; i++) v += c[i]! * buf[n - TP_HALF + i]!;
      if (Math.abs(v) > best) best = Math.abs(v);
    }
  }
  return best;
}

/** bs.1770 over what is pushed. any slice sizes give the same numbers bit for bit */
export class LoudnessMeter {
  private readonly k: [Biquad, Biquad];
  private readonly sub: number;
  private z = new Float64Array(8);
  private subSum = 0;
  private subFill = 0;
  private ring = new Float64Array(30);
  private ringPos = 0;
  private subN = 0;
  private blocks = new Float64Array(256);
  private nBlocks = 0;
  private shorts = new Float64Array(64);
  private nShorts = 0;
  private lastBlock = 0;
  private lastShort = 0;
  private maxBlock = 0;
  private maxShort = 0;
  private frames = 0;
  private sp = 0;
  private tp = 0;
  private hl = new Float64Array(16);
  private hr = new Float64Array(16);
  private hpos = 0;
  private t = 0;
  private lastLoud = -1e9;

  constructor(readonly rate: number) {
    this.k = kWeighting(rate);
    this.sub = Math.max(1, Math.round(rate / 10));
  }

  push(l: Float32Array, r: Float32Array, from: number, n: number): void {
    const [s1, s2] = this.k;
    const z = this.z;
    const end = from + n;
    for (let i = from; i < end; i++) {
      const xl = l[i]!, xr = r[i]!;
      let y = s1.b0 * xl + z[0]!;
      z[0] = s1.b1 * xl - s1.a1 * y + z[1]!;
      z[1] = s1.b2 * xl - s1.a2 * y;
      const wl = s2.b0 * y + z[2]!;
      z[2] = s2.b1 * y - s2.a1 * wl + z[3]!;
      z[3] = s2.b2 * y - s2.a2 * wl;
      y = s1.b0 * xr + z[4]!;
      z[4] = s1.b1 * xr - s1.a1 * y + z[5]!;
      z[5] = s1.b2 * xr - s1.a2 * y;
      const wr = s2.b0 * y + z[6]!;
      z[6] = s2.b1 * y - s2.a1 * wr + z[7]!;
      z[7] = s2.b2 * y - s2.a2 * wr;
      this.addPower(wl * wl + wr * wr);
      this.peak(xl, xr);
    }
    this.frames += n;
  }

  /** the preview: samples that are k weighted already */
  pushWeighted(kl: Float32Array, kr: Float32Array, from: number, n: number): void {
    const end = from + n;
    for (let i = from; i < end; i++) this.addPower(kl[i]! * kl[i]! + kr[i]! * kr[i]!);
    this.frames += n;
  }

  /** a linear true peak found elsewhere (the preview's truePeakOf) */
  notePeak(linear: number): void {
    if (linear > this.tp) this.tp = linear;
  }

  /** the last intervals of the true peak: seven silent frames, not counted in the length */
  finish(): void {
    for (let i = 0; i < TP_HALF - 1; i++) this.peak(0, 0);
  }

  reset(): void {
    this.z = new Float64Array(8);
    this.subSum = 0;
    this.subFill = 0;
    this.ring = new Float64Array(30);
    this.ringPos = 0;
    this.subN = 0;
    this.blocks = new Float64Array(256);
    this.nBlocks = 0;
    this.shorts = new Float64Array(64);
    this.nShorts = 0;
    this.lastBlock = 0;
    this.lastShort = 0;
    this.maxBlock = 0;
    this.maxShort = 0;
    this.frames = 0;
    this.sp = 0;
    this.tp = 0;
    this.hl = new Float64Array(16);
    this.hr = new Float64Array(16);
    this.hpos = 0;
    this.t = 0;
    this.lastLoud = -1e9;
  }

  momentary(): number { return toLufs(this.lastBlock); }
  shortTerm(): number { return toLufs(this.lastShort); }
  integrated(): number { return gatedLoudness(this.blocks.subarray(0, this.nBlocks)); }
  range(): number { return loudnessRange(this.shorts.subarray(0, this.nShorts)); }
  truePeak(): number { return 20 * Math.log10(Math.max(this.tp, this.sp)); }
  samplePeak(): number { return 20 * Math.log10(this.sp); }

  numbers(): LoudnessNumbers {
    return {
      integrated: this.integrated(),
      lra: this.range(),
      truePeak: this.truePeak(),
      samplePeak: this.samplePeak(),
      maxMomentary: toLufs(this.maxBlock),
      maxShortTerm: toLufs(this.maxShort),
      seconds: this.frames / this.rate,
    };
  }

  /** copies, the meter goes on */
  trace(): LoudnessTrace {
    return { blocks: this.blocks.slice(0, this.nBlocks), shorts: this.shorts.slice(0, this.nShorts) };
  }

  private addPower(p: number): void {
    this.subSum += p;
    if (++this.subFill < this.sub) return;
    const mean = this.subSum / this.sub;
    this.subSum = 0;
    this.subFill = 0;
    this.ring[this.ringPos] = mean;
    this.ringPos = (this.ringPos + 1) % 30;
    this.subN++;
    if (this.subN >= 4) {
      let s = 0;
      for (let j = 4; j >= 1; j--) s += this.ring[(this.ringPos - j + 30) % 30]!;
      const b = s / 4;
      if (this.nBlocks === this.blocks.length) this.blocks = grown(this.blocks);
      this.blocks[this.nBlocks++] = b;
      this.lastBlock = b;
      if (b > this.maxBlock) this.maxBlock = b;
    }
    if (this.subN >= 30) {
      let s = 0;
      for (let j = 0; j < 30; j++) s += this.ring[(this.ringPos + j) % 30]!;
      const v = s / 30;
      if (this.nShorts === this.shorts.length) this.shorts = grown(this.shorts);
      this.shorts[this.nShorts++] = v;
      this.lastShort = v;
      if (v > this.maxShort) this.maxShort = v;
    }
  }

  private peak(xl: number, xr: number): void {
    const al = Math.abs(xl), ar = Math.abs(xr);
    const m = al > ar ? al : ar;
    if (m > this.sp) this.sp = m;
    this.hl[this.hpos] = xl;
    this.hr[this.hpos] = xr;
    this.hpos = (this.hpos + 1) & 15;
    const t = this.t++;
    if (m * TP_L1 > this.tp) this.lastLoud = t;
    // interval n = t - 7 reads x[n - 8 .. n + 7]: too early, or too quiet to beat the peak so far
    if (t < 7 || t - this.lastLoud > 15) return;
    const p = Math.max(intervalPeak(this.hl, this.hpos), intervalPeak(this.hr, this.hpos));
    if (p > this.tp) this.tp = p;
  }
}

function grown(a: Float64Array): Float64Array<ArrayBuffer> {
  const out = new Float64Array(a.length * 2);
  out.set(a);
  return out;
}

export function measureSamples(l: Float32Array, r: Float32Array, rate: number): LoudnessNumbers {
  const m = new LoudnessMeter(rate);
  m.push(l, r, 0, Math.min(l.length, r.length));
  m.finish();
  return m.numbers();
}

/** one decimal, -0.0 written 0.0 */
export function fix1(v: number): string {
  const s = v.toFixed(1);
  return s === '-0.0' ? '0.0' : s;
}
export const lufsText = (v: number): string => (Number.isFinite(v) ? `${fix1(v)} lufs` : '-inf lufs');
export const luText = (v: number): string => `${fix1(v)} lu`;
export const dbtpText = (v: number): string => (Number.isFinite(v) ? `${fix1(v)} dbtp` : '-inf dbtp');
