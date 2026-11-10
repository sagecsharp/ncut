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
 * 'video' tracks hold video, image, text, effect and camera clips (anything visual).
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
  /** 3d only (clip.threeD). depth in project pixels: + is away from the viewer, 0 = the canvas plane. */
  z?: number;
  /** 3d only. degrees. tilt: + leans the top edge away. */
  rotX?: number;
  /** 3d only. degrees. turn: + faces the plane to the right (its right edge moves away). */
  rotY?: number;
}

/**
 * 3d: 'camera' keeps the plane facing the camera position (a billboard), 'cameraY' does the same but
 * stays upright (only turns left / right). rotation / tilt / turn are applied on top.
 */
export type LookAt = 'none' | 'camera' | 'cameraY';

export type Easing = 'linear' | 'ease' | 'ease-in' | 'ease-out' | 'hold' | 'back' | 'bounce' | 'elastic';

export interface Keyframe {
  /** clip-local seconds (0 = the clip's start) */
  t: number;
  v: number;
  /** how the value travels from this key to the next one */
  ease: Easing;
}

/** animated properties of a clip: property name -> keys sorted by time. see lib/anim.ts. */
export type Keyframes = Record<string, Keyframe[]>;

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
  /** keyframe animation. a property listed here ignores its static value. see lib/anim.ts. */
  keyframes?: Keyframes;
}

/** shared by the clips that draw a picture (video, image, text) */
interface Spatial {
  transform: Transform;
  /**
   * true = the clip is a plane in 3d space seen through the camera (transform.z / rotX / rotY apply,
   * planes hide and cut through each other by depth). false / missing = a flat 2d layer.
   */
  threeD?: boolean;
  lookAt?: LookAt;
}

export interface VideoClip extends ClipBase, Spatial {
  type: 'video';
  assetId: string;
  /** offset into the source where this clip begins (source seconds) */
  trimStart: number;
  /** playback rate. source time = trimStart + (t - start) * speed */
  speed: number;
  /** 0..2 linear gain */
  volume: number;
  muted: boolean;
}

export interface ImageClip extends ClipBase, Spatial {
  type: 'image';
  assetId: string;
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

export interface TextClip extends ClipBase, Spatial {
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
}

/**
 * an effect clip is an adjustment layer: while it is active it changes the picture made by
 * everything BELOW its track (lower video tracks + the background). it lives on a video track.
 * the look is animated by the clip-local time, so preview and export always match.
 */
export interface EffectClip extends ClipBase {
  type: 'effect';
  /** id of an effect in engine/effects/registry. unknown ids are skipped. */
  effect: string;
  /** overall strength 0..1. also scaled by fadeIn / fadeOut. */
  amount: number;
  /** values keyed by the effect's param keys. missing keys use the effect's default. */
  params: Record<string, number>;
  /** varies the random parts (shake path, noise) between clips */
  seed: number;
}

/**
 * the 3d camera for its time range. lives on a video track; when several are active the one on the
 * highest track wins. without a camera clip the home camera is used (straight on, the canvas plane
 * fills the frame). every value is an offset from that home pose and can be keyframed.
 */
export interface CameraClip extends ClipBase {
  type: 'camera';
  /** position offset in project pixels: +x right, +y down, +z forward (toward the scene) */
  x: number;
  y: number;
  z: number;
  /** degrees. pan + looks right, tilt + looks up, roll + turns clockwise. */
  pan: number;
  tilt: number;
  roll: number;
  /** vertical field of view in degrees (home = 50). smaller zooms in. */
  fov: number;
}

export type Clip = VideoClip | ImageClip | AudioClip | TextClip | EffectClip | CameraClip;
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
export function isCameraClip(c: Clip): c is CameraClip {
  return c.type === 'camera';
}
export function isEffectClip(c: Clip): c is EffectClip {
  return c.type === 'effect';
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
