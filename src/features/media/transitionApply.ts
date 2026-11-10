import { DEFAULT_TRANSITION_DURATION, MAX_TRANSITION_DURATION, MIN_TRANSITION_DURATION, getTransition } from '../../engine/transitions/registry';
import type { Clip, Transition } from '../../types';

/**
 * the longest transition a cut allows: it sits half in each clip, so it can not be longer than the
 * shorter of the two (a clip with nothing before it only has its own length).
 */
export function cutLimit(clip: Clip, prev: Clip | null | undefined): number {
  return Math.min(MAX_TRANSITION_DURATION, clip.duration, prev ? prev.duration : Infinity);
}

/** a length kept inside the global range and inside what the cut allows (`limit` from cutLimit) */
export function clampToCut(duration: number, limit: number = MAX_TRANSITION_DURATION): number {
  const hi = Math.max(MIN_TRANSITION_DURATION, Math.min(limit, MAX_TRANSITION_DURATION));
  return Math.min(hi, Math.max(MIN_TRANSITION_DURATION, duration));
}

/**
 * the transition to store when `id` is applied to a clip: a tuned length is kept, a new one gets the default.
 * `limit` (optional, from cutLimit) keeps the length inside what the cut allows.
 */
export function transitionFor(id: string, current: Transition | null | undefined, limit?: number): Transition {
  const duration = current?.duration ?? DEFAULT_TRANSITION_DURATION;
  return { id, duration: limit === undefined ? duration : clampToCut(duration, limit) };
}

/* ---------- the transition that was used last (per browser) ---------- */

const KEY = 'ncut.lastTransition';
const FALLBACK_ID = 'cross-fade';

/** what is stored, read defensively: an unknown id or a bad length falls back to the plain fade / default length */
export function parseLastTransition(raw: string | null | undefined): Transition {
  const out: Transition = { id: FALLBACK_ID, duration: DEFAULT_TRANSITION_DURATION };
  if (!raw) return out;
  try {
    const o = JSON.parse(raw) as { id?: unknown; duration?: unknown } | null;
    if (o && typeof o === 'object') {
      if (typeof o.id === 'string' && getTransition(o.id)) out.id = o.id;
      if (typeof o.duration === 'number' && Number.isFinite(o.duration)) out.duration = clampToCut(o.duration);
    }
  } catch {
    // not json: defaults
  }
  return out;
}

let last: Transition | null = null;

/** the transition applied last (or the plain fade at the default length) */
export function lastTransition(): Transition {
  if (!last) {
    try {
      last = parseLastTransition(typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY));
    } catch {
      last = parseLastTransition(null);
    }
  }
  return last;
}

/** remember what was applied last. `duration` is optional: the id alone keeps the length */
export function rememberTransition(id: string, duration?: number): void {
  const prev = lastTransition();
  last = { id, duration: duration !== undefined && Number.isFinite(duration) ? clampToCut(duration) : prev.duration };
  try {
    localStorage.setItem(KEY, JSON.stringify(last));
  } catch {
    // private mode / full storage: kept in memory until the page reloads
  }
}
