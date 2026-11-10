/**
 * the camera inset of the scene view: a small picture of what the output looks like (what the project's camera
 * sees) in a corner of the preview. this file has the pure parts (size, pace) and the remembered on / off switch.
 * remembered in localStorage (wrapped in try/catch: it can be blocked).
 */
import { create } from 'zustand';
import { backingSize, type PreviewQuality } from './quality';

/** css width of the inset */
export const INSET_WIDTH = 240;
/** longest time between two inset renders while playing, ms (about 10 per second) */
export const INSET_INTERVAL_MS = 100;
/** while paused one more render follows an edit this long after it, so a late video frame or image shows up, ms */
export const INSET_SETTLE_MS = 250;

/** css size of the inset for a project: INSET_WIDTH wide, the project's aspect, at least 1 px per side */
export function insetCssSize(projW: number, projH: number): { w: number; h: number } {
  const aspect = projW > 0 && projH > 0 ? projH / projW : 9 / 16;
  return { w: INSET_WIDTH, h: Math.max(1, Math.round(INSET_WIDTH * aspect)) };
}

/** backing size of the inset canvas: css size x pixel ratio (at most 2), never above the project, then the preview quality */
export function insetBackingSize(projW: number, projH: number, dpr: number, quality: PreviewQuality): { w: number; h: number } {
  const css = insetCssSize(projW, projH);
  return backingSize(css.w, css.h, projW, projH, Math.min(2, dpr > 0 ? dpr : 1), quality);
}

/**
 * how long to wait before the next inset render, ms. paused: right away (0). playing: the rest of the interval
 * since the last render, so it never runs more than about 10 times a second.
 */
export function insetDelay(now: number, last: number, playing: boolean, interval = INSET_INTERVAL_MS): number {
  if (!playing) return 0;
  return Math.max(0, Math.min(interval, last + interval - now));
}

const KEY = 'ncut.scene.cameraInset';

export function parseInsetOn(v: unknown): boolean {
  return v !== '0' && v !== false;
}

function load(): boolean {
  try {
    return parseInsetOn(localStorage.getItem(KEY));
  } catch {
    return true;
  }
}

interface InsetState {
  on: boolean;
  toggle(): void;
}

export const useCameraInset = create<InsetState>((set, get) => ({
  on: load(),
  toggle() {
    const on = !get().on;
    try {
      localStorage.setItem(KEY, on ? '1' : '0');
    } catch {
      // storage is blocked: the choice still works for this session
    }
    set({ on });
  },
}));
