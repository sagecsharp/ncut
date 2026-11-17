import { describe, expect, it } from 'vitest';
import { CubeError, parseCube, writeCube } from './cube';

function identity3(n: number): string {
  const rows: string[] = [];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) rows.push(`${r / (n - 1)} ${g / (n - 1)} ${b / (n - 1)}`);
  return rows.join('\n');
}

function whyOf(text: string): CubeError {
  try {
    parseCube(text);
  } catch (e) {
    if (e instanceof CubeError) return e;
    throw e;
  }
  throw new Error('it parsed');
}

describe('parseCube', () => {
  it('3d with title and domain', () => {
    const c = parseCube('TITLE "warm look"\nLUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
    expect(c.title).toBe('warm look');
    expect(c.size3).toBe(2);
    expect(c.size1).toBe(0);
    expect(c.data3.length).toBe(24);
    expect(c.min3).toEqual([0, 0, 0]);
    expect(c.max3).toEqual([1, 1, 1]);
  });
  it('a quote in a trailing comment is not part of the title', () => {
    const c = parseCube(`TITLE "Film" # from "X"
LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`);
    expect(c.title).toBe('Film');
  });
  it('1d', () => {
    const c = parseCube('LUT_1D_SIZE 3\n0 0 0\n0.25 0.5 0.75\n1 1 1');
    expect(c.size1).toBe(3);
    expect(c.size3).toBe(0);
    expect(c.data3.length).toBe(0);
    expect(Array.from(c.data1)).toEqual([0, 0, 0, 0.25, 0.5, 0.75, 1, 1, 1]);
    expect(c.min3).toEqual([0, 0, 0]);
    expect(c.max3).toEqual([1, 1, 1]);
  });
  it('a resolve shaper with input ranges', () => {
    const c = parseCube(`LUT_1D_SIZE 2\nLUT_1D_INPUT_RANGE 0 10\nLUT_3D_SIZE 2\nLUT_3D_INPUT_RANGE -1 2\n0 0 0\n1 1 1\n${identity3(2)}`);
    expect(c.size1).toBe(2);
    expect(c.size3).toBe(2);
    expect(c.min1).toEqual([0, 0, 0]);
    expect(c.max1).toEqual([10, 10, 10]);
    expect(c.min3).toEqual([-1, -1, -1]);
    expect(c.max3).toEqual([2, 2, 2]);
    expect(c.data1.length).toBe(6);
    expect(c.data3.length).toBe(24);
    expect(c.identity).toBe(false);
  });
  it('input range wins over domain', () => {
    const c = parseCube(`LUT_3D_INPUT_RANGE 0.1 0.9\nDOMAIN_MIN 0.5 0.5 0.5\nDOMAIN_MAX 3 3 3\nLUT_3D_SIZE 2\n${identity3(2)}`);
    expect(c.min3).toEqual([0.1, 0.1, 0.1]);
    expect(c.max3).toEqual([0.9, 0.9, 0.9]);
    const d = parseCube(`DOMAIN_MIN 0.5 0 0\nDOMAIN_MAX 3 3 3\nLUT_3D_SIZE 2\n${identity3(2)}`);
    expect(d.min3).toEqual([0.5, 0, 0]);
    expect(d.max3).toEqual([3, 3, 3]);
  });
  it('comments, bom, tabs, windows line ends', () => {
    const text = `﻿# made by hand\r\nTITLE no quotes here  # a comment\r\n\r\nLUT_3D_SIZE\t2\r\n\t0\t0 0 # first\r\n1 0 0\r\n0 1 0\r\n1 1 0\r\n0 0 1\r\n1 0 1\r\n0 1 1\r\n1 1 1`;
    const c = parseCube(text);
    expect(c.title).toBe('no quotes here');
    expect(c.size3).toBe(2);
    expect(c.identity).toBe(true);
  });
  it('reads signs, dots and exponents', () => {
    const c = parseCube('LUT_1D_SIZE 2\n+1 .5 1e-3\n-0 1E0 0.5e+1\n');
    expect(c.data1[0]).toBeCloseTo(1, 7);
    expect(c.data1[1]).toBeCloseTo(0.5, 7);
    expect(c.data1[2]).toBeCloseTo(0.001, 7);
    expect(c.data1[4]).toBeCloseTo(1, 7);
    expect(c.data1[5]).toBeCloseTo(5, 7);
  });
  it('nan and inf are no numbers', () => {
    expect(whyOf('LUT_1D_SIZE 2\n0 nan 0\n1 1 1').why).toBe('expected three numbers');
    expect(whyOf('LUT_1D_SIZE 2\n0 inf 0\n1 1 1').line).toBe(2);
    expect(whyOf('LUT_1D_SIZE 2\n0 1e999 0\n1 1 1').line).toBe(2);
    expect(whyOf('LUT_1D_SIZE 2\n0 1x 0\n1 1 1').line).toBe(2);
    expect(whyOf('LUT_1D_SIZE 2\n0 1 0 1\n1 1 1').line).toBe(2);
    expect(whyOf('LUT_1D_SIZE 2\n0 1\n1 1 1').line).toBe(2);
  });
  it('red fastest', () => {
    const rows: string[] = [];
    for (let b = 0; b < 3; b++) for (let g = 0; g < 3; g++) for (let r = 0; r < 3; r++) rows.push(`${r} ${g * 10} ${b * 100}`);
    const c = parseCube(`LUT_3D_SIZE 3\n${rows.join('\n')}`);
    // the point r=2, g=1, b=2 is row 2 + 3 * (1 + 3 * 2)
    const o = (2 + 3 * (1 + 3 * 2)) * 3;
    expect(Array.from(c.data3.slice(o, o + 3))).toEqual([2, 10, 200]);
    expect(Array.from(c.data3.slice(3, 6))).toEqual([1, 0, 0]);
  });
  it('the line of a bad row', () => {
    const e = whyOf('# hi\nLUT_3D_SIZE 2\n0 0 0\n1 0 zero\n');
    expect(e.line).toBe(4);
    expect(e.message).toBe('line 4: expected three numbers');
    expect(whyOf('LUT_3D_SIZE 2\n0 0 0\nTITLE late\n').message).toBe('line 3: text between the rows of numbers');
  });
  it('size over 65 or under 2', () => {
    expect(whyOf('LUT_3D_SIZE 129\n').message).toBe('line 1: LUT_3D_SIZE has to be 2 to 65 (this file says 129)');
    expect(whyOf('LUT_3D_SIZE 1\n').why).toContain('2 to 65');
    expect(whyOf('LUT_3D_SIZE 2.5\n').why).toContain('this file says 2.5');
    expect(whyOf('LUT_3D_SIZE\n').why).toContain('this file says nothing');
    expect(whyOf('LUT_1D_SIZE 70000\n').why).toContain('LUT_1D_SIZE has to be 2 to 65536');
    expect(whyOf('LUT_1D_SIZE 1\n').why).toContain('2 to 65536');
  });
  it('wrong row count names both', () => {
    const three = whyOf(`LUT_3D_SIZE 2\n${identity3(2).split('\n').slice(0, 7).join('\n')}`);
    expect(three.line).toBe(0);
    expect(three.message).toBe('the file has 7 rows of numbers, a 2 point lut has 8');
    expect(whyOf('LUT_1D_SIZE 4\n0 0 0\n1 1 1').message).toBe('the file has 2 rows of numbers, a 4 point 1d lut has 4');
    expect(whyOf('LUT_1D_SIZE 2\nLUT_3D_SIZE 2\n0 0 0\n1 1 1').message).toBe('the file has 2 rows of numbers, a 2 point 1d lut plus a 2 point lut has 10');
    expect(whyOf(`LUT_3D_SIZE 2\n${identity3(2)}\n0 0 0`).message).toBe('the file has 9 rows of numbers, a 2 point lut has 8');
  });
  it('max not above min', () => {
    expect(whyOf(`LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 0 1\n${identity3(2)}`).message).toBe('DOMAIN_MAX has to be above DOMAIN_MIN');
    expect(whyOf('DOMAIN_MIN 0 0\n').message).toBe('line 1: expected three numbers');
    expect(whyOf('LUT_1D_INPUT_RANGE 1\n').message).toBe('line 1: expected two numbers');
    expect(whyOf('LUT_3D_INPUT_RANGE 2 1\n').message).toBe('line 1: LUT_3D_INPUT_RANGE needs the second number above the first');
  });
  it('no size', () => {
    expect(whyOf('TITLE "x"\n0 0 0\n').message).toBe('no LUT_3D_SIZE or LUT_1D_SIZE line: this is not a .cube lut');
    expect(whyOf('hello there').line).toBe(0);
    expect(whyOf('').why).toContain('not a .cube lut');
  });
  it('unknown keywords skipped', () => {
    const c = parseCube(`LUT_IN_VIDEO_RANGE 16 235\nsomething else\nLUT_3D_SIZE 2\n${identity3(2)}`);
    expect(c.size3).toBe(2);
    expect(c.title).toBe('');
  });
  it('identity marked', () => {
    expect(parseCube(`LUT_3D_SIZE 5\n${identity3(5)}`).identity).toBe(true);
    expect(parseCube('LUT_1D_SIZE 3\n0 0 0\n0.5 0.5 0.5\n1 1 1').identity).toBe(true);
    expect(parseCube(`LUT_3D_SIZE 2\n${identity3(2).replace('1 1 1', '0.9 1 1')}`).identity).toBe(false);
    expect(parseCube(`LUT_3D_SIZE 2\nDOMAIN_MAX 2 2 2\n${identity3(2)}`).identity).toBe(false);
    expect(parseCube('LUT_1D_SIZE 3\n0 0 0\n0.4 0.5 0.5\n1 1 1').identity).toBe(false);
  });
  it('a 65 point lut parses fast', () => {
    const text = `LUT_3D_SIZE 65\n${identity3(65)}`;
    const t0 = performance.now();
    const c = parseCube(text);
    expect(c.data3.length).toBe(65 * 65 * 65 * 3);
    expect(c.identity).toBe(true);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe('writeCube', () => {
  it('write then read within 5e-7', () => {
    const sample = (r: number, g: number, b: number): [number, number, number] => [r * 0.9, Math.sqrt(g), (b + r) / 2];
    const text = writeCube({ title: 'round', size: 5, sample });
    const c = parseCube(text);
    expect(c.title).toBe('round');
    expect(c.size3).toBe(5);
    for (let b = 0; b < 5; b++) {
      for (let g = 0; g < 5; g++) {
        for (let r = 0; r < 5; r++) {
          const want = sample(r / 4, g / 4, b / 4);
          const o = (r + 5 * (g + 5 * b)) * 3;
          for (let k = 0; k < 3; k++) expect(Math.abs(c.data3[o + k]! - want[k]!)).toBeLessThanOrEqual(5e-7 + 1e-7);
        }
      }
    }
  });
  it('the writer header', () => {
    const text = writeCube({ title: 'a "b"\nc', size: 2, comments: ['made with ncut', 'two\r\nlines'], sample: (r, g, b) => [r, g, b] });
    const lines = text.split('\n');
    expect(lines.slice(0, 6)).toEqual(['TITLE "a b c"', '# made with ncut', '# two lines', 'LUT_3D_SIZE 2', 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1']);
    expect(lines[6]).toBe('0.000000 0.000000 0.000000');
    expect(lines[7]).toBe('1.000000 0.000000 0.000000');
    expect(text.endsWith('1.000000 1.000000 1.000000\n')).toBe(true);
    expect(lines.length).toBe(6 + 8 + 1);
  });
  it('clamps, and a value that is not finite writes 0', () => {
    const text = writeCube({ title: '', size: 2, sample: () => [-3, 7, NaN] });
    expect(text.split('\n')[6]).toBe('0.000000 1.000000 0.000000');
    expect(parseCube(writeCube({ title: '', size: 2, sample: () => [Infinity, 0, 0] })).size3).toBe(2);
  });
  it('sample once per row in order', () => {
    const calls: number[][] = [];
    writeCube({ title: '', size: 3, sample: (r, g, b) => (calls.push([r, g, b]), [r, g, b]) });
    expect(calls.length).toBe(27);
    expect(calls[0]).toEqual([0, 0, 0]);
    expect(calls[1]).toEqual([0.5, 0, 0]);
    expect(calls[3]).toEqual([0, 0.5, 0]);
    expect(calls[9]).toEqual([0, 0, 0.5]);
    expect(calls[26]).toEqual([1, 1, 1]);
  });
  it('a size that is no whole number 2 to 65 is refused', () => {
    const s = (r: number, g: number, b: number): [number, number, number] => [r, g, b];
    expect(() => writeCube({ title: '', size: 1, sample: s })).toThrow(RangeError);
    expect(() => writeCube({ title: '', size: 66, sample: s })).toThrow(RangeError);
    expect(() => writeCube({ title: '', size: 2.5, sample: s })).toThrow(RangeError);
  });
});
