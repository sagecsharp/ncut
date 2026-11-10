/**
 * the numbers a project card shows, kept per project in localStorage ('ncut.summary.<id>') so the projects
 * screen does not have to read every whole project out of indexeddb.
 *
 * a summary is derived data, always produced by summarize() from the project that was just stored:
 *  - saveProject drops the summary BEFORE the write starts and writes the new one after it committed, so a page
 *    that dies half way (or a write that fails) leaves no summary, never an old one next to a new project;
 *  - deleteProject drops it;
 *  - a missing, unreadable or malformed summary is never trusted: listProjects loads that project instead.
 * every function quietly does nothing when storage is blocked or full.
 */
import type { ProjectSummary } from '../types';

const PREFIX = 'ncut.summary.';
const VERSION = 1;

export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const summaryKey = (projectId: string): string => PREFIX + projectId;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function encodeSummary(s: ProjectSummary): string {
  return JSON.stringify({ v: VERSION, s });
}

const NUM_FIELDS = ['createdAt', 'updatedAt', 'width', 'height', 'fps', 'duration', 'clipCount'] as const;

/** the summary in `raw` when it is complete and belongs to `projectId`, else null */
export function decodeSummary(raw: string | null, projectId: string): ProjectSummary | null {
  if (!raw) return null;
  try {
    const o: unknown = JSON.parse(raw);
    if (!o || typeof o !== 'object') return null;
    const { v, s } = o as { v?: unknown; s?: unknown };
    if (v !== VERSION || !s || typeof s !== 'object') return null;
    const r = s as Record<string, unknown>;
    if (r.id !== projectId || typeof r.name !== 'string') return null;
    for (const f of NUM_FIELDS) if (typeof r[f] !== 'number' || !Number.isFinite(r[f])) return null;
    return {
      id: projectId,
      name: r.name,
      createdAt: r.createdAt as number,
      updatedAt: r.updatedAt as number,
      width: r.width as number,
      height: r.height as number,
      fps: r.fps as number,
      duration: r.duration as number,
      clipCount: r.clipCount as number,
    };
  } catch {
    return null;
  }
}

export function readSummary(projectId: string, storage: StorageLike | null = defaultStorage()): ProjectSummary | null {
  if (!storage) return null;
  try {
    return decodeSummary(storage.getItem(summaryKey(projectId)), projectId);
  } catch {
    return null;
  }
}

/** true when stored. on failure the old summary is removed too, so none is left that no longer matches. */
export function writeSummary(s: ProjectSummary, storage: StorageLike | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(summaryKey(s.id), encodeSummary(s));
    return true;
  } catch {
    removeSummary(s.id, storage);
    return false;
  }
}

/** write only when there is none yet (a listing that read an older project must not overwrite a newer save) */
export function writeSummaryIfMissing(s: ProjectSummary, storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    if (storage.getItem(summaryKey(s.id)) !== null) return;
  } catch {
    return;
  }
  writeSummary(s, storage);
}

export function removeSummary(projectId: string, storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(summaryKey(projectId));
  } catch {
    /* nothing to clean up */
  }
}

/** drops the summaries of projects that are not in `known` (they only take space). returns how many went. */
export function pruneSummaries(known: Iterable<string>, storage: StorageLike | null = defaultStorage()): number {
  if (!storage) return 0;
  try {
    const keep = new Set<string>(known);
    const drop: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(PREFIX) && !keep.has(k.slice(PREFIX.length))) drop.push(k);
    }
    for (const k of drop) storage.removeItem(k);
    return drop.length;
  } catch {
    return 0;
  }
}

/**
 * newest first. ties keep key (id) order, which is the order the whole-project read used to give
 * (the database hands projects out by key and the sort is stable).
 */
export function sortSummaries(list: ProjectSummary[]): ProjectSummary[] {
  return list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).sort((a, b) => b.updatedAt - a.updatedAt);
}
