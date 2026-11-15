/**
 * the seam check of six side pictures named with words or numbers (sky.ts guessFaces words): packs differ in which
 * picture is left or right and how the top and bottom are turned. it tries the 32 ways (left and right swapped or
 * not, top turned 0..3, bottom turned 0..3) on SKY_SAMPLE samples and keeps the one whose cube edges match best, when
 * that is clearly better than the names.
 */
import { cubeFace, faceDirection, turnSample } from './sky';

/** a fit must be under this share of the named error ... */
export const FIT_SHARE = 0.7;
/** ... and at least this many levels (0..255) better */
export const FIT_LEVELS = 3;
/** fits within this share of the best count as the best: the one with the fewest changes wins */
export const FIT_CLOSE = 0.05;

export interface SideFit {
  /** swap the right and the left picture */
  swap: boolean;
  /** quarter turns clockwise of the top and the bottom picture */
  top: number;
  bottom: number;
  /** the mean seam difference (0..255) as named and after the fit */
  before: number;
  after: number;
}

// the texel pairs across the cube edges, per face size: [face a, texel a, face b, texel b] flat
const pairMemo = new Map<number, Int32Array>();

function pairsOf(n: number): Int32Array {
  const hit = pairMemo.get(n);
  if (hit) return hit;
  const out = new Int32Array(24 * n * 4);
  let k = 0;
  const put = (f: number, x: number, y: number, s: number, t: number) => {
    const d = faceDirection(f, s, t);
    const c = cubeFace(d[0], d[1], d[2]);
    const gx = Math.min(n - 1, Math.max(0, Math.floor(c.s * n)));
    const gy = Math.min(n - 1, Math.max(0, Math.floor(c.t * n)));
    out[k++] = f;
    out[k++] = y * n + x;
    out[k++] = c.face;
    out[k++] = gy * n + gx;
  };
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i < n; i++) {
      const along = (i + 0.5) / n;
      put(f, 0, i, -0.5 / n, along);
      put(f, n - 1, i, 1 + 0.5 / n, along);
      put(f, i, 0, along, -0.5 / n);
      put(f, i, n - 1, along, 1 + 0.5 / n);
    }
  }
  pairMemo.set(n, out);
  return out;
}

/** the mean color difference (0..255, rgb) across every edge of the cube: each border texel against the texel just past it */
export function seamError(faces: readonly Uint8ClampedArray[], n: number): number {
  const p = pairsOf(n);
  let sum = 0;
  for (let i = 0; i < p.length; i += 4) {
    const a = faces[p[i]!]!;
    const b = faces[p[i + 2]!]!;
    const ia = p[i + 1]! * 4;
    const ib = p[i + 3]! * 4;
    sum += (Math.abs(a[ia]! - b[ib]!) + Math.abs(a[ia + 1]! - b[ib + 1]!) + Math.abs(a[ia + 2]! - b[ib + 2]!)) / 3;
  }
  return sum / (p.length / 4);
}

/** the best of the 32 ways, or no change (swap false, 0, 0) when none is clearly better */
export function fitSides(faces: readonly Uint8ClampedArray[], n: number): SideFit {
  const tops = [0, 1, 2, 3].map((k) => (k === 0 ? faces[2]! : turnSample(faces[2]!, n, k)));
  const bottoms = [0, 1, 2, 3].map((k) => (k === 0 ? faces[3]! : turnSample(faces[3]!, n, k)));
  const ways: { swap: boolean; top: number; bottom: number; err: number; changes: number }[] = [];
  for (const swap of [false, true]) {
    for (let top = 0; top < 4; top++) {
      for (let bottom = 0; bottom < 4; bottom++) {
        const set = [swap ? faces[1]! : faces[0]!, swap ? faces[0]! : faces[1]!, tops[top]!, bottoms[bottom]!, faces[4]!, faces[5]!];
        ways.push({ swap, top, bottom, err: seamError(set, n), changes: (swap ? 1 : 0) + (top ? 1 : 0) + (bottom ? 1 : 0) });
      }
    }
  }
  const before = ways[0]!.err;
  let best = ways[0]!;
  for (const w of ways) if (w.err < best.err) best = w;
  if (!(best.err < FIT_SHARE * before && before - best.err >= FIT_LEVELS)) {
    return { swap: false, top: 0, bottom: 0, before, after: before };
  }
  let pick = best;
  for (const w of ways) {
    if (w.err > best.err * (1 + FIT_CLOSE)) continue;
    if (w.changes < pick.changes || (w.changes === pick.changes && w.err < pick.err)) pick = w;
  }
  return { swap: pick.swap, top: pick.top, bottom: pick.bottom, before, after: pick.err };
}

/** what a fit changed in words, or null for none: 'swapped left and right, turned the top 90 deg, turned the bottom 180 deg' */
export function fitNote(fit: SideFit): string | null {
  const parts: string[] = [];
  if (fit.swap) parts.push('swapped left and right');
  if (fit.top) parts.push(`turned the top ${fit.top * 90} deg`);
  if (fit.bottom) parts.push(`turned the bottom ${fit.bottom * 90} deg`);
  return parts.length ? parts.join(', ') : null;
}
