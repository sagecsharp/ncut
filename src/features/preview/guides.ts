/**
 * view preference of the preview: the composition guides (thirds, center cross, title safe box).
 * guides are a css / svg overlay above the stage. they are never drawn into the canvas and never exported.
 * remembered in localStorage (wrapped in try/catch: it can be blocked).
 */
import { create } from 'zustand';

const KEY = 'ncut.preview.guides';

/** share of the frame inside the title safe box */
export const TITLE_SAFE = 0.9;

function load(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function save(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // storage is blocked: the toggle still works for this session
  }
}

interface GuidesState {
  on: boolean;
  toggle(): void;
}

export const useGuides = create<GuidesState>((set, get) => ({
  on: load(),
  toggle() {
    const on = !get().on;
    save(on);
    set({ on });
  },
}));

/** the lines of the guides in a 0..100 box: thirds, center cross and the title safe rectangle */
export function guideLines(): { v: number[]; h: number[]; safe: { x: number; y: number; w: number; h: number } } {
  const m = ((1 - TITLE_SAFE) / 2) * 100;
  return { v: [100 / 3, 50, 200 / 3], h: [100 / 3, 50, 200 / 3], safe: { x: m, y: m, w: 100 - 2 * m, h: 100 - 2 * m } };
}
