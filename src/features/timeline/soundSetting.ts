/**
 * "separate sound on drop": a video with sound that is put on the timeline arrives as a picture and a sound clip.
 * kept per browser (localStorage), off by default. the mcp tools never read it.
 */
import { create } from 'zustand';

const KEY = 'ncut.sound.apart';

/** what is stored, read defensively: only 'on' turns it on */
export function parseSoundApart(raw: unknown): boolean {
  return raw === 'on';
}

function load(): boolean {
  try {
    return parseSoundApart(typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY));
  } catch {
    return false;
  }
}

interface SoundApartState {
  apart: boolean;
  setApart(on: boolean): void;
}

export const useSoundApart = create<SoundApartState>()((set, get) => ({
  apart: load(),
  setApart(on) {
    if (on === get().apart) return;
    set({ apart: on });
    try {
      localStorage.setItem(KEY, on ? 'on' : 'off');
    } catch {
      // storage is blocked: the choice still works until the page is closed
    }
  },
}));
