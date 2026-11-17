/**
 * where the frame goes on an export canvas whose shape is not the project's (a custom size in the export's advanced
 * part). the frame is drawn at the project's shape, so effects on the whole picture see what the preview sees, then
 * placed 1:1: fit = the whole picture with bars, fill = no bars, the edges cut. an output of the project's shape is
 * drawn straight onto with the transform every export always used.
 */
import type { Project } from '../../types';

export type FitMode = 'fit' | 'fill';

/** direct = the project's shape, drawn straight on. else drawn at drawWidth x drawHeight, placed at x, y (fill reaches past the edges) */
export interface FramePlacement { direct: boolean; drawWidth: number; drawHeight: number; x: number; y: number }

/** shapes closer than this (relative) count as the same: no bars for a pixel of rounding */
export const SHAPE_TOLERANCE = 0.01;

export function placeFrame(projectW: number, projectH: number, outW: number, outH: number, fit: FitMode): FramePlacement {
  const direct: FramePlacement = { direct: true, drawWidth: outW, drawHeight: outH, x: 0, y: 0 };
  if (!(projectW > 0) || !(projectH > 0) || !(outW > 0) || !(outH > 0)) return direct;
  const pa = projectW / projectH;
  if (Math.abs(outW / outH - pa) / pa <= SHAPE_TOLERANCE) return direct;
  const k = fit === 'fill' ? Math.max(outW / projectW, outH / projectH) : Math.min(outW / projectW, outH / projectH);
  const drawWidth = Math.max(1, Math.round(projectW * k));
  const drawHeight = Math.max(1, Math.round(projectH * k));
  return { direct: false, drawWidth, drawHeight, x: Math.round((outW - drawWidth) / 2), y: Math.round((outH - drawHeight) / 2) };
}

/** target: what renderFrame draws on, in project units. finish: after renderFrame, puts it on the output. dispose: frees the helper */
export interface FrameDrawer { target: OffscreenCanvasRenderingContext2D; finish(): void; dispose(): void }

export function createFrameDrawer(
  out: OffscreenCanvas,
  ctx: OffscreenCanvasRenderingContext2D,
  project: Pick<Project, 'width' | 'height' | 'background'>,
  place: FramePlacement | null,
  transparent: boolean,
): FrameDrawer {
  if (!place || place.direct) {
    ctx.setTransform(out.width / project.width, 0, 0, out.height / project.height, 0, 0);
    return { target: ctx, finish() {}, dispose() {} };
  }
  const inner = new OffscreenCanvas(place.drawWidth, place.drawHeight);
  const ictx = inner.getContext('2d', { alpha: transparent });
  if (!ictx) throw new Error('2d canvas is not available');
  ictx.setTransform(place.drawWidth / project.width, 0, 0, place.drawHeight / project.height, 0, 0);
  return {
    target: ictx,
    finish() {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      if (transparent) ctx.clearRect(0, 0, out.width, out.height);
      else {
        ctx.fillStyle = project.background || '#000000';
        ctx.fillRect(0, 0, out.width, out.height);
      }
      ctx.drawImage(inner, place.x, place.y);
      ctx.restore();
    },
    dispose() {
      inner.width = 0;
      inner.height = 0;
    },
  };
}
