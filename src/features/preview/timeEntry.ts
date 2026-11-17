/**
 * the open request of the typed time field: a tiny external store. the field (TimeField) mounts and registers,
 * the keys and the search row ask it to open.
 */
import { useUi } from '../../store/ui';
import { keysOnTimeline } from '../timeline/nudgeActions';
import { reasonFor, reasonSnapshot } from '../shell/reasons';
import { ENTRY_TEXT } from './timeEntryPlan';

export type EntryFrom = 'playhead' | 'timeline';
/** n counts opens */
export interface EntryRequest {
  from: EntryFrom;
  n: number;
  returnTo: HTMLElement | null;
}

let req: EntryRequest | null = null;
let fields = 0;
let opens = 0;
const subs = new Set<() => void>();
const notify = () => {
  for (const f of subs) f();
};

/** false when no time field is mounted */
export function openTimeEntry(from: EntryFrom, returnTo: HTMLElement | null = null): boolean {
  if (fields === 0) return false;
  req = { from, n: ++opens, returnTo };
  notify();
  return true;
}

export function closeTimeEntry(): void {
  if (!req) return;
  req = null;
  notify();
}

export function getTimeEntry(): EntryRequest | null {
  return req;
}

export function subscribeTimeEntry(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** TimeField on mount. the last unmount closes the request */
export function registerTimeField(): () => void {
  fields++;
  return () => {
    fields = Math.max(0, fields - 1);
    if (fields === 0) closeTimeEntry();
  };
}

export function goToTime(from: EntryFrom, returnTo: HTMLElement | null = null): void {
  const why = reasonFor('go-to-time', reasonSnapshot());
  if (why) useUi.getState().toast(why);
  else if (!openTimeEntry(from, returnTo)) useUi.getState().toast(ENTRY_TEXT.noField);
}

export function goToTimeKey(e: KeyboardEvent): void {
  const t = e.target;
  const back = typeof HTMLElement !== 'undefined' && t instanceof HTMLElement && t !== document.body && t.tabIndex >= 0 ? t : null;
  goToTime(keysOnTimeline(t) ? 'timeline' : 'playhead', back);
}
