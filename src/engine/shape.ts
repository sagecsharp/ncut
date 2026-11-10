/** drawing of shape clips (types.ts ShapeClip). pure canvas 2d, shared by the flat and the 3d path. */
import type { ShapeClip } from '../types';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const TAU = Math.PI * 2;

function clampInt(v: number | undefined, fallback: number, min: number, max: number): number {
  const n = Math.round(v ?? fallback);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** a regular polygon / star fitted into the box. the first corner points up. */
function ngon(ctx: Ctx, w: number, h: number, corners: number, inner: number | null): void {
  const steps = inner === null ? corners : corners * 2;
  for (let i = 0; i < steps; i++) {
    const a = -Math.PI / 2 + (i / steps) * TAU;
    const r = inner !== null && i % 2 === 1 ? inner : 1;
    const x = (Math.cos(a) * r * w) / 2;
    const y = (Math.sin(a) * r * h) / 2;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function roundRect(ctx: Ctx, w: number, h: number, radius: number): void {
  const r = Math.min(w, h) / 2 * Math.min(1, Math.max(0, radius));
  const x = -w / 2;
  const y = -h / 2;
  if (r <= 0.01) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/**
 * trace the outline of a shape centered on the origin in a w x h box. begins a new path.
 * `radius` (0..1) rounds the corners of a rect.
 */
export function shapePath(ctx: Ctx, clip: ShapeClip, w: number, h: number, radius = 0): void {
  ctx.beginPath();
  switch (clip.kind) {
    case 'rect':
      roundRect(ctx, w, h, radius);
      break;
    case 'ellipse':
      ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, TAU);
      ctx.closePath();
      break;
    case 'triangle':
      ctx.moveTo(0, -h / 2);
      ctx.lineTo(w / 2, h / 2);
      ctx.lineTo(-w / 2, h / 2);
      ctx.closePath();
      break;
    case 'polygon':
      ngon(ctx, w, h, clampInt(clip.points, 6, 3, 12), null);
      break;
    case 'star': {
      const inner = Math.min(0.95, Math.max(0.1, clip.inner ?? 0.45));
      ngon(ctx, w, h, clampInt(clip.points, 5, 3, 12), inner);
      break;
    }
    case 'heart': {
      const x = w / 2;
      const y = h / 2;
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(-x * 0.2, y * 0.7, -x, y * 0.25, -x, -y * 0.35);
      ctx.bezierCurveTo(-x, -y * 0.85, -x * 0.55, -y, -x * 0.5, -y);
      ctx.bezierCurveTo(-x * 0.2, -y, 0, -y * 0.75, 0, -y * 0.45);
      ctx.bezierCurveTo(0, -y * 0.75, x * 0.2, -y, x * 0.5, -y);
      ctx.bezierCurveTo(x * 0.55, -y, x, -y * 0.85, x, -y * 0.35);
      ctx.bezierCurveTo(x, y * 0.25, x * 0.2, y * 0.7, 0, y);
      ctx.closePath();
      break;
    }
    case 'arrow': {
      // points right. the head takes the last 40% (never longer than the box is tall)
      const head = Math.min(w * 0.4, h);
      const shaft = h * 0.22;
      const x0 = -w / 2;
      const x1 = w / 2 - head;
      ctx.moveTo(x0, -shaft);
      ctx.lineTo(x1, -shaft);
      ctx.lineTo(x1, -h / 2);
      ctx.lineTo(w / 2, 0);
      ctx.lineTo(x1, h / 2);
      ctx.lineTo(x1, shaft);
      ctx.lineTo(x0, shaft);
      ctx.closePath();
      break;
    }
    case 'line':
      // a horizontal bar through the middle of the box, as thick as the box is tall
      roundRect(ctx, w, h, radius);
      break;
  }
}

function fillStyle(ctx: Ctx, clip: ShapeClip, w: number, h: number): string | CanvasGradient {
  if (!clip.color2) return clip.color;
  let g: CanvasGradient;
  if (clip.gradientRadial) {
    g = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(w, h) / 2);
  } else {
    const a = ((clip.gradientAngle ?? 90) * Math.PI) / 180;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    // long enough to cover the box along the gradient direction
    const half = (Math.abs(dx) * w + Math.abs(dy) * h) / 2;
    g = ctx.createLinearGradient(-dx * half, -dy * half, dx * half, dy * half);
  }
  g.addColorStop(0, clip.color);
  g.addColorStop(1, clip.color2);
  return g;
}

/** how far the outline reaches outside the shape's box (canvas pixels at scale 1) */
export function shapeSpill(clip: ShapeClip): number {
  return clip.stroke && clip.stroke.width > 0 ? clip.stroke.width / 2 + 1 : 0;
}

/**
 * draw a shape centered on the origin. w / h = the size of its box in the current units, `unit` =
 * how many of those units one canvas pixel at scale 1 is (the clip's scale), used for the outline.
 */
export function drawShape(ctx: Ctx, clip: ShapeClip, w: number, h: number, unit = 1): void {
  if (!(w > 0) || !(h > 0)) return;
  shapePath(ctx, clip, w, h, clip.radius ?? 0);
  if (clip.filled !== false) {
    ctx.fillStyle = fillStyle(ctx, clip, w, h);
    ctx.fill();
  }
  if (clip.stroke && clip.stroke.width > 0) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = clip.stroke.width * unit;
    ctx.strokeStyle = clip.stroke.color;
    ctx.stroke();
  }
}

/** everything that changes how a shape looks, for texture caches */
export function shapeSignature(clip: ShapeClip): string {
  return [
    clip.kind,
    clip.width,
    clip.height,
    clip.color,
    clip.color2 ?? '',
    clip.gradientAngle ?? 90,
    clip.gradientRadial ? 1 : 0,
    clip.filled === false ? 0 : 1,
    clip.stroke ? `${clip.stroke.color}:${clip.stroke.width}` : '',
    clip.points ?? '',
    clip.inner ?? '',
    clip.radius ?? 0,
  ].join('|');
}
