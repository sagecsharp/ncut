/**
 * small dependency free animated gif (GIF89a) encoder. pure typescript, no dom, so it runs in node and in a worker.
 *
 * flow: buildPalette(samples) -> createGifEncoder({ width, height, palette }) -> for each frame
 * indexFrame(rgba, width, palette) + addFrame(indices, delayCs) -> finish() / finishParts().
 * everything is deterministic (no random numbers, ordered dithering), so the same frames give the same bytes.
 *
 * a palette is a flat Uint8Array of r, g, b triples (length 3 * colors, 1..256 colors).
 */

export type Palette = Uint8Array;

/** gif delays are in 1/100 s and browsers treat anything below 2 as slow (about 10 fps) */
export const GIF_MIN_DELAY_CS = 2;
/** so the fastest gif that plays as written is 50 fps */
export const GIF_MAX_FPS = 50;

/** the frame rate a gif can really have: capped at 50 */
export function effectiveGifFps(fps: number): number {
  if (!(fps > 0)) return 1;
  return Math.min(GIF_MAX_FPS, fps);
}

/**
 * delay of output frame i in centiseconds. rounding is done on the running total, so a 30 fps gif alternates
 * 3, 3, 4 and its total length is exact instead of drifting. never below 2 (the browser slow-down floor).
 */
export function gifDelayCs(i: number, fps: number): number {
  const f = effectiveGifFps(fps);
  const d = Math.round(((i + 1) * 100) / f) - Math.round((i * 100) / f);
  return Math.max(GIF_MIN_DELAY_CS, d);
}

// ---------------------------------------------------------------------------------------------------------------
// palette
// ---------------------------------------------------------------------------------------------------------------

const BINS = 32768; // 5 bits per channel
/** pixels looked at when building a palette (more are skipped evenly) */
export const PALETTE_SAMPLE_LIMIT = 200_000;

function binOf(r: number, g: number, b: number): number {
  return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
}

/**
 * one global palette (median cut over a 5 bit per channel histogram) from rgba samples.
 * at most PALETTE_SAMPLE_LIMIT pixels are read, evenly spread. fully transparent pixels are ignored.
 * returns 1..maxColors colors (maxColors is clamped to 2..256, an empty input gives black + white).
 */
export function buildPalette(samples: Uint8Array | Uint8ClampedArray, maxColors = 256): Palette {
  const limit = Math.max(2, Math.min(256, Math.floor(maxColors)));
  const pixels = samples.length >> 2;
  const step = Math.max(1, Math.ceil(pixels / PALETTE_SAMPLE_LIMIT));
  const count = new Uint32Array(BINS);
  const sumR = new Float64Array(BINS);
  const sumG = new Float64Array(BINS);
  const sumB = new Float64Array(BINS);
  for (let p = 0; p < pixels; p += step) {
    const o = p << 2;
    if (samples[o + 3] === 0) continue;
    const r = samples[o];
    const g = samples[o + 1];
    const b = samples[o + 2];
    const k = binOf(r, g, b);
    count[k]++;
    sumR[k] += r;
    sumG[k] += g;
    sumB[k] += b;
  }
  const used: number[] = [];
  for (let k = 0; k < BINS; k++) if (count[k] > 0) used.push(k);
  if (used.length === 0) return Uint8Array.of(0, 0, 0, 255, 255, 255);

  // a box is a list of used bins
  let boxes: number[][] = [used];
  const pop = (box: number[]) => {
    let n = 0;
    for (const k of box) n += count[k];
    return n;
  };
  // channel (0 r, 1 g, 2 b) of a bin in 5 bit units
  const chan = (k: number, c: number) => (c === 0 ? k >> 10 : c === 1 ? (k >> 5) & 31 : k & 31);
  const widest = (box: number[]): { c: number; range: number } => {
    let best = { c: 0, range: -1 };
    for (let c = 0; c < 3; c++) {
      let lo = 31;
      let hi = 0;
      for (const k of box) {
        const v = chan(k, c);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi - lo > best.range) best = { c, range: hi - lo };
    }
    return best;
  };

  while (boxes.length < limit) {
    // split the most populated box that has more than one bin
    let pick = -1;
    let pickPop = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      const n = pop(boxes[i]);
      if (n > pickPop) {
        pickPop = n;
        pick = i;
      }
    }
    if (pick < 0) break;
    const box = boxes[pick];
    const { c } = widest(box);
    box.sort((a, b) => chan(a, c) - chan(b, c) || a - b);
    // split at the weighted median, both halves keep at least one bin
    let acc = 0;
    let cut = 1;
    const half = pickPop / 2;
    for (let i = 0; i < box.length - 1; i++) {
      acc += count[box[i]];
      cut = i + 1;
      if (acc >= half) break;
    }
    boxes = boxes.filter((_, i) => i !== pick);
    boxes.push(box.slice(0, cut), box.slice(cut));
  }

  // darker colors first: stable order
  const colors = boxes.map((box) => {
    let n = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (const k of box) {
      n += count[k];
      r += sumR[k];
      g += sumG[k];
      b += sumB[k];
    }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  });
  colors.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]) || a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const out = new Uint8Array(colors.length * 3);
  colors.forEach((col, i) => out.set(col, i * 3));
  return out;
}

