import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTextClip } from '../lib/factory';
import {
  curveLayout,
  EXTRUDE_MAX_STEPS,
  drawText,
  extrudeOffsets,
  fontRetryDelay,
  glyphAnimActive,
  gradientLine,
  highlightIndex,
  highlightIndexFromCounts,
  lineBackgrounds,
  lineDecorations,
  lineLengths,
  lineSpans,
  lineVisibility,
  measureText,
  remapPoint,
  textSignature,
  textSpill,
  wordLit,
  wrapLine,
  wrapText,
} from './text';
import { textAnimActive, textAnimUnits } from './textAnim';
import { ensureFont } from '../lib/fonts';

vi.mock('../lib/fonts', () => ({ ensureFont: vi.fn(async () => true), fontsVersion: () => 0 }));


/** every character is 10 wide, spaces too */
const measure = (s: string) => Array.from(s).length * 10;
/** prefix widths of a line, like the real lineEdges */
const edgesOf = (line: string) => [0, ...Array.from(line).map((_, i) => (i + 1) * 10)];

describe('wrapLine', () => {
  it('leaves a line that fits', () => {
    expect(wrapLine('hello world', 200, measure)).toEqual(['hello world']);
  });

  it('breaks at spaces and drops the space it breaks at', () => {
    expect(wrapLine('aaa bbb ccc', 70, measure)).toEqual(['aaa bbb', 'ccc']);
    expect(wrapLine('aaa bbb ccc', 40, measure)).toEqual(['aaa', 'bbb', 'ccc']);
  });

  it('fills a line up to exactly the width', () => {
    expect(wrapLine('aaa bbb', 70, measure)).toEqual(['aaa bbb']);
    expect(wrapLine('aaa bbb', 69, measure)).toEqual(['aaa', 'bbb']);
  });

  it('keeps a word that is wider than the width whole', () => {
    expect(wrapLine('abcdefghij kl', 30, measure)).toEqual(['abcdefghij', 'kl']);
  });

  it('counts letter spacing toward the width', () => {
    // 'aaa bbb' = 70 + 6 gaps * 5 = 100
    expect(wrapLine('aaa bbb', 100, measure, 5)).toEqual(['aaa bbb']);
    expect(wrapLine('aaa bbb', 99, measure, 5)).toEqual(['aaa', 'bbb']);
  });

  it('does nothing without a width', () => {
    expect(wrapLine('aaa bbb ccc', 0, measure)).toEqual(['aaa bbb ccc']);
  });
});

describe('wrapText', () => {
  it('keeps explicit line breaks and wraps each line on its own', () => {
    expect(wrapText('aaa bbb\nccc ddd eee', 70, measure)).toEqual(['aaa bbb', 'ccc ddd', 'eee']);
    expect(wrapText('aaa\n\nbbb', 70, measure)).toEqual(['aaa', '', 'bbb']);
  });

  it('only splits at line breaks without a width', () => {
    expect(wrapText('a b\nc', 0, measure)).toEqual(['a b', 'c']);
  });
});

