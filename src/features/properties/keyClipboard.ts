import { useSyncExternalStore } from 'react';
import { getEffect } from '../../engine/effects/registry';
import { animProps, canKey, evalKeys } from '../../lib/anim';
import { handlesOf, splitBezierAt } from '../../lib/keyBezier';
import type { KeyRef } from '../../store/ui';
import type { Clip, Keyframe, Keyframes, Project } from '../../types';
import { refIndex, shownKeyClips } from '../timeline/keySelection';
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
    if (keys.length > 0) out[prop] = keys.map((k) => ({ t: k.t - span.lo, v: k.v, ease: k.ease, ...handlesOf(k) }));
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
    const all: Keyframe[] = copied[prop]!.map((k) => ({ t: t0 + k.t, v: k.v, ease: k.ease, ...handlesOf(k) }));
    // keys that would land after the clip's end are left out, nobody would ever see them. but they shape the
    // curve inside the clip: a key at the very end holds the value the full animation has there
    let keys = all.filter((k) => k.t <= clip.duration + 1e-6);
    if (keys.length === 0) continue;
    const last = keys[keys.length - 1]!;
    if (keys.length < all.length && clip.duration - last.t > 1e-3) {
      // a custom part is cut on the curve itself: the last kept key is its split copy, the end key starts where the cut is
      const split = last.ease === 'bezier' ? splitBezierAt(all, clip.duration) : null;
      const at = split ? split.findIndex((k) => k.t === clip.duration) : -1;
      if (split && at > 0) {
        const mid = split[at]!;
        keys = [...split.slice(0, at), { t: clip.duration, v: mid.v, ease: 'linear', ...(mid.in ? { in: mid.in } : null) }];
      } else keys.push({ t: clip.duration, v: evalKeys(all, clip.duration, clip, prop), ease: 'linear' });
    }
    out[prop] = keys;
  }
  return out;
}

/** copied keys of the keyframe panel: one item per clip, keys as offsets from the earliest copied key on the timeline */
export interface KeyCopyItem { clipId: string; keys: KeyClip }
export interface KeyCopy { items: KeyCopyItem[] }

/** the selected keys: offsets from the earliest selected key on the timeline, by clip and value */
export function captureKeyCopy(p: Project, sel: readonly KeyRef[]): KeyCopy | null {
  const clips = shownKeyClips(p, [...new Set(sel.map((r) => r.clipId))]);
  const picked: { clip: Clip; props: Map<string, Set<number>> }[] = [];
  let lo = Infinity;
  for (const clip of clips) {
    const props = new Map<string, Set<number>>();
    for (const r of sel) {
      if (r.clipId !== clip.id) continue;
      const i = refIndex(clip, r);
      if (i === -1) continue;
      let set = props.get(r.prop);
      if (!set) props.set(r.prop, (set = new Set()));
      set.add(i);
    }
    if (props.size === 0) continue;
    for (const [prop, set] of props) for (const i of set) lo = Math.min(lo, clip.start + clip.keyframes![prop]![i]!.t);
    picked.push({ clip, props });
  }
  const items: KeyCopyItem[] = [];
  for (const { clip, props } of picked) {
    const keys: KeyClip = {};
    for (const [prop, set] of props) {
      keys[prop] = [...set].sort((a, b) => a - b).map((i) => {
        const k = clip.keyframes![prop]![i]!;
        return { ...k, t: clip.start + k.t - lo };
      });
    }
    items.push({ clipId: clip.id, keys });
  }
  return items.length > 0 ? { items } : null;
}

/**
 * placeKeys for both ends of a clip, plus the values the clip cannot take. the first copied key lands at `at`
 * (clip-local, not clamped: keys that fall before 0 or after the end are cut). an edge key keeps the curve value
 * there. no key inside and keys on one side only: nothing (not left out). keys on both sides: keys at 0 and the end
 */
