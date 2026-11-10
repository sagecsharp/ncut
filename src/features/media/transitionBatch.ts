/** pure planning for the batch transition tools (a whole track, the shuffle). no store, no dom. */
import { previousClipOnTrack } from '../../lib/transitions';
import { DEFAULT_TRANSITION_DURATION, MIN_TRANSITION_DURATION } from '../../engine/transitions/registry';
import type { TransitionDef } from '../../engine/transitions/registry';
import { isVisualClip } from '../../types';
import type { Project, Transition, VisualClip } from '../../types';
import { clampToCut, cutLimit } from './transitionApply';

export interface TransitionPatch {
  clipId: string;
  transition: Transition | null;
}

export interface Cut {
  clip: VisualClip;
  prev: VisualClip;
  /** the longest transition this cut allows */
  limit: number;
}

function visualClips(project: Project, trackId: string): VisualClip[] {
  return project.clips.filter((c): c is VisualClip => c.trackId === trackId && isVisualClip(c)).sort((a, b) => a.start - b.start);
}

function isLocked(project: Project, trackId: string): boolean {
  return project.tracks.find((t) => t.id === trackId)?.locked ?? false;
}

/** the clips of a track that start right where another visual clip ends and are long enough for a transition */
export function cutsOnTrack(project: Project, trackId: string): Cut[] {
  const out: Cut[] = [];
  for (const clip of visualClips(project, trackId)) {
    const prev = previousClipOnTrack(project, clip);
    if (!prev) continue;
    const limit = cutLimit(clip, prev);
    if (limit >= MIN_TRANSITION_DURATION) out.push({ clip, prev, limit });
  }
  return out;
}

/** put `use` on every cut of a track. cuts that have one are left alone unless `replace`. locked track: nothing. */
export function planTrackTransitions(project: Project, trackId: string, use: Transition, replace: boolean): TransitionPatch[] {
  if (isLocked(project, trackId)) return [];
  const out: TransitionPatch[] = [];
  for (const { clip, limit } of cutsOnTrack(project, trackId)) {
    if (clip.transition && !replace) continue;
    const next: Transition = { id: use.id, duration: clampToCut(use.duration, limit) };
    if (clip.transition && clip.transition.id === next.id && clip.transition.duration === next.duration) continue;
    out.push({ clipId: clip.id, transition: next });
  }
  return out;
}

/** take the transition off every clip of a track that has one */
export function planRemoveTransitions(project: Project, trackId: string): TransitionPatch[] {
  if (isLocked(project, trackId)) return [];
  return visualClips(project, trackId)
    .filter((c) => c.transition)
    .map((c) => ({ clipId: c.id, transition: null }));
}

/** give every other transition of the track the length of `sourceId`'s, clamped per cut */
export function planSameLength(project: Project, trackId: string, sourceId: string): TransitionPatch[] {
  if (isLocked(project, trackId)) return [];
  const clips = visualClips(project, trackId);
  const source = clips.find((c) => c.id === sourceId)?.transition;
  if (!source) return [];
  const out: TransitionPatch[] = [];
  for (const clip of clips) {
    if (clip.id === sourceId || !clip.transition) continue;
    const duration = clampToCut(source.duration, cutLimit(clip, previousClipOnTrack(project, clip)));
    if (duration === clip.transition.duration) continue;
    out.push({ clipId: clip.id, transition: { id: clip.transition.id, duration } });
  }
  return out;
}

/** the calm transitions: fades, slides, pushes and plain wipes (picked by category / name from the registry) */
export function calmPool(defs: readonly TransitionDef[]): TransitionDef[] {
  return defs.filter(
    (d) => d.category === 'fade' || (d.category === 'move' && /^(slide|push)-/.test(d.id)) || (d.category === 'wipe' && /^wipe-/.test(d.id)),
  );
}

/** small seeded generator (mulberry32): same seed, same numbers */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * one transition id per slot: random from `pool`, never the same as the one before it (and, when the pool
 * allows, never the same as that slot's `current` one). `after` is the one used just before the first slot.
 */
export function shuffleOrder(pool: readonly string[], currents: readonly (string | undefined)[], seed: number, after?: string): string[] {
  if (pool.length === 0) return [];
  const rnd = seededRandom(seed);
  const out: string[] = [];
  let prev = after;
  for (const current of currents) {
    let options = pool.filter((id) => id !== prev && id !== current);
    if (options.length === 0) options = pool.filter((id) => id !== prev);
    if (options.length === 0) options = [...pool];
    const id = options[Math.floor(rnd() * options.length)]!;
    out.push(id);
    prev = id;
  }
  return out;
}

/** shuffle: every selected clip that starts on a cut gets a different transition, in timeline order */
export function planShuffle(project: Project, clipIds: readonly string[], pool: readonly string[], seed: number, after?: string): TransitionPatch[] {
  const wanted = new Set(clipIds);
  const targets: { clip: VisualClip; limit: number }[] = [];
  for (const clip of project.clips) {
    if (!wanted.has(clip.id) || !isVisualClip(clip) || isLocked(project, clip.trackId)) continue;
    const prev = previousClipOnTrack(project, clip);
    if (!prev) continue;
    const limit = cutLimit(clip, prev);
    if (limit >= MIN_TRANSITION_DURATION) targets.push({ clip, limit });
  }
  targets.sort((a, b) => a.clip.start - b.clip.start);
  const ids = shuffleOrder(pool, targets.map((t) => t.clip.transition?.id), seed, after);
  return targets.map((t, i) => ({
    clipId: t.clip.id,
    transition: { id: ids[i]!, duration: clampToCut(t.clip.transition?.duration ?? DEFAULT_TRANSITION_DURATION, t.limit) },
  }));
}