describe('curveLayout', () => {
  const lh = 20;
  const word = 'abcdefghi'; // 9 letters, 90 wide, odd so the middle one sits on the axis

  it('puts the middle letter on top of the circle and mirrors the rest', () => {
    const cl = curveLayout([edgesOf(word)], 0, lh, 90, 'center', 90);
    expect(cl.glyphs).toHaveLength(9);
    const mid = cl.glyphs[4]!;
    expect(mid.x).toBeCloseTo(0, 6);
    expect(mid.rot).toBeCloseTo(0, 6);
    expect(mid.y).toBeCloseTo(lh / 2, 6);
    const a = cl.glyphs[1]!;
    const b = cl.glyphs[7]!;
    expect(a.x).toBeCloseTo(-b.x, 6);
    expect(a.y).toBeCloseTo(b.y, 6);
    expect(a.rot).toBeCloseTo(-b.rot, 6);
  });

  it('an arch hangs its ends down and tilts the right end clockwise', () => {
    const cl = curveLayout([edgesOf(word)], 0, lh, 90, 'center', 90);
    const mid = cl.glyphs[4]!;
    const right = cl.glyphs[8]!;
    expect(right.y).toBeGreaterThan(mid.y);
    expect(right.rot).toBeGreaterThan(0);
  });

  it('a smile lifts its ends and tilts the right end the other way', () => {
    const cl = curveLayout([edgesOf(word)], 0, lh, -90, 'center', 90);
    const mid = cl.glyphs[4]!;
    const right = cl.glyphs[8]!;
    expect(right.y).toBeLessThan(mid.y);
    expect(right.rot).toBeLessThan(0);
  });

  it('the widest line spans the given arc and sits on a circle of radius width / radians', () => {
    const deg = 120;
    const cl = curveLayout([edgesOf(word)], 0, lh, deg, 'center', 90);
    const r = 90 / ((deg * Math.PI) / 180);
    const yc = lh / 2 + r;
    for (const g of cl.glyphs) expect(Math.hypot(g.x, g.y - yc)).toBeCloseTo(r, 6);
    // the outer letter edges are +-45 on the arc, the centers 40 -> angle = 40 / r
    expect(cl.glyphs[8]!.rot).toBeCloseTo(40 / r, 6);
  });

  it('every letter lies inside the bounding box', () => {
    for (const deg of [30, -30, 180, -270, 360]) {
      const cl = curveLayout([edgesOf(word), edgesOf('xyz')], 0, lh, deg, 'center', 90);
      for (const g of cl.glyphs) {
        expect(g.x).toBeGreaterThanOrEqual(cl.minX);
        expect(g.x).toBeLessThanOrEqual(cl.maxX);
        expect(g.y).toBeGreaterThanOrEqual(cl.minY);
        expect(g.y).toBeLessThanOrEqual(cl.maxY);
      }
      expect(cl.maxX).toBeGreaterThan(cl.minX);
      expect(cl.maxY).toBeGreaterThan(cl.minY);
    }
  });

  it('a gentle curve is about as big as the straight text', () => {
    const cl = curveLayout([edgesOf(word)], 0, lh, 1, 'center', 90);
    expect(cl.maxX - cl.minX).toBeCloseTo(90, 0);
    expect(cl.maxY - cl.minY).toBeCloseTo(lh, 0);
  });

  it('a ring is about as wide as it is tall', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const cl = curveLayout([edgesOf(text)], 0, lh, 360, 'center', 360);
    const w = cl.maxX - cl.minX;
    const h = cl.maxY - cl.minY;
    expect(w / h).toBeGreaterThan(0.9);
    expect(w / h).toBeLessThan(1.1);
  });

  it('further lines sit lineHeight lower on concentric circles', () => {
    // one letter per line: the apex of each is straight below the one before (arch and smile)
    for (const deg of [90, -90]) {
      const cl = curveLayout([edgesOf('a'), edgesOf('b'), edgesOf('c')], 0, lh, deg, 'center', 200);
      const [a, b, c] = cl.glyphs;
      expect(b!.y - a!.y).toBeCloseTo(lh, 2);
      expect(c!.y - b!.y).toBeCloseTo(lh, 2);
    }
  });

  it('a shorter line is centered on the axis and spans a shorter arc', () => {
    const cl = curveLayout([edgesOf(word), edgesOf('abc')], 0, lh, 90, 'center', 90);
    const second = cl.glyphs.filter((g) => g.line === 1);
    expect(second[1]!.x).toBeCloseTo(0, 6);
    expect(Math.abs(second[2]!.rot)).toBeLessThan(Math.abs(cl.glyphs[8]!.rot));
  });

  it('left and right alignment anchor the line to the ends of the arc', () => {
    const left = curveLayout([edgesOf(word), edgesOf('abc')], 0, lh, 90, 'left', 90);
    const right = curveLayout([edgesOf(word), edgesOf('abc')], 0, lh, 90, 'right', 90);
    const l = left.glyphs.filter((g) => g.line === 1);
    const r = right.glyphs.filter((g) => g.line === 1);
    expect(l[0]!.x).toBeLessThan(0);
    expect(r[2]!.x).toBeGreaterThan(0);
  });

  it('letter spacing pushes the letters along the arc', () => {
    const tight = curveLayout([edgesOf(word)], 0, lh, 90, 'center', 90);
    const loose = curveLayout([edgesOf(word)], 10, lh, 90, 'center', 90);
    expect(loose.glyphs[8]!.rot).toBeGreaterThan(tight.glyphs[8]!.rot);
  });

  it('is deterministic and has no letters for no lines', () => {
    expect(curveLayout([edgesOf(word)], 0, lh, 77, 'center', 90)).toEqual(curveLayout([edgesOf(word)], 0, lh, 77, 'center', 90));
    const empty = curveLayout([], 0, lh, 90, 'center', 10);
    expect(empty.glyphs).toHaveLength(0);
    expect(Number.isFinite(empty.minX)).toBe(true);
  });
});

