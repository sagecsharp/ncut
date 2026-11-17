/* the maths of a field that edits several clips at once. pure. */
import { formatNumber } from '../../components/ui/numberFormat';
import { unitText } from '../../components/ui/sliderMath';

export type MultiMode = 'add' | 'times';

/** values a parent hands to a child (engine/parent.ts: position adds, rotation adds, uniform scale multiplies; opacity does not) */
export const INHERITED_PROPS: ReadonlySet<string> = new Set(['x', 'y', 'z', 'rotation', 'rotX', 'rotY', 'scale']);

/**
 * what one clip gets in stored units. add: start + (to - from) / scale. times: start * to / from,
 * falling back to add when from <= 0. the store clamps it per clip afterwards.
 */
export function multiValue(mode: MultiMode, start: number, from: number, to: number, scale: number): number {
  if (mode === 'times' && from > 0) return (start * to) / from;
  return start + (to - from) / scale;
}

/** the shared shown value when every value shows the same text (formatNumber at this precision), else null. [] = null */
export function sharedShown(shownValues: readonly number[], precision: number): number | null {
  if (shownValues.length === 0) return null;
  const first = shownValues[0]!;
  const text = formatNumber(first, precision);
  for (let i = 1; i < shownValues.length; i++) if (formatNumber(shownValues[i]!, precision) !== text) return null;
  return first;
}

/** the text a mixed field shows while dragged: "+12 px", "-4.5 deg", "+0%", "x1.25" (times: to / from, 2 decimals, zeros cut) */
export function deltaText(mode: MultiMode, from: number, to: number, precision: number, unit: string): string {
  if (mode === 'times' && from > 0) return `x${formatNumber(to / from, 0)}`;
  const t = formatNumber(to - from, precision);
  return unitText(t.startsWith('-') ? t : `+${t}`, unit);
}
