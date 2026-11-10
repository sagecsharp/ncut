/**
 * pure numbers for gif export: frame rate cap, frame count, size estimate and warnings.
 * shared by the dialog (what it shows) and the exporter (what it does), so they always agree.
 */
import { GIF_MAX_FPS, effectiveGifFps } from '../../lib/gif';

export { GIF_MAX_FPS };

/** what the dialog picks when the user switches to gif (their video settings are kept apart) */
export const GIF_DEFAULT_FPS = 15;
export const GIF_DEFAULT_SCALE = 0.5;
/** frame rates offered for gif */
export const GIF_FPS_OPTIONS: readonly number[] = [10, 12, 15, 20, 24, 25, 30, 50];

/** a gif of more pixels than this (width * height * frames) gets a warning, it will be slow and big */
export const GIF_PIXEL_WARN = 150_000_000;

/** the frame rate a gif export really renders at */
export function gifExportFps(fps: number): number {
  return effectiveGifFps(fps);
}

/** the dialog text for a frame rate pick that gets capped, empty when it is used as picked */
export function gifFpsNote(fps: number): string {
  return fps > GIF_MAX_FPS ? `gif plays at most ${GIF_MAX_FPS} fps, this will be ${GIF_MAX_FPS} fps` : '';
}

/** rough file size: lzw on dithered video frames lands near this many bytes per pixel */
const BYTES_PER_PIXEL = 0.12;

export function estimateGifBytes(width: number, height: number, frames: number): number {
  return Math.round(width * height * frames * BYTES_PER_PIXEL);
}

/** a warning for exports that will be huge, empty otherwise */
export function gifSizeWarning(width: number, height: number, frames: number): string {
  if (width * height * frames <= GIF_PIXEL_WARN) return '';
  return 'this gif will be very large and slow to make, try a smaller resolution, a lower frame rate or a shorter range';
}

/** frames sampled for the palette: evenly spread, at most `max` */
export function paletteSampleFrames(totalFrames: number, max = 24): number[] {
  const n = Math.max(1, Math.min(totalFrames, max));
  const out: number[] = [];
  for (let k = 0; k < n; k++) out.push(Math.min(totalFrames - 1, Math.floor(((k + 0.5) * totalFrames) / n)));
  return out;
}

/** size of the small canvas used for palette sampling (about 160 px wide) */
export function sampleSize(width: number, height: number, target = 160): { width: number; height: number } {
  const s = Math.min(1, target / Math.max(1, width));
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}
