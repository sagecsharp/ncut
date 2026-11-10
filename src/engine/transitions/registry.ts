/**
 * transitions between two clips on the same track (types.ts Transition, stored on the INCOMING clip).
 * the picture of the outgoing clip (a) and the incoming clip (b) are each drawn as a full frame layer,
 * then one webgl pass mixes them by progress 0..1. the look lives in ./defs.ts.
 */
import { TRANSITION_GLSL } from './defs';

export type TransitionCategory = 'fade' | 'move' | 'wipe' | 'stylize';

export const TRANSITION_CATEGORIES: { id: TransitionCategory; label: string }[] = [
  { id: 'fade', label: 'fade' },
  { id: 'move', label: 'move' },
  { id: 'wipe', label: 'wipe' },
  { id: 'stylize', label: 'stylize' },
];

export interface TransitionDef {
  /** stable id saved in projects. lowercase-kebab. */
  id: string;
  /** lowercase display name */
  name: string;
  category: TransitionCategory;
  /** glsl defining `vec4 transition(vec2 uv, float p)`. see ./defs.ts. */
  glsl: string;
}

export const DEFAULT_TRANSITION_DURATION = 0.6;
export const MIN_TRANSITION_DURATION = 0.1;
export const MAX_TRANSITION_DURATION = 5;

const LIST: [id: string, name: string, category: TransitionCategory][] = [
  ['cross-fade', 'cross fade', 'fade'],
  ['dip-black', 'dip to black', 'fade'],
  ['dip-white', 'dip to white', 'fade'],
  ['blur-fade', 'blur fade', 'fade'],
  ['dissolve', 'dissolve', 'fade'],
  ['slide-left', 'slide left', 'move'],
  ['slide-right', 'slide right', 'move'],
  ['slide-up', 'slide up', 'move'],
  ['slide-down', 'slide down', 'move'],
  ['push-left', 'push left', 'move'],
  ['push-right', 'push right', 'move'],
  ['push-up', 'push up', 'move'],
  ['push-down', 'push down', 'move'],
  ['whip-left', 'whip left', 'move'],
  ['whip-right', 'whip right', 'move'],
  ['zoom-in', 'zoom in', 'move'],
  ['zoom-out', 'zoom out', 'move'],
  ['spin', 'spin', 'move'],
  ['wipe-left', 'wipe left', 'wipe'],
  ['wipe-right', 'wipe right', 'wipe'],
  ['wipe-up', 'wipe up', 'wipe'],
  ['wipe-down', 'wipe down', 'wipe'],
  ['iris', 'iris', 'wipe'],
  ['clock', 'clock wipe', 'wipe'],
  ['blinds', 'blinds', 'wipe'],
  ['checker', 'checker', 'wipe'],
  ['glitch', 'glitch', 'stylize'],
  ['pixelate', 'pixelate', 'stylize'],
  ['rgb-split', 'rgb split', 'stylize'],
  ['flash', 'flash', 'stylize'],
  ['ripple', 'ripple', 'stylize'],
];

export const TRANSITIONS: TransitionDef[] = LIST.map(([id, name, category]) => ({
  id,
  name,
  category,
  glsl: TRANSITION_GLSL[id] ?? TRANSITION_GLSL['cross-fade']!,
}));

const BY_ID = new Map(TRANSITIONS.map((t) => [t.id, t]));

export function getTransition(id: string): TransitionDef | undefined {
  return BY_ID.get(id);
}

export function transitionsInCategory(category: TransitionCategory): TransitionDef[] {
  return TRANSITIONS.filter((t) => t.category === category);
}
