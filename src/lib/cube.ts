/**
 * .cube luts (adobe / resolve): the types the renderers hold, and the reader and writer.
 */
import type { Rgb3 } from './gradeMath';

export const CUBE_MAX_3D = 65;
export const CUBE_MAX_1D = 65536;
export const CUBE_MAX_BYTES = 64 * 1024 * 1024;

export interface CubeLut {
  title: string; // '' when none
  size3: number; // 0 = no 3d table
  data3: Float32Array; // size3^3 * 3, red fastest, then green, then blue
  min3: Rgb3;
  max3: Rgb3;
  size1: number; // 0 = no 1d table
  data1: Float32Array; // size1 * 3
  min1: Rgb3;
  max1: Rgb3;
  /** every point maps to itself within 1e-6 on a 0..1 domain: drawing it changes nothing */
  identity: boolean;
}

/** a table as the renderers hold it. key = the media id (a media's file never changes) */
export interface LutTable extends CubeLut { key: string }

/** message: 'line 12: why', and with line 0 the why alone */
export class CubeError extends Error {
  constructor(readonly line: number, readonly why: string) {
    super(line > 0 ? `line ${line}: ${why}` : why);
    this.name = 'CubeError';
  }
}

const POW10 = [1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22];

// where the last number read stopped. a module scratch: no allocation per row, the reader never re-enters itself
let numEnd = 0;

function isBlank(c: number): boolean {
  return c === 32 || c === 9 || c === 13;
}

function isLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** one number at i (sign, digits, dot, exponent), NaN when there is none, it is not finite or a letter follows it. sets numEnd. no regex */
function readNumber(text: string, i: number, end: number): number {
  let p = i;
  let neg = false;
  let c = p < end ? text.charCodeAt(p) : 0;
  if (c === 43 || c === 45) {
    neg = c === 45;
    p++;
  }
  let mant = 0;
  let digits = 0;
  let kept = 0;
  let exp10 = 0;
  while (p < end) {
    c = text.charCodeAt(p);
    if (c < 48 || c > 57) break;
    if (kept < 18) {
      mant = mant * 10 + (c - 48);
      if (mant !== 0) kept++;
    } else exp10++;
    digits++;
    p++;
  }
  if (p < end && text.charCodeAt(p) === 46) {
    p++;
    while (p < end) {
      c = text.charCodeAt(p);
      if (c < 48 || c > 57) break;
      if (kept < 18) {
        mant = mant * 10 + (c - 48);
        if (mant !== 0) kept++;
        exp10--;
      }
      digits++;
      p++;
    }
  }
  if (digits === 0) return NaN;
  if (p < end) {
    c = text.charCodeAt(p);
    if (c === 101 || c === 69) {
      p++;
      let eneg = false;
      c = p < end ? text.charCodeAt(p) : 0;
      if (c === 43 || c === 45) {
        eneg = c === 45;
        p++;
      }
      let e = 0;
      let edigits = 0;
      while (p < end) {
        c = text.charCodeAt(p);
        if (c < 48 || c > 57) break;
        if (e < 100000) e = e * 10 + (c - 48);
        edigits++;
        p++;
      }
      if (edigits === 0) return NaN;
      exp10 += eneg ? -e : e;
    }
  }
  if (p < end) {
    c = text.charCodeAt(p);
    if (!isBlank(c) && c !== 35) return NaN;
  }
  numEnd = p;
  let v = mant;
  if (exp10 < 0) v = -exp10 <= 22 ? v / POW10[-exp10]! : v / Math.pow(10, -exp10);
  else if (exp10 > 0) v = exp10 <= 22 ? v * POW10[exp10]! : v * Math.pow(10, exp10);
  if (!Number.isFinite(v)) return NaN;
  return neg ? -v : v;
}

/** from i to the end of the line or a '#': every number into out. false on anything else */
function readNumbers(text: string, i: number, end: number, out: number[]): boolean {
  let p = i;
  for (;;) {
    while (p < end && isBlank(text.charCodeAt(p))) p++;
    if (p >= end || text.charCodeAt(p) === 35) return true;
    const v = readNumber(text, p, end);
    if (Number.isNaN(v)) return false;
    out.push(v);
    p = numEnd;
  }
}

