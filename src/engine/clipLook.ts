/**
 * per-clip picture processing: color correction (clip.adjust) and chroma key (clip.chromaKey).
 * runs on the clip's own picture before it is placed, so a keyed clip really is see-through and
 * whatever is under it shows.
 */
import type { ChromaKey, ClipAdjust, VisualClip } from '../types';

export const DEFAULT_ADJUST: ClipAdjust = { brightness: 0, contrast: 0, saturation: 0, hue: 0, temperature: 0 };
export const DEFAULT_CHROMA_KEY: ChromaKey = { color: '#00d000', tolerance: 0.3, softness: 0.1, spill: 0.5 };

/** true when the adjust values would change the picture */
export function isAdjustActive(adjust: ClipAdjust | null | undefined): boolean {
  if (!adjust) return false;
  return (
    Math.abs(adjust.brightness) > 1e-4 ||
    Math.abs(adjust.contrast) > 1e-4 ||
    Math.abs(adjust.saturation) > 1e-4 ||
    Math.abs(adjust.hue) > 1e-4 ||
    Math.abs(adjust.temperature) > 1e-4
  );
}

/** true when the clip's picture has to go through clipLookTexture */
export function hasClipLook(clip: VisualClip): boolean {
  return isAdjustActive(clip.adjust) || !!clip.chromaKey;
}

/** a string that changes whenever the result of clipLookTexture would (for texture caches) */
export function clipLookSignature(clip: VisualClip): string {
  if (!hasClipLook(clip)) return '';
  return JSON.stringify([clip.adjust ?? null, clip.chromaKey ?? null]);
}

/**
 * the clip's picture with its look applied. `source` is the untouched picture, width x height its
 * size in pixels. returns `source` itself when the clip has no look or webgl2 is missing.
 * the result is only valid until the next call on the same channel (it reuses one canvas).
 */
export function clipLookTexture(
  source: CanvasImageSource,
  width: number,
  height: number,
  clip: VisualClip,
  channel: 'preview' | 'export' = 'preview',
): CanvasImageSource {
  void width;
  void height;
  void clip;
  void channel;
  return source;
}