export function placeKeyCopy(copied: KeyClip, clip: Clip, at: number): { keys: Keyframes; leftOut: string[] } {
  const allowed = new Set(animProps(clip).map((a) => a.prop));
  if (clip.type === 'effect') for (const q of getEffect(clip.effect)?.params ?? []) allowed.add('p.' + q.key);
  const keys: Keyframes = {};
  const leftOut: string[] = [];
  const dur = clip.duration;
  const clampT = (t: number) => Math.min(dur, Math.max(0, t));
  for (const prop of Object.keys(copied)) {
    if (!allowed.has(prop) || !canKey(clip, prop)) {
      leftOut.push(prop);
      continue;
    }
    const all: Keyframe[] = copied[prop]!.map((k) => ({ ...k, t: at + k.t }));
    const before = all.filter((k) => k.t < -1e-6);
    const mid = all.filter((k) => k.t >= -1e-6 && k.t <= dur + 1e-6);
    const after = all.filter((k) => k.t > dur + 1e-6);
    let out: Keyframe[];
    if (mid.length === 0) {
      if (before.length === 0 || after.length === 0) continue;
      // one custom part over the whole clip: cut at 0, then at the end, both on the curve
      const cut0 = before[before.length - 1]!.ease === 'bezier' ? splitBezierAt(all, 0) : null;
      const cut = cut0 ? splitBezierAt(cut0, dur) : null;
      const k0 = cut?.find((k) => k.t === 0);
      const k1 = cut?.find((k) => k.t === dur);
      if (k0 && k1) out = [{ t: 0, v: k0.v, ease: 'bezier', ...(k0.out ? { out: k0.out } : null) }, { t: dur, v: k1.v, ease: 'linear', ...(k1.in ? { in: k1.in } : null) }];
      else out = [{ t: 0, v: evalKeys(all, 0, clip, prop), ease: before[before.length - 1]!.ease }, { t: dur, v: evalKeys(all, dur, clip, prop), ease: 'linear' }];
    } else {
      out = mid.map((k) => ({ ...k, t: clampT(k.t) }));
      // the cut start: a key at 0 holds the value the full animation has there, with the ease it arrives by.
      // a custom part is cut on the curve: key 0 starts its back half, the first inside key is its split copy
      if (before.length > 0 && out[0]!.t > 1e-3) {
        const cut = before[before.length - 1]!.ease === 'bezier' ? splitBezierAt(all, 0) : null;
        const at = cut ? cut.findIndex((k) => k.t === 0) : -1;
        if (cut && at >= 0) {
          const k0 = cut[at]!;
          const next = cut[at + 1]!;
          if (next.in) out[0] = { ...out[0]!, in: next.in };
          out.unshift({ t: 0, v: k0.v, ease: 'bezier', ...(k0.out ? { out: k0.out } : null) });
        } else out.unshift({ t: 0, v: evalKeys(all, 0, clip, prop), ease: before[before.length - 1]!.ease });
      }
      if (after.length > 0 && dur - out[out.length - 1]!.t > 1e-3) {
        const lastIn = out[out.length - 1]!;
        const cut = lastIn.ease === 'bezier' ? splitBezierAt(all, dur) : null;
        const at = cut ? cut.findIndex((k) => k.t === dur) : -1;
        if (cut && at > 0) {
          const k1 = cut[at]!;
          const prev = cut[at - 1]!;
          if (prev.out) out[out.length - 1] = { ...lastIn, out: prev.out };
          out.push({ t: dur, v: k1.v, ease: 'linear', ...(k1.in ? { in: k1.in } : null) });
        } else out.push({ t: dur, v: evalKeys(all, dur, clip, prop), ease: 'linear' });
      }
    }
    keys[prop] = out;
  }
  return { keys, leftOut };
}

/* ---------- module level clipboard ---------- */

let current: KeyCopy | null = null;
let first: KeyClip | null = null;
const listeners = new Set<() => void>();

/** item 0's keys as offsets from its own earliest key. the same object when it already starts at 0 */
function rebased(item: KeyCopyItem | undefined): KeyClip | null {
  if (!item) return null;
  const keys = item.keys;
  let lo = Infinity;
  for (const prop of Object.keys(keys)) for (const k of keys[prop]!) lo = Math.min(lo, k.t);
  if (lo === Infinity || lo === 0) return keys;
  const out: KeyClip = {};
  for (const prop of Object.keys(keys)) out[prop] = keys[prop]!.map((k) => ({ ...k, t: k.t - lo }));
  return out;
}

export function setKeyCopy(c: KeyCopy | null): void {
  current = c;
  first = c ? rebased(c.items[0]) : null;
  for (const l of listeners) l();
}

export function getKeyCopy(): KeyCopy | null {
  return current;
}

export function hasKeyCopy(): boolean {
  return !!current && current.items.length > 0;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useKeyCopy(): KeyCopy | null {
  return useSyncExternalStore(subscribe, getKeyCopy, getKeyCopy);
}

export function setKeyClip(data: KeyClip | null): void {
  setKeyCopy(data ? { items: [{ clipId: '', keys: data }] } : null);
}

export function getKeyClip(): KeyClip | null {
  return first;
}

export function useKeyClipboard(): KeyClip | null {
  return useSyncExternalStore(subscribe, getKeyClip, getKeyClip);
}
