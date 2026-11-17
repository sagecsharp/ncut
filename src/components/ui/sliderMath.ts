/* the pure rules of SliderField: the fill, the drag, the arrows, typed text. no react, no dom. */

const THRESHOLD_MOUSE = 3;
const THRESHOLD_TOUCH = 8;
/** a field narrower than this drags as if it were this wide (pairs, the field next to a select) */
export const MIN_TRAVEL = 120;
/** a field with no face and no perPx moves one step per JOG_PX pixels */
export const JOG_PX = 4;
/** shift: this much of the normal speed */
const FINE = 0.1;
export const DOUBLE_CLICK_MS = 500;
export const DOUBLE_CLICK_PX = 4;

export type Span = readonly [number, number];

/** everything the maths needs about one field, in shown units */
export interface SliderSpec {
  /** hard limits. -Infinity / Infinity = none */
  min: number;
  max: number;
  /** the face. null = no face (a jog field) */
  soft: Span | null;
  /** > 0. arrows move by it, a drag rounds to it */
  step: number;
  /** decimals the field shows */
  precision: number;
  /** ctrl grid, a whole multiple of step */
  snap: number;
  /** value per pixel of a field without a face */
  perPx: number;
  /** where the fill starts. null = 0 when 0 is inside the face, else the face's low end */
  origin: number | null;
}

/** the fill, all 0..1 of the field width. null = draw no fill */
export interface Face {
  a: number;
  b: number;
  v: number;
  pin: 'over' | 'under' | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function faceOf(value: number, soft: Span | null, origin: number | null): Face | null {
  if (!soft || !Number.isFinite(value)) return null;
  const [lo, hi] = soft;
  const span = hi - lo;
  if (!(span > 0)) return null;
  const o0 = origin ?? (lo <= 0 && 0 <= hi ? 0 : lo);
  const o = clamp(o0, lo, hi);
  const pv = clamp(value, lo, hi);
  const eps = 1e-9 * span;
  const pin = value > hi + eps ? 'over' : value < lo - eps ? 'under' : null;
  const at = (n: number) => (n - lo) / span;
  return { a: at(Math.min(o, pv)), b: at(Math.max(o, pv)), v: at(pv), pin };
}

/** decimals needed to write a step: 1 -> 0, 0.1 -> 1, 0.05 -> 2, 0.25 -> 2, 0.001 -> 3, 2 -> 0. at most 6 */
export function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  for (let d = 0; d < 6; d++) {
    const s = step * 10 ** d;
    if (Math.abs(s - Math.round(s)) < 1e-9 * Math.max(1, s)) return d;
  }
  return 6;
}

/** v on a grid through 0, written with `decimals` decimals (no 0.30000000000000004), never -0 */
export function roundTo(v: number, grid: number, decimals: number): number {
  const g = grid > 0 ? grid : 1;
  const n = Number((Math.round(v / g) * g).toFixed(Math.max(0, Math.min(10, decimals))));
  return n === 0 ? 0 : n;
}

/** the finest grid a shift drag lands on: min(step, 10^-precision) */
function fineGrid(spec: SliderSpec): number {
  return Math.min(spec.step, 10 ** -spec.precision);
}

/** value per pixel: face span / max(width, MIN_TRAVEL), or spec.perPx without a face */
export function rateOf(spec: SliderSpec, widthPx: number): number {
  if (!spec.soft) return spec.perPx;
  return (spec.soft[1] - spec.soft[0]) / Math.max(widthPx, MIN_TRAVEL);
}

export function clampHard(v: number, spec: SliderSpec): number {
  return clamp(v, spec.min, spec.max);
}

export interface DragState {
  anchorX: number;
  /** raw (unrounded) value at anchorX */
  anchorV: number;
  lastX: number;
  lastRaw: number;
  /** the rounded value this drag shows / wrote last */
  out: number;
  fine: boolean;
  snap: boolean;
  /** hard limits for this drag: spec.min / max widened to the start value */
  lo: number;
  hi: number;
  rate: number;
}

/** called when the press passes the threshold, at that pointer x. out = v0 (no jump) */
export function beginDrag(v0: number, x: number, spec: SliderSpec, widthPx: number, fine: boolean, snap: boolean): DragState {
  return {
    anchorX: x,
    anchorV: v0,
    lastX: x,
    lastRaw: v0,
    out: v0,
    fine,
    snap,
    lo: Math.min(spec.min, v0),
    hi: Math.max(spec.max, v0),
    rate: rateOf(spec, widthPx),
  };
}

