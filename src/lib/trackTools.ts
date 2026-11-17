/** track height, sync lock and track order rules. pure: no store, no dom */
import type { Project, Track, TrackKind } from '../types';

export const TRACK_H_MIN = 28;
export const TRACK_H_MAX = 240;
export const DEFAULT_TRACK_H: Readonly<Record<TrackKind, number>> = { video: 56, audio: 48 };
/** taller / shorter step along this ladder. both defaults are on it */
export const TRACK_SIZES: readonly number[] = [28, 36, 48, 56, 72, 96, 128, 176, 240];
/** a header this tall or taller has two rows, below it one */
export const HEAD_FULL_H = 48;

const fit = (h: number): number => Math.min(TRACK_H_MAX, Math.max(TRACK_H_MIN, Math.round(h)));

export function trackHeightOf(t: Pick<Track, 'kind' | 'height'>): number {
  return typeof t.height === 'number' && Number.isFinite(t.height) ? fit(t.height) : DEFAULT_TRACK_H[t.kind];
}

/** the track with this height (null: the default, stored as missing). the same object when nothing changes */
export function withHeight(t: Track, h: number | null): Track {
  const want = h === null || !Number.isFinite(h) ? DEFAULT_TRACK_H[t.kind] : fit(h);
  if (want === DEFAULT_TRACK_H[t.kind]) {
    if (!('height' in t)) return t;
    const next = { ...t };
    delete next.height;
    return next;
  }
  return t.height === want ? t : { ...t, height: want };
}

/** one ladder step for every track. only tracks that change are in it; null = back to the default */
export function stepHeights(tracks: readonly Track[], dir: 1 | -1): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const t of tracks) {
    const h = trackHeightOf(t);
    const next = dir > 0 ? TRACK_SIZES.find((s) => s > h) : [...TRACK_SIZES].reverse().find((s) => s < h);
    if (next !== undefined) out[t.id] = next === DEFAULT_TRACK_H[t.kind] ? null : next;
  }
  return out;
}

export function normalHeights(tracks: readonly Track[]): Record<string, null> {
  const out: Record<string, null> = {};
  for (const t of tracks) if ('height' in t) out[t.id] = null;
  return out;
}

/** undo / redo / rollback: snap's tracks with the heights of now. snap itself when nothing differs */
export function keepHeights(snap: Track[], now: readonly Track[]): Track[] {
  const hOf = new Map(now.map((t) => [t.id, t.height]));
  let out: Track[] | null = null;
  for (let i = 0; i < snap.length; i++) {
    const t = snap[i]!;
    if (!hOf.has(t.id) || hOf.get(t.id) === t.height) continue;
    out ??= [...snap];
    out[i] = withHeight(t, hOf.get(t.id) ?? null);
  }
  return out ?? snap;
}

export function syncLockOf(t: Pick<Track, 'syncLock'>): boolean {
  return t.syncLock !== false;
}

/** the sync rule: the tracks an edit moves. unlocked, and edited (the edit is on it) or sync lock on. nothing else decides this */
export function syncTrackIds(tracks: readonly Pick<Track, 'id' | 'locked' | 'syncLock'>[], edited: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const t of tracks) if (!t.locked && (edited.has(t.id) || syncLockOf(t))) out.add(t.id);
  return out;
}

/** an unlocked sync lock off track has a clip at or after `time`: "insert gap here" leaves it alone */
export function syncOffAfter(p: Pick<Project, 'tracks' | 'clips'>, time: number): boolean {
  const off = new Set(p.tracks.filter((t) => !t.locked && !syncLockOf(t)).map((t) => t.id));
  return off.size > 0 && p.clips.some((c) => off.has(c.trackId) && c.start >= time - 1e-6);
}

/** the index one place up (-1) or down (1) inside the track's kind. null at the end of its kind or for an unknown id */
export function stepIndex(tracks: readonly Pick<Track, 'id' | 'kind'>[], id: string, dir: -1 | 1): number | null {
  const i = tracks.findIndex((t) => t.id === id);
  const t = i < 0 ? undefined : tracks[i + dir];
  return t && t.kind === tracks[i]!.kind ? i + dir : null;
}

/** the tracks that hold a selected clip, in track order */
export function tracksOf(p: Pick<Project, 'tracks' | 'clips'>, sel: readonly string[]): string[] {
  const on = new Set(p.clips.filter((c) => sel.includes(c.id)).map((c) => c.trackId));
  return p.tracks.filter((t) => on.has(t.id)).map((t) => t.id);
}

const VIEW_KEYS = new Set(['height', 'syncLock']);
const TRACKS = new Set(['tracks']);
const differ = (a: object, b: object, skip: ReadonlySet<string>): boolean => {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) if (!skip.has(k) && x[k] !== y[k]) return true;
  return false;
};

/** next differs from prev only in what no frame and no sample uses: track heights and sync lock. a reorder is never this */
export function timelineOnlyChange(prev: Project, next: Project): boolean {
  if (prev === next || prev.tracks === next.tracks || prev.tracks.length !== next.tracks.length) return false;
  if (differ(prev, next, TRACKS)) return false;
  for (let i = 0; i < prev.tracks.length; i++) {
    const a = prev.tracks[i]!;
    const b = next.tracks[i]!;
    if (a !== b && (a.id !== b.id || differ(a, b, VIEW_KEYS))) return false;
  }
  return true;
}
