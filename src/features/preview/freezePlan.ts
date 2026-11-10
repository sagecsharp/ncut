/** pure planning of a freeze frame (no store, no dom): which clip, where the still goes, what moves */
import { clipEnd } from '../../lib/timelineOps';
import { formatTimecode } from '../../lib/time';
import type { Clip, ImageClip, Project, VideoClip } from '../../types';

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
  for (const track of project.tracks) {
    if (hidden.has(track.id)) continue;
    const hit = project.clips.find((c) => c.trackId === track.id && inside(c));
    if (hit) return hit as VideoClip;
  }
  return null;
}

/** where the still goes and where the split is: inside one frame of an edge there is no split */
export function planFreeze(clip: Pick<Clip, 'start' | 'duration'>, time: number, fps: number): FreezePlan {
  const frame = 1 / Math.max(1, fps);
  const end = clipEnd(clip);
  if (time - clip.start < frame - EPS) return { split: false, stillStart: clip.start, shiftFrom: clip.start };
  if (end - time < frame - EPS) return { split: false, stillStart: end, shiftFrom: end };
  return { split: true, stillStart: time, shiftFrom: time };
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

/** the still: the video clip's spatial look (static, already resolved at the time) as a fresh image clip */
export function stillClipFrom(video: VideoClip, resolvedTransform: VideoClip['transform'], assetId: string, start: number, duration: number): ImageClip {
  const still: ImageClip = {
    id: '',
    type: 'image',
    trackId: video.trackId,
    start,
    duration,
    name: `${video.name} frame`,
    fadeIn: 0,
    fadeOut: 0,
    assetId,
    transform: { ...resolvedTransform },
  };
  if (video.threeD !== undefined) still.threeD = video.threeD;
  if (video.lookAt) still.lookAt = structuredClone(video.lookAt);
  if (video.shape) still.shape = video.shape;
  if (video.shapeDepth !== undefined) still.shapeDepth = video.shapeDepth;
  if (video.crop) still.crop = { ...video.crop };
  if (video.radius !== undefined) still.radius = video.radius;
  if (video.blend) still.blend = video.blend;
  if (video.parent) still.parent = video.parent;
  if (video.adjust) still.adjust = structuredClone(video.adjust);
  if (video.chromaKey) still.chromaKey = structuredClone(video.chromaKey);
  if (video.motionBlur) still.motionBlur = structuredClone(video.motionBlur);
  return still;
}