/** a pointer move, or a shift / ctrl change at the same x. returns a new state */
export function moveDrag(d: DragState, x: number, fine: boolean, snap: boolean, spec: SliderSpec): DragState {
  let anchorX = d.anchorX;
  let anchorV = d.anchorV;
  if (fine !== d.fine || snap !== d.snap) {
    anchorV = d.lastRaw;
    anchorX = x;
  }
  let raw = anchorV + (x - anchorX) * d.rate * (fine ? FINE : 1);
  if (raw < d.lo) {
    raw = d.lo;
    anchorV = d.lo;
    anchorX = x;
  } else if (raw > d.hi) {
    raw = d.hi;
    anchorV = d.hi;
    anchorX = x;
  }
  const grid = snap ? spec.snap : fine ? fineGrid(spec) : spec.step;
  const out = clamp(roundTo(raw, grid, decimalsOf(grid)), d.lo, d.hi);
  return { ...d, anchorX, anchorV, lastX: x, lastRaw: raw, out, fine, snap };
}

/** the writer kept another value: anchor there, at the current x */
export function keptDrag(d: DragState, kept: number): DragState {
  return { ...d, anchorX: d.lastX, anchorV: kept, lastRaw: kept, out: kept };
}

/** one arrow press: v + dir * step (x10 with big), written with max(decimalsOf(step), precision) decimals, then clampHard */
export function nudge(v: number, dir: 1 | -1, big: boolean, spec: SliderSpec): number {
  const decimals = Math.max(decimalsOf(spec.step), spec.precision);
  const n = Number((v + dir * spec.step * (big ? 10 : 1)).toFixed(Math.min(10, decimals)));
  return clampHard(n === 0 ? 0 : n, spec);
}

const UNIT_TAIL = /\s*(?:px|%|deg|°|sec|s|x|fr|hz|bpm)$/i;

/** typed text -> number. null = ignore it */
export function parseTyped(text: string): number | null {
  const src = text.trim().replace(/,/g, '.').replace(UNIT_TAIL, '');
  let i = 0;
  let bad = false;
  const skip = () => {
    while (i < src.length && src[i] === ' ') i++;
  };
  const number = (): number => {
    const m = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(src.slice(i));
    if (!m) {
      bad = true;
      return 0;
    }
    i += m[0].length;
    return Number(m[0]);
  };
  let factor: () => number = () => 0;
  const term = (): number => {
    let v = factor();
    for (;;) {
      skip();
      const c = src[i];
      if (c === '*') {
        i++;
        v *= factor();
      } else if (c === '/') {
        i++;
        v /= factor();
      } else return v;
    }
  };
  const expr = (): number => {
    let v = term();
    for (;;) {
      skip();
      const c = src[i];
      if (c === '+') {
        i++;
        v += term();
      } else if (c === '-') {
        i++;
        v -= term();
      } else return v;
    }
  };
  factor = (): number => {
    skip();
    const c = src[i];
    if (c === '+') {
      i++;
      return factor();
    }
    if (c === '-') {
      i++;
      return -factor();
    }
    if (c === '(') {
      i++;
      const v = expr();
      skip();
      if (src[i] !== ')') bad = true;
      else i++;
      return v;
    }
    return number();
  };
  const result = expr();
  skip();
  if (bad || i < src.length || !Number.isFinite(result)) return null;
  return result;
}

export function isPastThreshold(dx: number, pointerType: string): boolean {
  return Math.abs(dx) >= (pointerType === 'mouse' ? THRESHOLD_MOUSE : THRESHOLD_TOUCH);
}

/** "100%", "15°", "1x", "15 deg", "10 px", "0.5 s", "8" (no space before %, ° and x) */
export function unitText(valueText: string, unit: string): string {
  if (!unit) return valueText;
  if (unit === '%' || unit === '°' || unit === 'x') return valueText + unit;
  return `${valueText} ${unit}`;
}

/** the gesture line under every field title */
export function gestureHint(snapText: string, restText: string | null): string {
  const base = `drag sideways or click to type. shift: finer. ctrl: steps of ${snapText}`;
  return restText === null ? base : `${base}. double click: back to ${restText}`;
}
