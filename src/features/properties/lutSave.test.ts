import { describe, expect, it } from 'vitest';
import { adjustColor } from '../../engine/clipLook';
import { gradeData, gradeLutColor } from '../../engine/grade';
import { withLuts } from '../../engine/lutScope';
import type { LutLookup } from '../../engine/lutScope';
import { parseCube } from '../../lib/cube';
import type { LutTable } from '../../lib/cube';
import { createShapeClip, createTextClip } from '../../lib/factory';
import type { Rgb3 } from '../../lib/gradeMath';
import type { Clip, ClipAdjust, ClipGrade } from '../../types';
import { cubeFileName, cubeOfClip } from './lutSave';

const noLuts: LutLookup = () => null;
const TOL = 6e-7;
const key = (t: number, v: number) => ({ t, v, ease: 'linear' as const });

/** a 3d table made by hand: the function of the lattice color, red fastest */
function table3(n: number, f: (c: Rgb3) => Rgb3): LutTable {
  const data3 = new Float32Array(n * n * n * 3);
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) data3.set(f([r / (n - 1), g / (n - 1), b / (n - 1)]), ((b * n + g) * n + r) * 3);
    }
  }
  return { title: '', size3: n, data3, min3: [0, 0, 0], max3: [1, 1, 1], size1: 0, data1: new Float32Array(0), min1: [0, 0, 0], max1: [1, 1, 1], identity: false, key: 'film' };
}
const film = (c: Rgb3): Rgb3 => [c[0] ** 0.8, 0.95 * c[1] + 0.03, c[2] ** 1.2];
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** the file read back: its lattice colors and what is in each row */
function rowsOf(text: string): { n: number; at(r: number, g: number, b: number): Rgb3 } {
  const cube = parseCube(text);
  return {
    n: cube.size3,
    at: (r, g, b) => {
      const i = ((b * cube.size3 + g) * cube.size3 + r) * 3;
      return [cube.data3[i]!, cube.data3[i + 1]!, cube.data3[i + 2]!];
    },
  };
}

const near = (a: Rgb3, b: Rgb3, tol = TOL): void => a.forEach((v, i) => expect(Math.abs(v - b[i]!)).toBeLessThanOrEqual(tol));

const shape = (over: Partial<Clip> = {}): Clip => createShapeClip('t1', 0, { id: 'a', duration: 5, ...over } as never);

