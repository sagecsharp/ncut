/**
 * the frame renderer. draws one frame of a project onto a 2d canvas.
 * shared by the live preview and the exporter so both always look the same.
 * it does not know where pixels come from: the caller passes a resolver that returns the
 * current image for a video/image clip (a <video>, <img>, ImageBitmap, VideoFrame, canvas...).
 */
import type { ImageClip, Project, TextClip, Transform, VideoClip, VisualClip } from '../types';
import { isVisualClip } from '../types';
import { clipEnd, fadeFactor, sourceTimeAt } from '../lib/timelineOps';

export interface DrawSource {
  image: CanvasImageSource;
  /** natural size of the image in pixels */
  width: number;
  height: number;
}

/**
 * return the picture for a clip at a source time (seconds into the asset; 0 for images),
 * or null when it is not available (still loading / missing) - the clip is skipped.
 */
export type SourceResolver = (clip: VideoClip | ImageClip, sourceTime: number) => DrawSource | null;

/** axis-aligned box of a clip before rotation, in canvas pixels. cx/cy is the center. */
export interface ClipBox {
  cx: number;
  cy: number;
  width: number;
  height: number;
  /** degrees */
  rotation: number;
}

export const TEXT_LINE_HEIGHT = 1.25;
/** padding of the text background box, as a fraction of the font size */
export const TEXT_PADDING = 0.3;

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

let measureCtx: Ctx | null = null;
function getMeasureCtx(): Ctx {
  if (measureCtx) return measureCtx;
  if (typeof OffscreenCanvas !== 'undefined') {
    measureCtx = new OffscreenCanvas(8, 8).getContext('2d');
  }
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) throw new Error('2d canvas is not available');
  return measureCtx;
}

export function textFont(clip: Pick<TextClip, 'italic' | 'fontWeight' | 'fontSize' | 'fontFamily'>): string {
  return `${clip.italic ? 'italic ' : ''}${clip.fontWeight} ${clip.fontSize}px "${clip.fontFamily}", "Noto Sans", sans-serif`;
}

/** unscaled size of a text clip's box (text + padding) and its lines */
export function measureText(clip: TextClip): { width: number; height: number; lines: string[]; lineHeight: number; pad: number } {
  const ctx = getMeasureCtx();
  ctx.font = textFont(clip);
  const lines = (clip.text.length > 0 ? clip.text : ' ').split('\n');
  let max = 0;
  for (const line of lines) max = Math.max(max, ctx.measureText(line).width);
  const lineHeight = clip.fontSize * TEXT_LINE_HEIGHT;
  const pad = clip.fontSize * TEXT_PADDING;
  return { width: max + pad * 2, height: lines.length * lineHeight + pad * 2, lines, lineHeight, pad };
}

/** size of a media clip at transform.scale = 1: the largest size that fits inside the canvas */
export function containSize(srcW: number, srcH: number, canvasW: number, canvasH: number): { width: number; height: number } {
  if (srcW <= 0 || srcH <= 0) return { width: canvasW, height: canvasH };
  const s = Math.min(canvasW / srcW, canvasH / srcH);
  return { width: srcW * s, height: srcH * s };
}

/**
 * where a visual clip sits on the canvas. for video/image clips pass the asset's natural size
 * (falls back to the asset metadata in the project, then to the full canvas).
 */
export function getClipBox(project: Project, clip: VisualClip, natural?: { width: number; height: number }): ClipBox {
  const t: Transform = clip.transform;
  let width: number;
  let height: number;
  if (clip.type === 'text') {
    const m = measureText(clip);
    width = m.width * t.scale;
    height = m.height * t.scale;
  } else {
    let nat = natural;
    if (!nat) {
      const asset = project.assets.find((a) => a.id === clip.assetId);
      if (asset && asset.width > 0 && asset.height > 0) nat = { width: asset.width, height: asset.height };
    }
    const fit = containSize(nat?.width ?? project.width, nat?.height ?? project.height, project.width, project.height);
    width = fit.width * t.scale;
    height = fit.height * t.scale;
  }
  return { cx: project.width / 2 + t.x, cy: project.height / 2 + t.y, width, height, rotation: t.rotation };
}

/** visual clips under a time in paint order (bottom layer first). skips hidden tracks. */
export function visibleClipsAt(project: Project, time: number): VisualClip[] {
  const out: VisualClip[] = [];
  for (let i = project.tracks.length - 1; i >= 0; i--) {
    const track = project.tracks[i]!;
    if (track.kind !== 'video' || track.hidden) continue;
    for (const clip of project.clips) {
      if (clip.trackId !== track.id || !isVisualClip(clip)) continue;
      if (time >= clip.start - 1e-6 && time < clipEnd(clip) - 1e-6) out.push(clip);
    }
  }
  return out;
}

/** true when the canvas point (px, py) is inside the clip's rotated box */
export function hitTestBox(box: ClipBox, px: number, py: number): boolean {
  const rad = (-box.rotation * Math.PI) / 180;
  const dx = px - box.cx;
  const dy = py - box.cy;
  const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
  return Math.abs(lx) <= box.width / 2 && Math.abs(ly) <= box.height / 2;
}

function drawText(ctx: Ctx, clip: TextClip): void {
  const m = measureText(clip);
  const s = clip.transform.scale;
  ctx.scale(s, s);
  if (clip.background) {
    ctx.fillStyle = clip.background;
    ctx.fillRect(-m.width / 2, -m.height / 2, m.width, m.height);
  }
  ctx.font = textFont(clip);
  ctx.fillStyle = clip.color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = clip.align;
  const innerW = m.width - m.pad * 2;
  const x = clip.align === 'left' ? -innerW / 2 : clip.align === 'right' ? innerW / 2 : 0;
  const top = -m.height / 2 + m.pad;
  for (let i = 0; i < m.lines.length; i++) {
    ctx.fillText(m.lines[i]!, x, top + m.lineHeight * (i + 0.5));
  }
}

/**
 * draw the whole frame at `time`. the context must belong to a canvas of project.width x project.height
 * (or be pre-scaled so that those are its logical units).
 */
export function renderFrame(ctx: Ctx, project: Project, time: number, resolve: SourceResolver): void {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = project.background || '#000000';
  ctx.fillRect(0, 0, project.width, project.height);

  for (const clip of visibleClipsAt(project, time)) {
    const alpha = clip.transform.opacity * fadeFactor(clip, time);
    if (alpha <= 0.001) continue;

    let source: DrawSource | null = null;
    if (clip.type !== 'text') {
      source = resolve(clip, clip.type === 'video' ? sourceTimeAt(clip, time) : 0);
      if (!source) continue;
    }
    const box = getClipBox(project, clip, source ? { width: source.width, height: source.height } : undefined);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(box.cx, box.cy);
    if (box.rotation) ctx.rotate((box.rotation * Math.PI) / 180);
    if (clip.type === 'text') {
      drawText(ctx, clip);
    } else if (source) {
      try {
        ctx.drawImage(source.image, -box.width / 2, -box.height / 2, box.width, box.height);
      } catch {
        // a source that is not ready (e.g. a video with no decoded frame yet) is skipped
      }
    }
    ctx.restore();
  }
  ctx.restore();
}
