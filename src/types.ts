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

/** what a 3d clip is wrapped on. every shape is unlit and shows the clip's picture on each face. */
export type Shape3D = 'plane' | 'box' | 'sphere' | 'cylinder';

/**
 * a transition INTO a clip from whatever was on its track right before it (or from nothing).
 * it is centered on the clip's start: half of `duration` before the cut, half after.
 * `id` is a transition in engine/transitions/registry.
 */
export interface Transition {
  id: string;
  /** seconds, whole length */
  duration: number;
}

/**
 * how a clip's picture mixes with what is already under it. 'normal' = plain alpha.
 * 2d clips use the canvas composite operation of the same idea; 3d clips support them through the
 * gl blend state where possible (see engine/draw.ts).
 */
export type BlendMode = 'normal' | 'add' | 'screen' | 'multiply' | 'overlay' | 'darken' | 'lighten' | 'difference';

export const BLEND_MODES: BlendMode[] = ['normal', 'add', 'screen', 'multiply', 'overlay', 'darken', 'lighten', 'difference'];

/** how much of each edge of a clip's picture is cut off, as a fraction of its own width / height (0..1) */
export interface Crop {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * a ready-made motion for a whole clip (video, image, shape, text). `id` is a motion in engine/clipAnim.
 * in / out: `duration` = how long the entrance / exit takes (seconds). loop: seconds per cycle.
 * it is applied on top of the clip's own transform / keyframes and never changes the stored values.
 */
export interface ClipAnim {
  id: string;
  duration: number;
}

/** shared by the clips that draw a picture (video, image, text, shape) */
interface Spatial {
  transform: Transform;
  /**
   * true = the clip is a plane in 3d space seen through the camera (transform.z / rotX / rotY apply,
   * planes hide and cut through each other by depth). false / missing = a flat 2d layer.
   */
  threeD?: boolean;
  lookAt?: LookAt;
  /** 3d only. missing = 'plane'. */
  shape?: Shape3D;
  /** 3d only, box / cylinder: thickness in project pixels at scale 1. missing = the clip's height. */
  shapeDepth?: number;
  /** transition into this clip. null / missing = a plain cut. */
  transition?: Transition | null;
  /** missing = 'normal' */
  blend?: BlendMode;
  /** cut the edges off. the picture keeps its place: cropping never moves or stretches what is left. */
  crop?: Crop | null;
  /** corner roundness of the (cropped) picture, 0..1. 1 = fully round ends (a circle for a square). */
  radius?: number;
  /** ready-made motion when the clip appears / leaves / while it is on screen (engine/clipAnim) */
  motionIn?: ClipAnim | null;
  motionOut?: ClipAnim | null;
  motionLoop?: ClipAnim | null;
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

/** outline around the letters */
export interface TextStroke {
  color: string;
  /** thickness as a fraction of the font size (0.05 = thin, 0.2 = heavy) */
  width: number;
}

/** flat drop shadow behind the letters */
export interface TextShadow {
  color: string;
  /** 0..1 */
  opacity: number;
  /** softness as a fraction of the font size. 0 = a hard copy. */
  blur: number;
  /** offset as a fraction of the font size */
  distance: number;
  /** degrees, direction the shadow falls. 0 = right, 90 = down. */
  angle: number;
}

/**
 * a text animation. `id` is an animation in engine/textAnim.
 * in / out: `duration` = how long the entrance / exit takes (seconds).
 * loop: `duration` = seconds per cycle.
 */
export interface TextAnim {
  id: string;
  duration: number;
}

/** fill the letters with a gradient instead of one color */
export interface TextGradient {
  from: string;
  to: string;
  /** degrees. 0 = left to right, 90 = top to bottom. */
  angle: number;
}

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
  /* ---- optional style. missing = the plain look. ---- */
  /** extra space between letters as a fraction of the font size (0 = normal) */
  letterSpacing?: number;
  /** line height as a multiple of the font size. missing = 1.25 */
  lineHeight?: number;
  /** draw the text in capitals */
  uppercase?: boolean;
  stroke?: TextStroke | null;
  shadow?: TextShadow | null;
  /** corner roundness of the background box, 0..1 (1 = pill) */
  backgroundRadius?: number;
  /** space between the text and the edge of its box as a fraction of the font size. missing = 0.3 */
  backgroundPadding?: number;
  /** gradient fill across the whole text block. null / missing = the plain `color`. */
  gradient?: TextGradient | null;
  /**
   * bend the text along a circle: degrees of arc one line spans. + = an arch (ends hang down),
   * - = a smile (ends rise). 0 / missing = straight. 360 = a full ring.
   */
  curve?: number;
  /** wrap lines longer than this (canvas pixels at scale 1). 0 / missing = only break at line breaks. */
  wrapWidth?: number;
  /* ---- animation ---- */
  animIn?: TextAnim | null;
  animOut?: TextAnim | null;
  animLoop?: TextAnim | null;
}

export type ShapeKind = 'rect' | 'ellipse' | 'triangle' | 'polygon' | 'star' | 'heart' | 'arrow' | 'line';

export const SHAPE_KINDS: ShapeKind[] = ['rect', 'ellipse', 'triangle', 'polygon', 'star', 'heart', 'arrow', 'line'];

/** outline of a shape */
export interface ShapeStroke {
  color: string;
  /** canvas pixels at scale 1 */
  width: number;
}

/**
 * a drawn shape: a solid or gradient filled figure. it is a visual clip like an image (transform,
 * 3d, transitions, crop, blend all work). a full-canvas rect is a solid background.
 * `radius` (Spatial) rounds the corners of a rect.
 */
export interface ShapeClip extends ClipBase, Spatial {
  type: 'shape';
  kind: ShapeKind;
  /** size of the shape's box in canvas pixels at scale 1 */
  width: number;
  height: number;
  /** fill color. also the first gradient color. */
  color: string;
  /** second gradient color. null / missing = flat fill. */
  color2?: string | null;
  /** degrees. 0 = left to right, 90 = top to bottom. missing = 90. */
  gradientAngle?: number;
  /** true = the gradient runs from the center outwards */
  gradientRadial?: boolean;
  /** false = no fill, only the outline. missing = true. */
  filled?: boolean;
  stroke?: ShapeStroke | null;
  /** polygon: number of corners (3..12, missing = 6). star: number of points (3..12, missing = 5). */
  points?: number;
  /** star: inner radius as a fraction of the outer one (0.1..0.95, missing = 0.45) */
  inner?: number;
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
  /**
   * seconds added to the clip-local time that animates the look. set on the right half when an
   * effect clip is split, so the animation carries on across the cut instead of starting over.
   */
  timeOffset?: number;
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
  /**
   * id of a visual clip the camera keeps looking at (its center, wherever it moves). pan / tilt are
   * added on top as an offset. null / missing / unknown id = no target.
   */
  target?: string | null;
}

/** a named point on the timeline (snaps, jump with shortcuts) */
export interface Marker {
  id: string;
  /** timeline seconds */
  time: number;
  name: string;
}

export type Clip = VideoClip | ImageClip | AudioClip | TextClip | ShapeClip | EffectClip | CameraClip;
export type ClipType = Clip['type'];
export type VisualClip = VideoClip | ImageClip | TextClip | ShapeClip;
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
  /** sorted by time. missing = none. */
  markers?: Marker[];
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
  return c.type === 'video' || c.type === 'image' || c.type === 'text' || c.type === 'shape';
}
export function isShapeClip(c: Clip): c is ShapeClip {
  return c.type === 'shape';
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
