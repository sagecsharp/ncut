/**
 * core data model. everything in a project is plain json (serializable to indexeddb).
 * all times are in SECONDS unless a name says otherwise.
 */

export type MediaKind = 'video' | 'audio' | 'image';

/** metadata for an imported file. the blob itself lives in indexeddb + the runtime registry. */
export interface MediaAsset {
  id: string;
  name: string;
  kind: MediaKind;
  mime: string;
  /** bytes */
  size: number;
  /** seconds. 0 for images. */
  duration: number;
  /** pixels. 0 for audio. */
  width: number;
  height: number;
  /** true for audio assets and for video assets that carry an audio track. */
  hasAudio: boolean;
  createdAt: number;
}

/**
 * 'video' tracks hold video, image and text clips (anything visual).
 * 'audio' tracks hold audio clips only.
 * in project.tracks, index 0 is the TOP row of the timeline and the TOP visual layer.
 * all video tracks come before all audio tracks.
 */
export type TrackKind = 'video' | 'audio';

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  /** audio from this track is silenced. */
  muted: boolean;
  /** visuals from this track are not drawn (video tracks only). */
  hidden: boolean;
  /** clips on this track cannot be selected/moved/edited. */
  locked: boolean;
}

/**
 * visual placement on the canvas.
 * x/y: offset of the element center from the canvas center, in canvas pixels.
 * scale: 1 means "contain" fit for media (largest size that fits fully inside the canvas),
 *        and natural size for text.
 * rotation: degrees, clockwise.
 * opacity: 0..1
 */
export interface Transform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
}

interface ClipBase {
  id: string;
  trackId: string;
  /** position on the timeline */
  start: number;
  /** length on the timeline (already accounts for speed) */
  duration: number;
  name: string;
  /** seconds of fade at the head/tail. affects opacity for visuals and gain for audio. */
  fadeIn: number;
  fadeOut: number;
}

export interface VideoClip extends ClipBase {
  type: 'video';
  assetId: string;
  /** offset into the source where this clip begins (source seconds) */
  trimStart: number;
  /** playback rate. source time = trimStart + (t - start) * speed */
  speed: number;
  /** 0..2 linear gain */
  volume: number;
  muted: boolean;
  transform: Transform;
}

export interface ImageClip extends ClipBase {
  type: 'image';
  assetId: string;
  transform: Transform;
}

export interface AudioClip extends ClipBase {
  type: 'audio';
  assetId: string;
  trimStart: number;
  speed: number;
  volume: number;
  muted: boolean;
}

export type TextAlign = 'left' | 'center' | 'right';

export interface TextClip extends ClipBase {
  type: 'text';
  text: string;
  fontFamily: string;
  /** canvas pixels at scale 1 */
  fontSize: number;
  fontWeight: 400 | 700;
  italic: boolean;
  color: string;
  /** css color for a box behind the text, or null for none */
  background: string | null;
  align: TextAlign;
  transform: Transform;
}

export type Clip = VideoClip | ImageClip | AudioClip | TextClip;
export type ClipType = Clip['type'];
export type VisualClip = VideoClip | ImageClip | TextClip;
export type MediaClip = VideoClip | ImageClip | AudioClip;
/** clips that read from a timed source (have trimStart/speed/volume) */
export type TimedClip = VideoClip | AudioClip;

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** canvas size in pixels */
  width: number;
  height: number;
  fps: number;
  /** css color drawn behind everything */
  background: string;
  assets: MediaAsset[];
  tracks: Track[];
  clips: Clip[];
}

/** lightweight row for the projects screen */
export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  width: number;
  height: number;
  fps: number;
  duration: number;
  clipCount: number;
}

export const DEFAULT_TRANSFORM: Transform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };

export const MIN_CLIP_DURATION = 0.05;
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

export function isVisualClip(c: Clip): c is VisualClip {
  return c.type === 'video' || c.type === 'image' || c.type === 'text';
}
export function isMediaClip(c: Clip): c is MediaClip {
  return c.type === 'video' || c.type === 'image' || c.type === 'audio';
}
export function isTimedClip(c: Clip): c is TimedClip {
  return c.type === 'video' || c.type === 'audio';
}
/** which track kind a clip type must live on */
export function trackKindForClip(type: ClipType): TrackKind {
  return type === 'audio' ? 'audio' : 'video';
}
