import { describe, expect, it } from 'vitest';
import { buildPalette, createGifEncoder, encodeGifFrame, gifMinCodeSize, indexFrame, lzwEncode } from './gif';

/**
 * the encoder as it was before it got fast (a trie with sibling lists, one push per byte, the dither offset
 * computed per pixel). the fast one must write exactly the same bytes.
 */
function lzwEncodeOld(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const raw: number[] = [];
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
    let cur = indices[0]!;
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i]!;
      let c = child[cur]!;
      while (c >= 0 && suffix[c] !== k) c = sibling[c]!;
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
        sibling[next] = child[cur]!;
        child[next] = -1;
        child[cur] = next;
        next++;
      }
      cur = k;
    }
    emit(cur);
    if (next < 4096 && next >= 1 << codeSize) codeSize++;
  }
  emit(eoi);
  if (bitCount > 0) raw.push(bitBuf & 255);
  const n = raw.length;
  const blocks = Math.ceil(n / 255);
  const out = new Uint8Array(n + blocks + 1);
  let o = 0;
  for (let p = 0; p < n; p += 255) {
    const size = Math.min(255, n - p);
    out[o++] = size;
    for (let q = 0; q < size; q++) out[o++] = raw[p + q]!;
  }
  out[o] = 0;
  return out;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/** the old dithering: nearest palette color of the 5 bit cell of the shifted pixel */
function indexFrameOld(rgba: Uint8Array, width: number, palette: Uint8Array): Uint8Array {
  const pixels = rgba.length >> 2;
  const res = new Uint8Array(pixels);
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
  const nearest = (key: number) => {
    const r = ((key >> 10) << 3) | 4;
    const g = (((key >> 5) & 31) << 3) | 4;
    const b = ((key & 31) << 3) | 4;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0, n = palette.length / 3; i < n; i++) {
      const dr = palette[i * 3]! - r;
      const dg = palette[i * 3 + 1]! - g;
      const db = palette[i * 3 + 2]! - b;
      const d = dr * dr * 3 + dg * dg * 4 + db * db * 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };
  let x = 0;
  let y = 0;
  for (let p = 0, o = 0; p < pixels; p++, o += 4) {
    const t = (BAYER4[((y & 3) << 2) | (x & 3)]! - 7.5) * (12 / 7.5);
    const key = ((clamp(rgba[o]! + t) >> 3) << 10) | ((clamp(rgba[o + 1]! + t) >> 3) << 5) | (clamp(rgba[o + 2]! + t) >> 3);
    res[p] = nearest(key);
    if (++x === width) {
      x = 0;
      y++;
    }
  }
  return res;
}

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s >>> 8;
  };
}

/** a picture with flat areas, gradients and noise, like a rendered frame */
function picture(w: number, h: number, seed: number): Uint8Array {
  const rnd = lcg(seed);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const zone = (x * 3) / w;
      if (zone < 1) {
        out[o] = 20;
        out[o + 1] = 120;
        out[o + 2] = 220;
      } else if (zone < 2) {
        out[o] = (x * 255) / w;
        out[o + 1] = (y * 255) / h;
        out[o + 2] = ((x + y) * 255) / (w + h);
      } else {
        out[o] = rnd() & 255;
        out[o + 1] = rnd() & 255;
        out[o + 2] = rnd() & 255;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

describe('the fast lzw writes the bytes the old one wrote', () => {
  it('on empty, tiny, flat, striped and noisy input at every code size', () => {
    const rnd = lcg(11);
    for (let bits = 2; bits <= 8; bits++) {
      const colors = 1 << bits;
      const cases: Uint8Array[] = [
        Uint8Array.of(),
        Uint8Array.of(colors - 1),
        Uint8Array.of(0, 0),
        new Uint8Array(20000).fill(colors - 1),
        Uint8Array.from({ length: 30000 }, (_, i) => i % colors),
        Uint8Array.from({ length: 30000 }, () => rnd() % colors),
        Uint8Array.from({ length: 50000 }, (_, i) => (i % 211 < 100 ? (i >> 4) % colors : rnd() % colors)),
      ];
      for (const c of cases) expect(lzwEncode(c, bits)).toEqual(lzwEncodeOld(c, bits));
    }
  });
  it('on every length across the first table resets', () => {
    const rnd = lcg(5);
    const noise = Uint8Array.from({ length: 9000 }, () => rnd() % 256);
    for (let n = 3800; n < 4400; n += 7) expect(lzwEncode(noise.subarray(0, n), 8)).toEqual(lzwEncodeOld(noise.subarray(0, n), 8));
    for (let n = 8100; n < 8400; n += 13) expect(lzwEncode(noise.subarray(0, n), 8)).toEqual(lzwEncodeOld(noise.subarray(0, n), 8));
  });
  it('after a longer frame used the scratch buffers (leftovers must not leak into the next frame)', () => {
    const rnd = lcg(21);
    const big = Uint8Array.from({ length: 80000 }, () => rnd() % 256);
    const small = Uint8Array.from({ length: 500 }, () => rnd() % 16);
    expect(lzwEncode(big, 8)).toEqual(lzwEncodeOld(big, 8));
    expect(lzwEncode(small, 4)).toEqual(lzwEncodeOld(small, 4));
    expect(lzwEncode(big, 8)).toEqual(lzwEncodeOld(big, 8));
  });
});

describe('the fast dithering picks the indices the old one picked', () => {
  it('for widths that are not a multiple of 4 too', () => {
    for (const [w, h] of [
      [64, 48],
      [37, 29],
      [1, 50],
      [130, 3],
    ] as const) {
      const rgba = picture(w, h, w * 31 + h);
      const palette = buildPalette(rgba, 256);
      expect(indexFrame(rgba, w, palette, true)).toEqual(indexFrameOld(rgba, w, palette));
      const few = buildPalette(rgba, 7);
      expect(indexFrame(rgba, w, few, true)).toEqual(indexFrameOld(rgba, w, few));
    }
  });
});

describe('frames compressed elsewhere', () => {
  it('encodeGifFrame + addEncodedFrame give the file addFrame gives', () => {
    const w = 53;
    const h = 31;
    const frames = [picture(w, h, 1), picture(w, h, 2), picture(w, h, 3)];
    const palette = buildPalette(frames[0]!, 200);
    const a = createGifEncoder({ width: w, height: h, palette });
    const b = createGifEncoder({ width: w, height: h, palette });
    // the second encoder gets its frames "from workers": made in another order, added in playing order
    const made = [2, 0, 1].map((i) => ({ i, lzw: encodeGifFrame(frames[i]!, w, palette) })).sort((x, y) => x.i - y.i);
    frames.forEach((f, i) => {
      a.addFrame(indexFrame(f, w, palette, true), 4 + i);
      b.addEncodedFrame(made[i]!.lzw, 4 + i);
    });
    expect(b.finish()).toEqual(a.finish());
    expect(b.frameCount).toBe(3);
  });
  it('reuses the index scratch without changing the result', () => {
    const w = 40;
    const rgba = picture(w, 20, 9);
    const palette = buildPalette(rgba, 64);
    const scratch = new Uint8Array(w * 20).fill(7);
    expect(encodeGifFrame(rgba, w, palette, scratch)).toEqual(encodeGifFrame(rgba, w, palette));
  });
  it('the minimum code size is at least 2', () => {
    expect(gifMinCodeSize(1)).toBe(2);
    expect(gifMinCodeSize(2)).toBe(2);
    expect(gifMinCodeSize(5)).toBe(3);
    expect(gifMinCodeSize(256)).toBe(8);
  });
});
