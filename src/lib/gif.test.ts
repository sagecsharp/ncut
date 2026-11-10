import { describe, expect, it } from 'vitest';
import {
  GIF_MAX_FPS,
  buildPalette,
  createGifEncoder,
  effectiveGifFps,
  gifDelayCs,
  indexFrame,
  lzwEncode,
} from './gif';

/** a plain gif lzw decoder (the textbook one), to check what the encoder wrote */
function lzwDecode(blocks: Uint8Array, minCode: number): number[] {
  const data: number[] = [];
  let p = 0;
  while (blocks[p] !== 0) {
    const n = blocks[p++];
    for (let i = 0; i < n; i++) data.push(blocks[p++]);
  }
  expect(p).toBe(blocks.length - 1); // the terminator is the last byte
  const clear = 1 << minCode;
  const eoi = clear + 1;
  let size = minCode + 1;
  let table: number[][] = [];
  const resetTable = () => {
    table = [];
    for (let i = 0; i < clear; i++) table.push([i]);
    table.push([], []);
    size = minCode + 1;
  };
  resetTable();
  const out: number[] = [];
  let bitPos = 0;
  const read = (): number => {
    let v = 0;
    for (let i = 0; i < size; i++) {
      const byte = data[bitPos >> 3];
      if (byte === undefined) throw new Error('ran out of data');
      v |= ((byte >> (bitPos & 7)) & 1) << i;
      bitPos++;
    }
    return v;
  };
  let prev: number[] | null = null;
  for (;;) {
    const code = read();
    if (code === clear) {
      resetTable();
      prev = null;
      continue;
    }
    if (code === eoi) break;
    let entry: number[];
    if (code < table.length) entry = table[code];
    else if (prev && code === table.length) entry = [...prev, prev[0]];
    else throw new Error('bad code ' + code);
    out.push(...entry);
    if (prev && table.length < 4096) {
      table.push([...prev, entry[0]]);
      if (table.length === 1 << size && size < 12) size++;
    }
    prev = entry;
  }
  return out;
}

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s >>> 8;
  };
}

describe('lzw', () => {
  it('round trips short, repetitive and noisy input', () => {
    const rnd = lcg(7);
    const cases: Uint8Array[] = [
      Uint8Array.of(),
      Uint8Array.of(1),
      Uint8Array.of(0, 1, 2, 3, 3, 3, 3, 2, 1, 0),
      new Uint8Array(10000).fill(2),
      Uint8Array.from({ length: 5000 }, () => rnd() % 4),
    ];
    for (const c of cases) {
      expect(lzwDecode(lzwEncode(c, 2), 2)).toEqual(Array.from(c));
    }
  });
  it('survives code size growth and table resets (256 colors, long noise)', () => {
    const rnd = lcg(99);
    const noise = Uint8Array.from({ length: 60000 }, () => rnd() % 256);
    expect(lzwDecode(lzwEncode(noise, 8), 8)).toEqual(Array.from(noise));
    const mixed = Uint8Array.from({ length: 40000 }, (_, i) => (i % 97 < 50 ? i % 13 : rnd() % 64));
    expect(lzwDecode(lzwEncode(mixed, 6), 6)).toEqual(Array.from(mixed));
  });
  it('round trips every length around the code size boundaries', () => {
    const rnd = lcg(3);
    for (let n = 1; n < 700; n += 1) {
      const d = Uint8Array.from({ length: n }, () => rnd() % 4);
      expect(lzwDecode(lzwEncode(d, 2), 2)).toEqual(Array.from(d));
    }
  });
  it('splits the data into sub-blocks of at most 255 bytes', () => {
    const rnd = lcg(5);
    const noise = Uint8Array.from({ length: 4000 }, () => rnd() % 256);
    const out = lzwEncode(noise, 8);
    let p = 0;
    let blocks = 0;
    while (out[p] !== 0) {
      expect(out[p]).toBeLessThanOrEqual(255);
      p += out[p] + 1;
      blocks++;
    }
    expect(blocks).toBeGreaterThan(1);
  });
});