describe('gradientLine', () => {
  it('0 degrees runs left to right across the width', () => {
    const [x0, y0, x1, y1] = gradientLine(0, 200, 100);
    expect(x0).toBeCloseTo(-100);
    expect(x1).toBeCloseTo(100);
    expect(y0).toBeCloseTo(0);
    expect(y1).toBeCloseTo(0);
  });

  it('90 degrees runs top to bottom across the height', () => {
    const [x0, y0, x1, y1] = gradientLine(90, 200, 100);
    expect(y0).toBeCloseTo(-50);
    expect(y1).toBeCloseTo(50);
    expect(x0).toBeCloseTo(0);
    expect(x1).toBeCloseTo(0);
  });

  it('a diagonal reaches the corners', () => {
    const [x0, y0, x1, y1] = gradientLine(45, 100, 100);
    // projection of the corner (50, 50) on the direction is 70.7
    expect(Math.hypot(x1, y1)).toBeCloseTo(Math.SQRT1_2 * 100, 6);
    expect(x0).toBeCloseTo(-x1);
    expect(y0).toBeCloseTo(-y1);
  });

  it('never returns an empty line', () => {
    const [x0, , x1] = gradientLine(0, 0, 0);
    expect(x1 - x0).not.toBe(0);
  });
});

describe('remapPoint', () => {
  const id = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

  it('is the identity when the letter has no transform of its own', () => {
    expect(remapPoint(id, id, 3, 4)).toEqual([3, 4]);
  });

  it('undoes a translation and a scale of the letter', () => {
    const block = { a: 2, b: 0, c: 0, d: 2, e: 100, f: 50 };
    // the letter: block, then moved by (10, 5) in block units and scaled by 3
    const letter = { a: 6, b: 0, c: 0, d: 6, e: 120, f: 60 };
    const [x, y] = remapPoint(block, letter, 10, 5);
    // block point (10, 5) is the letter's origin
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
    const [x2, y2] = remapPoint(block, letter, 13, 5);
    expect(x2).toBeCloseTo(1);
    expect(y2).toBeCloseTo(0);
  });

  it('undoes a rotation', () => {
    const rot = { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 }; // 90 degrees
    const [x, y] = remapPoint(id, rot, 0, 5);
    // the letter's x axis points down, so (0, 5) is 5 along the letter's x axis
    expect(x).toBeCloseTo(5);
    expect(y).toBeCloseTo(0);
  });
});

describe('textSignature', () => {
  const base = createTextClip('t1', 0, { text: 'hello' });
  const sig = textSignature(base);

  it('is stable for the same clip', () => {
    expect(textSignature(base)).toBe(sig);
    expect(textSignature({ ...base })).toBe(sig);
  });

  it('changes with the new look fields', () => {
    expect(textSignature({ ...base, gradient: { from: '#fff', to: '#000', angle: 0 } })).not.toBe(sig);
    expect(textSignature({ ...base, curve: 90 })).not.toBe(sig);
    expect(textSignature({ ...base, wrapWidth: 300 })).not.toBe(sig);
  });

  it('changes with the existing look fields', () => {
    expect(textSignature({ ...base, text: 'other' })).not.toBe(sig);
    expect(textSignature({ ...base, color: '#ff0000' })).not.toBe(sig);
    expect(textSignature({ ...base, stroke: { color: '#000', width: 0.1 } })).not.toBe(sig);
  });

  it('ignores animation and position', () => {
    expect(textSignature({ ...base, animIn: { id: 'fade', duration: 1 } })).toBe(sig);
    expect(textSignature({ ...base, transform: { ...base.transform, x: 50 } })).toBe(sig);
  });
});

