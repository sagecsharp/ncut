/** pure planning of a freeze frame (no store, no dom): which clip, where the still goes, what moves */
import { resolveClip } from '../../lib/anim';
import { faceSourceSet } from '../../engine/scene3d/faces';
import { clipEnd, fadeFactor } from '../../lib/timelineOps';
import { formatTimecode } from '../../lib/time';
import type { Clip, ClipAnim, EffectClip, ImageClip, Project, Transition, VideoClip } from '../../types';
import { MIN_CLIP_DURATION } from '../../types';

export interface FreezePlan {
  /** split the video clip at the playhead first */
  split: boolean;
  /** timeline start of the still */
  stillStart: number;
  /** every clip of the track starting at or after this moves right by the still length (after the split) */
  shiftFrom: number;
}

const EPS = 1e-6;

/**
 * the clip to freeze: the selected video clip when exactly one video clip is selected and the playhead is inside it,
 * else the topmost visible video clip under the playhead. null when there is none.
 */
export function pickFreezeTarget(project: Project, selection: readonly string[], time: number): VideoClip | null {
  const inside = (c: Clip): c is VideoClip => c.type === 'video' && time >= c.start - EPS && time < clipEnd(c) - EPS;
  const selected = project.clips.filter((c) => selection.includes(c.id) && c.type === 'video');
  if (selected.length === 1) {
    const only = selected[0]!;
    if (inside(only)) return only;
  }
  const hidden = new Set(project.tracks.filter((t) => t.hidden).map((t) => t.id));
  // a clip that is shown on a side of a solid is not on screen by itself: the frame there is the solid's
  const onSides = faceSourceSet(project);
  for (const track of project.tracks) {
    if (hidden.has(track.id)) continue;
    const hit = project.clips.find((c) => c.trackId === track.id && !onSides.has(c.id) && inside(c));
    if (hit) return hit as VideoClip;
  }
  return null;
}

/** where the still goes and where the split is: inside one frame of an edge there is no split */
export function planFreeze(clip: Pick<Clip, 'start' | 'duration'>, time: number, fps: number): FreezePlan {
  const frame = 1 / Math.max(1, fps);
  const end = clipEnd(clip);
  // within a frame of an edge, or closer than the shortest piece a split may leave (the store refuses that cut):
  // the still goes before / after the whole clip
  const near = (d: number): boolean => d < frame - EPS || d < MIN_CLIP_DURATION + EPS;
  if (near(time - clip.start)) return { split: false, stillStart: clip.start, shiftFrom: clip.start };
  if (near(end - time)) return { split: false, stillStart: end, shiftFrom: end };
  return { split: true, stillStart: time, shiftFrom: time };
}

/**
 * effects put on clips that move, which the usual "an effect follows its clip" rule misses because they do not
 * cover the clip exactly (trimmed shorter, or only the part after a cut): they start at or after `from`, so they
 * go right by `by` with their clip. effects on locked tracks stay.
 */
export function effectShiftMoves(
  clips: readonly Clip[],
  tracks: readonly { id: string; locked?: boolean }[],
  moves: readonly TrackMove[],
  from: number,
  by: number,
): TrackMove[] {
  const moving = new Set(moves.map((m) => m.id));
  const locked = new Set(tracks.filter((t) => t.locked).map((t) => t.id));
  const out: TrackMove[] = [];
  for (const c of clips) {
    if (c.type !== 'effect' || !c.target || !moving.has(c.target) || moving.has(c.id)) continue;
    if (c.start < from - EPS || locked.has(c.trackId)) continue;
    out.push({ id: c.id, trackId: c.trackId, start: c.start + by });
  }
  return out;
}

export interface TrackMove {
  id: string;
  trackId: string;
  start: number;
}

