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
 * scaleX / scaleY / scaleZ: a stretch of one axis on top of scale (missing = 1). the clip's box is
 *        (size at scale 1) x scale x scaleX wide and x scale x scaleY high. scaleZ is the depth of a 3d solid
 *        or of extruded text. a stretch is the clip's own: clips attached to it follow scale only.
 * rotation: degrees, clockwise.
 * opacity: 0..1
 */
export interface Transform {
  x: number;
  y: number;
  scale: number;
  /** stretch along the clip's own x axis, on top of scale. missing = 1. read it with stretchX. */
  scaleX?: number;
  /** stretch along the clip's own y axis, on top of scale. missing = 1. read it with stretchY. */
  scaleY?: number;
  /** stretch of the depth of a 3d solid / extruded text, on top of scale. missing = 1. read it with stretchZ. */
  scaleZ?: number;
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
 * stays upright (only turns left / right). 'clip' faces the center of another clip (Spatial.lookTarget),
 * wherever that one moves; without a valid target it behaves like 'none'.
 * rotation / tilt / turn are applied on top.
 */
export type LookAt = 'none' | 'camera' | 'cameraY' | 'clip';

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
  /**
   * clips with the same group id belong together: clicking one selects them all (see lib/links.ts
   * expandGroups), so they move, copy and delete as one. missing = not grouped.
   */
  group?: string;
}

/**
 * what a 3d clip is wrapped on. every shape is unlit and shows the clip's picture on each face.
 * capsule = a tube with round ends. prism / hexagon / star / heart = that outline pushed back along z
 * (thickness = shapeDepth): the picture on the front and the back face, a side all around.
 */
export type Shape3D = 'plane' | 'box' | 'sphere' | 'cylinder' | 'cone' | 'pyramid' | 'torus' | 'capsule' | 'prism' | 'hexagon' | 'star' | 'heart';

export const SHAPES_3D: Shape3D[] = ['plane', 'box', 'sphere', 'cylinder', 'cone', 'pyramid', 'torus', 'capsule', 'prism', 'hexagon', 'star', 'heart'];

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

/**
 * motion blur for one clip: the clip is drawn several times across the time the shutter is open and
 * the copies are averaged, so whatever moves it (keyframes, motions, its parent) leaves a trail.
 * the picture itself (a video frame) is not blurred, only its movement. see engine/draw.ts.
 */
export interface ClipMotionBlur {
  /** how long the shutter stays open, in frames. 0.5 = the classic 180 degree shutter. 0..2 */
  shutter: number;
  /** how many copies are averaged. 2..32 */
  samples: number;
  /**
   * the kind of blur. missing = 'even'.
   * 'even'  = every moment of the open shutter counts the same: the classic smooth smear.
   * 'trail' = the clip itself stays sharp and bright where it is now and leaves a tail that fades out
   *           behind it (the weights fall off toward the past, nothing from the future).
   * 'ghost' = a few separate see-through copies behind the clip instead of a smear (a strobe look):
   *           at most 5 copies spread over the shutter, however many samples are set.
   */
  style?: MotionBlurStyle;
}

export type MotionBlurStyle = 'even' | 'trail' | 'ghost';
export const MOTION_BLUR_STYLES: MotionBlurStyle[] = ['even', 'trail', 'ghost'];

/** color correction of one clip's picture. every value at 0 changes nothing. see engine/clipLook.ts. */
export interface ClipAdjust {
  /** -1..1 */
  brightness: number;
  /** -1..1 */
  contrast: number;
  /** -1..1 (-1 = gray) */
  saturation: number;
  /** degrees, -180..180 */
  hue: number;
  /** -1 (cool) .. 1 (warm) */
  temperature: number;
}

/** make one color of a clip's picture see-through (green screen). see engine/clipLook.ts. */
export interface ChromaKey {
  /** css hex color to remove */
  color: string;
  /** how far from the color still counts, 0..1 */
  tolerance: number;
  /** width of the soft edge, 0..1 */
  softness: number;
  /** how strongly the key color is taken out of what stays (edges, reflections), 0..1 */
  spill: number;
}