/* ---------- drawing cost ---------- */

const counts = { measure: 0 };

beforeAll(() => {
  // the measuring canvas: every letter is 10 wide, and every measureText call is counted
  class FakeOffscreen {
    getContext() {
      return {
        font: '',
        measureText: (s: string) => {
          counts.measure++;
          return { width: Array.from(s).length * 10 };
        },
      };
    }
  }
  vi.stubGlobal('OffscreenCanvas', FakeOffscreen);
});
afterAll(() => vi.unstubAllGlobals());

/** a drawing context that does nothing and counts the calls */
function fakeCtx() {
  const calls: Record<string, number> = {};
  const target: Record<string, unknown> = {
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    measureText: (s: string) => {
      counts.measure++;
      return { width: Array.from(s).length * 10 };
    },
  };
  const ctx = new Proxy(target, {
    get(t, k: string) {
      if (k in t) return t[k];
      return () => {
        calls[k] = (calls[k] ?? 0) + 1;
      };
    },
    set(t, k: string, v) {
      t[k] = v;
      return true;
    },
    has: (t, k: string) => k in t,
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const LONG = 'abcdefghij'.repeat(30); // 300 characters

describe('drawText cost', () => {
  it('measures a 300 character text once, not on every frame', () => {
    const clip = createTextClip('t', 0, { text: LONG, fontFamily: 'Cost A', animLoop: { id: 'pulse', duration: 1 } });
    const { ctx } = fakeCtx();
    counts.measure = 0;
    drawText(ctx, clip, 0);
    const first = counts.measure;
    expect(first).toBeGreaterThan(0);
    for (let i = 1; i <= 30; i++) drawText(ctx, clip, i / 30);
    expect(counts.measure).toBe(first);
  });

  it('a letter animation also measures nothing after the first frame', () => {
    const clip = createTextClip('t', 0, { text: LONG, fontFamily: 'Cost B', animLoop: { id: 'wobble', duration: 1 } });
    const { ctx } = fakeCtx();
    counts.measure = 0;
    drawText(ctx, clip, 0);
    const first = counts.measure;
    for (let i = 1; i <= 30; i++) drawText(ctx, clip, i / 30);
    expect(counts.measure).toBe(first);
  });

  it('a block animation (pulse) fills the line once, a letter animation (wobble) fills every letter', () => {
    const block = createTextClip('t', 0, { text: LONG, fontFamily: 'Cost C', animLoop: { id: 'pulse', duration: 1 } });
    const a = fakeCtx();
    drawText(a.ctx, block, 0.3);
    expect(a.calls.fillText).toBe(1);

    const letters = createTextClip('t', 0, { text: LONG, fontFamily: 'Cost C', animLoop: { id: 'wobble', duration: 1 } });
    const b = fakeCtx();
    drawText(b.ctx, letters, 0.3);
    expect(b.calls.fillText).toBe(300);
  });

  it('spacing, curve and block spacing animations still lay the letters out', () => {
    const spaced = createTextClip('t', 0, { text: 'hello', fontFamily: 'Cost D', letterSpacing: 0.1 });
    const a = fakeCtx();
    drawText(a.ctx, spaced);
    expect(a.calls.fillText).toBe(5);

    const expand = createTextClip('t', 0, { text: 'hello', fontFamily: 'Cost D', animIn: { id: 'expand', duration: 1 } });
    const b = fakeCtx();
    drawText(b.ctx, expand, 0.2);
    expect(b.calls.fillText).toBe(5);
  });

  it('the box is cached on the clip object', () => {
    const clip = createTextClip('t', 0, { text: LONG, fontFamily: 'Cost E' });
    expect(measureText(clip)).toBe(measureText(clip));
  });
});

describe('glyphAnimActive', () => {
  it('is false for block animations and true for letter animations', () => {
    const pulse = createTextClip('t', 0, { animLoop: { id: 'pulse', duration: 1 } });
    expect(glyphAnimActive(pulse, 0.5, textAnimUnits(pulse))).toBe(false);
    const wobble = createTextClip('t', 0, { animLoop: { id: 'wobble', duration: 1 } });
    expect(glyphAnimActive(wobble, 0.5, textAnimUnits(wobble))).toBe(true);
  });
  it('an in animation only counts while it runs', () => {
    const clip = createTextClip('t', 0, { animIn: { id: 'cascade', duration: 1 } });
    expect(glyphAnimActive(clip, 0.5, textAnimUnits(clip))).toBe(true);
    expect(glyphAnimActive(clip, 1.5, textAnimUnits(clip))).toBe(false);
  });
});

describe('font retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(ensureFont).mockReset();
  });
  afterAll(() => vi.useRealTimers());

  it('the pause grows and is capped', () => {
    expect(fontRetryDelay(0)).toBe(2000);
    expect(fontRetryDelay(2000)).toBe(4000);
    expect(fontRetryDelay(1e9)).toBe(60000);
  });

  it('a failed font load is asked again later, not every frame and not never', async () => {
    const ask = vi.mocked(ensureFont);
    ask.mockResolvedValueOnce(false).mockResolvedValue(true);
    const clip = createTextClip('t', 0, { text: 'retry', fontFamily: 'Retry Font' });
    measureText(clip);
    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0); // the failure lands
    for (let i = 0; i < 5; i++) measureText(clip); // frames inside the pause
    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2500);
    measureText(clip); // the same clip object still asks again after the pause
    expect(ask).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120000);
    measureText(clip); // it loaded: no more asking
    expect(ask).toHaveBeenCalledTimes(2);
  });
});

