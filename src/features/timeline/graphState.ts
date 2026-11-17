/** the graph view's prefs (remembered in localStorage, try/catch: it can be blocked) and its session state (never saved) */
import { create } from 'zustand';
import type { KeyRef } from '../../store/ui';

export type GraphKind = 'value' | 'speed';
/** a window of shown units (or units per second) */
export interface Win { lo: number; hi: number }
export interface GraphPrefs { kind: GraphKind; autoFit: boolean }
export const DEFAULT_GRAPH: Readonly<GraphPrefs> = { kind: 'value', autoFit: true };
/** a fit the plot does at its next draw */
export type PendingFit = 'all' | 'selected' | null;
const KEY = 'ncut.timeline.graph';
const REF_EPS = 1e-4;

export function parseGraphPrefs(raw: unknown): GraphPrefs {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      v = null;
    }
  }
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  return { kind: o.kind === 'speed' ? 'speed' : 'value', autoFit: o.autoFit !== false };
}

function load(): GraphPrefs {
  try {
    return parseGraphPrefs(localStorage.getItem(KEY));
  } catch {
    return parseGraphPrefs(null);
  }
}

const sameWins = (a: Record<string, Win> | null, b: Record<string, Win> | null): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => b[k] !== undefined && a[k]!.lo === b[k]!.lo && a[k]!.hi === b[k]!.hi);
};

const sameKey = (a: KeyRef | null, b: KeyRef | null): boolean => a === b || (a !== null && b !== null && a.clipId === b.clipId && a.prop === b.prop && Math.abs(a.t - b.t) <= REF_EPS);

/** the clip id of a line id (laneId: clip id, a nul, the property) */
const clipOf = (id: string): string => {
  const i = id.indexOf('\u0000');
  return i < 0 ? id : id.slice(0, i);
};

interface GraphState extends GraphPrefs {
  /** lines that are switched off. never saved */
  hidden: ReadonlySet<string>;
  /** the line that is edited (a line id). never saved */
  active: string | null;
  activeKey: KeyRef | null;
  /** the plot's windows by line id. null = fit them */
  windows: Record<string, Win> | null;
  pendingFit: PendingFit;
  setKind(kind: GraphKind): void;
  /** turning it on also drops the windows */
  setAutoFit(on: boolean): void;
  toggleHidden(id: string): void;
  /** id shown and all others hidden: everything shows again, else only id shows. ids = every line id of the shown clips */
  showOnly(id: string, ids: readonly string[]): void;
  showAll(): void;
  setActive(id: string | null): void;
  setActiveKey(k: KeyRef | null): void;
  setWindows(w: Record<string, Win> | null): void;
  setPendingFit(f: PendingFit): void;
  /** forget lines of clips that are not in the list. windows stay */
  pruneTo(clipIds: readonly string[]): void;
}

export const useGraph = create<GraphState>((set, get) => {
  const savePrefs = (patch: Partial<GraphPrefs>) => {
    const s = get();
    if ((Object.keys(patch) as (keyof GraphPrefs)[]).every((k) => s[k] === patch[k])) return;
    set(patch);
    const n = get();
    // storage blocked: the choice still works for this session
    try {
      localStorage.setItem(KEY, JSON.stringify({ kind: n.kind, autoFit: n.autoFit }));
    } catch {
      /* ignore */
    }
  };
  return {
    ...load(),
    hidden: new Set<string>(),
    active: null,
    activeKey: null,
    windows: null,
    pendingFit: null,
    setKind: (kind) => savePrefs({ kind }),
    setAutoFit(on) {
      savePrefs({ autoFit: on });
      if (on && get().windows !== null) set({ windows: null });
    },
    toggleHidden(id) {
      const next = new Set(get().hidden);
      if (!next.delete(id)) next.add(id);
      set({ hidden: next });
    },
    showOnly(id, ids) {
      const h = get().hidden;
      const alone = !h.has(id) && ids.every((x) => x === id || h.has(x));
      const next = alone ? new Set<string>() : new Set(ids.filter((x) => x !== id));
      if (next.size === h.size && [...next].every((x) => h.has(x))) return;
      set({ hidden: next });
    },
    showAll() {
      if (get().hidden.size > 0) set({ hidden: new Set<string>() });
    },
    setActive(id) {
      if (get().active !== id) set({ active: id });
    },
    setActiveKey(k) {
      if (!sameKey(get().activeKey, k)) set({ activeKey: k });
    },
    setWindows(w) {
      if (!sameWins(get().windows, w)) set({ windows: w });
    },
    setPendingFit(f) {
      if (get().pendingFit !== f) set({ pendingFit: f });
    },
    pruneTo(clipIds) {
      const ok = new Set(clipIds);
      const s = get();
      const hidden = [...s.hidden].filter((id) => ok.has(clipOf(id)));
      const patch: Partial<GraphState> = {};
      if (hidden.length !== s.hidden.size) patch.hidden = new Set(hidden);
      if (s.active !== null && !ok.has(clipOf(s.active))) patch.active = null;
      if (s.activeKey !== null && !ok.has(s.activeKey.clipId)) patch.activeKey = null;
      if (Object.keys(patch).length > 0) set(patch);
    },
  };
});

/** dev counters for the proof page */
export const graphDebug = { draws: 0, lastDrawMs: 0, lines: 0, segments: 0 };
