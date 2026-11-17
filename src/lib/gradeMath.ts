/**
 * the math of the color grade that the engine, the wheels and the curves share: rec 709 luma and chroma, the hue circle,
 * the wheel pucks and the monotone curve. pure, imports only gradeData and types.
 */
import type { GradePoint } from '../types';
import { isHueKind, isToneKind, normalizeCurve } from './gradeData';
import type { CurveKind } from './gradeData';

/** rec 709, kept here on purpose (the scopes have their own) */
export const KR = 0.2126;
export const KG = 0.7152;
export const KB = 0.0722;
export const CB_DIV = 1.8556;
export const CR_DIV = 1.5748;
/** a puck at the rim of the wheel is this much chroma */
export const PUCK_K = 0.25;
export const TAU = Math.PI * 2;

export type Rgb3 = [number, number, number];

const fract = (x: number): number => x - Math.floor(x);
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export const lumaOf = (r: number, g: number, b: number): number => KR * r + KG * g + KB * b;

/** [cb, cr] */
export function cbcrOf(r: number, g: number, b: number): [number, number] {
  const y = lumaOf(r, g, b);
  return [(b - y) / CB_DIV, (r - y) / CR_DIV];
}

/** the angle of pure red on the chroma plane (about 102.906 degrees) */
export const HUE_RED = Math.atan2(0.5, -KR / CB_DIV);

/** 0 is red, 0.1996 yellow, 0.3522 green, 0.5 cyan, 0.6996 blue, 0.8522 magenta. -1 for gray */
export function hueOf(r: number, g: number, b: number): number {
  const [cb, cr] = cbcrOf(r, g, b);
  if (cb * cb + cr * cr <= 1e-10) return -1;
  return fract((Math.atan2(cr, cb) - HUE_RED) / TAU);
}

export const HUE_SWATCHES: readonly { name: string; h: number }[] = [
  { name: 'red', h: hueOf(1, 0, 0) },
  { name: 'yellow', h: hueOf(1, 1, 0) },
  { name: 'green', h: hueOf(0, 1, 0) },
  { name: 'cyan', h: hueOf(0, 1, 1) },
  { name: 'blue', h: hueOf(0, 0, 1) },
  { name: 'magenta', h: hueOf(1, 0, 1) },
];

/** the full color of a hue, scaled to 0..1 */
export function hueColor(h: number): Rgb3 {
  const a = HUE_RED + h * TAU;
  const cb = Math.cos(a);
  const cr = Math.sin(a);
  const r = CR_DIV * cr;
  const b = CB_DIV * cb;
  const g = -(KR * r + KB * b) / KG;
  const lo = Math.min(r, g, b);
  const hi = Math.max(r, g, b);
  return [(r - lo) / (hi - lo), (g - lo) / (hi - lo), (b - lo) / (hi - lo)];
}

/** where a color sits on a wheel: the chroma over PUCK_K, put on the rim when it is past it */
export function puckOf(rgb: Rgb3): { x: number; y: number; beyond: boolean } {
  const [cb, cr] = cbcrOf(rgb[0], rgb[1], rgb[2]);
  let x = cb / PUCK_K;
  let y = cr / PUCK_K;
  const len = Math.hypot(x, y);
  const beyond = len > 1;
  if (beyond) {
    x /= len;
    y /= len;
  }
  return { x, y, beyond };
}

/** the color of a puck at (x, y) with the luma part kept */
export function rgbFromPuck(x: number, y: number, keep: number): Rgb3 {
  const len = Math.hypot(x, y);
  if (len > 1) {
    x /= len;
    y /= len;
  }
  const cb = PUCK_K * x;
  const cr = PUCK_K * y;
  const r = keep + CR_DIV * cr;
  const b = keep + CB_DIV * cb;
  const g = (keep - KR * r - KB * b) / KG;
  const out = (v: number): number => Math.round(Math.min(1, Math.max(-1, v)) * 1e4) / 1e4;
  return [out(r), out(g), out(b)];
}

function endSlope(s0: number, s1: number, h0: number, h1: number): number {
  const p = s0 * (1 + h0 / (h0 + h1)) - (s1 * h0) / (h0 + h1);
  if (p * s0 <= 0) return 0;
  return Math.abs(p) > 2 * Math.abs(s0) ? 2 * s0 : p;
}

/** steffen 1990: monotone cubic hermite through every point, never past a local extreme */
export function steffen(xs: readonly number[], ys: readonly number[]): (x: number) => number {
  const n = xs.length;
  if (n === 1) {
    const c = ys[0]!;
    return () => c;
  }
  const h: number[] = [];
  const s: number[] = [];
  for (let k = 0; k < n - 1; k++) {
    h.push(xs[k + 1]! - xs[k]!);
    s.push((ys[k + 1]! - ys[k]!) / h[k]!);
  }
  const m = new Array<number>(n);
  if (n === 2) {
    m[0] = s[0]!;
    m[1] = s[0]!;
  } else {
    for (let k = 1; k < n - 1; k++) {
      const p = (s[k - 1]! * h[k]! + s[k]! * h[k - 1]!) / (h[k - 1]! + h[k]!);
      m[k] = (Math.sign(s[k - 1]!) + Math.sign(s[k]!)) * Math.min(Math.abs(s[k - 1]!), Math.abs(s[k]!), 0.5 * Math.abs(p));
    }
    m[0] = endSlope(s[0]!, s[1]!, h[0]!, h[1]!);
    m[n - 1] = endSlope(s[n - 2]!, s[n - 3]!, h[n - 2]!, h[n - 3]!);
  }
  return (x) => {
    if (x <= xs[0]!) return ys[0]!;
    if (x >= xs[n - 1]!) return ys[n - 1]!;
    let k = 0;
    while (k < n - 2 && x > xs[k + 1]!) k++;
    const t = (x - xs[k]!) / h[k]!;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[k]! + (t3 - 2 * t2 + t) * h[k]! * m[k]! + (-2 * t3 + 3 * t2) * ys[k + 1]! + (t3 - t2) * h[k]! * m[k + 1]!
    );
  };
}

/** the curve of a list as a function, over what normalizeCurve keeps. every result is 0..1 */
export function curveSampler(kind: CurveKind, pts: readonly GradePoint[] | null | undefined): (x: number) => number {
  const list = normalizeCurve(kind, pts);
  const tone = isToneKind(kind);
  if (!list) return tone ? (x) => clamp01(x) : () => 0.5;
  if (list.length === 1) {
    const c = clamp01(list[0]![1]);
    return () => c;
  }
  if (isHueKind(kind)) {
    const xs = [...list.map((p) => p[0] - 1), ...list.map((p) => p[0]), ...list.map((p) => p[0] + 1)];
    const ys = [...list.map((p) => p[1]), ...list.map((p) => p[1]), ...list.map((p) => p[1])];
    const f = steffen(xs, ys);
    return (x) => clamp01(f(fract(x)));
  }
  const f = steffen(
    list.map((p) => p[0]),
    list.map((p) => p[1]),
  );
  return (x) => clamp01(f(clamp01(x)));
}
