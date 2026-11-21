/**
 * folders on the projects screen: a name per folder and which project sits in which. one level, no folders in folders.
 * kept in localStorage (this machine, like the projects), apart from the projects themselves: a project file (.ncut)
 * carries no folder, and moving a project never rewrites it. the rules are pure; the store at the bottom reads and
 * writes them and lets react follow.
 */
import { useSyncExternalStore } from 'react';

export interface ProjectFolder {
  id: string;
  name: string;
  createdAt: number;
}

export interface FolderState {
  folders: ProjectFolder[];
  /** project id -> folder id. a project that is missing here (or points at a folder that is gone) is in no folder */
  of: Record<string, string>;
}

export const EMPTY_FOLDERS: FolderState = Object.freeze({ folders: [], of: {} }) as FolderState;

export const FOLDER_NAME_MAX = 60;
export const NEW_FOLDER_NAME = 'new folder';

/** a saved folder state, every part checked alone: bad folders and bad links are dropped, never the whole thing */
export function parseFolders(raw: string | null): FolderState {
  if (!raw) return EMPTY_FOLDERS;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return EMPTY_FOLDERS;
  }
  if (!o || typeof o !== 'object') return EMPTY_FOLDERS;
  const r = o as Record<string, unknown>;
  const folders: ProjectFolder[] = [];
  const seen = new Set<string>();
  if (Array.isArray(r.folders)) {
    for (const f of r.folders) {
      if (!f || typeof f !== 'object') continue;
      const x = f as Record<string, unknown>;
      if (typeof x.id !== 'string' || !x.id || seen.has(x.id) || typeof x.name !== 'string') continue;
      const name = cleanFolderName(x.name);
      if (!name) continue;
      seen.add(x.id);
      folders.push({ id: x.id, name, createdAt: typeof x.createdAt === 'number' && Number.isFinite(x.createdAt) ? x.createdAt : 0 });
    }
  }
  const of: Record<string, string> = {};
  if (r.of && typeof r.of === 'object' && !Array.isArray(r.of)) {
    for (const [pid, fid] of Object.entries(r.of as Record<string, unknown>)) {
      if (typeof fid === 'string' && seen.has(fid)) of[pid] = fid;
    }
  }
  return { folders, of };
}

/** a folder name as it is kept: one line, no outer spaces, at most FOLDER_NAME_MAX characters. '' = not a name */
export function cleanFolderName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, FOLDER_NAME_MAX).trim();
}

/** `base`, or `base 2`, `base 3` ... : the first that no folder has yet (case does not count) */
export function uniqueFolderName(state: FolderState, base = NEW_FOLDER_NAME): string {
  const clean = cleanFolderName(base) || NEW_FOLDER_NAME;
  const taken = new Set(state.folders.map((f) => f.name.toLowerCase()));
  if (!taken.has(clean.toLowerCase())) return clean;
  for (let n = 2; ; n++) {
    const name = `${clean} ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

export function addFolder(state: FolderState, id: string, name: string, now: number): FolderState {
  if (state.folders.some((f) => f.id === id)) return state;
  return { ...state, folders: [...state.folders, { id, name: uniqueFolderName(state, name), createdAt: now }] };
}

/** a rename to nothing, or to the name it has, changes nothing */
export function renameFolder(state: FolderState, id: string, name: string): FolderState {
  const clean = cleanFolderName(name);
  const f = state.folders.find((x) => x.id === id);
  if (!f || !clean || clean === f.name) return state;
  return { ...state, folders: state.folders.map((x) => (x.id === id ? { ...x, name: clean } : x)) };
}

/** the folder goes, its projects stay: they are in no folder after it */
export function removeFolder(state: FolderState, id: string): FolderState {
  if (!state.folders.some((f) => f.id === id)) return state;
  const of: Record<string, string> = {};
  for (const [pid, fid] of Object.entries(state.of)) if (fid !== id) of[pid] = fid;
  return { folders: state.folders.filter((f) => f.id !== id), of };
}

/** put projects in a folder, or in none (null). an unknown folder id changes nothing */
export function moveProjects(state: FolderState, projectIds: readonly string[], folderId: string | null): FolderState {
  if (folderId !== null && !state.folders.some((f) => f.id === folderId)) return state;
  let changed = false;
  const of = { ...state.of };
  for (const pid of projectIds) {
    if (folderId === null) {
      if (pid in of) {
        delete of[pid];
        changed = true;
      }
    } else if (of[pid] !== folderId) {
      of[pid] = folderId;
      changed = true;
    }
  }
  return changed ? { ...state, of } : state;
}

/** the links of projects that no longer exist go (the folders stay, also when empty) */
export function pruneFolders(state: FolderState, projectIds: readonly string[]): FolderState {
  const live = new Set(projectIds);
  const stale = Object.keys(state.of).filter((pid) => !live.has(pid));
  if (stale.length === 0) return state;
  const of = { ...state.of };
  for (const pid of stale) delete of[pid];
  return { ...state, of };
}

/** the folder a project is in, or null */
export function folderOf(state: FolderState, projectId: string): string | null {
  const fid = state.of[projectId];
  return fid !== undefined && state.folders.some((f) => f.id === fid) ? fid : null;
}

/** how many of these projects each folder holds */
export function folderCounts(state: FolderState, projectIds: readonly string[]): Map<string, number> {
  const out = new Map<string, number>(state.folders.map((f) => [f.id, 0]));
  for (const pid of projectIds) {
    const fid = folderOf(state, pid);
    if (fid !== null) out.set(fid, (out.get(fid) ?? 0) + 1);
  }
  return out;
}

/** folders by name, the way the screen lists them */
export function sortedFolders(state: FolderState): ProjectFolder[] {
  return [...state.folders].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

/* ---------- the store ---------- */

const KEY = 'ncut-project-folders';
let current: FolderState | null = null;
const listeners = new Set<() => void>();

function read(): FolderState {
  if (current) return current;
  try {
    current = parseFolders(localStorage.getItem(KEY));
  } catch {
    current = EMPTY_FOLDERS;
  }
  return current;
}

/** change the folders: one write, every subscriber hears it. a change to the same state writes nothing */
export function updateFolders(fn: (s: FolderState) => FolderState): void {
  const before = read();
  const next = fn(before);
  if (next === before) return;
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage full or blocked: the folders still work until the app closes
  }
  for (const l of Array.from(listeners)) l();
}

export function getFolders(): FolderState {
  return read();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useFolders(): FolderState {
  return useSyncExternalStore(subscribe, read, read);
}

export function newFolderId(): string {
  return `fld_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
