import { describe, expect, it } from 'vitest';
import type { ChromaKey, ClipAdjust, VisualClip } from '../types';
import {
  DEFAULT_ADJUST,
  DEFAULT_CHROMA_KEY,
  adjustColor,
  clipLookSignature,
  clipLookTexture,
  despill,
  hasClipLook,
  isAdjustActive,
  keyAlpha,
  lookSize,
  parseHexColor,
  releaseClipLook,
  type Rgb,
} from './clipLook';

const adj = (p: Partial<ClipAdjust>): ClipAdjust => ({ ...DEFAULT_ADJUST, ...p });
const key = (p: Partial<ChromaKey> = {}): ChromaKey => ({ ...DEFAULT_CHROMA_KEY, ...p });
const clip = (p: Partial<VisualClip>) => p as VisualClip;
const near = (a: Rgb, b: Rgb, digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, digits));
const luma = (c: Rgb) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

const SAMPLES: Rgb[] = [
  [0, 0, 0],
  [1, 1, 1],
  [0.5, 0.5, 0.5],
  [0.9, 0.3, 0.1],
  [0.2, 0.6, 0.4],
  [0.1, 0.2, 0.9],
];

describe('parseHexColor', () => {
  it('parses short and long hex', () => {
    near(parseHexColor('#fff')!, [1, 1, 1]);
    near(parseHexColor('#00d000')!, [0, 208 / 255, 0]);
    near(parseHexColor('0F0')!, [0, 1, 0]);
    near(parseHexColor('  #FF0000 ')!, [1, 0, 0]);
  });
  it('rejects garbage', () => {
    for (const bad of ['', '#', '#ff', '#ffff', '#gggggg', 'red', 'rgb(0,0,0)', '#12345678', null, 5]) {
      expect(parseHexColor(bad)).toBeNull();
    }
  });
});

