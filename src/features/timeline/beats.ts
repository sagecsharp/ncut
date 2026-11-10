/**
 * pure beat detection from waveform peaks. no dom, no audio decoding: it only reads the peak array
 * the timeline already computes (WaveformData). tested with synthetic peaks.
 *
 * steps: onset envelope (positive change of the smoothed peaks) -> tempo by autocorrelation in
 * 60..180 bpm with a mild preference for 120 (octave rule) -> period refined by folding the onsets
 * on the period -> phase = the fold position with the most onset energy -> beat times.
 */

export const MIN_BPM = 60;
export const MAX_BPM = 180;
/** below this confidence the audio has no steady beat (speech, noise) */
export const MIN_CONFIDENCE = 0.4;
/** shortest audio that is analysed (seconds) */
export const MIN_SECONDS = 4;
/** peaks quieter than this everywhere count as silence */
const SILENCE = 0.01;

export type BeatReason = 'ok' | 'silent' | 'too short' | 'no steady beat';

export interface BeatResult {
  /** beat times in asset seconds, ascending. empty when reason is not 'ok' */
  beats: number[];
  bpm: number;
  /** 0..1, how much stronger the picked tempo is than the average tempo */
  confidence: number;
  reason: BeatReason;
}

const none = (reason: BeatReason, bpm = 0, confidence = 0): BeatResult => ({ beats: [], bpm, confidence, reason });

/** onset envelope: positive change of the lightly smoothed peaks, then smoothed again */
export function onsetEnvelope(peaks: ArrayLike<number>): Float32Array {
  const n = peaks.length;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = (peaks[i]! + (i > 0 ? peaks[i - 1]! : peaks[i]!)) * 0.5;
  const o = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const d = s[i]! - s[i - 1]!;
    o[i] = d > 0 ? d : 0;
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.25 * (o[i - 1] ?? 0) + 0.5 * o[i]! + 0.25 * (o[i + 1] ?? 0);
  return out;
}

/** weight that prefers tempos near 120 bpm (one octave away = 0.61) */
function tempoWeight(bpm: number): number {
  const d = Math.log2(bpm / 120);
  return Math.exp(-0.5 * d * d);
}

/** folded onset energy for a period (in buckets): returns the best smoothed bin score and its position */
function fold(env: Float32Array, period: number, bins: Float32Array): { score: number; phase: number } {
  const b = bins.length;
  bins.fill(0);
  const k = b / period;
  for (let i = 0; i < env.length; i++) {
    const v = env[i]!;
    if (v === 0) continue;
    let pos = (i * k) % b;
    if (pos < 0) pos += b;
    bins[pos | 0]! += v;
  }
  let best = -1;
  let bestAt = 0;
  for (let j = 0; j < b; j++) {
    const sc = bins[(j + b - 1) % b]! + 2 * bins[j]! + bins[(j + 1) % b]!;
    if (sc > best) {
      best = sc;
      bestAt = j;
    }
  }
  // centroid over the three bins around the max for a sub-bin phase
  const l = bins[(bestAt + b - 1) % b]!;
  const c = bins[bestAt]!;
  const r = bins[(bestAt + 1) % b]!;
  const tot = l + c + r;
  const off = tot > 0 ? (r - l) / tot : 0;
  const pos = bestAt + 0.5 + off;
  return { score: best, phase: (pos / b) * period };
}

/** how far (seconds) a beat may move to reach a hit */
export const SNAP_SECONDS = 0.035;
/** a hit must be this many times stronger than the average onset around it to attract a beat */
const SNAP_CONTRAST = 3;

/**
 * second pass: every grid position (buckets) moves to the strongest onset within +- SNAP_SECONDS, but only
 * when that onset is clearly above the local average and not already taken by the previous beat. the
 * position inside the bucket comes from the three bins around the peak (same convention as the fold).
 */
export function snapToOnsets(env: ArrayLike<number>, grid: readonly number[], period: number, peaksPerSecond: number): number[] {
  const n = env.length;
  const win = SNAP_SECONDS * peaksPerSecond;
  const half = Math.max(1, Math.round(period / 2));
  const cum = new Float64Array(n + 1);
  let envMax = 0;
  for (let i = 0; i < n; i++) {
    cum[i + 1] = cum[i]! + env[i]!;
    if (env[i]! > envMax) envMax = env[i]!;
  }
  const out: number[] = [];
  let prev = -Infinity;
  for (const g of grid) {
    let pos = g;
    const lo = Math.max(1, Math.ceil(g - win));
    const hi = Math.min(n - 2, Math.floor(g + win));
    let bestI = -1;
    let bestV = 0;
    for (let i = lo; i <= hi; i++) {
      const v = env[i]!;
      if (v > bestV) {
        bestV = v;
        bestI = i;
      }
    }
    if (bestI >= 0 && bestV >= envMax * 0.15) {
      const a = Math.max(0, bestI - half);
      const b = Math.min(n, bestI + half + 1);
      const mean = (cum[b]! - cum[a]!) / (b - a);
      if (bestV >= SNAP_CONTRAST * mean) {
        const l = env[bestI - 1]!;
        const r = env[bestI + 1]!;
        const tot = l + bestV + r;
        const cand = bestI + 0.5 + (tot > 0 ? (r - l) / tot : 0);
        if (cand - prev > period * 0.5) pos = cand;
      }
    }
    if (pos <= prev) pos = g;
    prev = pos;
    out.push(pos);
  }
  return out;
}

