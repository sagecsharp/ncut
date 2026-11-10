/**
 * clip masks (types.ts Mask): show only part of a clip's picture, with an optional soft edge.
 * the mask lives in the picture's own frame, so it follows the clip's transform.
 *
 * pure geometry (maskCoverage, starPoints, heartPoints, blurAlpha, maskWorkSize) is separate from the
 * canvas code (maskedPicture) so it can be tested without a dom.
 */
import type { Mask, VisualClip } from '../types';

export const DEFAULT_MASK: Mask = { shape: 'ellipse', x: 0, y: 0, width: 0.8, height: 0.8, rotation: 0, feather: 0.05, invert: false };

/** the larger side of the picture the mask works at (bigger pictures are scaled down proportionally) */
export const MASK_MAX_SIDE = 2048;

/** true when the clip has a mask that hides something */
export function hasMask(clip: VisualClip): boolean {
  return !!clip.mask;
}

const n = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** a string that changes whenever the masked picture would (for texture caches). '' = no mask. */
export function maskSignature(clip: VisualClip): string {
  const m = clip.mask;
  if (!m) return '';
  return [m.shape, n(m.x), n(m.y), n(m.width), n(m.height), n(m.rotation), n(m.feather), m.invert ? 1 : 0, n(m.radius)].join(',');
}

/* ---------- geometry ---------- */

export type Pt = readonly [number, number];

/** fit a point list into the unit box -0.5..0.5 (both axes, independently) */
function normalizePoints(pts: Pt[]): Pt[] {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const w = x1 - x0 || 1;
  const h = y1 - y0 || 1;
  return pts.map(([x, y]) => [(x - x0) / w - 0.5, (y - y0) / h - 0.5] as const);
}

let starCache: Pt[] | null = null;
/** the 10 corners of a five pointed star (one point up), fitted to the unit box -0.5..0.5 (y down) */
export function starPoints(): Pt[] {
  if (starCache) return starCache;
  const pts: Pt[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? 1 : 0.4;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  starCache = normalizePoints(pts);
  return starCache;
}

let heartCache: Pt[] | null = null;
/** the outline of a heart (point down), fitted to the unit box -0.5..0.5 (y down) */
export function heartPoints(): Pt[] {
  if (heartCache) return heartCache;
  const pts: Pt[] = [];
  const steps = 64;
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const x = 16 * Math.sin(t) ** 3;
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    pts.push([x, -y]);
  }
  heartCache = normalizePoints(pts);
  return heartCache;
}

