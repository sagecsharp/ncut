/**
 * pure helpers over the project model. no react, no store. safe to use anywhere (ui, export, tests).
 */
import type { Clip, Project, Track, TrackKind } from '../types';
import { isTimedClip } from '../types';

const EPS = 1e-6;

export function clipEnd(c: Pick<Clip, 'start' | 'duration'>): number {
  return c.start + c.duration;
}

/** end of the last clip, 0 for an empty project */
export function projectDuration(project: Pick<Project, 'clips'>): number {
  let end = 0;
  for (const c of project.clips) end = Math.max(end, clipEnd(c));
  return end;
}

export function getTrack(project: Project, trackId: string): Track | undefined {
  return project.tracks.find((t) => t.id === trackId);
}

export function getClip(project: Project, clipId: string): Clip | undefined {
  return project.clips.find((c) => c.id === clipId);
}

/** clips on a track sorted by start */
export function getTrackClips(project: Pick<Project, 'clips'>, trackId: string): Clip[] {
  return project.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);
}

export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd - EPS && bStart < aEnd - EPS;
}

/** true when [start, start+duration) is free on the track, ignoring the given clip ids */
export function isRangeFree(
  project: Pick<Project, 'clips'>,
  trackId: string,
  start: number,
  duration: number,
  ignoreIds: readonly string[] = [],
): boolean {
  if (start < -EPS) return false;
  const end = start + duration;
  for (const c of project.clips) {
    if (c.trackId !== trackId || ignoreIds.includes(c.id)) continue;
    if (rangesOverlap(start, end, c.start, clipEnd(c))) return false;
  }
  return true;
}

/**
 * nearest start >= 0 to `desiredStart` where a clip of `duration` fits on the track without overlap.
 * always returns a value (worst case: right after the last clip).
 */
export function findFreeStart(
  project: Pick<Project, 'clips'>,
  trackId: string,
  desiredStart: number,
  duration: number,
  ignoreIds: readonly string[] = [],
): number {
  const want = Math.max(0, desiredStart);
  if (isRangeFree(project, trackId, want, duration, ignoreIds)) return want;
  const others = getTrackClips(project, trackId).filter((c) => !ignoreIds.includes(c.id));
  // candidate positions: flush after each clip, flush before each clip, and 0
  const candidates: number[] = [0];
  for (const c of others) {
    candidates.push(clipEnd(c));
    candidates.push(c.start - duration);
  }
  let best = -1;
  let bestDist = Infinity;
  for (const cand of candidates) {
    if (cand < -EPS) continue;
    const s = Math.max(0, cand);
    if (!isRangeFree(project, trackId, s, duration, ignoreIds)) continue;
    const d = Math.abs(s - want);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  if (best >= 0) return best;
  const last = others[others.length - 1];
  return last ? clipEnd(last) : 0;
}

/** first track of a kind that has room for the range, or undefined */
export function findTrackWithRoom(
  project: Project,
  kind: TrackKind,
  start: number,
  duration: number,
  ignoreIds: readonly string[] = [],
): Track | undefined {
  return project.tracks.find(
    (t) => t.kind === kind && !t.locked && isRangeFree(project, t.id, start, duration, ignoreIds),
  );
}

/** clips under a time. half-open: a clip covers [start, end) */
export function clipsAtTime(project: Pick<Project, 'clips'>, t: number): Clip[] {
  return project.clips.filter((c) => t >= c.start - EPS && t < clipEnd(c) - EPS);
}

/** source time (seconds into the asset) for a timed clip at timeline time t */
export function sourceTimeAt(clip: Clip, t: number): number {
  if (!isTimedClip(clip)) return 0;
  return clip.trimStart + (t - clip.start) * clip.speed;
}

/**
 * 0..1 multiplier from the clip's fadeIn/fadeOut at timeline time t.
 * 1 outside of the fade regions. used for opacity (visual) and gain (audio).
 */
export function fadeFactor(clip: Pick<Clip, 'start' | 'duration' | 'fadeIn' | 'fadeOut'>, t: number): number {
  const local = t - clip.start;
  let f = 1;
  if (clip.fadeIn > 0 && local < clip.fadeIn) f = Math.min(f, Math.max(0, local / clip.fadeIn));
  const toEnd = clip.duration - local;
  if (clip.fadeOut > 0 && toEnd < clip.fadeOut) f = Math.min(f, Math.max(0, toEnd / clip.fadeOut));
  return f;
}

/**
 * max timeline duration a timed clip can have given its trimStart, speed and source length.
 * Infinity for clips without a bounded source (image/text).
 */
export function maxClipDuration(clip: Clip, assetDuration: number | undefined): number {
  if (!isTimedClip(clip) || !assetDuration) return Infinity;
  return Math.max(0, (assetDuration - clip.trimStart) / clip.speed);
}

/** all interesting snap times: clip edges (except ignored ones), 0, and optional extras (playhead) */
export function collectSnapPoints(
  project: Pick<Project, 'clips'>,
  ignoreIds: readonly string[] = [],
  extra: readonly number[] = [],
): number[] {
  const set = new Set<number>([0, ...extra]);
  for (const c of project.clips) {
    if (ignoreIds.includes(c.id)) continue;
    set.add(c.start);
    set.add(clipEnd(c));
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * snap `t` to the closest point within `threshold` seconds.
 * returns the snapped time and the point that was hit (or null when nothing was close).
 */
export function snapTime(t: number, points: readonly number[], threshold: number): { time: number; hit: number | null } {
  let best: number | null = null;
  let bestDist = threshold;
  for (const p of points) {
    const d = Math.abs(p - t);
    if (d <= bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best === null ? { time: t, hit: null } : { time: best, hit: best };
}

/** video tracks first then audio tracks, preserving relative order */
export function normalizeTrackOrder(tracks: Track[]): Track[] {
  return [...tracks.filter((t) => t.kind === 'video'), ...tracks.filter((t) => t.kind === 'audio')];
}
