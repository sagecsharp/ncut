import { useSyncExternalStore } from 'react';
import type { ClipGrade } from '../../types';

export interface GradeCopy {
  grade: ClipGrade;
  /** the name of the clip it came from, for the toast */
  name: string;
}

/* module level clipboard, like lookClipboard */

let current: GradeCopy | null = null;
const listeners = new Set<() => void>();

/** keeps a deep copy, so later edits to the clip do not leak in */
export function setGradeCopy(grade: ClipGrade, name: string): void {
  current = { grade: structuredClone(grade), name };
  for (const l of listeners) l();
}

/** the same object until the next set */
export function getGradeCopy(): GradeCopy | null {
  return current;
}

export function hasGradeCopy(): boolean {
  return current !== null;
}

export function useGradeCopy(): GradeCopy | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getGradeCopy,
    getGradeCopy,
  );
}