/** find the beats in a peak array (peaksPerSecond buckets per second). O(n x lags) with small constants. */
export function detectBeats(peaks: ArrayLike<number>, peaksPerSecond: number): BeatResult {
  const n = peaks.length;
  if (n < MIN_SECONDS * peaksPerSecond) return none('too short');
  let max = 0;
  for (let i = 0; i < n; i++) if (peaks[i]! > max) max = peaks[i]!;
  if (max < SILENCE) return none('silent');

  const env = onsetEnvelope(peaks);
  let envMax = 0;
  for (let i = 0; i < n; i++) if (env[i]! > envMax) envMax = env[i]!;
  if (envMax <= 0) return none('no steady beat');

  // autocorrelation over the lag range (in buckets)
  const minLag = (60 * peaksPerSecond) / MAX_BPM;
  const maxLag = (60 * peaksPerSecond) / MIN_BPM;
  const lo = Math.max(2, Math.floor(minLag) - 1);
  const hi = Math.min(n - 2, Math.ceil(maxLag) + 1);
  if (hi <= lo + 2) return none('too short');
  const r = new Float64Array(hi + 2);
  for (let lag = lo; lag <= hi + 1 && lag < n; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += env[i]! * env[i + lag]!;
    r[lag] = sum / (n - lag);
  }
  let mean = 0;
  let cnt = 0;
  for (let lag = lo; lag <= hi; lag++) {
    mean += r[lag]!;
    cnt++;
  }
  mean /= cnt;
  let bestLag = -1;
  let bestScore = 0;
  let rawPeak = 0;
  for (let lag = lo + 1; lag < hi; lag++) {
    const bpm = (60 * peaksPerSecond) / lag;
    if (bpm < MIN_BPM - 1 || bpm > MAX_BPM + 1) continue;
    const v = r[lag]!;
    if (v < r[lag - 1]! || v < r[lag + 1]!) continue; // local maximum only
    const score = v * tempoWeight(bpm);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
      rawPeak = v;
    }
  }
  if (bestLag < 0 || rawPeak <= 0) return none('no steady beat');
  const confidence = Math.max(0, Math.min(1, 1 - mean / rawPeak));
  if (confidence < MIN_CONFIDENCE) return none('no steady beat', 0, confidence);

  // parabolic interpolation of the lag
  const y0 = r[bestLag - 1]!;
  const y1 = r[bestLag]!;
  const y2 = r[bestLag + 1]!;
  const den = y0 - 2 * y1 + y2;
  let period = bestLag + (den < 0 ? (0.5 * (y0 - y2)) / den : 0);

  // refine the period by folding: three passes, each narrower
  const bins = new Float32Array(Math.max(8, Math.ceil(bestLag * 2.5)));
  let phase = fold(env, period, bins).phase;
  let span = 0.04;
  for (let pass = 0; pass < 3; pass++) {
    let bestP = period;
    let bestS = -1;
    const steps = 21;
    for (let s = 0; s < steps; s++) {
      const p = period * (1 + span * ((s / (steps - 1)) * 2 - 1));
      const f = fold(env, p, bins);
      if (f.score > bestS) {
        bestS = f.score;
        bestP = p;
        phase = f.phase;
      }
    }
    period = bestP;
    span /= 10;
  }
  phase = fold(env, period, bins).phase;

  // beats on the grid, from the first real onset to the end of the last one
  let first = n;
  let last = 0;
  const thr = envMax * 0.3;
  for (let i = 0; i < n; i++) {
    if (env[i]! > thr) {
      if (first === n) first = i;
      last = i;
    }
  }
  const startT = Math.max(0, first - period * 0.5);
  const endT = Math.min(n, last + period * 0.5);
  const grid: number[] = [];
  let k = Math.ceil((startT - phase) / period);
  for (let t = phase + k * period; t <= endT; t = phase + ++k * period) {
    if (t >= 0) grid.push(t);
  }
  // second pass: swung or drifting material lands on the hits (the grid is the fallback)
  const beats = snapToOnsets(env, grid, period, peaksPerSecond).map((t) => t / peaksPerSecond);
  const bpm = (60 * peaksPerSecond) / period;
  if (beats.length < 2) return none('no steady beat', bpm, confidence);
  return { beats, bpm, confidence, reason: 'ok' };
}

/** the part of a clip that maps asset time to timeline time */
export interface BeatClip {
  start: number;
  duration: number;
  trimStart: number;
  speed: number;
}

/** a beat inside a clip: its timeline time and its index in the whole sound (0 = the first beat of the song) */
export interface ClipBeat {
  time: number;
  index: number;
}

/** asset-second beats -> timeline seconds with their index in the whole sound, only the beats inside the clip's visible range */
export function beatsInClipIndexed(assetBeats: readonly number[], clip: BeatClip): ClipBeat[] {
  const speed = clip.speed > 0 ? clip.speed : 1;
  const end = clip.start + clip.duration;
  const out: ClipBeat[] = [];
  for (let i = 0; i < assetBeats.length; i++) {
    const b = assetBeats[i]!;
    if (b < clip.trimStart) continue;
    const t = clip.start + (b - clip.trimStart) / speed;
    if (t > end + 1e-9) break;
    out.push({ time: t, index: i });
  }
  return out;
}

/** asset-second beats -> timeline seconds, only the beats inside the clip's visible range */
export function beatsInClip(assetBeats: readonly number[], clip: BeatClip): number[] {
  return beatsInClipIndexed(assetBeats, clip).map((b) => b.time);
}

/** keep every `step`th beat (1 = all, 2 = every other, 4 = bars), starting with the first */
export function thinBeats<T>(beats: readonly T[], step: number): T[] {
  const s = Math.max(1, Math.round(step));
  return beats.filter((_, i) => i % s === 0);
}
