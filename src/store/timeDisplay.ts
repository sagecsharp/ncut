import { create } from 'zustand';
import type { TimeDisplay } from '../lib/time';

const KEY = 'ncut.time.display';

export const TIME_DISPLAYS: ReadonlyArray<{ id: TimeDisplay; label: string; title: string }> = [
  { id: 'timecode', label: 'timecode', title: 'hours:minutes:seconds:frames' },
  { id: 'frames', label: 'frames', title: 'the frame number' },
  { id: 'seconds', label: 'seconds', title: 'seconds with the part of a second' },
];

export function parseTimeDisplay(v: unknown): TimeDisplay {
  return v === 'frames' || v === 'seconds' ? v : 'timecode';
}

function load(): TimeDisplay {
  try {
    return parseTimeDisplay(localStorage.getItem(KEY));
  } catch {
    return 'timecode';
  }
}

function save(m: TimeDisplay): void {
  try {
    localStorage.setItem(KEY, m);
  } catch {
    /* blocked: works for this session */
  }
}

interface TimeDisplayState {
  mode: TimeDisplay;
  setMode(m: TimeDisplay): void;
}

export const useTimeDisplay = create<TimeDisplayState>((set, get) => ({
  mode: load(),
  setMode(m) {
    if (m === get().mode) return;
    save(m);
    set({ mode: m });
  },
}));
