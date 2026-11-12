/**
 * one picture of the project at a time, as a png, without the preview (tool render_frame). drawn by the picture
 * export (features/export/still.ts): real decoded pictures from the sources, renderFrame on an offscreen canvas.
 * the pure pieces are on top and tested; renderFramePng needs a browser (OffscreenCanvas, webcodecs).
 */
import { beginExport, endExport } from '../engine/exportState';
import { renderStill } from '../features/export/still';
import { projectDuration } from '../lib/timelineOps';
import type { Project } from '../types';
import { ToolError } from './helpers';

export const DEFAULT_MAX_SIZE = 960;
export const LIMIT_MAX_SIZE = 1920;

/**
 * a time that shows a picture: not before 0, not after the start of the last frame (every clip is only visible
 * before its end, so the end itself is empty). a time that is not a number counts as 0
 */
export function clampFrameTime(time: number, duration: number, fps: number): number {
  if (!Number.isFinite(time)) return 0;
  const last = Math.max(0, duration - 1 / (fps > 0 ? fps : 30));
  return Math.max(0, Math.min(last, time));
}

export { fontWarning } from '../features/export/still';

/** the size of the picture: the longest side is at most `maxSize`, the shape stays, a small project is not blown up */
export function frameSize(width: number, height: number, maxSize: number = DEFAULT_MAX_SIZE): { width: number; height: number } {
  const cap = Math.max(1, Math.min(LIMIT_MAX_SIZE, Math.floor(Number.isFinite(maxSize) ? maxSize : DEFAULT_MAX_SIZE)));
  const longest = Math.max(width, height, 1);
  const k = Math.min(1, cap / longest);
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** base64 of bytes (in slices, so a big picture does not blow the argument limit of fromCharCode) */
export function bytesToBase64(bytes: Uint8Array): string {
  const SLICE = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += SLICE) {
    bin += String.fromCharCode(...bytes.subarray(i, i + SLICE));
  }
  return btoa(bin);
}

export interface FramePng {
  /** base64 */
  data: string;
  /** the timeline time that was drawn */
  time: number;
  width: number;
  height: number;
  /** things that went wrong on the way and left something out (a missing file, a video that cannot be decoded) */
  warnings: string[];
}

/**
 * draw the project at `time` and encode it as png. the caller makes sure no export runs (the renderer shares its
 * scratch resources with it). nothing it opens stays open.
 */
export async function renderFramePng(project: Project, time: number, maxSize: number = DEFAULT_MAX_SIZE): Promise<FramePng> {
  const duration = projectDuration(project);
  if (!(duration > 0)) throw new ToolError('the project is empty, there is no picture to draw. add clips first');
  const t = clampFrameTime(time, duration, project.fps);
  const { width, height } = frameSize(project.width, project.height, maxSize);
  const warnings: string[] = [];
  // while this runs the renderer does not use wall clock retry pauses (engine/exportState.ts)
  beginExport();
  try {
    const blob = await renderStill(project, { time: t, width, height, mime: 'image/png' }, { onWarning: (m) => warnings.push(m) });
    const data = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
    return { data, time: t, width, height, warnings };
  } finally {
    endExport();
  }
}
