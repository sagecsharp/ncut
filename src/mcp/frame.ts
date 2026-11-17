/**
 * one picture of the project at a time, as a png, without the preview (tool render_frame). drawn by the picture
 * export (features/export/still.ts): real decoded pictures from the sources, renderFrame on an offscreen canvas.
 * the pure pieces are on top and tested; renderFramePng needs a browser (OffscreenCanvas, webcodecs).
 */
import { beginExport, endExport } from '../engine/exportState';
import { renderStill } from '../features/export/still';
import { clampFrameTime } from '../lib/frameTime';
import { skyUsable } from '../engine/scene3d/sky';
import { projectDuration } from '../lib/timelineOps';
import { paintScope, plotScratch } from '../features/preview/scopePlot';
import { binScopes, channelMeans, EXACT_SAMPLE, lumaLevels, lumaStats, subsample } from '../features/preview/scopes';
import type { ScopeKind } from '../features/preview/scopesState';
import type { Project } from '../types';
import { ToolError } from './helpers';

export const DEFAULT_MAX_SIZE = 960;
export const LIMIT_MAX_SIZE = 1920;

export { clampFrameTime };
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
  /** only when asked for (FrameWants.levels) */
  levels?: FrameLevels;
  /** only when asked for (FrameWants.scope): that scope of the picture as a png */
  scope?: { kind: ScopeKind; data: string; width: number; height: number };
}

/** what render_frame may measure on the picture it answers */
export interface FrameWants {
  levels?: boolean;
  scope?: ScopeKind;
}

/** luma and rgb on 0..100 (0.1 steps), black and white as shares of the pixels 0..1 (0.0001 steps) */
export interface FrameLevels {
  luma_min: number;
  luma_max: number;
  luma_mean: number;
  black: number;
  white: number;
  rgb_mean: { r: number; g: number; b: number };
}

/** the size of the png of each scope (the vectorscope is square) */
export const SCOPE_IMAGE_SIZE: Record<ScopeKind, { width: number; height: number }> = {
  waveform: { width: 640, height: 360 },
  parade: { width: 640, height: 360 },
  vectorscope: { width: 480, height: 480 },
  histogram: { width: 640, height: 360 },
};

const round1 = (n: number) => Math.round(n * 10) / 10;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** the levels of a 4 x 256 histogram (r, g, b, luma) of that many pixels. null for no pixels. integer 709 luma, as the scopes measure it */
export function levelsAnswer(hist: Uint32Array, pixels: number): FrameLevels | null {
  const stats = lumaStats(hist, pixels);
  const means = channelMeans(hist, pixels);
  if (!stats || !means) return null;
  return {
    luma_min: round1(stats.min),
    luma_max: round1(stats.max),
    luma_mean: round1(stats.mean),
    black: round4(stats.black),
    white: round4(stats.white),
    rgb_mean: { r: round1(means.r), g: round1(means.g), b: round1(means.b) },
  };
}

/**
 * the time the picture is drawn at. a project without clips has a picture only when it has a sky it can draw: that is
 * drawn at time 0. anything else empty is refused.
 */
export function frameTimeFor(project: Project, time: number): number {
  const duration = projectDuration(project);
  if (!(duration > 0)) {
    if (skyUsable(project)) return 0;
    throw new ToolError('the project is empty, there is no picture to draw. add clips first');
  }
  return clampFrameTime(time, duration, project.fps);
}

/**
 * draw the project at `time` and encode it as png. the caller makes sure no export runs (the renderer shares its
 * scratch resources with it). nothing it opens stays open.
 */
export async function renderFramePng(project: Project, time: number, maxSize: number = DEFAULT_MAX_SIZE, wants: FrameWants = {}): Promise<FramePng> {
  const t = frameTimeFor(project, time);
  const { width, height } = frameSize(project.width, project.height, maxSize);
  const warnings: string[] = [];
  // while this runs the renderer does not use wall clock retry pauses (engine/exportState.ts)
  beginExport();
  try {
    const asked = wants.levels === true || wants.scope !== undefined;
    // the canvas is cleared after the picture is encoded: what is measured is read inside the hook
    let hist: Uint32Array | null = null;
    let pixels = 0;
    let bins: ReturnType<typeof binScopes> | null = null;
    const onCanvas = (canvas: OffscreenCanvas) => {
      const g = canvas.getContext('2d');
      if (!g) return;
      const img = g.getImageData(0, 0, canvas.width, canvas.height);
      pixels = img.width * img.height;
      hist = lumaLevels(img.data, pixels);
      if (wants.scope) {
        const sub = subsample(img.data, img.width, img.height, EXACT_SAMPLE);
        const kind = wants.scope;
        bins = binScopes(sub.data, sub.w, sub.h, 1, { wave: kind === 'waveform', parade: kind === 'parade', vector: kind === 'vectorscope' });
      }
    };
    const blob = await renderStill(project, { time: t, width, height, mime: 'image/png' }, { onWarning: (m) => warnings.push(m), ...(asked ? { onCanvas } : {}) });
    const data = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
    const out: FramePng = { data, time: t, width, height, warnings };
    if (!asked) return out;
    if (wants.levels === true && hist) {
      const levels = levelsAnswer(hist, pixels);
      if (levels) out.levels = levels;
    }
    if (wants.scope) {
      const kind = wants.scope;
      const size = SCOPE_IMAGE_SIZE[kind];
      const c = new OffscreenCanvas(size.width, size.height);
      const g = c.getContext('2d');
      if (g) {
        paintScope(g, kind, bins, hist, pixels, { w: size.width, h: size.height, k: 1, zoom: 1 }, plotScratch());
        const scopeBlob = await c.convertToBlob({ type: 'image/png' });
        out.scope = { kind, data: bytesToBase64(new Uint8Array(await scopeBlob.arrayBuffer())), width: size.width, height: size.height };
      }
      c.width = 0;
      c.height = 0;
    }
    return out;
  } finally {
    endExport();
  }
}
