import { createEffectClip } from '../../lib/factory';
import { pickEffectTrack } from '../timeline/effectTarget';
import type { Clip, EffectClip, Project, VisualClip } from '../../types';

/** the effect clips that point at a clip (their target is that clip), earliest first */
export function effectsOnClip(clips: readonly Clip[], clipId: string): EffectClip[] {
  return clips.filter((c): c is EffectClip => c.type === 'effect' && c.target === clipId).sort((a, b) => a.start - b.start);
}

/**
 * a track above the clip's own where a new effect clip fits: the same rule as dropping an effect on a clip
 * (pickEffectTrack). null = make a new track (addClips puts it on top).
 */
export function effectHomeTrack(project: Pick<Project, 'tracks' | 'clips'>, clip: Pick<Clip, 'trackId' | 'start' | 'duration'>): string | null {
  return pickEffectTrack(project, clip.trackId, clip.start, clip.duration);
}

/** the effect clip for "add effect" on a clip: same start and duration, pointing at the clip. the track is a placeholder for addClips. */
export function newTargetedEffect(effectId: string, effectName: string, clip: VisualClip, trackId: string): EffectClip {
  return createEffectClip(effectId, effectName, trackId, clip.start, { duration: clip.duration, target: clip.id });
}

/** true when the two clips are on screen at the same time at some point */
export function overlapsInTime(a: Pick<Clip, 'start' | 'duration'>, b: Pick<Clip, 'start' | 'duration'>): boolean {
  return a.start < b.start + b.duration && b.start < a.start + a.duration;
}
