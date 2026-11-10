import { createEffectClip } from '../../lib/factory';
import { isRangeFree } from '../../lib/timelineOps';
import type { Clip, EffectClip, Project, VisualClip } from '../../types';

/** the effect clips that point at a clip (their target is that clip), earliest first */
export function effectsOnClip(clips: readonly Clip[], clipId: string): EffectClip[] {
  return clips.filter((c): c is EffectClip => c.type === 'effect' && c.target === clipId).sort((a, b) => a.start - b.start);
}

/**
 * a track above the clip's own where a new effect clip fits and nothing but effect clips lives: the nearest one.
 * null = make a new track (addClips puts it on top).
 */
export function effectHomeTrack(project: Pick<Project, 'tracks' | 'clips'>, clip: Pick<Clip, 'trackId' | 'start' | 'duration'>): string | null {
  const at = project.tracks.findIndex((t) => t.id === clip.trackId);
  for (let i = at - 1; i >= 0; i--) {
    const t = project.tracks[i]!;
    if (t.kind !== 'video' || t.locked) continue;
    const mine = project.clips.filter((c) => c.trackId === t.id);
    if (!mine.every((c) => c.type === 'effect')) continue;
    if (isRangeFree(project as Project, t.id, clip.start, clip.duration)) return t.id;
  }
  return null;
}

/** the effect clip for "add effect" on a clip: same start and duration, pointing at the clip. the track is a placeholder for addClips. */
export function newTargetedEffect(effectId: string, effectName: string, clip: VisualClip, trackId: string): EffectClip {
  return createEffectClip(effectId, effectName, trackId, clip.start, { duration: clip.duration, target: clip.id });
}

/** true when the two clips are on screen at the same time at some point */
export function overlapsInTime(a: Pick<Clip, 'start' | 'duration'>, b: Pick<Clip, 'start' | 'duration'>): boolean {
  return a.start < b.start + b.duration && b.start < a.start + a.duration;
}