/** the full move list of one track: every clip starting at or after `from` goes right by `by` */
export function shiftMoves(clips: readonly Clip[], trackId: string, from: number, by: number): TrackMove[] {
  const out: TrackMove[] = [];
  for (const c of clips) if (c.trackId === trackId && c.start >= from - EPS) out.push({ id: c.id, trackId, start: c.start + by });
  return out;
}

/** the source time to grab: the playhead mapped into the clip, kept half a frame inside the picture range */
export function freezeSourceTime(clip: VideoClip, time: number, fps: number, assetDuration?: number): number {
  const half = 0.5 / Math.max(1, fps);
  const raw = clip.trimStart + (time - clip.start) * clip.speed;
  const lastInClip = clip.trimStart + Math.max(0, clip.duration - half) * clip.speed;
  let t = Math.min(raw, lastInClip);
  if (assetDuration && assetDuration > 0) t = Math.min(t, Math.max(0, assetDuration - half));
  return Math.max(0, t);
}

/** "<clip name> frame <timecode>.png" with the colons of the timecode made safe for file systems */
export function freezeFileName(clipName: string, time: number, fps: number): string {
  const name =
    clipName
      .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'clip';
  return `${name} frame ${formatTimecode(time, fps).replace(/:/g, '-')}.png`;
}

/**
 * what the still takes over from the video so the picture does not dip or pop at the seam.
 * head (the still goes before the video, plan.split false): the entrance (fadeIn, the transition INTO the clip,
 * motionIn) belongs to whatever comes first now, so the still takes it and the video loses it.
 * tail (the still goes after the video): the exit (fadeOut, motionOut) goes the same way.
 * a split in the middle needs nothing: the store already keeps the entrance on the left half and the exit on the right.
 * a fade or a transition that is longer than the still is shortened to the still by the store (the picture never
 * dips at the seam; the fade just runs a little faster).
 * the clip after the tail keeps its own transition: it now crosses from the still, which holds the last frame
 * of the video, so the picture stays the same as before.
 */
export interface FreezeHandover {
  where: 'head' | 'tail' | 'middle';
  fadeIn: number;
  fadeOut: number;
  transition?: Transition;
  motionIn?: ClipAnim;
  motionOut?: ClipAnim;
  /** what to clear on the video (null clears an optional field). null = nothing to change. */
  videoPatch: { fadeIn?: number; fadeOut?: number; transition?: null; motionIn?: null; motionOut?: null } | null;
}

export function freezeHandover(video: VideoClip, plan: FreezePlan): FreezeHandover {
  if (plan.split) return { where: 'middle', fadeIn: 0, fadeOut: 0, videoPatch: null };
  const patch: NonNullable<FreezeHandover['videoPatch']> = {};
  if (plan.stillStart <= video.start + EPS) {
    const out: FreezeHandover = { where: 'head', fadeIn: video.fadeIn, fadeOut: 0, videoPatch: null };
    if (video.fadeIn > 0) patch.fadeIn = 0;
    if (video.transition) {
      out.transition = structuredClone(video.transition);
      patch.transition = null;
    }
    if (video.motionIn) {
      out.motionIn = structuredClone(video.motionIn);
      patch.motionIn = null;
    }
    if (Object.keys(patch).length > 0) out.videoPatch = patch;
    return out;
  }
  const out: FreezeHandover = { where: 'tail', fadeIn: 0, fadeOut: video.fadeOut, videoPatch: null };
  if (video.fadeOut > 0) patch.fadeOut = 0;
  if (video.motionOut) {
    out.motionOut = structuredClone(video.motionOut);
    patch.motionOut = null;
  }
  if (Object.keys(patch).length > 0) out.videoPatch = patch;
  return out;
}

/**
 * copies of the effects that sit on the video and are active at the freeze time, retargeted to the still.
 * - span: the still's span. the store puts each on a free track position (addClips, newTrack false).
 * - keyframed values (amount, p.<key>) are baked at the freeze time and the keys dropped: the still holds that pose.
 * - the fades are baked into amount at that time and the copy has none.
 * - time: the model cannot hold a look still (it reads clip time), so timeOffset starts the look at the moment of
 *   the freeze and it keeps moving from there; fullDuration keeps spread-over-the-length moves on the same pace.
 */
