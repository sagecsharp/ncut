/**
 * can a frame be known to look the same as the one painted a moment ago? pure (no dom), conservative: every rule
 * answers false when in doubt, a false only costs a repaint.
 *
 * `isStaticAt` is about one clip: nothing about its own picture or placement depends on the time. a video clip is
 * "static" only in this sense: its frames change on their own, the preview engine watches them separately.
 * `frameInfo` is about a whole frame: which clips it draws (in order) and whether all of them are static.
 */
import type { Clip, Project, VideoClip, VisualClip } from '../../types';
import { isVisualClip } from '../../types';
import { neededClipsAt, paintListAt } from '../../engine/draw';
import { transitionSpan } from '../../lib/transitions';

const EPS = 1e-3;
const MAX_PARENT_DEPTH = 16;

/** fields on every clip that do not depend on time (keyframes, fades and the like are checked separately) */
const COMMON = ['type', 'id', 'trackId', 'start', 'duration', 'name', 'fadeIn', 'fadeOut', 'group'];
/** fields of the visual clips (Spatial) that do not depend on time as plain values */
const SPATIAL = ['transform', 'lookTarget', 'shape', 'shapeDepth', 'transition', 'blend', 'crop', 'radius', 'parent', 'adjust', 'chromaKey', 'mask'];
const VIDEO = ['assetId', 'trimStart', 'speed', 'volume', 'muted', 'bpm', 'beatOffset'];
const IMAGE = ['assetId'];
const TEXT = [
  'text', 'fontFamily', 'fontSize', 'fontWeight', 'italic', 'color', 'background', 'align', 'letterSpacing', 'lineHeight',
  'uppercase', 'stroke', 'stroke2', 'shadow', 'backgroundRadius', 'backgroundPadding', 'gradient', 'curve', 'wrapWidth',
  'extrude', 'underline', 'strike', 'hollow', 'backgroundPerLine',
];
const SHAPE = [
  'kind', 'width', 'height', 'color', 'color2', 'gradientAngle', 'gradientRadial', 'filled', 'stroke', 'points', 'inner',
  'drawStart', 'drawEnd',
];
/** fields that only mean "static" while they are empty: any value makes the picture depend on the time */
const MUST_BE_EMPTY = ['threeD', 'motionIn', 'motionOut', 'motionLoop', 'motionBlur', 'animIn', 'animOut', 'animLoop', 'highlight', 'counter'];
/** the keys of a transform (all plain numbers) */
const TRANSFORM = ['x', 'y', 'scale', 'scaleX', 'scaleY', 'scaleZ', 'rotation', 'opacity', 'z', 'rotX', 'rotY'];

function allowedFor(extra: string[]): Set<string> {
  return new Set([...COMMON, ...SPATIAL, ...extra]);
}

const ALLOWED: Record<string, Set<string> | undefined> = {
  video: allowedFor(VIDEO),
  image: allowedFor(IMAGE),
  text: allowedFor(TEXT),
  shape: allowedFor(SHAPE),
};
const EMPTY_OK = new Set(MUST_BE_EMPTY);
const TRANSFORM_OK = new Set(TRANSFORM);

/** the part of the verdict that only depends on the clip object itself (clips are immutable snapshots) */
const ownCache = new WeakMap<object, boolean>();

function ownStatic(clip: Clip): boolean {
  const hit = ownCache.get(clip);
  if (hit !== undefined) return hit;
  const r = computeOwn(clip);
  ownCache.set(clip, r);
  return r;
}

function computeOwn(clip: Clip): boolean {
  const allowed = ALLOWED[clip.type];
  if (!allowed) return false;
  const rec = clip as unknown as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    const v = rec[key];
    if (key === 'keyframes') {
      if (!noKeys(v)) return false;
    } else if (key === 'lookAt') {
      if (v !== undefined && v !== null && v !== 'none') return false;
    } else if (EMPTY_OK.has(key)) {
      if (v) return false;
    } else if (key === 'transform') {
      if (!v || typeof v !== 'object') return false;
      for (const k of Object.keys(v)) if (!TRANSFORM_OK.has(k)) return false;
    } else if (!allowed.has(key)) {
      // a field this check does not know about: it may depend on the time
      return false;
    }
  }
  return true;
}

/** true when there are no animated properties (missing, or no property with a key) */
function noKeys(kf: unknown): boolean {
  if (kf === undefined || kf === null) return true;
  if (typeof kf !== 'object') return false;
  for (const list of Object.values(kf as Record<string, unknown>)) {
    if (!Array.isArray(list) || list.length > 0) return false;
  }
  return true;
}

/** is the pose of this parent chain constant (no keyframes / motions anywhere up the chain, no camera)? */
function parentChainStatic(project: Project, clip: VisualClip, depth: number): boolean {
  const pid = clip.parent;
  if (!pid) return true;
  if (depth > MAX_PARENT_DEPTH) return false;
  const parent = project.clips.find((c) => c.id === pid);
  // an unknown id means no parent
  if (!parent) return true;
  if (!isVisualClip(parent) || !ownStatic(parent)) return false;
  return parentChainStatic(project, parent, depth + 1);
}

/**
 * nothing that draws this clip depends on the time: no keyframes, ready-made motions, text animation, running
 * number, karaoke, motion blur, 3d, look-at, no fade or transition running at this moment and a parent chain that
 * does not move either. any field the check does not know makes it false. effect, camera and audio clips: false.
 */
export function isStaticAt(project: Project, clip: Clip, time: number): boolean {
  if (!isVisualClip(clip) || !ownStatic(clip)) return false;
  const local = time - clip.start;
  if (clip.fadeIn > 0 && local <= clip.fadeIn + EPS) return false;
  if (clip.fadeOut > 0 && clip.duration - local <= clip.fadeOut + EPS) return false;
  if (clip.transition) {
    const span = transitionSpan(project, clip);
    if (span && time >= span.start - EPS && time < span.end + EPS) return false;
  }
  return parentChainStatic(project, clip, 0);
}

export interface FrameInfo {
  /** the clips the frame paints (bottom first) and the ones it needs pictures of: same key = same clips, same order */
  key: string;
  /** every clip of the frame is static, no transition runs, no camera clip is on */
  allStatic: boolean;
  /** the video clips on screen (their elements decide whether a new picture arrived) */
  videos: VideoClip[];
}

/** what the frame at a time is made of (see FrameInfo). the same lists renderFrame and the exporter use. */
export function frameInfo(project: Project, time: number): FrameInfo {
  const paint = paintListAt(project, time);
  const needed = neededClipsAt(project, time);
  let allStatic = true;
  let key = '';
  for (const c of paint) {
    key += `${c.id},`;
    if (allStatic && !isStaticAt(project, c, time)) allStatic = false;
  }
  key += '|';
  const videos: VideoClip[] = [];
  for (const c of needed) {
    key += `${c.id},`;
    if (c.type === 'video') videos.push(c);
  }
  if (allStatic) {
    for (const c of project.clips) {
      if (c.type === 'camera') {
        // a camera clip that is on moves the 3d space (and anything pinned to it)
        if (time >= c.start - EPS && time < c.start + c.duration + EPS) allStatic = false;
      } else if (isVisualClip(c) && c.transition) {
        const span = transitionSpan(project, c);
        if (span && time >= span.start - EPS && time < span.end + EPS) allStatic = false;
      }
      if (!allStatic) break;
    }
  }
  return { key, allStatic, videos };
}