/** nearest palette entry for each 5 bit color, filled lazily */
const mappers = new WeakMap<Palette, Int16Array>();

function nearestCache(palette: Palette): Int16Array {
  let cache = mappers.get(palette);
  if (!cache) {
    cache = new Int16Array(BINS).fill(-1);
    mappers.set(palette, cache);
  }
  return cache;
}

function nearest(palette: Palette, cache: Int16Array, key: number): number {
  const hit = cache[key];
  if (hit >= 0) return hit;
  // center of the 5 bit cell
  const r = ((key >> 10) << 3) | 4;
  const g = (((key >> 5) & 31) << 3) | 4;
  const b = ((key & 31) << 3) | 4;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0, n = palette.length / 3; i < n; i++) {
    const dr = palette[i * 3] - r;
    const dg = palette[i * 3 + 1] - g;
    const db = palette[i * 3 + 2] - b;
    // weighted a little towards green (eye is most sensitive to it)
    const d = dr * dr * 3 + dg * dg * 4 + db * db * 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  cache[key] = best;
  return best;
}

/** 4x4 bayer matrix, values 0..15 */
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/** dither amplitude in 8 bit levels (one 5 bit cell is 8 wide) */
const DITHER_STRENGTH = 12;

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * palette indices of one rgba frame. `dither` uses an ordered 4x4 bayer pattern (deterministic, same input gives
 * the same output). `out` is reused when it has the right length (no allocation per frame).
 */
export function indexFrame(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  palette: Palette,
  dither = true,
  out?: Uint8Array,
): Uint8Array {
  const pixels = rgba.length >> 2;
  const res = out && out.length === pixels ? out : new Uint8Array(pixels);
  const cache = nearestCache(palette);
  const w = Math.max(1, Math.floor(width));
  if (!dither) {
    for (let p = 0, o = 0; p < pixels; p++, o += 4) res[p] = nearest(palette, cache, binOf(rgba[o], rgba[o + 1], rgba[o + 2]));
    return res;
  }
  let x = 0;
  let y = 0;
  for (let p = 0, o = 0; p < pixels; p++, o += 4) {
    const t = (BAYER4[((y & 3) << 2) | (x & 3)] - 7.5) * (DITHER_STRENGTH / 7.5);
    res[p] = nearest(palette, cache, binOf(clamp255(rgba[o] + t), clamp255(rgba[o + 1] + t), clamp255(rgba[o + 2] + t)));
    if (++x === w) {
      x = 0;
      y++;
    }
  }
  return res;
}

// ---------------------------------------------------------------------------------------------------------------
// lzw
// ---------------------------------------------------------------------------------------------------------------

/** growable byte buffer */
class Bytes {
  buf = new Uint8Array(1024);
  len = 0;
  push(b: number): void {
    if (this.len === this.buf.length) {
      const n = new Uint8Array(this.buf.length * 2);
      n.set(this.buf);
      this.buf = n;
    }
    this.buf[this.len++] = b & 255;
  }
}

/**
 * gif flavoured lzw. returns the data sub-blocks (each <= 255 bytes, with its length byte) plus the 0 terminator.
 * the caller writes the minimum code size byte in front.
 */