/* ---------- karaoke ---------- */

describe('highlightIndex', () => {
  it('gives every word a slice proportional to its letters', () => {
    const words = ['aa', 'bbbbbb', 'cc']; // 2 + 6 + 2 = 10
    expect(highlightIndex(words, 0)).toBe(0);
    expect(highlightIndex(words, 0.19)).toBe(0);
    expect(highlightIndex(words, 0.2)).toBe(1);
    expect(highlightIndex(words, 0.79)).toBe(1);
    expect(highlightIndex(words, 0.8)).toBe(2);
    expect(highlightIndex(words, 0.999)).toBe(2);
  });
  it('clamps the progress and survives odd input', () => {
    const words = ['a', 'b'];
    expect(highlightIndex(words, -3)).toBe(0);
    expect(highlightIndex(words, 1)).toBe(1);
    expect(highlightIndex(words, 7)).toBe(1);
    expect(highlightIndex(words, NaN)).toBe(0);
    expect(highlightIndex([], 0.5)).toBe(-1);
    expect(highlightIndexFromCounts([0, 0], 0.6)).toBe(1); // empty words still get a slice
  });
  it('wordLit: one word, or everything up to the current one', () => {
    expect(wordLit('word', 1, 1)).toBe(true);
    expect(wordLit('word', 0, 1)).toBe(false);
    expect(wordLit('fill', 0, 1)).toBe(true);
    expect(wordLit('fill', 2, 1)).toBe(false);
    expect(wordLit('fill', 0, -1)).toBe(false);
  });
});

