/**
 * text animations (types.ts TextAnim on a text clip: animIn, animOut, animLoop).
 * an animation moves / fades each letter (or word, or the whole block) of a text clip.
 * the lists here are what the ui offers; the motion itself is in glyphState below.
 */
import type { TextClip } from '../types';

export interface TextAnimInfo {
  id: string;
  /** lowercase display name */
  name: string;
}

/** entrances. the same ids work as exits (played backwards). */
export const TEXT_ANIMS_IN: TextAnimInfo[] = [
  { id: 'fade', name: 'fade' },
  { id: 'typewriter', name: 'typewriter' },
  { id: 'cascade', name: 'cascade' },
  { id: 'rise', name: 'rise' },
  { id: 'drop', name: 'drop' },
  { id: 'slide-left', name: 'slide left' },
  { id: 'slide-right', name: 'slide right' },
  { id: 'pop', name: 'pop' },
  { id: 'zoom', name: 'zoom' },
  { id: 'spin', name: 'spin' },
  { id: 'stretch', name: 'stretch' },
  { id: 'flicker', name: 'flicker' },
  { id: 'words', name: 'word by word' },
  { id: 'lines', name: 'line by line' },
];

export const TEXT_ANIMS_OUT: TextAnimInfo[] = TEXT_ANIMS_IN;

export const TEXT_ANIMS_LOOP: TextAnimInfo[] = [
  { id: 'wave', name: 'wave' },
  { id: 'wobble', name: 'wobble' },
  { id: 'pulse', name: 'pulse' },
  { id: 'bounce', name: 'bounce' },
  { id: 'shake', name: 'shake' },
  { id: 'float', name: 'float' },
  { id: 'pendulum', name: 'pendulum' },
  { id: 'jelly', name: 'jelly' },
  { id: 'blink', name: 'blink' },
  { id: 'rainbow', name: 'rainbow' },
];

export const DEFAULT_TEXT_ANIM_IN = 0.6;
export const DEFAULT_TEXT_ANIM_OUT = 0.6;
export const DEFAULT_TEXT_ANIM_LOOP = 1.5;

/** true when the clip's look changes over time because of a text animation at this clip-local time */
export function textAnimActive(clip: TextClip, local: number): boolean {
  if (clip.animLoop) return true;
  if (clip.animIn && local < clip.animIn.duration) return true;
  if (clip.animOut && local > clip.duration - clip.animOut.duration) return true;
  return false;
}
