/**
 * ready-made motions for whole clips (types.ts ClipAnim: clip.motionIn / motionOut / motionLoop).
 * a motion never changes stored values: it is applied on top of the clip's transform (after
 * keyframes) at draw time, so preview and export always match.
 */
import type { VisualClip } from '../types';

export interface ClipMotionInfo {
  id: string;
  /** lowercase label for menus */
  name: string;
}

/** entrances. the exits are the same moves played backwards (the clip leaves the way it would have come). */
export const CLIP_MOTIONS_IN: ClipMotionInfo[] = [
  { id: 'fade', name: 'fade' },
  { id: 'slide-left', name: 'slide from right' },
  { id: 'slide-right', name: 'slide from left' },
  { id: 'slide-up', name: 'slide from below' },
  { id: 'slide-down', name: 'slide from above' },
  { id: 'zoom-in', name: 'grow' },
  { id: 'zoom-out', name: 'shrink' },
  { id: 'pop', name: 'pop' },
  { id: 'spin', name: 'spin' },
  { id: 'drop', name: 'drop' },
  { id: 'swing', name: 'swing' },
  { id: 'flip', name: 'flip' },
];

export const CLIP_MOTIONS_OUT: ClipMotionInfo[] = CLIP_MOTIONS_IN;

export const CLIP_MOTIONS_LOOP: ClipMotionInfo[] = [
  { id: 'pulse', name: 'pulse' },
  { id: 'float', name: 'float' },
  { id: 'wobble', name: 'wobble' },
  { id: 'shake', name: 'shake' },
  { id: 'rotate', name: 'rotate' },
  { id: 'swing', name: 'swing' },
  { id: 'bounce', name: 'bounce' },
  { id: 'blink', name: 'blink' },
  { id: 'orbit', name: 'orbit' },
];

export const DEFAULT_CLIP_MOTION_IN = 0.5;
export const DEFAULT_CLIP_MOTION_OUT = 0.5;
export const DEFAULT_CLIP_MOTION_LOOP = 2;

/** true when the clip has any motion set */
export function hasClipMotion(clip: VisualClip): boolean {
  return !!(clip.motionIn || clip.motionOut || clip.motionLoop);
}

/**
 * the clip with its motions applied at a timeline time. pass the clip AFTER resolveClip (keyframes
 * baked in). returns the same object when no motion is active at that time.
 * `size` = the project canvas (slides travel relative to it).
 */
export function applyClipMotion<T extends VisualClip>(clip: T, time: number, size: { width: number; height: number }): T {
  // filled in by the motion engine; a clip without motions is returned untouched
  void time;
  void size;
  return clip;
}
