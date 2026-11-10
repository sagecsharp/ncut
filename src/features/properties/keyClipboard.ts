import { useSyncExternalStore } from 'react';
import { getEffect } from '../../engine/effects/registry';
import { animProps, evalKeys } from '../../lib/anim';
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
  // an effect's own settings are keyed as p.<name>: they fit when the effect has that setting
  const params = clip.type === 'effect' ? new Set((getEffect(clip.effect)?.params ?? []).map((q) => 'p.' + q.key)) : null;
  const t0 = Math.min(Math.max(at, 0), clip.duration);
  const out: Keyframes = {};
  for (const prop of Object.keys(copied)) {
    if (!allowed.has(prop) && !params?.has(prop)) continue;
    const all: Keyframe[] = copied[prop]!.map((k) => ({ t: t0 + k.t, v: k.v, ease: k.ease }));
    // keys that would land after the clip's end are left out, nobody would ever see them. but they shape the
    // curve inside the clip: a key at the very end holds the value the full animation has there
    const keys = all.filter((k) => k.t <= clip.duration + 1e-6);
    if (keys.length === 0) continue;
    const last = keys[keys.length - 1]!;
    if (keys.length < all.length && clip.duration - last.t > 1e-3) keys.push({ t: clip.duration, v: evalKeys(all, clip.duration), ease: 'linear' });
    out[prop] = keys;
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
