/**
 * app appearance: black / white theme (auto follows the system) and an optional color tint.
 * stored in localStorage (it is an app setting, not part of a project) and applied to <html>
 * as data-theme + the --tint-h / --tint-s custom properties that styles/theme.css is built on.
 */
import { create } from 'zustand';
import { clamp } from './time';

export type ThemeMode = 'auto' | 'dark' | 'light';

export interface Appearance {
  mode: ThemeMode;
  /** tint hue in degrees, 0..360 */
  tintHue: number;
  /** tint strength in percent, 0 = pure monochrome */
  tintStrength: number;
}

export interface TintPreset {
  id: string;
  label: string;
  hue: number;
  strength: number;
}

export const TINT_PRESETS: TintPreset[] = [
  { id: 'none', label: 'none', hue: 150, strength: 0 },
  { id: 'mint', label: 'mint', hue: 150, strength: 60 },
  { id: 'teal', label: 'teal', hue: 195, strength: 60 },
  { id: 'blue', label: 'blue', hue: 255, strength: 60 },
  { id: 'violet', label: 'violet', hue: 300, strength: 60 },
  { id: 'rose', label: 'rose', hue: 10, strength: 60 },
  { id: 'amber', label: 'amber', hue: 75, strength: 60 },
];

/** fired on window after the theme or tint changed, so canvases can re-read the tokens */
export const APPEARANCE_EVENT = 'ncut:appearance';

const STORAGE_KEY = 'ncut.appearance';
const DEFAULTS: Appearance = { mode: 'auto', tintHue: 150, tintStrength: 0 };

function load(): Appearance {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<Appearance>;
    return {
      mode: p.mode === 'dark' || p.mode === 'light' || p.mode === 'auto' ? p.mode : DEFAULTS.mode,
      tintHue: clamp(Number(p.tintHue) || 0, 0, 360),
      tintStrength: clamp(Number(p.tintStrength) || 0, 0, 100),
    };
  } catch {
    return DEFAULTS;
  }
}

function systemPrefersLight(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;
}

/** the theme actually shown for a mode */
export function resolveTheme(mode: ThemeMode): 'dark' | 'light' {
  if (mode === 'auto') return systemPrefersLight() ? 'light' : 'dark';
  return mode;
}

function apply(a: Appearance): void {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(a.mode);
  root.style.setProperty('--tint-h', String(a.tintHue));
  root.style.setProperty('--tint-s', String(a.tintStrength / 100));
  window.dispatchEvent(new Event(APPEARANCE_EVENT));
}

export interface AppearanceState extends Appearance {
  setAppearance(patch: Partial<Appearance>): void;
}

export const useAppearance = create<AppearanceState>()((set, get) => ({
  ...DEFAULTS,
  setAppearance(patch) {
    const next: Appearance = {
      mode: patch.mode ?? get().mode,
      tintHue: clamp(patch.tintHue ?? get().tintHue, 0, 360),
      tintStrength: clamp(patch.tintStrength ?? get().tintStrength, 0, 100),
    };
    set(next);
    apply(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  },
}));

let started = false;

/** call once before the first render: applies the saved appearance and follows system changes. */
export function initAppearance(): void {
  if (started) return;
  started = true;
  const initial = load();
  useAppearance.setState(initial);
  apply(initial);
  if (typeof matchMedia === 'function') {
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      const s = useAppearance.getState();
      if (s.mode === 'auto') apply(s);
    });
  }
}