export function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const raw = new Bytes();
  let bitBuf = 0;
  let bitCount = 0;
  let codeSize = minCodeSize + 1;
  const emit = (code: number) => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      raw.push(bitBuf & 255);
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  };

  // dictionary as a trie: first child / next sibling per code, the byte that extends the parent
  const child = new Int16Array(4096);
  const sibling = new Int16Array(4096);
  const suffix = new Uint8Array(4096);
  let next = eoi + 1;
  const reset = () => {
    child.fill(-1);
    next = eoi + 1;
    codeSize = minCodeSize + 1;
  };
  reset();
  emit(clear);

  if (indices.length > 0) {
    let cur = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      let c = child[cur];
      while (c >= 0 && suffix[c] !== k) c = sibling[c];
      if (c >= 0) {
        cur = c;
        continue;
      }
      emit(cur);
      if (next === 4096) {
        emit(clear);
        reset();
      } else {
        if (next >= 1 << codeSize) codeSize++;
        suffix[next] = k;
        sibling[next] = child[cur];
        child[next] = -1;
        child[cur] = next;
        next++;
      }
      cur = k;
    }
    emit(cur);
    // the decoder adds an entry after this code too, which can widen the code size of the end code
    if (next < 4096 && next >= 1 << codeSize) codeSize++;
  }
  emit(eoi);
  if (bitCount > 0) raw.push(bitBuf & 255);

  const n = raw.len;
  const blocks = Math.ceil(n / 255);
  const out = new Uint8Array(n + blocks + 1);
  let o = 0;
  for (let p = 0; p < n; p += 255) {
    const size = Math.min(255, n - p);
    out[o++] = size;
    out.set(raw.buf.subarray(p, p + size), o);
    o += size;
  }
  out[o] = 0;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// encoder
// ---------------------------------------------------------------------------------------------------------------

export interface GifEncoderOptions {
  width: number;
  height: number;
  palette: Palette;
  /** how often the animation plays: 0 = forever (default), n = n times */
  loop?: number;
}

export interface GifEncoder {
  /** `indices` is width * height palette indices, row by row. `delayCs` is rounded and clamped to 2..65535. */
  addFrame(indices: Uint8Array, delayCs: number): void;
  readonly frameCount: number;
  /** the finished file in pieces (cheap, nothing is copied): `new Blob(parts, { type: 'image/gif' })` */
  finishParts(): Uint8Array[];
  /** the finished file as one array */
  finish(): Uint8Array;
}

function u16(n: number): number[] {
  return [n & 255, (n >> 8) & 255];
}

/** number of bits so that 2^bits >= colors, at least 1 */
function tableBits(colors: number): number {
  let bits = 1;
  while (1 << bits < colors) bits++;
  return bits;
}

export function createGifEncoder(opts: GifEncoderOptions): GifEncoder {
  const width = Math.floor(opts.width);
  const height = Math.floor(opts.height);
  if (!(width >= 1 && width <= 65535 && height >= 1 && height <= 65535)) throw new Error('gif size must be 1..65535');
  const colors = opts.palette.length / 3;
  if (!Number.isInteger(colors) || colors < 1 || colors > 256) throw new Error('gif palette must have 1..256 colors');
  const bits = tableBits(colors);
  const tableSize = 1 << bits;
  const minCode = Math.max(2, bits);
  const loop = Math.max(0, Math.min(65535, Math.floor(opts.loop ?? 0)));

  const parts: Uint8Array[] = [];
  const head: number[] = [];
  for (const ch of 'GIF89a') head.push(ch.charCodeAt(0));
  // logical screen: global table present, 8 bit color resolution, table size field = bits - 1
  head.push(...u16(width), ...u16(height), 0x80 | 0x70 | (bits - 1), 0, 0);
  parts.push(Uint8Array.from(head));
  const table = new Uint8Array(tableSize * 3);
  table.set(opts.palette);
  parts.push(table);
  // netscape looping extension
  const app: number[] = [0x21, 0xff, 11];
  for (const ch of 'NETSCAPE2.0') app.push(ch.charCodeAt(0));
  app.push(3, 1, ...u16(loop), 0);
  parts.push(Uint8Array.from(app));

  let frames = 0;
  let done = false;
  return {
    addFrame(indices, delayCs) {
      if (done) throw new Error('gif is finished');
      if (indices.length !== width * height) throw new Error('frame has the wrong number of pixels');
      const delay = Math.max(GIF_MIN_DELAY_CS, Math.min(65535, Math.round(delayCs)));
      // graphic control: disposal 1 (leave), no transparency
      parts.push(Uint8Array.from([0x21, 0xf9, 4, 0x04, ...u16(delay), 0, 0]));
      // image descriptor: whole canvas, no local table, not interlaced
      parts.push(Uint8Array.from([0x2c, 0, 0, 0, 0, ...u16(width), ...u16(height), 0]));
      parts.push(Uint8Array.of(minCode));
      parts.push(lzwEncode(indices, minCode));
      frames++;
    },
    get frameCount() {
      return frames;
    },
    finishParts() {
      if (!done) {
        parts.push(Uint8Array.of(0x3b));
        done = true;
      }
      return parts.slice();
    },
    finish() {
      const all = this.finishParts();
      let n = 0;
      for (const p of all) n += p.length;
      const out = new Uint8Array(n);
      let o = 0;
      for (const p of all) {
        out.set(p, o);
        o += p.length;
      }
      return out;
    },
  };
}