describe('createGifEncoder', () => {
  const palette = Uint8Array.of(0, 0, 0, 255, 0, 0, 0, 255, 0, 255, 255, 255);
  it('writes the expected layout for a 2x2 two frame gif', () => {
    const enc = createGifEncoder({ width: 2, height: 2, palette });
    enc.addFrame(Uint8Array.of(0, 1, 2, 3), 5);
    enc.addFrame(Uint8Array.of(3, 2, 1, 0), 7);
    expect(enc.frameCount).toBe(2);
    const b = enc.finish();
    expect(String.fromCharCode(...b.subarray(0, 6))).toBe('GIF89a');
    expect(b[6] | (b[7] << 8)).toBe(2);
    expect(b[8] | (b[9] << 8)).toBe(2);
    // global table flag, 4 colors = size field 1
    expect(b[10] & 0x80).toBe(0x80);
    expect(b[10] & 7).toBe(1);
    // global color table: 4 entries
    expect(Array.from(b.subarray(13, 25))).toEqual(Array.from(palette));
    // netscape loop block right after, loop forever
    expect(Array.from(b.subarray(25, 28))).toEqual([0x21, 0xff, 11]);
    expect(String.fromCharCode(...b.subarray(28, 39))).toBe('NETSCAPE2.0');
    expect(Array.from(b.subarray(39, 44))).toEqual([3, 1, 0, 0, 0]);
    // first frame: graphic control with delay 5
    expect(Array.from(b.subarray(44, 48))).toEqual([0x21, 0xf9, 4, 0x04]);
    expect(b[48]).toBe(5);
    expect(b[49]).toBe(0);
    expect(b[b.length - 1]).toBe(0x3b);
    let gce = 0;
    for (let i = 44; i < b.length - 1; i++) {
      if (b[i] === 0x21 && b[i + 1] === 0xf9 && b[i + 2] === 4) gce++;
    }
    expect(gce).toBe(2);
  });
  it('decodes the frames it wrote', () => {
    const enc = createGifEncoder({ width: 2, height: 2, palette });
    enc.addFrame(Uint8Array.of(0, 1, 2, 3), 5);
    const b = enc.finish();
    const at = b.indexOf(0x2c, 44);
    expect(b[at + 9]).toBe(0); // no local table
    const min = b[at + 10];
    expect(min).toBe(2);
    expect(lzwDecode(b.subarray(at + 11, b.length - 1), min)).toEqual([0, 1, 2, 3]);
  });
  it('can loop a fixed number of times', () => {
    const b = createGifEncoder({ width: 1, height: 1, palette, loop: 3 }).finish();
    expect(b[41]).toBe(3);
  });
  it('pads the color table to a power of two', () => {
    const three = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9);
    const enc = createGifEncoder({ width: 1, height: 1, palette: three });
    const b = enc.finish();
    expect(b[10] & 7).toBe(1); // 4 entries
    expect(Array.from(b.subarray(13, 25))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 0, 0]);
    expect(enc.finishParts().length).toBeGreaterThan(2);
  });
  it('clamps the delay to at least 2 cs and rejects bad input', () => {
    const enc = createGifEncoder({ width: 1, height: 1, palette });
    enc.addFrame(Uint8Array.of(0), 1);
    const b = enc.finish();
    const at = b.indexOf(0xf9, 44);
    expect(b[at + 3]).toBe(2);
    expect(() => createGifEncoder({ width: 0, height: 1, palette })).toThrow();
    expect(() => createGifEncoder({ width: 1, height: 1, palette: new Uint8Array(0) })).toThrow();
    expect(() => createGifEncoder({ width: 1, height: 1, palette: new Uint8Array(257 * 3) })).toThrow();
    const e2 = createGifEncoder({ width: 2, height: 2, palette });
    expect(() => e2.addFrame(Uint8Array.of(0), 3)).toThrow();
  });
});

