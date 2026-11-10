/**
 * preview quality: the canvas backing store is rendered at a fraction of the fitted resolution to save time.
 * the canvas css size does not change (the overlay math keeps working) and the export never reads this.
 * remembered in localStorage (wrapped in try/catch: it can be blocked).
 */
import { create } from 'zustand';

export type PreviewQuality = 'full' | 'half' | 'quarter';

export const QUALITIES: ReadonlyArray<{ id: PreviewQuality; scale: number; title: string }> = [
  { id: 'full', scale: 1, title: 'full resolution' },
  { id: 'half', scale: 0.5, title: 'half the resolution, faster' },
  { id: 'quarter', scale: 0.25, title: 'quarter of the resolution, fastest' },
];

const KEY = 'ncut.preview.quality';

export function parseQuality(v: unknown): PreviewQuality {
  return QUALITIES.some((q) => q.id === v) ? (v as PreviewQuality) : 'full';
}

export function qualityScale(q: PreviewQuality): number {
  return QUALITIES.find((x) => x.id === q)?.scale ?? 1;
}

/**
 * backing store size: css size x device pixel ratio, never more than the project resolution, then scaled by the
 * quality. at least 1 px per side.
 */
export function backingSize(cssW: number, cssH: number, projW: number, projH: number, dpr: number, quality: PreviewQuality): { w: number; h: number } {
  const k = Math.min(dpr > 0 ? dpr : 1, projW / cssW, projH / cssH) * qualityScale(quality);
  return { w: Math.max(1, Math.round(cssW * k)), h: Math.max(1, Math.round(cssH * k)) };
}

function load(): PreviewQuality {
  try {
    return parseQuality(localStorage.getItem(KEY));
  } catch {
    return 'full';
  }
}

function save(q: PreviewQuality): void {
  try {
    localStorage.setItem(KEY, q);
  } catch {
    // storage is blocked: the choice still works for this session
  }
}

interface QualityState {
  quality: PreviewQuality;
  setQuality(q: PreviewQuality): void;
}

export const usePreviewQuality = create<QualityState>((set) => ({
  quality: load(),
  setQuality(q) {
    save(q);
    set({ quality: q });
  },
}));
