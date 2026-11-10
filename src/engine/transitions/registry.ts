/**
 * transitions between two clips on the same track (types.ts Transition, stored on the INCOMING clip).
 * the picture of the outgoing clip (a) and the incoming clip (b) are each drawn as a full frame layer,
 * then one webgl pass mixes them by progress 0..1. the look lives in ./defs.ts.
 */
import { TRANSITION_GLSL } from './defs';
import { GLSL_PACK2 } from './defs2';
import { GLSL_3D } from './defs3d';

export type TransitionCategory = 'fade' | 'move' | 'wipe' | 'stylize' | '3d';

export const TRANSITION_CATEGORIES: { id: TransitionCategory; label: string }[] = [
  { id: 'fade', label: 'fade' },
  { id: 'move', label: 'move' },
  { id: 'wipe', label: 'wipe' },
  { id: 'stylize', label: 'stylize' },
  { id: '3d', label: '3d' },
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
  // pack 2
  ['cube-left', 'cube left', '3d'],
  ['cube-right', 'cube right', '3d'],
  ['cube-up', 'cube up', '3d'],
  ['cube-down', 'cube down', '3d'],
  ['flip-horizontal', 'flip horizontal', '3d'],
  ['flip-vertical', 'flip vertical', '3d'],
  ['door', 'door', '3d'],
  ['fold', 'fold', '3d'],
  ['page-turn', 'page turn', '3d'],
  ['fly-in', 'fly in', '3d'],
  ['swing', 'swing', '3d'],
  ['zoom-blur', 'zoom blur', 'move'],
  ['stretch-left', 'stretch left', 'move'],
  ['stretch-right', 'stretch right', 'move'],
  ['roll', 'roll', 'move'],
  ['slide-diagonal', 'slide diagonal', 'move'],
  ['squeeze', 'squeeze', 'move'],
  ['wipe-diagonal', 'diagonal wipe', 'wipe'],
  ['barn-h', 'barn door h', 'wipe'],
  ['barn-v', 'barn door v', 'wipe'],
  ['diamond', 'diamond', 'wipe'],
  ['star', 'star', 'wipe'],
  ['heart', 'heart', 'wipe'],
  ['spiral', 'spiral', 'wipe'],
  ['radial-bars', 'radial bars', 'wipe'],
  ['fan', 'fan', 'wipe'],
  ['wave-wipe', 'wave wipe', 'wipe'],
  ['noise-wipe', 'noise wipe', 'wipe'],
  ['stripes', 'stripes', 'wipe'],
  ['split', 'split', 'wipe'],
  ['burn', 'burn', 'stylize'],
  ['tv-off', 'tv off', 'stylize'],
  ['luma-fade', 'luma fade', 'stylize'],
  ['kaleido-spin', 'kaleidoscope', 'stylize'],
  ['morph', 'morph', 'stylize'],
  ['light-sweep', 'light sweep', 'stylize'],
  ['film-roll', 'film roll', 'stylize'],
  ['dreamy', 'dreamy', 'stylize'],
  ['shake-cut', 'shake cut', 'stylize'],
  ['color-pulse', 'color pulse', 'stylize'],
];

const GLSL: Record<string, string> = { ...TRANSITION_GLSL, ...GLSL_PACK2, ...GLSL_3D };

export const TRANSITIONS: TransitionDef[] = LIST.map(([id, name, category]) => ({
  id,
  name,
  category,
  glsl: GLSL[id] ?? TRANSITION_GLSL['cross-fade']!,
}));

const BY_ID = new Map(TRANSITIONS.map((t) => [t.id, t]));

export function getTransition(id: string): TransitionDef | undefined {
  return BY_ID.get(id);
}

export function transitionsInCategory(category: TransitionCategory): TransitionDef[] {
  return TRANSITIONS.filter((t) => t.category === category);
}
