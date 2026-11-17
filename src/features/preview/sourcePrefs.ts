/**
 * two source view prefs: side by side in the preview and the skim of the media cards.
 * remembered in localStorage (wrapped in try/catch: it can be blocked). out of useUi on purpose:
 * the preview engine redraws on any useUi change.
 */
import { create } from 'zustand';

const SIDE_KEY = 'ncut.preview.sideBySide';
const SKIM_KEY = 'ncut.media.skim';

/** 'on' is true, 'off' is false, anything else is the fallback */
export function parsePref(raw: unknown, fallback: boolean): boolean {
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  return fallback;
}

function load(key: string, fallback: boolean): boolean {
  try {
    return parsePref(localStorage.getItem(key), fallback);
  } catch {
    return fallback;
  }
}

function save(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? 'on' : 'off');
  } catch {
    // storage is blocked: the choice still works for this session
  }
}

interface SourcePrefs {
  sideBySide: boolean;
  skim: boolean;
  setSideBySide(on: boolean): void;
  toggleSideBySide(): void;
  setSkim(on: boolean): void;
  toggleSkim(): void;
}

export const useSourcePrefs = create<SourcePrefs>()((set, get) => ({
  sideBySide: load(SIDE_KEY, false),
  skim: load(SKIM_KEY, true),
  setSideBySide(on) {
    if (get().sideBySide === on) return;
    save(SIDE_KEY, on);
    set({ sideBySide: on });
  },
  toggleSideBySide() {
    get().setSideBySide(!get().sideBySide);
  },
  setSkim(on) {
    if (get().skim === on) return;
    save(SKIM_KEY, on);
    set({ skim: on });
  },
  toggleSkim() {
    get().setSkim(!get().skim);
  },
}));