/** even-odd point in polygon test */
function inPolygon(pts: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!;
    const [xj, yj] = pts[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * how much of the picture the mask shows at a point WITHOUT its feather: 1 inside the shown part, 0 in
 * the hidden part (invert already applied). u, v are picture coordinates -0.5..0.5 (u right, v down).
 * `aspect` = picture width / height: the mask turns in real pixels, so a rotated rect stays a rect on a
 * wide picture. shapes with a zero size show nothing (invert: everything).
 */
export function maskCoverage(mask: Mask, u: number, v: number, aspect = 1): number {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  // work in units of the picture's height, so x is stretched by the aspect
  const dx = (u - n(mask.x)) * a;
  const dy = v - n(mask.y);
  const rad = (n(mask.rotation) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const lx = dx * cos + dy * sin;
  const ly = -dx * sin + dy * cos;
  const hw = (Math.max(0, n(mask.width)) * a) / 2;
  const hh = Math.max(0, n(mask.height)) / 2;
  let inside = false;
  switch (mask.shape) {
    case 'rect': {
      if (hw <= 0 || hh <= 0) break;
      const r = Math.min(1, Math.max(0, n(mask.radius))) * Math.min(hw, hh);
      const qx = Math.abs(lx) - (hw - r);
      const qy = Math.abs(ly) - (hh - r);
      inside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r <= 0;
      break;
    }
    case 'ellipse':
      if (hw <= 0 || hh <= 0) break;
      inside = (lx / hw) ** 2 + (ly / hh) ** 2 <= 1;
      break;
    case 'split':
      inside = lx <= 0;
      break;
    case 'band':
      inside = hh > 0 && Math.abs(ly) <= hh;
      break;
    case 'star':
    case 'heart':
      if (hw <= 0 || hh <= 0) break;
      inside = inPolygon(mask.shape === 'star' ? starPoints() : heartPoints(), lx / (hw * 2), ly / (hh * 2));
      break;
  }
  return inside !== !!mask.invert ? 1 : 0;
}

/** the size the mask works at: the larger side capped at MASK_MAX_SIDE, proportional, at least 1. null = unusable size */
export function maskWorkSize(width: number, height: number): { w: number; h: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  const k = Math.min(1, MASK_MAX_SIDE / Math.max(width, height));
  return { w: Math.max(1, Math.round(width * k)), h: Math.max(1, Math.round(height * k)) };
}

/**
 * soft edge: a three pass box blur (close to a gaussian) of a one channel image, in place. the edge is
 * clamped (the outside counts as the nearest border pixel), so a shape running off the picture stays solid.
 */
export function blurAlpha(data: Uint8ClampedArray | Float32Array, w: number, h: number, radius: number): void {
  const r = Math.round(radius);
  if (r < 1 || w < 1 || h < 1) return;
  const tmp = new Float32Array(Math.max(w, h));
  const line = new Float32Array(Math.max(w, h));
  const pass = (len: number, get: (i: number) => number, set: (i: number, v: number) => void) => {
    for (let i = 0; i < len; i++) line[i] = get(i);
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += line[Math.min(len - 1, Math.max(0, k))]!;
    const inv = 1 / (2 * r + 1);
    for (let i = 0; i < len; i++) {
      tmp[i] = sum * inv;
      sum += line[Math.min(len - 1, i + r + 1)]! - line[Math.max(0, i - r)]!;
    }
    for (let i = 0; i < len; i++) set(i, tmp[i]!);
  };
  for (let p = 0; p < 3; p++) {
    for (let y = 0; y < h; y++) pass(w, (i) => data[y * w + i]!, (i, v) => void (data[y * w + i] = v));
    for (let x = 0; x < w; x++) pass(h, (i) => data[i * w + x]!, (i, v) => void (data[i * w + x] = v));
  }
}

/* ---------- canvas ---------- */

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
interface Surface {
  canvas: AnyCanvas;
  ctx: Ctx;
}

function makeSurface(w: number, h: number, readback = false): Surface | null {
  let canvas: AnyCanvas | null = null;
  if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(w, h);
  else if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
  }
  if (!canvas) return null;
  const ctx = (canvas.getContext('2d', readback ? { willReadFrequently: true } : undefined) as Ctx | null) ?? null;
  return ctx ? { canvas, ctx } : null;
}

/** trace the shown part of the mask (before feather and invert) in the pixel space of a w x h canvas */
function traceShape(ctx: Ctx, mask: Mask, w: number, h: number): void {
  ctx.translate(w / 2 + n(mask.x) * w, h / 2 + n(mask.y) * h);
  ctx.rotate((n(mask.rotation) * Math.PI) / 180);
  const hw = (Math.max(0, n(mask.width)) * w) / 2;
  const hh = (Math.max(0, n(mask.height)) * h) / 2;
  const big = (w + h) * 4;
  ctx.beginPath();
  switch (mask.shape) {
    case 'rect': {
      if (hw <= 0 || hh <= 0) return;
      const r = Math.min(1, Math.max(0, n(mask.radius))) * Math.min(hw, hh);
      if (r > 0 && typeof ctx.roundRect === 'function') ctx.roundRect(-hw, -hh, hw * 2, hh * 2, r);
      else ctx.rect(-hw, -hh, hw * 2, hh * 2);
      break;
    }
    case 'ellipse':
      if (hw <= 0 || hh <= 0) return;
      ctx.ellipse(0, 0, hw, hh, 0, 0, Math.PI * 2);
      break;
    case 'split':
      ctx.rect(-big, -big, big, big * 2);
      break;
    case 'band':
      if (hh <= 0) return;
      ctx.rect(-big, -hh, big * 2, hh * 2);
      break;
    case 'star':
    case 'heart': {
      if (hw <= 0 || hh <= 0) return;
      const pts = mask.shape === 'star' ? starPoints() : heartPoints();
      pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * hw * 2, y * hh * 2) : ctx.lineTo(x * hw * 2, y * hh * 2)));
      ctx.closePath();
      break;
    }
  }
  ctx.fillStyle = '#fff';
  ctx.fill();
}

