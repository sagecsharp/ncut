import { describe, expect, it } from 'vitest';
import { createTextClip } from '../lib/factory';
import { curveLayout, gradientLine, remapPoint, textSignature, wrapLine, wrapText } from './text';

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
