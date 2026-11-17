/**
 * the scopes maths: sizes, binning, stats, targets and the read pace. pure (no dom, no store).
 * ncut is full range rgb: 0..100 in the scopes is 0..255. luma is rec 709 in integers, the same everywhere.
 */
export const LIVE_SAMPLE = 384,
  EXACT_SAMPLE = 1024,
  VECTOR_N = 256;
/** half width of the vectorscope grid at zoom 1 in cb / cr units (the strongest colors reach 0.596) */
export const VECTOR_RANGE = 0.6;
const W_R = 13933,
  W_G = 46871,
  W_B = 4732; // rec 709 x 65536, sum 65536
const CB_DIV = 1.8556,
  CR_DIV = 1.5748;

export const lumaOf = (r: number, g: number, b: number): number => (W_R * r + W_G * g + W_B * b + 32768) >> 16;

/** rec 709 cb / cr of 0..255 values, each -0.5..0.5; a gray is exactly 0, 0 */
export function chromaOf(r: number, g: number, b: number): { cb: number; cr: number } {
  const y16 = W_R * r + W_G * g + W_B * b;
  return { cb: (b * 65536 - y16) / (65536 * 255 * CB_DIV), cr: (r * 65536 - y16) / (65536 * 255 * CR_DIV) };
}

export interface BinWants {
  wave: boolean;
  parade: boolean;
  vector: boolean;
}
export interface ScopeBins {
  w: number;
  h: number;
  pixels: number;
  zoom: 1 | 2;
  /** x * 256 + luma */
  wave: Uint32Array;
  /** plane (r, g, b) * w * 256 + x * 256 + value */
  parade: Uint32Array;
  /** row * 256 + col, row 0 on top (cr up), col 0 left (cb right) */
  vector: Uint32Array;
  /** 4 * 256: r, g, b, luma */
  hist: Uint32Array;
}

/** a zeroed buffer of a length, the one of out when it has that length */
function buffer(old: Uint32Array | undefined, length: number): Uint32Array {
  if (old && old.length === length) {
    old.fill(0);
    return old;
  }
  return new Uint32Array(length);
}

/**
 * counts the pixels of rgba data into the wanted planes. throws when w or h < 1 or the data is short.
 * reuses out's buffers of the right length (zeroed); an unwanted plane has length 0; hist always.
 */
export function binScopes(data: Uint8ClampedArray, w: number, h: number, zoom: 1 | 2, wants: BinWants, out?: ScopeBins): ScopeBins {
  if (!(w >= 1) || !(h >= 1) || data.length < w * h * 4) throw new Error('binScopes: the data is shorter than w * h * 4');
  const pixels = w * h;
  const wave = buffer(out?.wave, wants.wave ? w * 256 : 0);
  const parade = buffer(out?.parade, wants.parade ? 3 * w * 256 : 0);
  const vector = buffer(out?.vector, wants.vector ? VECTOR_N * VECTOR_N : 0);
  const hist = buffer(out?.hist, 1024);
  const half = VECTOR_N / 2;
  const s = VECTOR_N / (2 * (VECTOR_RANGE / zoom));
  const kb = s / (65536 * 255 * CB_DIV);
  const kr = s / (65536 * 255 * CR_DIV);
  const plane = w * 256;
  for (let i = 0, p = 0; i < pixels; i++, p += 4) {
    const r = data[p]!,
      g = data[p + 1]!,
      b = data[p + 2]!;
    const y16 = W_R * r + W_G * g + W_B * b;
    const l = (y16 + 32768) >> 16;
    hist[r]!++;
    hist[256 + g]!++;
    hist[512 + b]!++;
    hist[768 + l]!++;
    if (wants.wave || wants.parade) {
      const x = i % w;
      if (wants.wave) wave[x * 256 + l]!++;
      if (wants.parade) {
        parade[x * 256 + r]!++;
        parade[plane + x * 256 + g]!++;
        parade[2 * plane + x * 256 + b]!++;
      }
    }
    if (wants.vector) {
      // integer differences: a gray gives exactly half, half (float weights put some grays in row 127)
      const fx = (b * 65536 - y16) * kb + half,
        fy = half - (r * 65536 - y16) * kr;
      // bounds first: |0 of a small negative would land in the edge bin
      if (fx >= 0 && fx < VECTOR_N && fy >= 0 && fy < VECTOR_N) vector[(fy | 0) * VECTOR_N + (fx | 0)]!++;
    }
  }
  const bins: ScopeBins = { w, h, pixels, zoom, wave, parade, vector, hist };
  if (out) {
    Object.assign(out, bins);
    return out;
  }
  return bins;
}