export type MaskShape = 'rect' | 'ellipse' | 'split' | 'band' | 'star' | 'heart';

export const MASK_SHAPES: MaskShape[] = ['rect', 'ellipse', 'split', 'band', 'star', 'heart'];

/**
 * show only part of a clip's picture, with an optional soft edge. everything is relative to the
 * clip's own (cropped) picture, so the mask moves, scales and turns with the clip. see engine/mask.ts.
 * - rect / ellipse / star / heart: the figure of width x height centered at x, y
 * - split: a straight edge through x, y: the side the rotation points away from is hidden
 *   (rotation 0 keeps the left half, 90 keeps the top half)
 * - band: a stripe of `height` across the picture through x, y (rotation 0 = a horizontal stripe)
 */
export interface Mask {
  shape: MaskShape;
  /** center of the mask as an offset from the picture's center, in fractions of its width / height */
  x: number;
  y: number;
  /** size in fractions of the picture's width / height (1 = as big as the picture). 0..3 */
  width: number;
  height: number;
  /** degrees, clockwise */
  rotation: number;
  /** soft edge, 0..1 (a fraction of the picture's shorter side / 2) */
  feather: number;
  /** show what is outside the figure instead */
  invert: boolean;
  /** rect only: corner roundness 0..1 */
  radius?: number;
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
  /** lookAt 'clip': id of the visual clip to face. null / missing / unknown id = no target. */
  lookTarget?: string | null;
  /** 3d only. missing = 'plane'. */
  shape?: Shape3D;
  /**
   * 3d only, every solid shape: thickness in project pixels at scale 1. missing = the clip's height for a
   * box and the clip's width for every other solid (as deep as wide), measured on the clip's own box
   * (a text's outline, shadow or animation room does not count).
   */
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
  /**
   * id of the clip this one is attached to (a visual clip or a camera clip). the clip's own
   * transform is then relative to the parent: it moves, turns and scales with it. opacity is not
   * inherited. null / missing / unknown id / a loop = no parent. the exact rules are in engine/parent.ts.
   */
  parent?: string | null;
  /** blurs the clip's own moves (keyframes, motions, parents), 2d and 3d. a camera move is not part of it: that is what the motion blur effect layer is for. null / missing = off. */
  motionBlur?: ClipMotionBlur | null;
  adjust?: ClipAdjust | null;
  chromaKey?: ChromaKey | null;
  mask?: Mask | null;
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
  /** tempo of its sound, like an audio clip (see AudioClip) */
  bpm?: number | null;
  beatOffset?: number | null;
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
  /** tempo of the sound in beats per minute at normal speed, detected or typed. missing or null = not known. see lib/tempo.ts */
  bpm?: number | null;
  /** source seconds where a beat falls: the beat grid runs both ways from there. missing = 0 */
  beatOffset?: number | null;
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

/**
 * the words of a text take turns being the "current" word, spread over the clip's length by their
 * number of letters (so long words stay longer). see engine/text.ts.
 */
export interface TextHighlight {
  /** fill color of the lit words */
  color: string;
  /** 'word' = only the current word is lit. 'fill' = every word up to the current one stays lit. */
  mode: 'word' | 'fill';
  /** a box behind the current word (css color). null / missing = none. */
  background?: string | null;
  /**
   * seconds of the run that already happened before this clip starts. set on the right half of a split and by a
   * head trim, so the words carry on across the cut instead of starting over. missing = 0.
   */
  offset?: number;
  /** the length the run is spread over. set together with `offset` (both halves of a split keep the old length). missing = the clip's length. */
  fullDuration?: number;
}

/**
 * a running number: the text shows a number that counts from one value to another over the length
 * of the clip. every "{n}" in the clip's text is replaced by the number; a text without "{n}" shows
 * only the number. see counterValue / counterText in engine/counter.ts.
 */
export interface TextCounter {
  /** the number at the start of the clip */
  from: number;
  /** the number it ends on */
  to: number;
  /** digits after the point, 0..4 */
  decimals: number;
  /** group the digits in threes: 1,234,567. missing = false. */
  separator?: boolean;
  /** how it moves: 'linear' = steady, 'out' = fast then settling, 'in-out' = slow, fast, slow. missing = 'out'. */
  ease?: 'linear' | 'out' | 'in-out';
  /** seconds at the end of the clip where the final number just stays. missing = 0. */
  hold?: number;
  /**
   * how the number is written. 'number' (missing) = digits with `decimals` and `separator`.
   * 'time' = the value is seconds, written as m:ss (h:mm:ss from one hour on). `decimals` adds fractions of a
   * second (1:05.3), `separator` is ignored. a count from 90 to 0 reads 1:30 ... 0:00.
   */
  format?: 'number' | 'time';
  /**
   * every digit takes the width of the widest digit of the font, so the text around the number does not
   * jiggle while it counts. missing = false.
   */
  fixedWidth?: boolean;
  /**
   * seconds of counting that already happened before this clip starts. set on the right half of a split and
   * by a head trim, so the number carries on across the cut instead of starting over. missing = 0.
   */
  offset?: number;
  /**
   * the length the count is spread over, in seconds: the clip's length before it was split or trimmed at the
   * head. missing = the clip's own duration (making the clip longer or shorter then changes the pace).
   */
  fullDuration?: number;
}

/**
 * a solid side for the letters: the text is repeated behind itself along a direction, like block
 * letters or a long hard shadow. drawn under the fill and the outline. see engine/text.ts.
 * on a 3d text clip (threeD) the side is real depth: the letters are stacked back along z by depth x font
 * size, so they show a side whenever the clip or the camera turns. angle is not used there.
 */
export interface TextExtrude {
  /** how far the side reaches, as a fraction of the font size. 0..1 */
  depth: number;
  /** direction it reaches toward, degrees clockwise from the right (45 = down right) */
  angle: number;
  /** css color of the side */
  color: string;
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
  /**
   * a second outline around the first one (sticker / comic titles). its width is a fraction of the font size
   * like `stroke`, measured outward from the edge of the first outline (from the letters when there is no
   * first outline). drawn under the first outline and the fill. null / missing = none.
   */
  stroke2?: TextStroke | null;
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
  /** karaoke: the words light up one after another over the length of the clip. null / missing = off. */
  highlight?: TextHighlight | null;
  /** block letters / long shadow. null / missing = off. */
  extrude?: TextExtrude | null;
  /** a running number inside the text. null / missing = off. */
  counter?: TextCounter | null;
  /** a line under every line of text, in the fill color, about 1/14 of the font size thick. missing = false. */
  underline?: boolean;
  /** a line through the middle of every line of text. missing = false. */
  strike?: boolean;
  /**
   * hollow letters: the fill is left out and only the outline shows (what is behind the text shows through
   * the letters). needs an outline (`stroke`); without one the text draws a thin outline in the fill color
   * (about 1/30 of the font size) so it never disappears. missing = false.
   */
  hollow?: boolean;
  /**
   * the background box (`background`) is drawn once per line, each hugging its own line's width
   * (the caption / label look), instead of one box around the whole block. missing = false.
   */
  backgroundPerLine?: boolean;
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
  /**
   * draw on: the part of the outline that is drawn, as shares of its length (0..1) measured from the
   * shape's start point in drawing direction. missing = 0 and 1 = the whole outline. both can be keyframed
   * (drawEnd from 0 to 1 draws the line on, drawStart from 0 to 1 wipes it off behind). only the outline
   * (stroke) and the kinds 'line' and 'arrow' follow it; a fill is not cut. an arrow keeps its head at the
   * drawn end.
   */
  drawStart?: number;
  drawEnd?: number;
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
  /**
   * the length of the effect before it was split or trimmed at the head, in seconds. effects that
   * spread a move over their whole length (whip) keep reading this, so the move carries on across a
   * cut instead of being squeezed into each half. missing = the clip's own duration.
   */
  fullDuration?: number;
  /**
   * id of ONE visual clip (video, image, text, shape) this effect is put on. null / missing = the
   * normal adjustment layer: everything under the effect's track. with a target the effect changes
   * only that clip's picture, wherever the two tracks are in the stack, while both clips are on
   * screen; the rest of the frame is left alone. an unknown id, a target that is not a visual clip
   * or the effect itself = the effect does nothing. see engine/draw.ts.
   */
  target?: string | null;
  /**
   * follow the tempo (bpm) of a clip with sound, evaluated when a frame is drawn (nothing is baked into keyframes).
   * missing / null = off. see lib/tempo.ts (EffectBeat) and engine/draw.ts (effectPassAt).
   * - source: id of the clip whose tempo to follow. missing / null / a clip that has no tempo any more = the sound under the effect.
   * - every: one cycle every this many beats.
   * - pulse: 0..1. the strength hits full on every cycle line and falls off until the next one.
   * - lock: only for effects that repeat on their own (EffectDef.sync): their rhythm follows the cycle.
   */
  beat?: { source?: string | null; every: number; pulse: number; lock: boolean } | null;
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
  /**
   * depth of field: 3d clips go soft the farther they are from the focus distance, like a real lens.
   * focusStrength 0 / missing = off (everything sharp, the old look). 1 = strong. only 3d clips are affected,
   * flat 2d layers stay sharp.
   */
  focusStrength?: number;
  /** distance from the camera (project pixels, along its view direction) that is sharp. missing = the home distance (where z = 0 sits for the home camera). */
  focusDistance?: number;
  /** depth around the focus distance (project pixels) that stays fully sharp. missing = 0. */
  focusRange?: number;
  /** true = the focus distance follows the clip the camera looks at (`target`) and focusDistance is ignored while there is a target */
  focusOnTarget?: boolean;
}

/**
 * distance haze for the 3d space: 3d clips blend toward `color` the farther they are from the camera,
 * which gives an unlit scene depth. 2d layers are never fogged.
 */
export interface SceneFog {
  /** css hex color, usually the project background */
  color: string;
  /** distance from the camera (project pixels) where the haze starts */
  near: number;
  /** distance where it reaches `amount` */
  far: number;
  /** strongest haze, 0..1 */
  amount: number;
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
  /** haze over the 3d space. null / missing = none. */
  fog?: SceneFog | null;
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

/** the smallest and the largest value of scale and of each stretch */
export const MIN_SCALE = 0.01;
export const MAX_SCALE = 100;

/**
 * a missing or broken value is no stretch. every other value is held inside the range: a keyed stretch can pass below zero
 * for a few frames (the back and elastic easings swing past their end), and that must read as "almost nothing", not as 1.
 */
function stretchOf(v: number | undefined): number {
  if (v === undefined || !isFinite(v)) return 1;
  return v < MIN_SCALE ? MIN_SCALE : v > MAX_SCALE ? MAX_SCALE : v;
}
/** the stretch of a transform along x (1 = none). multiply it onto scale for the width. */
export function stretchX(t: { scaleX?: number }): number {
  return stretchOf(t.scaleX);
}
/** the stretch of a transform along y (1 = none) */
export function stretchY(t: { scaleY?: number }): number {
  return stretchOf(t.scaleY);
}
/** the stretch of a transform along z: the depth of a solid or of extruded text (1 = none) */
export function stretchZ(t: { scaleZ?: number }): number {
  return stretchOf(t.scaleZ);
}
/** true when a transform is stretched on any axis */
export function isStretched(t: { scaleX?: number; scaleY?: number; scaleZ?: number }): boolean {
  return stretchOf(t.scaleX) !== 1 || stretchOf(t.scaleY) !== 1 || stretchOf(t.scaleZ) !== 1;
}

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
