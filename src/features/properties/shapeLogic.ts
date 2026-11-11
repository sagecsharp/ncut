import type { ShapeKind } from '../../types';
import { stretchX, stretchY } from '../../types';

export const SHAPE_LABELS: [ShapeKind, string][] = [
  ['rect', 'rectangle'],
  ['ellipse', 'ellipse'],
  ['triangle', 'triangle'],
  ['polygon', 'polygon'],
  ['star', 'star'],
  ['heart', 'heart'],
  ['arrow', 'arrow'],
  ['line', 'line'],
];

export const DEFAULT_POLYGON_POINTS = 6;
export const DEFAULT_STAR_POINTS = 5;
export const DEFAULT_STAR_INNER = 0.45;
export const DEFAULT_GRADIENT_ANGLE = 90;
export const DEFAULT_SHAPE_STROKE = { color: '#ffffff', width: 4 };

/** polygon and star have a number of corners */
export function hasPoints(kind: ShapeKind): boolean {
  return kind === 'polygon' || kind === 'star';
}

export function defaultPoints(kind: ShapeKind): number {
  return kind === 'star' ? DEFAULT_STAR_POINTS : DEFAULT_POLYGON_POINTS;
}

/** a second color that reads against the first: white on dark colors, black on light ones */
export function defaultSecondColor(color: string): string {
  let h = color.trim().replace('#', '');
  if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
  if (h.length < 6 || !/^[0-9a-f]+$/i.test(h)) return '#ffffff';
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  return luma < 128 ? '#ffffff' : '#000000';
}

/** scale that makes a box of (w x h) at `scale` cover a canvas (fill) or sit inside it (fit) */
export function coverScale(scale: number, boxW: number, boxH: number, canvasW: number, canvasH: number): number {
  if (boxW <= 0 || boxH <= 0) return scale;
  return scale * Math.max(canvasW / boxW, canvasH / boxH);
}

/**
 * thickness of a solid at scale 100% and no stretch, worked out from its box on the canvas: a box is as deep as it is
 * tall, the others as deep as they are wide. the box already has the scale and the stretch of its side in it.
 */
export function thicknessAtRest(
  shape: string | undefined,
  box: { width: number; height: number },
  t: { scale: number; scaleX?: number; scaleY?: number },
): number {
  const tall = shape === 'box';
  const side = tall ? box.height : box.width;
  const factor = Math.max(0.01, t.scale) * (tall ? stretchY(t) : stretchX(t));
  return Math.max(1, Math.round(side / factor));
}

/** the values fit and reset write to put the stretch back (writing 1 to a missing stretch changes nothing, see setValuesNow) */
export const STRETCH_REST = { scaleX: 1, scaleY: 1, scaleZ: 1 } as const;