/** the text of a keyword line after the word, without a comment, for the messages */
function restOf(text: string, from: number, end: number): string {
  let q = end;
  const h = text.indexOf('#', from);
  if (h >= 0 && h < q) q = h;
  return text.slice(from, q).trim();
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-6;
}

export function parseCube(text: string): CubeLut {
  let title = '';
  let size3 = 0;
  let size1 = 0;
  let domMin: Rgb3 | null = null;
  let domMax: Rgb3 | null = null;
  let range1: [number, number] | null = null;
  let range3: [number, number] | null = null;
  let data: Float32Array | null = null;
  let rows = 0;
  let line = 0;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const nums: number[] = [];
  const total = text.length;
  while (pos <= total) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = total;
    const lineStart = pos;
    pos = end + 1;
    line++;
    let p = lineStart;
    while (p < end && isBlank(text.charCodeAt(p))) p++;
    if (p >= end) continue;
    const c = text.charCodeAt(p);
    if (c === 35) continue;
    if (isLetter(c)) {
      if (rows > 0) throw new CubeError(line, 'text between the rows of numbers');
      let q = p;
      while (q < end) {
        const d = text.charCodeAt(q);
        if (isBlank(d) || d === 35) break;
        q++;
      }
      const word = text.slice(p, q);
      if (word === 'TITLE') {
        let a = q;
        while (a < end && isBlank(text.charCodeAt(a))) a++;
        if (a < end && text.charCodeAt(a) === 34) {
          const close = text.indexOf('"', a + 1);
          title = text.slice(a + 1, close >= 0 && close < end ? close : end).trim();
        } else title = restOf(text, a, end);
      } else if (word === 'LUT_3D_SIZE' || word === 'LUT_1D_SIZE') {
        const is3 = word === 'LUT_3D_SIZE';
        const max = is3 ? CUBE_MAX_3D : CUBE_MAX_1D;
        let a = q;
        while (a < end && isBlank(text.charCodeAt(a))) a++;
        const n = a < end ? readNumber(text, a, end) : NaN;
        if (!Number.isInteger(n) || n < 2 || n > max) throw new CubeError(line, `${word} has to be 2 to ${max} (this file says ${restOf(text, q, end) || 'nothing'})`);
        if (is3) size3 = n;
        else size1 = n;
      } else if (word === 'DOMAIN_MIN' || word === 'DOMAIN_MAX') {
        nums.length = 0;
        if (!readNumbers(text, q, end, nums) || nums.length !== 3) throw new CubeError(line, 'expected three numbers');
        const v: Rgb3 = [nums[0]!, nums[1]!, nums[2]!];
        if (word === 'DOMAIN_MIN') domMin = v;
        else domMax = v;
      } else if (word === 'LUT_1D_INPUT_RANGE' || word === 'LUT_3D_INPUT_RANGE') {
        nums.length = 0;
        if (!readNumbers(text, q, end, nums) || nums.length !== 2) throw new CubeError(line, 'expected two numbers');
        if (!(nums[1]! > nums[0]!)) throw new CubeError(line, `${word} needs the second number above the first`);
        const r: [number, number] = [nums[0]!, nums[1]!];
        if (word === 'LUT_1D_INPUT_RANGE') range1 = r;
        else range3 = r;
      }
      continue;
    }
    // a row of numbers: exactly three
    if (rows === 0 && size3 + size1 > 0) data = new Float32Array((size1 + size3 * size3 * size3) * 3);
    for (let k = 0; k < 3; k++) {
      while (p < end && isBlank(text.charCodeAt(p))) p++;
      const v = p < end ? readNumber(text, p, end) : NaN;
      if (Number.isNaN(v)) throw new CubeError(line, 'expected three numbers');
      if (data && rows * 3 + k < data.length) data[rows * 3 + k] = v;
      p = numEnd;
    }
    while (p < end && isBlank(text.charCodeAt(p))) p++;
    if (p < end && text.charCodeAt(p) !== 35) throw new CubeError(line, 'expected three numbers');
    rows++;
  }
  if (size3 === 0 && size1 === 0) throw new CubeError(0, 'no LUT_3D_SIZE or LUT_1D_SIZE line: this is not a .cube lut');
  const lo: Rgb3 = domMin ?? [0, 0, 0];
  const hi: Rgb3 = domMax ?? [1, 1, 1];
  for (let a = 0; a < 3; a++) if (!(hi[a]! > lo[a]!)) throw new CubeError(0, 'DOMAIN_MAX has to be above DOMAIN_MIN');
  const expected = size1 + size3 * size3 * size3;
  if (rows !== expected) {
    const what = size1 > 0 && size3 > 0 ? `a ${size1} point 1d lut plus a ${size3} point lut` : size1 > 0 ? `a ${size1} point 1d lut` : `a ${size3} point lut`;
    throw new CubeError(0, `the file has ${rows} rows of numbers, ${what} has ${expected}`);
  }
  const all = data ?? new Float32Array(0);
  const data1 = all.slice(0, size1 * 3);
  const data3 = all.slice(size1 * 3);
  const rangeOf = (r: [number, number] | null, own: boolean, fallback: Rgb3, unit: number): Rgb3 => (!own ? [unit, unit, unit] : r ? [r[unit], r[unit], r[unit]] : [fallback[0], fallback[1], fallback[2]]);
  const min1 = rangeOf(range1, size1 > 0, lo, 0);
  const max1 = rangeOf(range1, size1 > 0, hi, 1);
  const min3 = rangeOf(range3, size3 > 0, lo, 0);
  const max3 = rangeOf(range3, size3 > 0, hi, 1);
  const unit = (m: Rgb3, x: Rgb3): boolean => m.every((v) => v === 0) && x.every((v) => v === 1);
  let identity = unit(min1, max1) && unit(min3, max3);
  for (let i = 0; identity && i < size1; i++) {
    const w = i / (size1 - 1);
    if (!near(data1[i * 3]!, w) || !near(data1[i * 3 + 1]!, w) || !near(data1[i * 3 + 2]!, w)) identity = false;
  }
  for (let b = 0; identity && b < size3; b++) {
    for (let g = 0; identity && g < size3; g++) {
      for (let r = 0; r < size3; r++) {
        const o = (r + size3 * (g + size3 * b)) * 3;
        if (!near(data3[o]!, r / (size3 - 1)) || !near(data3[o + 1]!, g / (size3 - 1)) || !near(data3[o + 2]!, b / (size3 - 1))) {
          identity = false;
          break;
        }
      }
    }
  }
  return { title, size3, data3, min3, max3, size1, data1, min1, max1, identity };
}

function clean(text: string): string {
  return text.replace(/"/g, '').replace(/\r\n|\r|\n/g, ' ');
}

function value(v: number): string {
  if (!Number.isFinite(v)) return '0.000000';
  return (v < 0 ? 0 : v > 1 ? 1 : v).toFixed(6);
}

export function writeCube(o: { title: string; size: number; comments?: readonly string[]; sample(r: number, g: number, b: number): Rgb3 }): string {
  const n = o.size;
  if (!Number.isInteger(n) || n < 2 || n > CUBE_MAX_3D) throw new RangeError(`a lut has 2 to ${CUBE_MAX_3D} points, not ${n}`);
  const out: string[] = [`TITLE "${clean(o.title)}"`];
  for (const c of o.comments ?? []) out.push(`# ${clean(c)}`);
  out.push(`LUT_3D_SIZE ${n}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1');
  const d = n - 1;
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const c = o.sample(r / d, g / d, b / d);
        out.push(`${value(c[0])} ${value(c[1])} ${value(c[2])}`);
      }
    }
  }
  return out.join('\n') + '\n';
}