/** pixels the feather blur should reach, at a size of w x h */
export function featherPx(mask: Mask, w: number, h: number): number {
  return Math.max(0, Math.min(1, n(mask.feather))) * (Math.min(w, h) / 2);
}

const ALPHA_MAX = 24;
/** the alpha canvases (white shape on transparent, feather baked in). shared by both channels: it is pure in (mask, size). */
const alphaCache = new Map<string, AnyCanvas>();

/**
 * the mask as an alpha picture of w x h: the shown part is opaque white, the feather is baked in.
 * the blur runs on a small copy (a few pixels of blur need no more) and is stretched back, so it is
 * cheap and does not depend on ctx.filter.
 */
function alphaCanvas(mask: Mask, w: number, h: number): AnyCanvas | null {
  const key = maskSignature({ mask } as VisualClip) + '|' + w + 'x' + h;
  const hit = alphaCache.get(key);
  if (hit) {
    alphaCache.delete(key);
    alphaCache.set(key, hit);
    return hit;
  }
  const out = makeSurface(w, h);
  if (!out) return null;
  const blur = featherPx(mask, w, h);
  if (blur < 0.5) {
    traceShape(out.ctx, mask, w, h);
  } else {
    // reach `target` pixels of blur on the small copy
    const target = 12;
    const k = Math.min(1, target / blur);
    const sw = Math.max(2, Math.round(w * k));
    const sh = Math.max(2, Math.round(h * k));
    const small = makeSurface(sw, sh, true);
    if (!small) return null;
    small.ctx.save();
    traceShape(small.ctx, mask, sw, sh);
    small.ctx.restore();
    const img = small.ctx.getImageData(0, 0, sw, sh);
    const a = new Float32Array(sw * sh);
    for (let i = 0; i < a.length; i++) a[i] = img.data[i * 4 + 3]!;
    blurAlpha(a, sw, sh, (blur * (sw / w)) / 3);
    for (let i = 0; i < a.length; i++) {
      img.data[i * 4] = 255;
      img.data[i * 4 + 1] = 255;
      img.data[i * 4 + 2] = 255;
      img.data[i * 4 + 3] = a[i]!;
    }
    small.ctx.putImageData(img, 0, 0);
    out.ctx.imageSmoothingEnabled = true;
    out.ctx.imageSmoothingQuality = 'high';
    out.ctx.drawImage(small.canvas, 0, 0, w, h);
  }
  alphaCache.set(key, out.canvas);
  if (alphaCache.size > ALPHA_MAX) {
    const first = alphaCache.keys().next().value;
    if (first !== undefined) alphaCache.delete(first);
  }
  return out.canvas;
}

const results = new Map<'preview' | 'export', Surface | null>();

/** free the channel's scratch canvas (call when an export is done). a later call rebuilds it. */
export function releaseMaskResources(channel: 'preview' | 'export'): void {
  const r = results.get(channel);
  if (r) {
    r.canvas.width = 0;
    r.canvas.height = 0;
  }
  results.delete(channel);
}

/**
 * the picture with the clip's mask applied: a canvas that is see-through where the mask hides it. it is
 * the picture's pixel size (width x height), scaled down proportionally when the larger side is over 2048.
 * returns `source` itself when the clip has no mask or a canvas cannot be made. the result is only valid
 * until the next call on the same channel.
 */
export function maskedPicture(
  source: CanvasImageSource,
  width: number,
  height: number,
  clip: VisualClip,
  channel: 'preview' | 'export' = 'preview',
): CanvasImageSource {
  const mask = clip.mask;
  if (!mask) return source;
  try {
    const size = maskWorkSize(width, height);
    if (!size) return source;
    const alpha = alphaCanvas(mask, size.w, size.h);
    if (!alpha) return source;
    let res = results.get(channel);
    if (res === undefined) {
      res = makeSurface(size.w, size.h);
      results.set(channel, res);
    }
    if (!res) return source;
    if (res.canvas.width !== size.w || res.canvas.height !== size.h) {
      res.canvas.width = size.w;
      res.canvas.height = size.h;
    }
    const c = res.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'copy';
    c.drawImage(source, 0, 0, size.w, size.h);
    c.globalCompositeOperation = mask.invert ? 'destination-out' : 'destination-in';
    c.drawImage(alpha, 0, 0);
    c.globalCompositeOperation = 'source-over';
    return res.canvas;
  } catch {
    return source;
  }
}