/** a context that records the fill color of every fillText and the rounded boxes */
function recordCtx() {
  const fills: { text: string; color: unknown }[] = [];
  const boxes: number[][] = [];
  const rects: number[][] = [];
  const state: Record<string, unknown> = {
    fillStyle: '#fff',
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    measureText: (s: string) => ({ width: Array.from(s).length * 10 }),
    fillText: (text: string) => fills.push({ text, color: state.fillStyle }),
    roundRect: (...a: number[]) => boxes.push(a),
    rect: (...a: number[]) => boxes.push(a),
    fillRect: (...a: number[]) => rects.push(a),
  };
  const ctx = new Proxy(state, {
    get: (t, k: string) => (k in t ? t[k] : () => undefined),
    set: (t, k: string, v) => {
      t[k] = v;
      return true;
    },
    has: (t, k: string) => k in t,
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fills, boxes, rects };
}

describe('karaoke drawing', () => {
  const mk = (extra: Partial<Parameters<typeof createTextClip>[2]> = {}) =>
    createTextClip('t', 0, { text: 'aa bbbbbb cc', fontFamily: 'Karaoke A', duration: 10, color: '#ffffff', highlight: { color: '#ff0', mode: 'word' }, ...extra });

  it('word mode colors only the current word', () => {
    const r = recordCtx();
    drawText(r.ctx, mk(), 5); // 0.5 -> second word
    const lit = r.fills.filter((f) => f.color === '#ff0').map((f) => f.text);
    expect(lit.join('')).toBe('bbbbbb');
    expect(r.fills.filter((f) => f.color === '#ffffff').map((f) => f.text).join('')).toBe('aacc');
  });
  it('fill mode keeps the earlier words lit', () => {
    const r = recordCtx();
    drawText(r.ctx, mk({ highlight: { color: '#ff0', mode: 'fill' } }), 5);
    expect(r.fills.filter((f) => f.color === '#ff0').map((f) => f.text).join('')).toBe('aabbbbbb');
  });
  it('lights nothing and stays on the cheap path without a time', () => {
    const r = recordCtx();
    drawText(r.ctx, mk());
    expect(r.fills.every((f) => f.color === '#ffffff')).toBe(true);
    expect(r.fills.map((f) => f.text)).toEqual(['aa bbbbbb cc']); // one fill per line
  });
  it('draws a rounded box behind the current word, but not on curved text', () => {
    const r = recordCtx();
    drawText(r.ctx, mk({ highlight: { color: '#ff0', mode: 'word', background: '#f00' } }), 0);
    expect(r.boxes.length).toBe(1);
    const [, , w, h, radius] = r.boxes[0]!;
    expect(w).toBeCloseTo(20 + 2 * 0.12 * 96, 6);
    expect(h).toBeCloseTo(96 * (1 + 0.24), 6);
    expect(radius).toBeCloseTo(0.2 * 96, 6);
    const c = recordCtx();
    drawText(c.ctx, mk({ curve: 90, highlight: { color: '#ff0', mode: 'word', background: '#f00' } }), 0);
    expect(c.boxes.length).toBe(0);
    expect(c.fills.some((f) => f.color === '#ff0')).toBe(true);
  });
  it('works together with a letter animation', () => {
    const r = recordCtx();
    drawText(r.ctx, mk({ animLoop: { id: 'wobble', duration: 1 } }), 9.9);
    expect(r.fills.filter((f) => f.color === '#ff0').map((f) => f.text).join('')).toBe('cc');
  });
  it('is part of the signature, counts as animated and leaves room for the box', () => {
    const plain = mk({ highlight: null });
    const lit = mk();
    expect(textSignature(plain)).not.toBe(textSignature(lit));
    expect(textSignature(lit)).not.toBe(textSignature(mk({ highlight: { color: '#0f0', mode: 'word' } })));
    expect(textAnimActive(lit, 3)).toBe(true);
    expect(textAnimActive(plain, 3)).toBe(false);
    expect(textSpill(mk({ highlight: { color: '#ff0', mode: 'word', background: '#f00' } }), false)).toBeGreaterThan(textSpill(lit, false));
  });
});

describe('extrudeOffsets', () => {
  it('is empty without depth', () => {
    expect(extrudeOffsets(0, 45)).toEqual([]);
    expect(extrudeOffsets(-3, 45)).toEqual([]);
    expect(extrudeOffsets(Number.NaN, 45)).toEqual([]);
  });
  it('makes one copy per pixel, far to near, the nearest one step from the face', () => {
    const o = extrudeOffsets(10, 0);
    expect(o.length).toBe(10);
    expect(o[0]!.dx).toBeCloseTo(10, 9);
    expect(o[9]!.dx).toBeCloseTo(1, 9);
    for (let i = 1; i < o.length; i++) expect(o[i]!.dx).toBeLessThan(o[i - 1]!.dx);
    expect(extrudeOffsets(0.4, 0).length).toBe(1);
  });
  it('caps the count and still reaches the full depth', () => {
    const o = extrudeOffsets(400, 90);
    expect(o.length).toBe(EXTRUDE_MAX_STEPS);
    expect(o[0]!.dy).toBeCloseTo(400, 9);
    expect(o[0]!.dy - o[1]!.dy).toBeCloseTo(400 / EXTRUDE_MAX_STEPS, 9);
    expect(extrudeOffsets(400, 90, 8).length).toBe(8);
  });
  it('points along the angle: 0 right, 90 down, 225 up left', () => {
    const right = extrudeOffsets(20, 0)[0]!;
    expect(right.dx).toBeCloseTo(20, 9);
    expect(right.dy).toBeCloseTo(0, 9);
    const down = extrudeOffsets(20, 90)[0]!;
    expect(down.dx).toBeCloseTo(0, 9);
    expect(down.dy).toBeCloseTo(20, 9);
    const ul = extrudeOffsets(20, 225)[0]!;
    expect(ul.dx).toBeLessThan(0);
    expect(ul.dy).toBeLessThan(0);
    expect(ul.dx).toBeCloseTo(ul.dy, 9);
  });
});

describe('extrude drawing', () => {
  const mk = (extra: Partial<Parameters<typeof createTextClip>[2]> = {}) =>
    createTextClip('t', 0, { text: 'ab', fontFamily: 'Extrude A', fontSize: 100, color: '#ffffff', ...extra });
  const ex = { depth: 0.1, angle: 90, color: '#123456' };

  it('draws the copies in the side color under the face', () => {
    const r = recordCtx();
    drawText(r.ctx, mk({ extrude: ex }));
    const colors = r.fills.map((f) => f.color);
    expect(colors.filter((c) => c === '#123456').length).toBe(10); // 10px of depth, one line
    expect(colors[colors.length - 1]).toBe('#ffffff');
    expect(colors.indexOf('#ffffff')).toBe(colors.length - 1);
  });
  it('stays at one fill per line without it', () => {
    const r = recordCtx();
    drawText(r.ctx, mk({ extrude: null }));
    expect(r.fills.length).toBe(1);
    const z = recordCtx();
    drawText(z.ctx, mk({ extrude: { ...ex, depth: 0 } }));
    expect(z.fills.length).toBe(1);
  });
  it('moves with every letter when letters are drawn one by one', () => {
    const r = recordCtx();
    drawText(r.ctx, mk({ extrude: ex, letterSpacing: 0.1 }));
    expect(r.fills.filter((f) => f.color === '#123456').length).toBe(20);
  });
  it('is part of the signature and widens the spill', () => {
    const a = mk();
    const b = mk({ extrude: ex });
    expect(textSignature(a)).not.toBe(textSignature(b));
    expect(textSignature(b)).not.toBe(textSignature(mk({ extrude: { ...ex, angle: 45 } })));
    expect(textSpill(b, false)).toBeGreaterThanOrEqual(textSpill(a, false) + 0.1);
  });
});

describe('line geometry', () => {
  const widths = [100, 60];
  it('places lines by alignment', () => {
    expect(lineSpans(widths, null, 100, 'left')).toEqual([
      { left: -50, width: 100 },
      { left: -50, width: 60 },
    ]);
    expect(lineSpans(widths, null, 100, 'center')[1]).toEqual({ left: -30, width: 60 });
    expect(lineSpans(widths, null, 100, 'right')[1]).toEqual({ left: -10, width: 60 });
  });
  it('widens lines by extra spacing between letters', () => {
    const s = lineSpans([100], [5], 100, 'center', 2);
    expect(s[0]!.width).toBe(108);
    expect(s[0]!.left).toBe(-54);
    expect(lineLengths(['abc', '', 'a\u{1F600}'])).toEqual([3, 0, 2]);
  });
  it('makes underline and strike bars of fontSize / 14 thickness', () => {
    const spans = lineSpans(widths, null, 100, 'left');
    const r = lineDecorations(spans, 125, -125, 100, true, true);
    expect(r.length).toBe(4);
    for (const b of r) expect(b.h).toBeCloseTo(100 / 14, 6);
    const first = r.filter((b) => b.line === 0);
    expect(first[1]!.y).toBeGreaterThan(first[0]!.y);
    expect(first[1]!.w).toBe(100);
    expect(r.filter((b) => b.line === 1)[0]!.y - first[0]!.y).toBeCloseTo(125, 6);
    expect(lineDecorations(spans, 125, 0, 100, false, false)).toEqual([]);
    expect(lineDecorations(lineSpans([0], null, 100, 'left'), 125, 0, 100, true, false)).toEqual([]);
  });
  it('makes per line boxes that touch and hug each line', () => {
    const spans = lineSpans([100, 60, 80], null, 100, 'center');
    const b = lineBackgrounds(spans, 100, 0, 10);
    expect(b.length).toBe(3);
    expect(b[0]!.y).toBe(-10);
    expect(b[0]!.y + b[0]!.h).toBe(b[1]!.y);
    expect(b[1]!.y + b[1]!.h).toBe(b[2]!.y);
    expect(b[2]!.y + b[2]!.h).toBe(310);
    expect(b[1]!.w).toBe(80);
    expect(b[1]!.x).toBe(-40);
    expect(lineBackgrounds(lineSpans([0, 50], null, 100, 'left'), 100, 0, 10).length).toBe(1);
  });
  it('finds what shows of a line while letters animate', () => {
    const g = [
      { ch: 'a', x: 5, w: 10, line: 0 },
      { ch: ' ', x: 15, w: 10, line: 0 },
      { ch: 'b', x: 25, w: 10, line: 0 },
      { ch: 'c', x: 5, w: 10, line: 1 },
    ];
    const v = lineVisibility(g, [1, 1, 0, 0], 2);
    expect(v[0]).toEqual({ x0: 0, x1: 10, alpha: 1, all: false });
    expect(v[1]).toBeNull();
    const all = lineVisibility(g, [0.5, 1, 0.8, 1], 2);
    expect(all[0]).toEqual({ x0: 0, x1: 30, alpha: 0.8, all: true });
    expect(all[1]!.all).toBe(true);
  });
});

describe('underline, strike and per line boxes drawing', () => {
  const mk = (extra: Partial<Parameters<typeof createTextClip>[2]> = {}) =>
    createTextClip('t', 0, { text: 'ab\ncd', fontFamily: 'Line A', fontSize: 70, color: '#ffffff', ...extra });
  it('draws nothing extra without the flags', () => {
    const r = recordCtx();
    drawText(r.ctx, mk());
    expect(r.rects.length).toBe(0);
  });
  it('draws a bar per line for underline, two per line for both', () => {
    const r = recordCtx();
    drawText(r.ctx, mk({ underline: true }));
    expect(r.rects.length).toBe(2);
    expect(r.rects[0]![2]).toBe(20);
    const b = recordCtx();
    drawText(b.ctx, mk({ underline: true, strike: true }));
    expect(b.rects.length).toBe(4);
  });
  it('skips the bars on curved text', () => {
    const r = recordCtx();
    drawText(r.ctx, mk({ underline: true, curve: 90 }));
    expect(r.rects.length).toBe(0);
  });
  it('draws one box per line with a background per line, one otherwise', () => {
    const one = recordCtx();
    drawText(one.ctx, mk({ background: '#000000' }));
    expect(one.boxes.length).toBe(1);
    const per = recordCtx();
    drawText(per.ctx, mk({ background: '#000000', backgroundPerLine: true, backgroundRadius: 0.5 }));
    expect(per.boxes.length).toBe(2);
    const none = recordCtx();
    drawText(none.ctx, mk({ background: null, backgroundPerLine: true }));
    expect(none.boxes.length).toBe(0);
  });
  it('is part of the signature', () => {
    const base = textSignature(mk());
    expect(textSignature(mk({ underline: true }))).not.toBe(base);
    expect(textSignature(mk({ strike: true }))).not.toBe(base);
    expect(textSignature(mk({ backgroundPerLine: true }))).not.toBe(base);
  });
  it('does not crash on a clip that still has a counter and shows its text', () => {
    const r = recordCtx();
    const c = mk({ text: '{n}', counter: { from: 0, to: 5, decimals: 0 } });
    drawText(r.ctx, c);
    expect(r.fills[0]!.text).toBe('{n}');
    expect(measureText(c).lines).toEqual(['{n}']);
  });
});
