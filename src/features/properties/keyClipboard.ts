import { useSyncExternalStore } from 'react';
import { animProps } from '../../lib/anim';
import type { Clip, Keyframe, Keyframes } from '../../types';
import { keySpan } from './keyTools';

/** copied keys: per property, keys whose t is an OFFSET from the first key of the whole set */
export type KeyClip = Keyframes;

/** deep copy of a clip's keyframes as offsets from the first key, or null when it has none */
export function captureKeys(kf: Keyframes | undefined): KeyClip | null {
  if (!kf) return null;
  const span = keySpan(kf);
  if (!span) return null;
  const out: KeyClip = {};
  for (const prop of Object.keys(kf)) {
    const keys = kf[prop]!;
    if (keys.length > 0) out[prop] = keys.map((k) => ({ t: k.t - span.lo, v: k.v, ease: k.ease }));
  }
  return out;
}

/**
 * the keys to write on a clip: the first key lands at `at` (clip-local, clamped into the clip), only
 * properties the clip can animate. empty record = nothing fits.
 */
export function placeKeys(copied: KeyClip, clip: Clip, at: number): Keyframes {
  const allowed = new Set(animProps(clip).map((p) => p.prop));
  const t0 = Math.min(Math.max(at, 0), clip.duration);
  const out: Keyframes = {};
  for (const prop of Object.keys(copied)) {
    if (!allowed.has(prop)) continue;
    const keys: Keyframe[] = copied[prop]!.map((k) => ({ t: t0 + k.t, v: k.v, ease: k.ease }));
    if (keys.length > 0) out[prop] = keys;
  }
  return out;
}

/* ---------- module level clipboard ---------- */

let current: KeyClip | null = null;
const listeners = new Set<() => void>();

export function setKeyClip(data: KeyClip | null): void {
  current = data;
  for (const l of listeners) l();
}

export function getKeyClip(): KeyClip | null {
  return current;
}

export function useKeyClipboard(): KeyClip | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getKeyClip,
    getKeyClip,
  );
}
