import { roundShown } from '../../components/ui/numberFormat';
import type { BlendMode, Crop } from '../../types';

/** plain names for the blend modes, in menu order */
export const BLEND_LABELS: [BlendMode, string][] = [
  ['normal', 'normal'],
  ['add', 'add'],
  ['screen', 'screen'],
  ['multiply', 'multiply'],
  ['overlay', 'overlay'],
  ['darken', 'darken'],
  ['lighten', 'lighten'],
  ['difference', 'difference'],
];

export type CropEdge = keyof Crop;

/** one edge never cuts more than this (percent) */
export const MAX_CROP_EDGE = 95;
/** two opposite edges together never cut more than this (percent) */
export const MAX_CROP_PAIR = 99;

const OPPOSITE: Record<CropEdge, CropEdge> = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };

const round4 = (v: number) => Number(v.toFixed(4));

/** percent shown in a field for a stored fraction */
export function cropPercent(crop: Crop | null | undefined, edge: CropEdge): number {
  return roundShown((crop?.[edge] ?? 0) * 100, 1);
}

/** the biggest percent an edge may take right now (the opposite edge keeps its share) */
export function maxCropPercent(crop: Crop | null | undefined, edge: CropEdge): number {
  const other = cropPercent(crop, OPPOSITE[edge]);
  return Math.max(0, Math.min(MAX_CROP_EDGE, MAX_CROP_PAIR - other));
}

/**
 * the crop after one edge is typed in as a percent. keeps 0..95 per edge and left + right, top + bottom
 * at 99 or less. returns null when every edge is back to 0 (a clip without a crop has none).
 */
export function setCropEdge(crop: Crop | null | undefined, edge: CropEdge, percent: number): Crop | null {
  const next: Crop = { left: crop?.left ?? 0, top: crop?.top ?? 0, right: crop?.right ?? 0, bottom: crop?.bottom ?? 0 };
  const v = Number.isFinite(percent) ? Math.min(Math.max(0, percent), maxCropPercent(crop, edge)) : 0;
  next[edge] = round4(v / 100);
  return next.left === 0 && next.top === 0 && next.right === 0 && next.bottom === 0 ? null : next;
}
