/** the scopes strip's view prefs, remembered in localStorage (try/catch: it can be blocked), never in the project */
import { create } from 'zustand';

export type ScopeKind = 'waveform' | 'parade' | 'vectorscope' | 'histogram';
/** the order the cells are drawn in */
export const SCOPE_KINDS: readonly ScopeKind[] = ['waveform', 'parade', 'vectorscope', 'histogram'];
export const SIDE_WIDTH_DEFAULT = 300,
  BELOW_HEIGHT_DEFAULT = 220,
  SIZE_MIN = 120,
  SIZE_MAX = 2000;

export interface ScopesPrefs {
  open: boolean;
  /** shown kinds in drawing order, 1 to 4, never empty */
  kinds: ScopeKind[];
  exact: boolean;
  vectorZoom: 1 | 2;
  sideWidth: number;
  belowHeight: number;
}

export const DEFAULT_SCOPES: Readonly<ScopesPrefs> = {
  open: false,
  kinds: ['waveform', 'vectorscope'],
  exact: false,
  vectorZoom: 1,
  sideWidth: SIDE_WIDTH_DEFAULT,
  belowHeight: BELOW_HEIGHT_DEFAULT,
};
const KEY = 'ncut.preview.scopes';

const sizeOf = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(SIZE_MAX, Math.max(SIZE_MIN, v))) : d);

/** the known kinds of a list, once each, in drawing order */
export const shownInOrder = (kinds: readonly unknown[]): ScopeKind[] => SCOPE_KINDS.filter((k) => kinds.includes(k));

export function parseScopesPrefs(raw: unknown): ScopesPrefs {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      v = null;
    }
  }
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const kinds = Array.isArray(o.kinds) ? shownInOrder(o.kinds) : [];
  return {
    open: o.open === true,
    kinds: kinds.length > 0 ? kinds : [...DEFAULT_SCOPES.kinds],
    exact: o.exact === true,
    vectorZoom: o.vectorZoom === 2 ? 2 : 1,
    sideWidth: sizeOf(o.sideWidth, SIDE_WIDTH_DEFAULT),
    belowHeight: sizeOf(o.belowHeight, BELOW_HEIGHT_DEFAULT),
  };
}

/** a click on a kind button: a hidden kind shows, a shown one goes unless it is the last */
export function toggleKindIn(kinds: readonly ScopeKind[], kind: ScopeKind): ScopeKind[] {
  if (!kinds.includes(kind)) return shownInOrder([...kinds, kind]);
  return kinds.length > 1 ? kinds.filter((k) => k !== kind) : [...kinds];
}

/** make sure a kind shows, never hide one */
export const ensureKind = (kinds: readonly ScopeKind[], kind: ScopeKind): ScopeKind[] => shownInOrder([...kinds, kind]);

function load(): ScopesPrefs {
  try {
    return parseScopesPrefs(localStorage.getItem(KEY));
  } catch {
    return parseScopesPrefs(null);
  }
}

interface ScopesState extends ScopesPrefs {
  toggleOpen(): void;
  setOpen(open: boolean): void;
  toggleKind(kind: ScopeKind): void;
  /** shows a kind and opens the strip */
  showKind(kind: ScopeKind): void;
  setExact(exact: boolean): void;
  setVectorZoom(zoom: 1 | 2): void;
  setSideWidth(px: number): void;
  setBelowHeight(px: number): void;
}

export const useScopes = create<ScopesState>((set, get) => {
  const save = (patch: Partial<ScopesPrefs>) => {
    set(patch);
    const s = get();
    const prefs: ScopesPrefs = { open: s.open, kinds: s.kinds, exact: s.exact, vectorZoom: s.vectorZoom, sideWidth: s.sideWidth, belowHeight: s.belowHeight };
    // storage blocked: the choice still works for this session
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      /* ignore */
    }
  };
  return {
    ...load(),
    toggleOpen: () => save({ open: !get().open }),
    setOpen: (open) => save({ open }),
    toggleKind: (kind) => save({ kinds: toggleKindIn(get().kinds, kind) }),
    showKind: (kind) => save({ open: true, kinds: ensureKind(get().kinds, kind) }),
    setExact: (exact) => save({ exact }),
    setVectorZoom: (vectorZoom) => save({ vectorZoom }),
    setSideWidth: (px) => save({ sideWidth: sizeOf(px, SIDE_WIDTH_DEFAULT) }),
    setBelowHeight: (px) => save({ belowHeight: sizeOf(px, BELOW_HEIGHT_DEFAULT) }),
  };
});
