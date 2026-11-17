/** which panes the preview shows: the source view, the output, or both side by side. pure */
import type { PreviewMode, ProgramMode } from '../../store/ui';

/** side by side needs the views row at least this wide (px) */
export const SPLIT_MIN_W = 720;

export interface LayoutIn {
  mode: PreviewMode;
  programMode: ProgramMode;
  sideBySide: boolean;
  hasMedia: boolean;
  width: number;
}

export function paneLayout(o: LayoutIn): { source: boolean; main: boolean; split: boolean } {
  const split = o.sideBySide && o.hasMedia && o.mode !== 'scene' && o.programMode === 'output' && o.width >= SPLIT_MIN_W;
  if (split) return { source: true, main: true, split: true };
  return o.mode === 'source' ? { source: true, main: false, split: false } : { source: false, main: true, split: false };
}

/** why side by side is on but not shown, in this order. null: it is shown, or it is off */
export function splitBlock(o: LayoutIn): 'scene' | 'empty' | 'narrow' | null {
  if (!o.sideBySide || paneLayout(o).split) return null;
  if (o.mode === 'scene' || o.programMode !== 'output') return 'scene';
  if (!o.hasMedia) return 'empty';
  return 'narrow';
}
