/**
 * starred effects and transitions: a "favorites" group at the top of their tabs. kept per browser
 * (localStorage), not in the project.
 */
import { create } from 'zustand';

export type FavoriteKind = 'effects' | 'transitions';
export type Favorites = Record<FavoriteKind, string[]>;

const KEY = 'ncut.favorites';

/** what is stored, read defensively: anything odd is dropped, ids are unique, order = the order they were starred */
export function parseFavorites(raw: string | null | undefined): Favorites {
  const out: Favorites = { effects: [], transitions: [] };
  if (!raw) return out;
  try {
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== 'object') return out;
    const list = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0))] : []);
    const r = o as Record<string, unknown>;
    out.effects = list(r.effects);
    out.transitions = list(r.transitions);
  } catch {
    // not json: start empty
  }
  return out;
}

/** the list with the id added at the end, or taken out when it was in */
export function toggleIn(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/** the starred items that still exist (and pass `match`), in the order they were starred */
export function pickFavorites<T extends { id: string }>(ids: readonly string[], all: readonly T[], match: (item: T) => boolean = () => true): T[] {
  if (ids.length === 0) return [];
  const byId = new Map(all.map((item) => [item.id, item]));
  const out: T[] = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (item && match(item)) out.push(item);
  }
  return out;
}

function load(): Favorites {
  try {
    return parseFavorites(typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY));
  } catch {
    return parseFavorites(null);
  }
}

export const useFavorites = create<Favorites>(() => load());

export function toggleFavorite(kind: FavoriteKind, id: string): void {
  const next = { ...useFavorites.getState(), [kind]: toggleIn(useFavorites.getState()[kind], id) };
  useFavorites.setState(next);
  try {
    localStorage.setItem(KEY, JSON.stringify({ effects: next.effects, transitions: next.transitions }));
  } catch {
    // private mode / full storage: the star still works until the page reloads
  }
}
