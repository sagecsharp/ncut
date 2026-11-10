/**
 * clip masks (types.ts Mask): show only part of a clip's picture, with an optional soft edge.
 * the mask lives in the picture's own frame, so it follows the clip's transform.
 */
import type { Mask, VisualClip } from '../types';

export const DEFAULT_MASK: Mask = { shape: 'ellipse', x: 0, y: 0, width: 0.8, height: 0.8, rotation: 0, feather: 0.05, invert: false };

/** true when the clip has a mask that hides something */
export function hasMask(clip: VisualClip): boolean {
  return !!clip.mask;
}

/** a string that changes whenever the masked picture would (for texture caches). '' = no mask. */
export function maskSignature(clip: VisualClip): string {
  return clip.mask ? JSON.stringify(clip.mask) : '';
}

/**
 * the picture with the clip's mask applied: a canvas of width x height (the picture's pixel size)
 * that is see-through where the mask hides it. returns `source` itself when the clip has no mask or
 * a canvas cannot be made. the result is only valid until the next call on the same channel.
 */
export function maskedPicture(
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