export function freezeEffectCopies(clips: readonly Clip[], videoId: string, time: number, stillId: string, stillStart: number, duration: number): EffectClip[] {
  const out: EffectClip[] = [];
  for (const c of clips) {
    if (c.type !== 'effect' || c.target !== videoId) continue;
    if (time < c.start - EPS || time >= clipEnd(c) - EPS) continue;
    const baked = resolveClip(c, time);
    const copy = structuredClone(baked);
    copy.id = '';
    copy.target = stillId;
    copy.start = stillStart;
    copy.duration = duration;
    copy.amount = Math.max(0, Math.min(1, baked.amount * fadeFactor(c, time)));
    copy.fadeIn = 0;
    copy.fadeOut = 0;
    delete copy.keyframes;
    delete copy.group;
    copy.timeOffset = Math.max(0, time - c.start) + (c.timeOffset ?? 0);
    copy.fullDuration = c.fullDuration ?? c.duration;
    out.push(copy);
  }
  return out;
}

/**
 * the still: the video clip's look (static, already resolved at the time) as a fresh image clip.
 * copied: everything that changes how the frame looks (threeD, lookAt + lookTarget, shape, shapeDepth, faces, crop, radius,
 * mask, blend, adjust, chromaKey, parent, motionBlur) and, from `handover`, the entrance / exit.
 * deliberately NOT copied:
 * - id, trackId (same track), name, start, duration: the still has its own.
 * - keyframes: the still holds the pose of that moment (transform is resolved by the caller), it does not animate.
 * - motionLoop: a loop motion is a function of clip time, it cannot hold one moment and would start moving.
 * - group: the still is its own clip, a group would pull the video along when it is clicked.
 * - assetId / trimStart / speed / volume / muted: the picture is the grabbed png and a still has no sound.
 * - transition / motionIn / motionOut / fades: only through `handover` (head and tail), see freezeHandover.
 */
export function stillClipFrom(
  video: VideoClip,
  resolvedTransform: VideoClip['transform'],
  assetId: string,
  start: number,
  duration: number,
  handover?: FreezeHandover,
): ImageClip {
  const still: ImageClip = {
    id: '',
    type: 'image',
    trackId: video.trackId,
    start,
    duration,
    name: `${video.name} frame`,
    fadeIn: handover?.fadeIn ?? 0,
    fadeOut: handover?.fadeOut ?? 0,
    assetId,
    transform: { ...resolvedTransform },
  };
  if (handover?.transition) still.transition = handover.transition;
  if (handover?.motionIn) still.motionIn = handover.motionIn;
  if (handover?.motionOut) still.motionOut = handover.motionOut;
  if (video.mask) still.mask = structuredClone(video.mask);
  if (video.lookTarget) still.lookTarget = video.lookTarget;
  if (video.threeD !== undefined) still.threeD = video.threeD;
  if (video.lookAt) still.lookAt = video.lookAt;
  if (video.shape) still.shape = video.shape;
  if (video.shapeDepth !== undefined) still.shapeDepth = video.shapeDepth;
  // what its sides show (other clips are still named by id)
  if (video.faces) still.faces = structuredClone(video.faces);
  if (video.crop) still.crop = { ...video.crop };
  if (video.radius !== undefined) still.radius = video.radius;
  if (video.blend) still.blend = video.blend;
  if (video.parent) still.parent = video.parent;
  if (video.adjust) still.adjust = structuredClone(video.adjust);
  if (video.chromaKey) still.chromaKey = structuredClone(video.chromaKey);
  if (video.motionBlur) still.motionBlur = structuredClone(video.motionBlur);
  return still;
}
