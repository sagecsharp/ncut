/**
 * effects that sit on ONE clip (EffectClip.target). pure: no dom, no canvas.
 * the frame renderer (engine/draw.ts) asks which effect clips point at a clip and are on screen at a time.
 */
import type { EffectClip, Project, Track } from '../types';
import { isVisualClip } from '../types';
import { clipEnd } from '../lib/timelineOps';

/** target clip id -> the effect clips that point at it, in the order they run (see buildTargetIndex) */
export type TargetIndex = Map<string, EffectClip[]>;

/** true when the clip is an effect clip with a target (the normal adjustment layer walk skips these) */
export function isTargetedEffect(clip: { type: string; target?: string | null }): boolean {
  return clip.type === 'effect' && !!clip.target;
}

/**
 * every valid targeted effect grouped by the clip it points at. an effect counts when its target is a visual clip
 * (video, image, text, shape; not itself, not audio, not unknown) and it sits on a video track. each list is in
 * the order the effects run: the effect clips' tracks from bottom to top, then by start, then project order.
 * null when the project has no effect with a target at all.
 */
export function buildTargetIndex(project: Project): TargetIndex | null {
  let any = false;
  for (const c of project.clips) {
    if (isTargetedEffect(c)) {
      any = true;
      break;
    }
  }
  if (!any) return null;
  const visual = new Set<string>();
  for (const c of project.clips) if (isVisualClip(c)) visual.add(c.id);
  // a higher track index sits lower in the stack
  const rank = new Map<string, number>();
  project.tracks.forEach((t, i) => {
    if (t.kind === 'video') rank.set(t.id, i);
  });
  const index: TargetIndex = new Map();
  for (const c of project.clips) {
    if (c.type !== 'effect' || !c.target || !visual.has(c.target) || !rank.has(c.trackId)) continue;
    const list = index.get(c.target);
    if (list) list.push(c);
    else index.set(c.target, [c]);
  }
  if (index.size === 0) return null;
  for (const list of index.values()) {
    if (list.length > 1) list.sort((a, b) => rank.get(b.trackId)! - rank.get(a.trackId)! || a.start - b.start);
  }
  return index;
}

const cache = new WeakMap<object, { n: number; tracks: readonly Track[]; index: TargetIndex | null }>();

/**
 * buildTargetIndex, kept per clips array (the store replaces the array on every edit, so identity is the key; length
 * and the tracks array guard the rest). a frame of a project without targeted effects costs one scan of the clips
 * the first time and a map lookup after that.
 */
export function targetIndex(project: Project): TargetIndex | null {
  const hit = cache.get(project.clips);
  if (hit && hit.n === project.clips.length && hit.tracks === project.tracks) return hit.index;
  const index = buildTargetIndex(project);
  cache.set(project.clips, { n: project.clips.length, tracks: project.tracks, index });
  return index;
}

/**
 * the effect clips that change the clip `clipId` at a time: they point at it, the time is inside them
 * (start <= t < end) and their track is not hidden. in run order. null when none, so callers can take the plain path.
 */
export function effectsOnClip(index: TargetIndex | null, project: Project, clipId: string, time: number): EffectClip[] | null {
  if (!index) return null;
  const list = index.get(clipId);
  if (!list) return null;
  let out: EffectClip[] | null = null;
  for (const e of list) {
    if (time < e.start - 1e-6 || time >= clipEnd(e) - 1e-6) continue;
    const track = project.tracks.find((t) => t.id === e.trackId);
    if (!track || track.kind !== 'video' || track.hidden) continue;
    (out ??= []).push(e);
  }
  return out;
}