describe('adjustColor', () => {
  it('is identity at zero', () => {
    for (const c of SAMPLES) near(adjustColor(c, DEFAULT_ADJUST), c);
  });
  it('brightness extremes', () => {
    near(adjustColor([0.7, 0.4, 0.2], adj({ brightness: -1 })), [0, 0, 0]);
    near(adjustColor([0.7, 0.4, 0.2], adj({ brightness: 1 })), [1, 1, 1]);
    expect(adjustColor([0.4, 0.4, 0.4], adj({ brightness: 0.3 }))[0]).toBeGreaterThan(0.4);
    expect(adjustColor([0.4, 0.4, 0.4], adj({ brightness: -0.3 }))[0]).toBeLessThan(0.4);
  });
  it('contrast pivots on mid gray', () => {
    near(adjustColor([0.5, 0.5, 0.5], adj({ contrast: 0.8 })), [0.5, 0.5, 0.5]);
    near(adjustColor([0.9, 0.1, 0.5], adj({ contrast: -1 })), [0.5, 0.5, 0.5]);
    const hi = adjustColor([0.6, 0.4, 0.5], adj({ contrast: 1 }));
    expect(hi[0]).toBeGreaterThan(0.6);
    expect(hi[1]).toBeLessThan(0.4);
  });
  it('saturation -1 is rec709 gray, +1 doubles distance from gray', () => {
    const c: Rgb = [0.8, 0.4, 0.2];
    const l = luma(c);
    near(adjustColor(c, adj({ saturation: -1 })), [l, l, l]);
    const d = adjustColor(c, adj({ saturation: 1 }));
    expect(d[0]).toBeCloseTo(Math.min(1, l + (c[0] - l) * 2), 6);
    expect(d[2]).toBeCloseTo(Math.max(0, l + (c[2] - l) * 2), 6);
  });
  it('hue rotates and keeps gray, 360 is identity', () => {
    near(adjustColor([0.4, 0.4, 0.4], adj({ hue: 90 })), [0.4, 0.4, 0.4], 2);
    near(adjustColor([0.9, 0.3, 0.1], adj({ hue: 360 })), [0.9, 0.3, 0.1], 6);
    const r = adjustColor([1, 0, 0], adj({ hue: 120 }));
    expect(r[1]).toBeGreaterThan(r[0]);
    expect(r[1]).toBeGreaterThan(r[2]);
    const c: Rgb = [0.5, 0.35, 0.2];
    expect(luma(adjustColor(c, adj({ hue: 75 })))).toBeCloseTo(luma(c), 2);
  });
  it('temperature warms and cools, luma roughly constant', () => {
    const c: Rgb = [0.5, 0.5, 0.5];
    const w = adjustColor(c, adj({ temperature: 1 }));
    expect(w[0]).toBeGreaterThan(w[2]);
    const k = adjustColor(c, adj({ temperature: -1 }));
    expect(k[2]).toBeGreaterThan(k[0]);
    expect(luma(w)).toBeCloseTo(luma(c), 3);
    expect(luma(k)).toBeCloseTo(luma(c), 3);
  });
  it('clamps out of range input', () => {
    near(adjustColor([0.5, 0.5, 0.5], adj({ brightness: 9 })), [1, 1, 1]);
    for (const v of adjustColor([1, 0, 1], adj({ contrast: 1, saturation: 1, hue: 33, temperature: 1 }))) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('keyAlpha', () => {
  const k = DEFAULT_CHROMA_KEY;
  it('removes green screens at any brightness', () => {
    expect(keyAlpha([0, 208 / 255, 0], k)).toBe(0);
    expect(keyAlpha([0, 1, 0], k)).toBe(0);
    expect(keyAlpha([0.05, 0.7, 0.1], k)).toBe(0);
    expect(keyAlpha([0, 0.4, 0], k)).toBe(0);
    expect(keyAlpha([0.1, 0.5, 0.15], k)).toBe(0);
  });
  it('keeps white, black, red, blue, skin opaque', () => {
    const keep: Rgb[] = [
      [1, 1, 1],
      [0, 0, 0],
      [1, 0, 0],
      [0, 0, 1],
      [0.88, 0.675, 0.41],
      [0.55, 0.35, 0.25],
      [0.5, 0.5, 0.5],
    ];
    for (const c of keep) expect(keyAlpha(c, k)).toBe(1);
  });
  it('softness is monotonic and alpha rises with distance from the key', () => {
    const edge: Rgb = [0.3, 0.75, 0.3];
    const a0 = keyAlpha(edge, key({ softness: 0 }));
    const a1 = keyAlpha(edge, key({ softness: 0.2 }));
    const a2 = keyAlpha(edge, key({ softness: 0.6 }));
    expect(a0).toBeGreaterThanOrEqual(a1);
    expect(a1).toBeGreaterThanOrEqual(a2);
    let prev = -1;
    for (const t of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      const a = keyAlpha([t, 1 - t * 0.5, t], key({ softness: 0.3 }));
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
  });
  it('tolerance grows the keyed area, zero tolerance and softness stay finite', () => {
    const px: Rgb = [0.6, 0.8, 0.5];
    expect(keyAlpha(px, key({ tolerance: 0.9 }))).toBeLessThanOrEqual(keyAlpha(px, key({ tolerance: 0.1 })));
    expect(Number.isFinite(keyAlpha(px, key({ tolerance: 0, softness: 0 })))).toBe(true);
  });
  it('works for other key colors', () => {
    const blue = key({ color: '#0000ff' });
    expect(keyAlpha([0, 0, 1], blue)).toBe(0);
    expect(keyAlpha([0, 1, 0], blue)).toBe(1);
  });
  it('unparsable color keys nothing', () => {
    expect(keyAlpha([0, 1, 0], key({ color: 'green' }))).toBe(1);
  });
});

describe('despill', () => {
  it('removes a green cast from what stays', () => {
    const out = despill([0.5, 0.8, 0.4], key({ spill: 1 }));
    expect(out[1]).toBeCloseTo(0.5, 6);
    expect(out[0]).toBe(0.5);
    expect(out[2]).toBe(0.4);
    expect(despill([0.5, 0.8, 0.4], key({ spill: 0.5 }))[1]).toBeCloseTo(0.65, 6);
  });
  it('spill 0 and non green pixels do not change', () => {
    expect(despill([0.5, 0.8, 0.4], key({ spill: 0 }))).toEqual([0.5, 0.8, 0.4]);
    const keep: Rgb[] = [
      [0.88, 0.675, 0.41],
      [1, 1, 1],
      [0, 0, 0],
      [0.9, 0.2, 0.2],
    ];
    for (const c of keep) expect(despill(c, key({ spill: 1 }))).toEqual(c);
  });
  it('follows the key color (blue screen)', () => {
    expect(despill([0.3, 0.4, 0.9], key({ color: '#0000ff', spill: 1 }))[2]).toBeCloseTo(0.4, 6);
  });
  it('gray key color has no despill', () => {
    expect(despill([0.1, 0.9, 0.1], key({ color: '#888888', spill: 1 }))).toEqual([0.1, 0.9, 0.1]);
  });
});

describe('signature and flags', () => {
  it('empty when no look', () => {
    expect(clipLookSignature(clip({}))).toBe('');
    expect(clipLookSignature(clip({ adjust: DEFAULT_ADJUST, chromaKey: null }))).toBe('');
    expect(hasClipLook(clip({ adjust: DEFAULT_ADJUST }))).toBe(false);
    expect(isAdjustActive(null)).toBe(false);
  });
  it('unparsable key color is no look', () => {
    expect(hasClipLook(clip({ chromaKey: key({ color: 'nope' }) }))).toBe(false);
    expect(clipLookSignature(clip({ chromaKey: key({ color: 'nope' }) }))).toBe('');
  });
  it('changes with every value', () => {
    const sig = clipLookSignature(clip({ adjust: adj({ brightness: 0.2 }), chromaKey: key() }));
    expect(sig).not.toBe('');
    const variants: Partial<VisualClip>[] = [
      { adjust: adj({ brightness: 0.3 }), chromaKey: key() },
      { adjust: adj({ brightness: 0.2, hue: 5 }), chromaKey: key() },
      { adjust: adj({ brightness: 0.2 }), chromaKey: key({ color: '#00ff00' }) },
      { adjust: adj({ brightness: 0.2 }), chromaKey: key({ tolerance: 0.31 }) },
      { adjust: adj({ brightness: 0.2 }), chromaKey: key({ softness: 0.11 }) },
      { adjust: adj({ brightness: 0.2 }), chromaKey: key({ spill: 0.6 }) },
      { adjust: adj({ brightness: 0.2 }) },
      { chromaKey: key() },
    ];
    const sigs = new Set([sig, ...variants.map((v) => clipLookSignature(clip(v)))]);
    expect(sigs.size).toBe(variants.length + 1);
  });
  it('same look, same signature (hex short form)', () => {
    expect(clipLookSignature(clip({ chromaKey: key({ color: '#0F0' }) }))).toBe(
      clipLookSignature(clip({ chromaKey: key({ color: '#00ff00' }) })),
    );
  });
});

describe('texture entry point without webgl', () => {
  const src = { tag: 'src' } as unknown as CanvasImageSource;
  it('returns the source for no look, bad sizes, or no webgl2', () => {
    expect(clipLookTexture(src, 100, 100, clip({}))).toBe(src);
    expect(clipLookTexture(src, 0, 100, clip({ chromaKey: key() }))).toBe(src);
    expect(clipLookTexture(src, 100, 0.5, clip({ chromaKey: key() }), 'export')).toBe(src);
    expect(clipLookTexture(src, NaN, 100, clip({ chromaKey: key() }))).toBe(src);
    expect(clipLookTexture(src, 100, 100, clip({ chromaKey: key() }), 'export')).toBe(src);
    releaseClipLook('export');
    releaseClipLook('preview');
  });
  it('caps the size at 4096 proportionally', () => {
    expect(lookSize(1920, 1080)).toEqual({ w: 1920, h: 1080 });
    expect(lookSize(8192, 4096)).toEqual({ w: 4096, h: 2048 });
    expect(lookSize(100, 20000)).toEqual({ w: 20, h: 4096 });
    expect(lookSize(0, 5)).toBeNull();
  });
});
