/**
 * real depth for 3d block text (TextExtrude on a text clip with threeD). the face is one plane, the side is a stack
 * of planes behind it along the clip's own z axis, all showing the same flat silhouette of the letters.
 * pure helpers only: how many planes, where they sit, how they fade, the cache key of the silhouette.
 */
import type { VisualClip } from '../types';
import { stretchZ } from '../types';
import { finite } from './text';

/** about one plane per this many project pixels of depth */
export const SIDE_PX = 2;
export const SIDE_MIN = 4;
export const SIDE_MAX = 48;

/** true when a clip is drawn as a face plus a stack of side planes: a 3d text with an extrude, as a flat plane */
export function hasTextDepth(clip: VisualClip): boolean {
  return clip.type === 'text' && !!clip.threeD && !!clip.extrude && clip.extrude.depth > 0 && (clip.shape ?? 'plane') === 'plane';
}

/** how far the side reaches back, in project pixels: depth x font size x the clip's scale x its depth stretch (scaleZ) (depth is capped at 1 like the texture room) */
export function depthPixels(clip: VisualClip): number {
  if (clip.type !== 'text' || !clip.extrude) return 0;
  return finite(Math.max(0, Math.min(1, finite(clip.extrude.depth))) * finite(clip.fontSize) * finite(clip.transform.scale) * stretchZ(clip.transform));
}

/** number of side planes for a depth in pixels: one per SIDE_PX, at least SIDE_MIN, at most SIDE_MAX (0 for no depth) */
export function sideCount(depthPx: number): number {
  if (!(depthPx > 0)) return 0;
  return Math.min(SIDE_MAX, Math.max(SIDE_MIN, Math.ceil(depthPx / SIDE_PX)));
}

/**
 * the z offset of every side plane behind the face (+ is away from the viewer along the clip's z axis), from the
 * farthest to the nearest. the last one is one step behind the face, the first sits at the full depth.
 */
export function sideOffsets(depthPx: number): number[] {
  const n = sideCount(depthPx);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((depthPx * (n - i)) / n);
  return out;
}

/**
 * the plane alpha of the side planes: the clip's opacity, clamped. the stack is not corrected here: the renderer
 * (Plane3D.stack) turns every texel into the per-plane alpha that makes the n planes composite to texel alpha x this
 * opacity, so the side composites to the clip's opacity (not its square) and keeps the soft edges of the picture.
 * the face composites over it at the same opacity, so where letters are fully opaque a faded clip shows the side
 * colour through the face a little (a group fade is not possible per plane).
 */
export function sideAlpha(alpha: number): number {
  if (!(alpha > 0)) return 0;
  return alpha >= 1 ? 1 : alpha;
}

/** cache key of the silhouette texture: the text signature (it holds the side colour and depth) + 'side' */
export function sideSignature(faceSig: string, color: string): string {
  return faceSig + '|side|' + color;
}

/** true when the silhouette can be made from the face picture by tinting it (no shadow or background box would come along) */
export function canTintFace(clip: { shadow?: unknown; background?: string | null; highlight?: { background?: unknown } | null }): boolean {
  return !clip.shadow && !clip.background && !clip.highlight?.background;
}
