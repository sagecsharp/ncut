/**
 * the pixels a motion-blurred 2d clip can paint, over all the poses of its samples. the blur clears and adds whole
 * canvases per sample; for a clip that covers a small part of the frame only that part is touched. everything outside the
 * rectangle is transparent in every sample, so clearing / adding less leaves the very same pixels.
 * pure maths: a rectangle is [x0, y0, x1, y1] in the clip's local units, placed by (cx, cy, rotation) and the context's
 * own transform, the same way paintFlat places it.
 */

export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** whole device pixels: x, y = the top left corner, w x h the size */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** extra pixels around the bounds: anti-aliased edges and filtering reach under a pixel past the geometry */
export const BLUR_MARGIN = 4;

/**
 * the device pixel bounds of a local rectangle placed like paintFlat does it: translate(cx, cy), rotate(rotation degrees,
 * skipped at 0), under the context's matrix `m` = [a, b, c, d, e, f]. null when anything is not a finite number.
 */
export function deviceBounds(m: readonly number[], cx: number, cy: number, rotation: number, local: Bounds): Bounds | null {
  const rad = rotation ? (rotation * Math.PI) / 180 : 0;
  const cos = rad ? Math.cos(rad) : 1;
  const sin = rad ? Math.sin(rad) : 0;
  const a = m[0]!;
  const b = m[1]!;
  const c = m[2]!;
  const d = m[3]!;
  const e = m[4]!;
  const f = m[5]!;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < 4; i++) {
    const lx = i & 1 ? local.x1 : local.x0;
    const ly = i & 2 ? local.y1 : local.y0;
    const px = lx * cos - ly * sin + cx;
    const py = lx * sin + ly * cos + cy;
    const x = a * px + c * py + e;
    const y = b * px + d * py + f;
    // a corner that is not a number (NaN comparisons are all false: it would just be skipped) means no bounds
    if (!(Number.isFinite(x) && Number.isFinite(y))) return null;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (!(Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(x1) && Number.isFinite(y1))) return null;
  return { x0, y0, x1, y1 };
}

/**
 * the whole-pixel rectangle that holds every bound, grown by `margin` and cut to the canvas (width x height). null when
 * there is nothing to bound, when it is not a proper number, when nothing of it is on the canvas, or when it is the whole
 * canvas anyway (the caller then takes the plain full-canvas path).
 */
export function unionRegion(list: readonly Bounds[], width: number, height: number, margin = BLUR_MARGIN): Region | null {
  if (list.length === 0 || !(width > 0) || !(height > 0)) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of list) {
    if (b.x0 < x0) x0 = b.x0;
    if (b.y0 < y0) y0 = b.y0;
    if (b.x1 > x1) x1 = b.x1;
    if (b.y1 > y1) y1 = b.y1;
  }
  if (!(Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(x1) && Number.isFinite(y1))) return null;
  // outward to whole pixels, then the margin
  const rx0 = Math.max(0, Math.floor(x0) - margin);
  const ry0 = Math.max(0, Math.floor(y0) - margin);
  const rx1 = Math.min(width, Math.ceil(x1) + margin);
  const ry1 = Math.min(height, Math.ceil(y1) + margin);
  if (!(rx1 > rx0 && ry1 > ry0)) return null;
  if (rx0 === 0 && ry0 === 0 && rx1 === width && ry1 === height) return null;
  return { x: rx0, y: ry0, w: rx1 - rx0, h: ry1 - ry0 };
}
