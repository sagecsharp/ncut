import { describe, expect, it } from 'vitest';
import { createTextClip } from '../../lib/factory';
import { MAX_PIECES, layoutGlyphsFrom, pieceClip, pieceTransform, splitBlocker, splitPlan } from './textSplit';
import type { PieceBase } from './textSplit';

/** a straight layout: every letter 10 wide, lines 20 apart, "ab cd" then "ef" */
function glyphsOf(lines: string[], align: 'left' | 'center' | 'right' = 'center', curve = 0) {
  const edges = lines.map((l) => [0, ...Array.from(l).map((_, i) => (i + 1) * 10)]);
  const widest = Math.max(...edges.map((e) => e[e.length - 1]!));
  const pad = 5;
  const box = {
    lines,
    width: widest + pad * 2,
    height: lines.length * 20 + pad * 2,
    pad,
    lineHeight: 20,
    spacing: 0,
    curve,
    curveRef: widest,
    curveCx: 0,
    curveCy: 0,
  };
  return { box, glyphs: layoutGlyphsFrom(box, align, edges) };
}

describe('layoutGlyphsFrom', () => {
  it('centers a line and counts words and lines', () => {
    const { glyphs } = glyphsOf(['ab cd', 'ef']);
    expect(glyphs.map((g) => g.ch).join('')).toBe('ab cdef');
    expect(glyphs[0]!.x).toBeCloseTo(-20); // line is 50 wide: first letter center at -25 + 5
    expect(glyphs[0]!.y).toBeCloseTo(-10);
    expect(glyphs[5]!.y).toBeCloseTo(10);
    expect(glyphs.map((g) => g.word)).toEqual([0, 0, 1, 1, 1, 2, 2]);
    expect(glyphs.map((g) => g.line)).toEqual([0, 0, 0, 0, 0, 1, 1]);
  });
});

describe('splitPlan', () => {
  it('letters: no piece for spaces', () => {
    const { box, glyphs } = glyphsOf(['ab cd']);
    const plan = splitPlan(box, glyphs, 'letters');
    expect(plan.pieces.map((p) => p.text)).toEqual(['a', 'b', 'c', 'd']);
    expect(plan.pieces[0]!.cx).toBeCloseTo(-20);
    expect(plan.pieces[3]!.cx).toBeCloseTo(20);
    expect(plan.pieces.every((p) => p.rot === 0)).toBe(true);
  });

  it('words: one piece per word, centered on the word', () => {
    const { box, glyphs } = glyphsOf(['ab cd']);
    const plan = splitPlan(box, glyphs, 'words');
    expect(plan.pieces.map((p) => p.text)).toEqual(['ab', 'cd']);
    expect(plan.pieces[0]!.cx).toBeCloseTo(-15); // ab spans -25..-5
    expect(plan.pieces[1]!.cx).toBeCloseTo(15);
  });

  it('lines: one piece per line, inner spaces kept', () => {
    const { box, glyphs } = glyphsOf(['ab cd', 'ef'], 'left');
    const plan = splitPlan(box, glyphs, 'lines');
    expect(plan.pieces.map((p) => p.text)).toEqual(['ab cd', 'ef']);
    expect(plan.pieces[0]!.cx).toBeCloseTo(0);
    expect(plan.pieces[1]!.cx).toBeCloseTo(-15); // left aligned: ef spans -25..-5
    expect(plan.pieces[1]!.cy).toBeCloseTo(10);
  });

  it('gives nothing for one piece or none', () => {
    const one = glyphsOf(['abc']);
    expect(splitPlan(one.box, one.glyphs, 'lines')).toEqual({ count: 1, pieces: [] });
    expect(splitPlan(one.box, one.glyphs, 'words').pieces).toEqual([]);
    const empty = glyphsOf([' ']);
    expect(splitPlan(empty.box, empty.glyphs, 'letters')).toEqual({ count: 0, pieces: [] });
  });

  it('gives nothing above MAX_PIECES but still reports the count', () => {
    const { box, glyphs } = glyphsOf(['x'.repeat(MAX_PIECES + 1)]);
    const plan = splitPlan(box, glyphs, 'letters');
    expect(plan.count).toBe(MAX_PIECES + 1);
    expect(plan.pieces).toEqual([]);
    expect(splitPlan(box, glyphs, 'letters').count).toBeGreaterThan(MAX_PIECES);
    const ok = glyphsOf(['x'.repeat(MAX_PIECES)]);
    expect(splitPlan(ok.box, ok.glyphs, 'letters').pieces).toHaveLength(MAX_PIECES);
  });

  it('curved letters carry their rotation in degrees, a curved word the rotation of its middle', () => {
    const { box, glyphs } = glyphsOf(['abc def'], 'center', 120);
    const letters = splitPlan(box, glyphs, 'letters');
    expect(letters.pieces[0]!.rot).not.toBe(0);
    expect(letters.pieces[0]!.rot).toBeLessThan(0); // an arch: the left end leans left
    expect(letters.pieces[5]!.rot).toBeGreaterThan(0);
    const words = splitPlan(box, glyphs, 'words');
    // "abc": the middle letter is b
    expect(words.pieces[0]!.rot).toBeCloseTo(letters.pieces[1]!.rot);
    expect(words.pieces[0]!.cx).toBeCloseTo(letters.pieces[1]!.cx);
  });
});

const flat = (over: Partial<PieceBase['transform']> = {}, rest: Partial<PieceBase> = {}): PieceBase => ({
  start: 0,
  transform: { x: 100, y: 50, scale: 1, rotation: 0, opacity: 0.8, ...over },
  ...rest,
});

