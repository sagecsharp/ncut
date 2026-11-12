/**
 * one picture of the project as a file (png / jpg): the frame a video export of the same range would start with.
 * drawn the way an export draws its frames: real decoded pictures from the sources, renderFrame on an offscreen
 * canvas. the pure pieces are on top and tested; renderStill needs a browser (OffscreenCanvas, webcodecs).
 */
import { releaseRenderResources, renderFrame } from '../../engine/draw';
import type { DrawSource } from '../../engine/draw';
import { ensureProjectFonts } from '../../lib/fonts';
import { getAssetBlob, getAssetUrl } from '../../media/registry';
import type { Project } from '../../types';
import { createFrameSources } from './sources';

/** a single picture, no sound and no length */
export type StillContainer = 'png' | 'jpg';
export type StillMime = 'image/png' | 'image/jpeg';

export function isStillContainer(c: string): c is StillContainer {
  return c === 'png' || c === 'jpg';
}

export function stillMime(c: StillContainer): StillMime {
  return c === 'jpg' ? 'image/jpeg' : 'image/png';
}

/** how hard a jpg is squeezed for the dialog's quality choice (png has no loss, the choice does nothing there) */
export function jpegQuality(quality: 'low' | 'medium' | 'high'): number {
  return quality === 'low' ? 0.7 : quality === 'medium' ? 0.85 : 0.95;
}

/** the size of the picture: the project size times the scale, at least 1 px (a video needs even sides, a picture does not) */
export function stillSize(project: Pick<Project, 'width' | 'height'>, scale: number): { width: number; height: number } {
  const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return { width: Math.max(1, Math.round(project.width * k)), height: Math.max(1, Math.round(project.height * k)) };
}

/** the same words every export uses for a font that did not load */
export function fontWarning(family: string): string {
  return `font "${family}" could not be loaded, its text is drawn in a fallback font`;
}

export interface StillOptions {
  /** the timeline second to draw (inside the project) */
  time: number;
  width: number;
  height: number;
  mime: StillMime;
  /** jpg only: 0..1 */
  quality?: number;
}

export interface StillHooks {
  /** things that left something out of the picture (a missing file, a font that did not load), each once */
  onWarning?: (message: string) => void;
  signal?: AbortSignal;
}

function abortError(): DOMException {
  return new DOMException('export cancelled', 'AbortError');
}

/** svg and friends: createImageBitmap rejects them, an <img> can draw them (the same as the video export) */
async function loadImageElement(assetId: string): Promise<DrawSource | null> {
  const url = getAssetUrl(assetId);
  if (!url) return null;
  const img = new Image();
  img.src = url;
  await img.decode();
  return { image: img, width: img.naturalWidth || 1, height: img.naturalHeight || 1 };
}

/**
 * draw the project at `time` and encode the picture. the caller holds the export state (engine/exportState.ts
 * beginExport / endExport) and makes sure no other export runs: the renderer shares its scratch resources with it.
 * nothing it opens stays open.
 */
export async function renderStill(project: Project, options: StillOptions, hooks: StillHooks = {}): Promise<Blob> {
  const { signal } = hooks;
  const warned = new Set<string>();
  const onWarning = (message: string) => {
    if (warned.has(message)) return;
    warned.add(message);
    hooks.onWarning?.(message);
  };
  // text must be drawn in its real font (never rejects)
  for (const family of await ensureProjectFonts(project)) onWarning(fontWarning(family));
  if (signal?.aborted) throw abortError();
  const { width, height } = options;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2d canvas is not available');
  // the renderer draws in project pixels
  ctx.setTransform(width / project.width, 0, 0, height / project.height, 0, 0);
  // a grid of one frame that starts at the time: the sources open exactly what that picture shows
  const sources = createFrameSources({
    project,
    fps: project.fps,
    rangeStart: options.time,
    totalFrames: 1,
    blobOf: getAssetBlob,
    loadImageElement,
    onWarning,
    signal,
  });
  try {
    await sources.open();
    if (signal?.aborted) throw abortError();
    await sources.step(0, (at) => {
      // twice: the first drawing of a frame may still be loading a texture
      renderFrame(ctx, project, at, sources.resolver);
      renderFrame(ctx, project, at, sources.resolver);
    });
    if (signal?.aborted) throw abortError();
    const blob = await canvas.convertToBlob(
      options.mime === 'image/jpeg' ? { type: 'image/jpeg', quality: options.quality ?? jpegQuality('high') } : { type: 'image/png' },
    );
    if (signal?.aborted) throw abortError();
    return blob;
  } finally {
    await sources.dispose();
    releaseRenderResources('export');
    canvas.width = 0;
    canvas.height = 0;
  }
}
