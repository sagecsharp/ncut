import { roundShown } from '../../components/ui/numberFormat';
import { DEFAULT_MASK } from '../../engine/mask';
import type { Mask, MaskShape } from '../../types';

/** plain names for the mask shapes, in menu order */
export const MASK_SHAPE_LABELS: [MaskShape, string][] = [
  ['rect', 'box'],
  ['ellipse', 'oval'],
  ['split', 'half'],
  ['band', 'strip'],
  ['star', 'star'],
  ['heart', 'heart'],
];

export type MaskKey = 'x' | 'y' | 'width' | 'height' | 'rotation' | 'feather' | 'radius';

/** slider range of each value as shown in the ui (percent, degrees) */
export const MASK_RANGES: Record<MaskKey, { min: number; max: number }> = {
  x: { min: -100, max: 100 },
  y: { min: -100, max: 100 },
  width: { min: 0, max: 200 },
  height: { min: 0, max: 200 },
  rotation: { min: -180, max: 180 },
  feather: { min: 0, max: 100 },
  radius: { min: 0, max: 100 },
};

/** which size / corner controls a shape uses (split and band ignore some, see types.ts Mask) */
export function maskFields(shape: MaskShape): { width: boolean; height: boolean; radius: boolean } {
  switch (shape) {
    case 'split':
      return { width: false, height: false, radius: false };
    case 'band':
      return { width: false, height: true, radius: false };
    case 'rect':
      return { width: true, height: true, radius: true };
    default:
      return { width: true, height: true, radius: false };
  }
}

const round4 = (v: number) => Number(v.toFixed(4));

/** the number shown in a field for a stored value (rotation is degrees, the rest percent) */
export function maskUiValue(mask: Mask, key: MaskKey): number {
  if (key === 'rotation') return roundShown(mask.rotation, 1);
  const stored = key === 'radius' ? (mask.radius ?? 0) : mask[key];
  return roundShown(stored * 100, 0);
}

/** the mask after one field is typed in (ui units). clamps to the ui range; radius 0 is stored as missing. */
export function setMaskValue(mask: Mask, key: MaskKey, ui: number): Mask {
  const { min, max } = MASK_RANGES[key];
  const v = Number.isFinite(ui) ? Math.min(max, Math.max(min, ui)) : 0;
  const next: Mask = { ...mask };
  if (key === 'rotation') next.rotation = round4(v);
  else if (key === 'radius') {
    if (v <= 0) delete next.radius;
    else next.radius = round4(v / 100);
  } else next[key] = round4(v / 100);
  return next;
}

/** switch the figure and keep the rest. the corner radius only belongs to boxes. */
export function setMaskShape(mask: Mask, shape: MaskShape): Mask {
  const next: Mask = { ...mask, shape };
  if (shape !== 'rect') delete next.radius;
  return next;
}

/** a fresh mask (a copy, never the shared default) */
export function newMask(): Mask {
  return { ...DEFAULT_MASK };
}