/** the size a w x h picture is read at so its long side is at most long. never grows */
export function sampleSize(w: number, h: number, long: number): { w: number; h: number } {
  const k = Math.min(1, long / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** nearest sampling to a long side of at most long; the input itself when it is small enough */
export function subsample(data: Uint8ClampedArray, w: number, h: number, long: number, out?: Uint8ClampedArray): { data: Uint8ClampedArray; w: number; h: number } {
  const t = sampleSize(w, h, long);
  if (t.w === w && t.h === h) return { data, w, h };
  const dst = out && out.length === t.w * t.h * 4 ? out : new Uint8ClampedArray(t.w * t.h * 4);
  let o = 0;
  for (let y = 0; y < t.h; y++) {
    const sy = Math.min(h - 1, Math.floor(((y + 0.5) * h) / t.h));
    for (let x = 0; x < t.w; x++) {
      const sx = Math.min(w - 1, Math.floor(((x + 0.5) * w) / t.w));
      const p = (sy * w + sx) * 4;
      dst[o++] = data[p]!;
      dst[o++] = data[p + 1]!;
      dst[o++] = data[p + 2]!;
      dst[o++] = data[p + 3]!;
    }
  }
  return { data: dst, w: t.w, h: t.h };
}

export interface LumaStats {
  /** luma min, max and mean on 0..100, unrounded */
  min: number;
  max: number;
  mean: number;
  /** the share of pixels at luma 0 and at luma 255, 0..1 */
  black: number;
  white: number;
  pixels: number;
}

/** luma stats of a 4 x 256 histogram, null for 0 pixels */
export function lumaStats(hist: Uint32Array, pixels: number): LumaStats | null {
  if (!(pixels > 0)) return null;
  let min = -1,
    max = -1,
    sum = 0;
  for (let l = 0; l < 256; l++) {
    const n = hist[768 + l]!;
    if (n === 0) continue;
    if (min < 0) min = l;
    max = l;
    sum += l * n;
  }
  if (min < 0) return null;
  return { min: (min * 100) / 255, max: (max * 100) / 255, mean: (sum / pixels) * (100 / 255), black: hist[768]! / pixels, white: hist[1023]! / pixels, pixels };
}

/** the mean of r, g and b on 0..100, null for 0 pixels */
export function channelMeans(hist: Uint32Array, pixels: number): { r: number; g: number; b: number } | null {
  if (!(pixels > 0)) return null;
  const mean = (at: number): number => {
    let sum = 0;
    for (let v = 0; v < 256; v++) sum += v * hist[at + v]!;
    return (sum / pixels) * (100 / 255);
  };
  return { r: mean(0), g: mean(256), b: mean(512) };
}

/** the 4 x 256 histogram (r, g, b, luma) of the first pixels pixels of rgba data */
export function lumaLevels(data: Uint8ClampedArray, pixels: number, out?: Uint32Array): Uint32Array {
  const hist = buffer(out, 1024);
  const n = Math.min(pixels, Math.floor(data.length / 4));
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = data[p]!,
      g = data[p + 1]!,
      b = data[p + 2]!;
    hist[r]!++;
    hist[256 + g]!++;
    hist[512 + b]!++;
    hist[768 + ((W_R * r + W_G * g + W_B * b + 32768) >> 16)]!++;
  }
  return hist;
}

export type VectorTargetId = 'r' | 'mg' | 'b' | 'cy' | 'g' | 'yl';

/** the six color targets at a level (0.75 for the 75% boxes), in the order r, mg, b, cy, g, yl */
export function vectorTargets(level: number): { id: VectorTargetId; cb: number; cr: number }[] {
  const at = (id: VectorTargetId, r: number, g: number, b: number) => {
    const c = chromaOf(r, g, b);
    return { id, cb: c.cb * level, cr: c.cr * level };
  };
  return [at('r', 255, 0, 0), at('mg', 255, 0, 255), at('b', 0, 0, 255), at('cy', 0, 255, 255), at('g', 0, 255, 0), at('yl', 255, 255, 0)];
}

/** the skin line: degrees from +cb, between red and yellow */
export const SKIN_ANGLE = 123;
/** its direction as (cb, cr), about (-0.545, 0.839) */
export const SKIN_DIR = { cb: Math.cos((SKIN_ANGLE * Math.PI) / 180), cr: Math.sin((SKIN_ANGLE * Math.PI) / 180) };

/** two lists equal item by item (===) */
export function sameKey(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const LIVE_INTERVAL_MS = 83,
  MAX_INTERVAL_MS = 250,
  COST_SHARE = 12;

/** the least time between two readings: playing at least 83 ms, a reading takes at most 1 / 12 of it, never over 250 ms */
export function scopeInterval(playing: boolean, costMs: number): number {
  const cost = Number.isFinite(costMs) && costMs > 0 ? costMs * COST_SHARE : 0;
  return Math.min(MAX_INTERVAL_MS, Math.max(playing ? LIVE_INTERVAL_MS : 0, cost));
}

/** how long to wait before the next reading, ms */
export function scopeDelay(now: number, last: number, playing: boolean, costMs: number): number {
  const interval = scopeInterval(playing, costMs);
  return interval <= 0 ? 0 : Math.max(0, Math.min(interval, last + interval - now));
}
