/**
 * one picture of the project at a time, as a png, without the preview (tool render_frame). the same path an export
 * takes for its frames: real decoded pictures from the sources, drawn by renderFrame on an offscreen canvas.
 * the pure pieces are on top and tested; renderFramePng needs a browser (OffscreenCanvas, webcodecs).
 */
import { releaseRenderResources, renderFrame } from '../engine/draw';
import type { DrawSource } from '../engine/draw';
import { beginExport, endExport } from '../engine/exportState';
import { createFrameSources } from '../features/export/sources';
import { ensureProjectFonts } from '../lib/fonts';
import { projectDuration } from '../lib/timelineOps';
import { getAssetBlob, getAssetUrl } from '../media/registry';
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

/** the same words the exporter uses for a font that did not load */
export function fontWarning(family: string): string {
  return `font "${family}" could not be loaded, its text is drawn in a fallback font`;
}

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

/** svg and friends: createImageBitmap rejects them, an <img> can draw them (the same as the export) */
async function loadImageElement(assetId: string): Promise<DrawSource | null> {
  const url = getAssetUrl(assetId);
  if (!url) return null;
  const img = new Image();
  img.src = url;
  await img.decode();
  return { image: img, width: img.naturalWidth || 1, height: img.naturalHeight || 1 };
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
  for (const family of await ensureProjectFonts(project)) warnings.push(fontWarning(family));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2d canvas is not available');
  // the renderer draws in project pixels
  ctx.setTransform(width / project.width, 0, 0, height / project.height, 0, 0);
  // a grid of one frame that starts at t: the sources open exactly what that picture shows
  const sources = createFrameSources({
    project,
    fps: project.fps,
    rangeStart: t,
    totalFrames: 1,
    blobOf: getAssetBlob,
    loadImageElement,
    onWarning: (m) => {
      if (!warnings.includes(m)) warnings.push(m);
    },
  });
  // while this runs the renderer does not use wall clock retry pauses (engine/exportState.ts)
  beginExport();
  try {
    await sources.open();
    await sources.step(0, (at) => {
      // twice: the first drawing of a frame may still be loading a texture
      renderFrame(ctx, project, at, sources.resolver);
      renderFrame(ctx, project, at, sources.resolver);
    });
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const data = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
    return { data, time: t, width, height, warnings };
  } finally {
    endExport();
    await sources.dispose();
    releaseRenderResources('export');
    canvas.width = 0;
    canvas.height = 0;
  }
}
