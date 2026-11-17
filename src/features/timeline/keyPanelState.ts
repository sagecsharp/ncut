/** the keyframe panel's view prefs, remembered in localStorage (try/catch: it can be blocked), never in the project */
import { create } from 'zustand';
import { useUi } from '../../store/ui';
import { LAYOUT_RESET_EVENT } from '../editor/layoutReset';

export type KeyPanelMode = 'keys' | 'graph';

export const KEY_PANEL_H_DEFAULT = 160,
  GRAPH_H_DEFAULT = 260,
  KEY_PANEL_H_MIN = 72,
  KEY_PANEL_H_MAX = 2000;

export interface KeyPanelPrefs {
  open: boolean;
  mode: KeyPanelMode;
  /** height of the keys view, whole px */
  height: number;
  /** height of the graph view, whole px */
  graphHeight: number;
}

export const DEFAULT_KEY_PANEL: Readonly<KeyPanelPrefs> = { open: false, mode: 'keys', height: KEY_PANEL_H_DEFAULT, graphHeight: GRAPH_H_DEFAULT };
const KEY = 'ncut.timeline.keyPanel';

const sizeOf = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(KEY_PANEL_H_MAX, Math.max(KEY_PANEL_H_MIN, v))) : d);

export function parseKeyPanelPrefs(raw: unknown): KeyPanelPrefs {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      v = null;
    }
  }
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  return {
    open: o.open === true,
    mode: o.mode === 'graph' ? 'graph' : 'keys',
    height: sizeOf(o.height, KEY_PANEL_H_DEFAULT),
    graphHeight: sizeOf(o.graphHeight, GRAPH_H_DEFAULT),
  };
}

/** the height of the shown view */
export const keyPanelHeight = (p: KeyPanelPrefs): number => (p.mode === 'graph' ? p.graphHeight : p.height);

function load(): KeyPanelPrefs {
  try {
    return parseKeyPanelPrefs(localStorage.getItem(KEY));
  } catch {
    return parseKeyPanelPrefs(null);
  }
}

interface KeyPanelState extends KeyPanelPrefs {
  toggle(): void;
  setOpen(open: boolean): void;
  setMode(mode: KeyPanelMode): void;
  /** the shown view's height. NaN changes nothing */
  setHeight(px: number): void;
  /** both heights go back to their defaults. open and mode stay */
  resetHeight(): void;
}

export const useKeyPanel = create<KeyPanelState>((set, get) => {
  const save = (patch: Partial<KeyPanelPrefs>) => {
    const s = get();
    if ((Object.keys(patch) as (keyof KeyPanelPrefs)[]).every((k) => s[k] === patch[k])) return;
    set(patch);
    const n = get();
    const prefs: KeyPanelPrefs = { open: n.open, mode: n.mode, height: n.height, graphHeight: n.graphHeight };
    // storage blocked: the choice still works for this session
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      /* ignore */
    }
  };
  return {
    ...load(),
    toggle: () => save({ open: !get().open }),
    setOpen: (open) => save({ open }),
    setMode: (mode) => save({ mode }),
    setHeight(px) {
      if (!Number.isFinite(px)) return;
      save(get().mode === 'graph' ? { graphHeight: sizeOf(px, GRAPH_H_DEFAULT) } : { height: sizeOf(px, KEY_PANEL_H_DEFAULT) });
    },
    resetHeight: () => save({ height: KEY_PANEL_H_DEFAULT, graphHeight: GRAPH_H_DEFAULT }),
  };
});

/** dev counters for the proof page */
export const keyPanelDebug = { draws: 0, lastDrawMs: 0, rows: 0 };

/** the focus is in the keyframe panel and it is open: delete, copy, paste, select all, esc and alt+arrows work on keyframes */
export function keyPanelHasKeys(): boolean {
  return useUi.getState().keyFocus && useKeyPanel.getState().open;
}

if (typeof window !== 'undefined') window.addEventListener(LAYOUT_RESET_EVENT, () => useKeyPanel.getState().resetHeight());