describe('pieceTransform', () => {
  it('plain: the offset is added', () => {
    const t = pieceTransform(flat(), { cx: 30, cy: -10, rot: 0 }, 0);
    expect(t.transform.x).toBeCloseTo(130);
    expect(t.transform.y).toBeCloseTo(40);
    expect(t.transform.opacity).toBe(0.8);
    expect(t.transform.rotation).toBe(0);
  });

  it('scaled: the offset is scaled', () => {
    const t = pieceTransform(flat({ scale: 2 }), { cx: 30, cy: -10, rot: 0 }, 0);
    expect(t.transform.x).toBeCloseTo(160);
    expect(t.transform.y).toBeCloseTo(30);
    expect(t.transform.scale).toBe(2);
  });

  it('rotated 90 degrees clockwise: the offset turns', () => {
    const t = pieceTransform(flat({ rotation: 90 }), { cx: 30, cy: 0, rot: 0 }, 0);
    // a point to the right of the center ends up below it (y is down)
    expect(t.transform.x).toBeCloseTo(100);
    expect(t.transform.y).toBeCloseTo(80);
    expect(t.transform.rotation).toBe(90);
  });

  it('a curved letter adds its own rotation', () => {
    const t = pieceTransform(flat({ rotation: 10 }), { cx: 0, cy: 0, rot: 25 }, 0);
    expect(t.transform.rotation).toBeCloseTo(35);
  });

  it('3d rotY 90: the x offset becomes depth', () => {
    const t = pieceTransform(flat({ rotY: 90, z: 5 }, { threeD: true }), { cx: 30, cy: 0, rot: 0 }, 0);
    expect(t.transform.x).toBeCloseTo(100);
    expect(t.transform.z).toBeCloseTo(35);
    expect(t.transform.rotY).toBe(90);
  });

  it('3d rotX 90 (top leans away): the y offset becomes depth', () => {
    const t = pieceTransform(flat({ rotX: 90 }, { threeD: true }), { cx: 0, cy: 10, rot: 0 }, 0);
    expect(t.transform.y).toBeCloseTo(50);
    expect(t.transform.z).toBeCloseTo(-10);
  });

  it('a flat clip ignores stored tilt and turn', () => {
    const t = pieceTransform(flat({ rotY: 90 }), { cx: 30, cy: 0, rot: 0 }, 0);
    expect(t.transform.x).toBeCloseTo(130);
    expect(t.transform.z).toBeUndefined();
  });

  it('keyframed position: the offset is added to every key, the static value stays', () => {
    const base = flat(
      { scale: 2 },
      {
        start: 1,
        keyframes: {
          x: [
            { t: 0, v: 0, ease: 'linear' },
            { t: 2, v: 200, ease: 'linear' },
          ],
        },
      },
    );
    const t = pieceTransform(base, { cx: 10, cy: 5, rot: 0 }, 2);
    expect(t.keyframes!.x!.map((k) => k.v)).toEqual([20, 220]);
    expect(t.keyframes!.x!.map((k) => k.t)).toEqual([0, 2]);
    expect(t.transform.x).toBe(100); // keyframed: the static field is ignored
    expect(t.transform.y).toBeCloseTo(60); // y is not animated: static
    expect(base.keyframes!.x![0]!.v).toBe(0); // the original is untouched
  });

  it('uses the scale and rotation keyed at the given time', () => {
    const base = flat(
      {},
      {
        start: 0,
        keyframes: {
          scale: [
            { t: 0, v: 1, ease: 'linear' },
            { t: 1, v: 3, ease: 'linear' },
          ],
        },
      },
    );
    expect(pieceTransform(base, { cx: 10, cy: 0, rot: 0 }, 1).transform.x).toBeCloseTo(130);
    expect(pieceTransform(base, { cx: 10, cy: 0, rot: 0 }, 0).transform.x).toBeCloseTo(110);
  });
});

describe('pieceClip', () => {
  const clip = createTextClip('t1', 2, {
    text: 'hi there',
    wrapWidth: 300,
    curve: 40,
    align: 'left',
    background: '#112233',
    group: 'g1',
    letterSpacing: 0.1,
    fadeIn: 0.2,
  });
  const piece = { text: 'hi', cx: 12, cy: 0, rot: 0 };

  it('keeps the style and timing, drops wrap, curve and group', () => {
    const c = pieceClip(clip, piece, 'words', 0);
    expect(c.text).toBe('hi');
    expect(c.align).toBe('center');
    expect(c.wrapWidth).toBeUndefined();
    expect(c.curve).toBeUndefined();
    expect(c.group).toBeUndefined();
    expect(c.letterSpacing).toBe(0.1);
    expect(c.start).toBe(2);
    expect(c.duration).toBe(clip.duration);
    expect(c.fadeIn).toBe(0.2);
    expect(c.background).toBe('#112233');
    expect(c.transform.x).toBeCloseTo(12);
  });

  it('letters drop the background', () => {
    expect(pieceClip(clip, piece, 'letters', 0).background).toBeNull();
    expect(clip.background).toBe('#112233');
  });
});

describe('splitBlocker', () => {
  it('refuses a running number and karaoke', () => {
    expect(splitBlocker({ counter: { from: 0, to: 9, decimals: 0 } })).toMatch(/running number/);
    expect(splitBlocker({ highlight: { color: '#fff', mode: 'word' } })).toMatch(/karaoke/);
    expect(splitBlocker({})).toBeNull();
  });
});