describe('palette', () => {
  function noise(n: number, seed: number): Uint8Array {
    const rnd = lcg(seed);
    const a = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) a.set([rnd() & 255, rnd() & 255, rnd() & 255, 255], i * 4);
    return a;
  }
  it('never has more colors than asked for', () => {
    const px = noise(5000, 1);
    expect(buildPalette(px, 256).length / 3).toBeLessThanOrEqual(256);
    expect(buildPalette(px, 16).length / 3).toBeLessThanOrEqual(16);
    expect(buildPalette(px, 16).length / 3).toBeGreaterThan(8);
    expect(buildPalette(px, 9999).length / 3).toBeLessThanOrEqual(256);
  });
  it('keeps exact colors when there are few', () => {
    const px = Uint8Array.of(255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255);
    const p = buildPalette(px, 256);
    expect(p.length / 3).toBe(2);
    const colors = [Array.from(p.subarray(0, 3)), Array.from(p.subarray(3, 6))];
    expect(colors).toContainEqual([255, 0, 0]);
    expect(colors).toContainEqual([0, 0, 255]);
  });
  it('is deterministic and handles empty input', () => {
    const px = noise(3000, 4);
    expect(Array.from(buildPalette(px))).toEqual(Array.from(buildPalette(px)));
    expect(buildPalette(new Uint8Array(0)).length).toBe(6);
  });
  it('maps a pixel to its nearest palette color', () => {
    const p = Uint8Array.of(0, 0, 0, 255, 255, 255, 255, 0, 0);
    const out = indexFrame(Uint8Array.of(250, 250, 250, 255, 10, 5, 5, 255, 240, 10, 10, 255), 3, p, false);
    expect(Array.from(out)).toEqual([1, 0, 2]);
  });
  it('dithering is deterministic and spreads a mid grey over both colors', () => {
    const p = Uint8Array.of(0, 0, 0, 255, 255, 255);
    const w = 8;
    const grey = new Uint8Array(w * 8 * 4);
    for (let i = 0; i < w * 8; i++) grey.set([128, 128, 128, 255], i * 4);
    const a = indexFrame(grey, w, p, true);
    const b = indexFrame(grey, w, p, true);
    expect(Array.from(a)).toEqual(Array.from(b));
    const ones = a.reduce((s, v) => s + v, 0);
    expect(ones).toBeGreaterThan(8);
    expect(ones).toBeLessThan(56);
    const flat = indexFrame(grey, w, p, false);
    expect(new Set(flat).size).toBe(1);
  });
  it('reuses the output array', () => {
    const p = Uint8Array.of(0, 0, 0, 255, 255, 255);
    const out = new Uint8Array(2);
    expect(indexFrame(Uint8Array.of(0, 0, 0, 255, 255, 255, 255, 255), 2, p, false, out)).toBe(out);
  });
});

describe('delays', () => {
  it('caps at 50 fps and never goes below 2 cs', () => {
    expect(effectiveGifFps(60)).toBe(GIF_MAX_FPS);
    expect(effectiveGifFps(15)).toBe(15);
    expect(effectiveGifFps(0)).toBe(1);
    for (const fps of [1, 10, 15, 24, 30, 50, 60, 240]) {
      for (let i = 0; i < 20; i++) expect(gifDelayCs(i, fps)).toBeGreaterThanOrEqual(2);
    }
    expect(gifDelayCs(0, 240)).toBe(2);
  });
  it('rounds on the running total so the length stays exact', () => {
    expect([0, 1, 2, 3, 4, 5].map((i) => gifDelayCs(i, 30))).toEqual([3, 4, 3, 3, 4, 3]);
    let sum = 0;
    for (let i = 0; i < 300; i++) sum += gifDelayCs(i, 30);
    expect(sum).toBe(1000);
    expect(gifDelayCs(0, 20)).toBe(5);
    expect(gifDelayCs(0, 15)).toBe(7);
    expect(gifDelayCs(1, 15)).toBe(6);
  });
});