describe('cubeOfClip', () => {
  it('33 cubed rows red fastest', () => {
    const clip = shape({ grade: { gainR: 0.4 } } as never);
    const { text } = cubeOfClip(clip, 1, noLuts);
    const rows = rowsOf(text);
    expect(rows.n).toBe(33);
    expect(parseCube(text).data3.length).toBe(33 * 33 * 33 * 3);
    const d = gradeData({ gainR: 0.4 })!;
    for (const [r, g, b] of [[0, 0, 0], [32, 0, 0], [0, 32, 0], [0, 0, 32], [5, 17, 29], [32, 32, 32], [31, 2, 9]] as const) {
      const c: Rgb3 = [r / 32, g / 32, b / 32];
      const want = gradeLutColor(c, d).map(clamp01) as Rgb3;
      near(rows.at(r, g, b), want);
      // gain on red only: green and blue are the lattice point itself
      expect(Math.abs(rows.at(r, g, b)[1] - c[1])).toBeLessThanOrEqual(TOL);
      expect(Math.abs(rows.at(r, g, b)[2] - c[2])).toBeLessThanOrEqual(TOL);
    }
    // red moves with the first index, not the last
    expect(rows.at(32, 0, 0)[0]).not.toBeCloseTo(rows.at(0, 0, 32)[0], 3);
  });

  it('no color saves an identity', () => {
    const { text, lutLeftOut } = cubeOfClip(shape(), 1, noLuts);
    expect(lutLeftOut).toBe(false);
    expect(parseCube(text).identity).toBe(true);
    // a grade switched on with nothing in it is the same
    expect(parseCube(cubeOfClip(shape({ grade: { liftY: 0 } } as never), 1, noLuts).text).identity).toBe(true);
  });

  it('adjust, grade, lut in that order', () => {
    const adjust: ClipAdjust = { brightness: 0.1, contrast: 0.2, saturation: -0.3, hue: 20, temperature: 0.1 };
    const grade: ClipGrade = { liftY: 0.05, gainR: 0.2, lut: { media: 'film', last: true } };
    const table = table3(9, film);
    const lookup: LutLookup = (id) => (id === 'film' ? table : null);
    const { text } = cubeOfClip(shape({ adjust, grade } as never), 1, lookup, 17);
    const rows = rowsOf(text);
    expect(rows.n).toBe(17);
    const d = withLuts(lookup, () => gradeData(grade))!;
    expect(d.lut).toBeDefined();
    let differs = 0;
    for (const [r, g, b] of [[0, 0, 0], [16, 16, 16], [3, 9, 14], [12, 4, 7], [16, 0, 8], [8, 8, 0]] as const) {
      const c: Rgb3 = [r / 16, g / 16, b / 16];
      const want = gradeLutColor(adjustColor(c, adjust), d).map(clamp01) as Rgb3;
      near(rows.at(r, g, b), want);
      // the other order (grade, then adjust) is another picture
      const other = adjustColor(gradeLutColor(c, d), adjust).map(clamp01) as Rgb3;
      if (Math.abs(other[0] - want[0]) + Math.abs(other[1] - want[1]) + Math.abs(other[2] - want[2]) > 1e-3) differs++;
    }
    expect(differs).toBeGreaterThan(0);
    // first, the lut gives another picture than last
    const first = cubeOfClip(shape({ adjust, grade: { ...grade, lut: { media: 'film' } } } as never), 1, lookup, 17).text;
    expect(first).not.toBe(text);
  });

  it('keys resolve at the time', () => {
    const keyed = shape({ keyframes: { 'grade.gainR': [key(0, 0), key(4, 0.5)] }, grade: { liftY: 0.05 } } as never);
    const at0 = cubeOfClip(keyed, 0, noLuts, 9).text;
    const at4 = cubeOfClip(keyed, 4, noLuts, 9).text;
    expect(at0).not.toBe(at4);
    // at 4 it is the grade with gain 0.5 (the keys are the only change)
    const still = cubeOfClip(shape({ grade: { liftY: 0.05, gainR: 0.5 } } as never), 4, noLuts, 9).text;
    expect(at4).toBe(still);
    // the time is held inside the clip
    expect(cubeOfClip(keyed, 99, noLuts, 9).text).toBe(cubeOfClip(keyed, 5, noLuts, 9).text);
    expect(cubeOfClip(keyed, -3, noLuts, 9).text).toBe(at0);
  });

  it('a lut that cannot be read is left out', () => {
    const grade: ClipGrade = { liftY: 0.1, lut: { media: 'film' } };
    const out = cubeOfClip(shape({ grade } as never), 1, noLuts, 9);
    expect(out.lutLeftOut).toBe(true);
    // the rest of the grade is in the file
    const bare = cubeOfClip(shape({ grade: { liftY: 0.1 } } as never), 1, noLuts, 9);
    expect(out.text.split('\n').slice(1).join('\n')).toBe(bare.text.split('\n').slice(1).join('\n'));
    // a lut at mix 0 shows nothing: nothing was left out
    expect(cubeOfClip(shape({ grade: { liftY: 0.1, lut: { media: 'film', mix: 0 } } } as never), 1, noLuts, 9).lutLeftOut).toBe(false);
    // a table that is there
    expect(cubeOfClip(shape({ grade } as never), 1, () => table3(5, film), 9).lutLeftOut).toBe(false);
  });
});

describe('file names and titles', () => {
  it('safe file name', () => {
    expect(cubeFileName('film')).toBe('film grade.cube');
    expect(cubeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j grade.cube');
    expect(cubeFileName('   ')).toBe('grade.cube');
    expect(cubeFileName('')).toBe('grade.cube');
    expect(cubeFileName('  spaced  ')).toBe('spaced grade.cube');
    const long = cubeFileName('x'.repeat(200));
    expect(long).toBe(`${'x'.repeat(80)} grade.cube`);
    // the cut can leave a space at its end: trimmed again
    expect(cubeFileName(`${'y'.repeat(79)} z`)).toBe(`${'y'.repeat(79)} grade.cube`);
  });

  it('title without quotes', () => {
    const clip = createTextClip('t1', 0, { id: 't', text: 'say "hi"', duration: 5, grade: { liftY: 0.1 } });
    const out = cubeOfClip(clip, 1, noLuts, 3);
    expect(out.text.split('\n')[0]).toBe('TITLE "say hi grade"');
    expect(parseCube(out.text).title).toBe('say hi grade');
    expect(out.name).toBe('say -hi- grade.cube');
    expect(out.text).toContain('# made with ncut');
  });
});
