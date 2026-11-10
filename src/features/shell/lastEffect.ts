import { getEffect } from '../../engine/effects/registry';

const KEY = 'ncut.lastEffect';
const FALLBACK = 'shake';

let last: string | null = null;

/** id of the effect the "e" shortcut adds. remembered across sessions, defaults to shake. */
export function getLastEffect(): string {
  if (last === null) {
    try {
      last = localStorage.getItem(KEY);
    } catch {
      last = null;
    }
  }
  return last && getEffect(last) ? last : FALLBACK;
}

/** call when an effect is added from anywhere, so "e" repeats it */
export function setLastEffect(id: string): void {
  if (!getEffect(id)) return;
  last = id;
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* storage can be blocked */
  }
}
