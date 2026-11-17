/* how every number of the properties feels: its unit, hard range, usual range (the face), step, snap and rest. pure. */
import type { ClipType } from '../../types';
import { MIN_CLIP_DURATION, MIN_SPEED, MAX_SPEED } from '../../types';
import type { EffectParam } from '../../engine/effects/types';
import { DEFAULT_CHROMA_KEY } from '../../engine/clipLook';
import { DEFAULT_MASK } from '../../engine/mask';
import { DEFAULT_FOV, homeDistance } from '../../engine/scene3d/camera';
import { DEFAULT_SUN, LIT_ON } from '../../engine/scene3d/light';
import { DEFAULT_TRANSITION_DURATION, MAX_TRANSITION_DURATION, MIN_TRANSITION_DURATION } from '../../engine/transitions/registry';
import { BPM_MAX, BPM_MIN } from '../../lib/tempo';
import { decimalsOf, JOG_PX, type Span } from '../../components/ui/sliderMath';
import { DEFAULT_BEAT } from './effectBeatLogic';
import { DEFAULT_MOTION_BLUR } from './colorLogic';
import { DEFAULT_SHAPE_STROKE } from './shapeLogic';
import { MAX_CROP_EDGE } from './look';
import { MAX_TURNS, MIN_TURNS, DEFAULT_PATH } from './pathMoves';
import { DEFAULT_REPEAT, MAX_REPEAT } from './repeat';
import { ARRANGE_DEFAULTS, type ArrangeKey } from './arrange3d';

/** sizes a range may depend on. home = Math.round(homeDistance(H)) (1158 at 1080p) */
export interface FeelCtx {
  W: number;
  H: number;
  home: number;
}

export function feelCtx(W: number, H: number): FeelCtx {
  return { W, H, home: Math.round(homeDistance(H)) };
}

export const DEFAULT_FEEL_CTX: FeelCtx = feelCtx(1920, 1080);

type Num = number | ((c: FeelCtx) => number);

/** one numeric field, in SHOWN units (stored * scale) */
export interface FeelEntry {
  /** shown = stored * scale. default 1 */
  scale?: number;
  /** the unit after the number: '%', 'px', 'deg', '°', 's', 'x', 'fr', '' */
  unit: string;
  /** hard limits. missing = none on that side */
  min?: Num;
  max?: Num;
  /** the face. null = no face (a jog field) */
  soft: readonly [Num, Num] | null;
  step: number;
  /** default decimalsOf(step) */
  precision?: number;
  /** ctrl grid. default 15 for 'deg' and '°', else step * 10 */
  snap?: number;
  /** jog fields only. default step / JOG_PX */
  perPx?: number;
  /** double click value. missing = no reset */
  rest?: Num;
  origin?: number;
  /** the anim.ts value this entry edits. the test pins min / max to animProps of these clip types times scale */
  anim?: { prop: string; types: readonly ClipType[] };
}

/** a resolved entry: plain numbers, -Infinity / Infinity for no hard limit */
export interface Feel {
  scale: number;
  unit: string;
  min: number;
  max: number;
  soft: Span | null;
  step: number;
  precision: number;
  snap: number;
  perPx: number;
  rest: number | null;
  origin: number | null;
}

/** site overrides, shown units. a key that is present wins, null included */
export interface FeelOverride {
  min?: number;
  max?: number;
  soft?: Span | null;
  rest?: number | null;
  precision?: number;
}

const V4 = ['video', 'image', 'text', 'shape'] as const;
const PCT = { unit: '%', scale: 100 } as const;

// text style defaults live in TextStyle.tsx (stroke 0.08, second outline 0.06, shadow 0.6, depth 0.2): shown x 100
const DEFAULT_STROKE = 8;
const DEFAULT_STROKE2 = 6;
const DEFAULT_SHADOW = 60;
const DEFAULT_EXTRUDE = 20;
// fogLogic.ts FOG_MAX and FOG_GAP (that file pulls in the store, so the numbers are copied)
const FOG_MAX = 50000;
const FOG_GAP = 10;

export const FEEL = {
  // clip
  clipIn: { unit: 's', min: 0, soft: null, step: 0.05, precision: 2, perPx: 0.02, snap: 1 },
  clipLen: { unit: 's', min: MIN_CLIP_DURATION, soft: null, step: 0.05, precision: 2, perPx: 0.02, snap: 1 },
  x: { unit: 'px', soft: [(c: FeelCtx) => -c.W / 2, (c: FeelCtx) => c.W / 2], step: 1, snap: 10, rest: 0, anim: { prop: 'x', types: ['video', 'image', 'text', 'shape', 'camera'] } },
  y: { unit: 'px', soft: [(c: FeelCtx) => -c.H / 2, (c: FeelCtx) => c.H / 2], step: 1, snap: 10, rest: 0, anim: { prop: 'y', types: ['video', 'image', 'text', 'shape', 'camera'] } },
  scale: { ...PCT, min: 1, max: 10000, soft: [1, 400], step: 1, snap: 10, rest: 100, anim: { prop: 'scale', types: V4 } },
  scaleX: { ...PCT, min: 1, max: 10000, soft: [1, 400], step: 1, snap: 10, rest: 100, anim: { prop: 'scaleX', types: V4 } },
  scaleY: { ...PCT, min: 1, max: 10000, soft: [1, 400], step: 1, snap: 10, rest: 100, anim: { prop: 'scaleY', types: V4 } },
  scaleZ: { ...PCT, min: 1, max: 10000, soft: [1, 400], step: 1, snap: 10, rest: 100, anim: { prop: 'scaleZ', types: V4 } },
  rotation: { unit: 'deg', soft: [-180, 180], step: 1, precision: 1, snap: 15, rest: 0, anim: { prop: 'rotation', types: V4 } },
  opacity: { ...PCT, min: 0, max: 100, soft: [0, 100], step: 1, snap: 10, rest: 100, anim: { prop: 'opacity', types: V4 } },
  volume: { ...PCT, min: 0, max: 200, soft: [0, 200], step: 1, snap: 10, rest: 100, anim: { prop: 'volume', types: ['video', 'audio'] } },
  speed: { unit: 'x', min: MIN_SPEED, max: MAX_SPEED, soft: [MIN_SPEED, MAX_SPEED], step: 0.05, precision: 2, snap: 0.25, rest: 1 },
  fade: { unit: 's', min: 0, soft: [0, 5], step: 0.1, precision: 2, snap: 0.5, rest: 0 },
  fontSize: { unit: 'px', min: 4, max: 1000, soft: [4, 300], step: 1, snap: 10, anim: { prop: 'fontSize', types: ['text'] } },

  // text style
  letterSpacing: { ...PCT, min: -50, max: 200, soft: [-20, 100], step: 1, snap: 10, rest: 0, anim: { prop: 'letterSpacing', types: ['text'] } },
  lineHeight: { ...PCT, min: 50, max: 300, soft: [50, 200], step: 1, snap: 10, rest: 125, anim: { prop: 'lineHeight', types: ['text'] } },
  textStroke: { ...PCT, min: 1, max: 50, soft: [1, 30], step: 1, snap: 5, rest: DEFAULT_STROKE, anim: { prop: 'stroke.width', types: ['text'] } },
  textStroke2: { ...PCT, min: 1, max: 50, soft: [1, 30], step: 1, snap: 5, rest: DEFAULT_STROKE2, anim: { prop: 'stroke2.width', types: ['text'] } },
  shadowOpacity: { ...PCT, min: 0, max: 100, soft: [0, 100], step: 1, snap: 10, rest: DEFAULT_SHADOW, anim: { prop: 'shadow.opacity', types: ['text'] } },
  shadowBlur: { ...PCT, min: 0, max: 100, soft: [0, 50], step: 1, snap: 5, rest: 10, anim: { prop: 'shadow.blur', types: ['text'] } },
  shadowDistance: { ...PCT, min: 0, max: 100, soft: [0, 50], step: 1, snap: 5, rest: 8, anim: { prop: 'shadow.distance', types: ['text'] } },
  shadowAngle: { unit: 'deg', min: -360, max: 360, soft: [-180, 180], step: 1, snap: 15, rest: 45, anim: { prop: 'shadow.angle', types: ['text'] } },
  extrudeDepth: { ...PCT, min: 1, max: 100, soft: [1, 60], step: 1, snap: 5, rest: DEFAULT_EXTRUDE, anim: { prop: 'extrude.depth', types: ['text'] } },
  extrudeAngle: { unit: 'deg', min: 0, max: 360, soft: [0, 360], step: 1, snap: 15, rest: 135, anim: { prop: 'extrude.angle', types: ['text'] } },
  textGradientAngle: { unit: 'deg', min: -360, max: 360, soft: [-180, 180], step: 1, snap: 15, rest: 0, anim: { prop: 'gradient.angle', types: ['text'] } },
  curve: { unit: 'deg', min: -360, max: 360, soft: [-360, 360], step: 1, snap: 15, rest: 0, anim: { prop: 'curve', types: ['text'] } },
  wrapWidth: { unit: 'px', min: 0, max: 20000, soft: [0, (c: FeelCtx) => c.W], step: 1, snap: 10, rest: 0, anim: { prop: 'wrapWidth', types: ['text'] } },
  backgroundRadius: { ...PCT, min: 0, max: 100, soft: [0, 100], step: 1, snap: 10, rest: 0, anim: { prop: 'backgroundRadius', types: ['text'] } },
  backgroundPadding: { ...PCT, min: 0, max: 200, soft: [0, 100], step: 1, snap: 10, rest: 30, anim: { prop: 'backgroundPadding', types: ['text'] } },
  counterValue: { unit: '', min: -1e9, max: 1e9, soft: null, step: 1, perPx: 1, snap: 10 },
  counterDecimals: { unit: '', min: 0, max: 4, soft: [0, 4], step: 1, snap: 1, rest: 0 },
  counterHold: { unit: 's', min: 0, max: 3600, soft: [0, 10], step: 0.1, precision: 2, snap: 1, rest: 0 },
  motionDuration: { unit: 's', min: 0.05, max: 60, soft: [0.05, 3], step: 0.1, precision: 2, snap: 0.5 },
  motionLoop: { unit: 's', min: 0.05, max: 60, soft: [0.05, 6], step: 0.1, precision: 2, snap: 0.5 },

  // shape
  shapeWidth: { unit: 'px', min: 1, max: 20000, soft: [1, (c: FeelCtx) => Math.max(c.W, c.H)], step: 1, snap: 10, anim: { prop: 'width', types: ['shape'] } },
  shapeHeight: { unit: 'px', min: 1, max: 20000, soft: [1, (c: FeelCtx) => Math.max(c.W, c.H)], step: 1, snap: 10, anim: { prop: 'height', types: ['shape'] } },
  points: { unit: '', min: 3, max: 12, soft: [3, 12], step: 1, snap: 1, anim: { prop: 'points', types: ['shape'] } },
  inner: { ...PCT, min: 10, max: 95, soft: [10, 95], step: 1, snap: 5, rest: 45, anim: { prop: 'inner', types: ['shape'] } },
  shapeGradientAngle: { unit: 'deg', min: -360, max: 360, soft: [-180, 180], step: 1, snap: 15, rest: 90, anim: { prop: 'gradientAngle', types: ['shape'] } },
  shapeStroke: { unit: 'px', min: 0.5, max: 500, soft: [0.5, 50], step: 0.5, precision: 1, snap: 5, rest: DEFAULT_SHAPE_STROKE.width, anim: { prop: 'stroke.width', types: ['shape'] } },
  drawStart: { ...PCT, min: 0, max: 100, soft: [0, 100], step: 1, snap: 10, rest: 0, anim: { prop: 'drawStart', types: ['shape'] } },
  drawEnd: { ...PCT, min: 0, max: 100, soft: [0, 100], step: 1, snap: 10, rest: 100, anim: { prop: 'drawEnd', types: ['shape'] } },

  // motion blur, transition, effects
  blurAmount: { unit: '%', min: 0, max: 200, soft: [0, 200], step: 1, snap: 10, rest: DEFAULT_MOTION_BLUR.shutter * 100 },
  blurSmoothness: { unit: '', min: 2, max: 32, soft: [2, 32], step: 1, snap: 2, rest: 8 },
  transitionDuration: { unit: 's', min: MIN_TRANSITION_DURATION, max: MAX_TRANSITION_DURATION, soft: [MIN_TRANSITION_DURATION, MAX_TRANSITION_DURATION], step: 0.1, precision: 2, snap: 0.5, rest: DEFAULT_TRANSITION_DURATION },
  effectAmount: { ...PCT, min: 0, max: 100, soft: [0, 100], step: 1, snap: 10, rest: 100, anim: { prop: 'amount', types: ['effect'] } },
  beatPulse: { unit: '%', min: 0, max: 100, soft: [0, 100], step: 1, snap: 10, rest: DEFAULT_BEAT.pulse * 100 },

  // color, look
  brightness: { unit: '', scale: 100, min: -100, max: 100, soft: [-100, 100], step: 1, snap: 10, rest: 0, anim: { prop: 'adjust.brightness', types: V4 } },
  contrast: { unit: '', scale: 100, min: -100, max: 100, soft: [-100, 100], step: 1, snap: 10, rest: 0, anim: { prop: 'adjust.contrast', types: V4 } },
  saturation: { unit: '', scale: 100, min: -100, max: 100, soft: [-100, 100], step: 1, snap: 10, rest: 0, anim: { prop: 'adjust.saturation', types: V4 } },
  warmth: { unit: '', scale: 100, min: -100, max: 100, soft: [-100, 100], step: 1, snap: 10, rest: 0, anim: { prop: 'adjust.temperature', types: V4 } },
  hue: { unit: 'deg', min: -180, max: 180, soft: [-180, 180], step: 1, snap: 15, rest: 0, anim: { prop: 'adjust.hue', types: V4 } },
  keyRange: { ...PCT, min: 0, max: 100, soft: [0, 100], step: 1, snap: 10, rest: DEFAULT_CHROMA_KEY.tolerance * 100, anim: { prop: 'chromaKey.tolerance', types: V4 } },
  keySoftness: { ...PCT, min: 0, max: 100, soft: [0, 100], step: 1, snap: 10, rest: DEFAULT_CHROMA_KEY.softness * 100, anim: { prop: 'chromaKey.softness', types: V4 } },
  keySpill: { ...PCT, min: 0, max: 100, soft: [0, 100], step: 1, snap: 10, rest: DEFAULT_CHROMA_KEY.spill * 100, anim: { prop: 'chromaKey.spill', types: V4 } },
  corners: { ...PCT, min: 0, max: 100, soft: [0, 100], step: 1, snap: 10, rest: 0, anim: { prop: 'radius', types: V4 } },
  cropLeft: { ...PCT, min: 0, max: MAX_CROP_EDGE, soft: [0, MAX_CROP_EDGE], step: 1, snap: 5, rest: 0, anim: { prop: 'crop.left', types: V4 } },
  cropTop: { ...PCT, min: 0, max: MAX_CROP_EDGE, soft: [0, MAX_CROP_EDGE], step: 1, snap: 5, rest: 0, anim: { prop: 'crop.top', types: V4 } },
  cropRight: { ...PCT, min: 0, max: MAX_CROP_EDGE, soft: [0, MAX_CROP_EDGE], step: 1, snap: 5, rest: 0, anim: { prop: 'crop.right', types: V4 } },
  cropBottom: { ...PCT, min: 0, max: MAX_CROP_EDGE, soft: [0, MAX_CROP_EDGE], step: 1, snap: 5, rest: 0, anim: { prop: 'crop.bottom', types: V4 } },

  // mask
  maskX: { ...PCT, min: -100, max: 100, soft: [-100, 100], step: 1, snap: 10, rest: 0, anim: { prop: 'mask.x', types: V4 } },
  maskY: { ...PCT, min: -100, max: 100, soft: [-100, 100], step: 1, snap: 10, rest: 0, anim: { prop: 'mask.y', types: V4 } },
  maskWidth: { ...PCT, min: 0, max: 300, soft: [0, 200], step: 1, snap: 10, rest: DEFAULT_MASK.width * 100, anim: { prop: 'mask.width', types: V4 } },
  maskHeight: { ...PCT, min: 0, max: 300, soft: [0, 200], step: 1, snap: 10, rest: DEFAULT_MASK.height * 100, anim: { prop: 'mask.height', types: V4 } },
  maskTurn: { unit: 'deg', min: -360, max: 360, soft: [-180, 180], step: 0.5, precision: 1, snap: 15, rest: 0, anim: { prop: 'mask.rotation', types: V4 } },
  maskFeather: { ...PCT, min: 0, max: 100, soft: [0, 100], step: 1, snap: 10, rest: 5, anim: { prop: 'mask.feather', types: V4 } },
  maskCorners: { ...PCT, min: 0, max: 100, soft: [0, 100], step: 1, snap: 10, rest: 0, anim: { prop: 'mask.radius', types: V4 } },

  // 3d, camera, focus
  z: { unit: 'px', soft: [(c: FeelCtx) => -0.75 * c.home, (c: FeelCtx) => 3 * c.home], step: 1, snap: 10, rest: 0, anim: { prop: 'z', types: V4 } },
  rotX: { unit: 'deg', soft: [-180, 180], step: 1, precision: 1, snap: 15, rest: 0, anim: { prop: 'rotX', types: V4 } },
  rotY: { unit: 'deg', soft: [-180, 180], step: 1, precision: 1, snap: 15, rest: 0, anim: { prop: 'rotY', types: V4 } },
  shapeDepth: { unit: 'px', min: 1, max: 10000, soft: [1, (c: FeelCtx) => c.H], step: 1, snap: 10, anim: { prop: 'shapeDepth', types: V4 } },
  lit: { ...PCT, min: 0, max: 100, soft: [0, 100], step: 1, snap: 10, rest: LIT_ON * 100, anim: { prop: 'lit', types: V4 } },
  cameraZ: { unit: 'px', soft: [(c: FeelCtx) => -c.home, (c: FeelCtx) => 2 * c.home], step: 1, snap: 10, rest: 0, anim: { prop: 'z', types: ['camera'] } },
  pan: { unit: 'deg', soft: [-180, 180], step: 1, precision: 1, snap: 15, rest: 0, anim: { prop: 'pan', types: ['camera'] } },
  roll: { unit: 'deg', soft: [-180, 180], step: 1, precision: 1, snap: 15, rest: 0, anim: { prop: 'roll', types: ['camera'] } },
  cameraTilt: { unit: 'deg', soft: [-90, 90], step: 1, precision: 1, snap: 15, rest: 0, anim: { prop: 'tilt', types: ['camera'] } },
  fov: { unit: 'deg', min: 5, max: 150, soft: [5, 150], step: 1, snap: 5, rest: DEFAULT_FOV, anim: { prop: 'fov', types: ['camera'] } },
  focusStrength: { ...PCT, min: 0, max: 100, soft: [0, 100], step: 1, snap: 10, rest: 0, anim: { prop: 'focusStrength', types: ['camera'] } },
  focusDistance: { unit: 'px', min: 1, soft: [1, (c: FeelCtx) => 6 * c.home], step: 10, precision: 0, snap: 100, rest: (c: FeelCtx) => c.home, anim: { prop: 'focusDistance', types: ['camera'] } },
  focusRange: { unit: 'px', min: 0, soft: [0, (c: FeelCtx) => 2 * c.home], step: 10, snap: 100, rest: 0 },
  wigglePerSecond: { unit: '', min: 1, max: 12, soft: [1, 12], step: 1, snap: 1, rest: 4 },

  // path, repeat, cascade, split
  pathSize: { unit: 'px', min: 0, max: 5000, soft: [0, 1000], step: 10, snap: 50, rest: DEFAULT_PATH.size },
  pathLaps: { unit: '', min: MIN_TURNS, max: MAX_TURNS, soft: [0.25, 4], step: 0.25, precision: 2, snap: 1, rest: 1 },
  repeatCount: { unit: '', min: 2, max: MAX_REPEAT, soft: [2, MAX_REPEAT], step: 1, snap: 5, rest: DEFAULT_REPEAT.count },
  repeatDx: { unit: 'px', soft: [(c: FeelCtx) => -c.W / 4, (c: FeelCtx) => c.W / 4], step: 10, snap: 50, rest: 0 },
  repeatDy: { unit: 'px', soft: [(c: FeelCtx) => -c.H / 4, (c: FeelCtx) => c.H / 4], step: 10, snap: 50, rest: 0 },
  repeatDz: { unit: 'px', soft: [(c: FeelCtx) => -c.home, (c: FeelCtx) => c.home], step: 50, snap: 100, rest: 0 },
  repeatTurn: { unit: '°', soft: [-90, 90], step: 5, snap: 15, rest: 0 },
  repeatScale: { unit: '%', min: 1, max: 1000, soft: [50, 150], origin: 100, step: 5, snap: 10, rest: 100 },
  repeatOpacity: { unit: '%', min: 0, max: 100, soft: [0, 100], step: 5, snap: 10, rest: 100 },
  repeatDelay: { unit: 's', min: 0, max: 60, soft: [0, 1], step: 0.05, precision: 2, snap: 0.25, rest: 0 },
  cascadeStep: { unit: 'fr', min: 0, max: 120, soft: [0, 30], step: 1, snap: 5, rest: 2 },
  cascadeStrength: { unit: '%', min: 0, max: 100, soft: [0, 100], step: 1, snap: 10, rest: 60 },
  cascadeLength: { unit: 's', min: 0.05, max: 10, soft: [0.05, 2], step: 0.1, precision: 2, snap: 0.5, rest: 0.5 },
  splitGap: { unit: 'px', min: 0, max: 80, soft: [0, 80], step: 1, snap: 10, rest: 0 },

  // tempo, project, fog, sky, light
  bpm: { unit: '', min: BPM_MIN, max: BPM_MAX, soft: [60, 180], step: 1, precision: 2, snap: 10 },
  beatOffset: { unit: 's', min: -86400, max: 86400, soft: [0, 0.5], step: 0.01, precision: 3, snap: 0.1, rest: 0 },
  canvasSide: { unit: 'px', min: 16, max: 8192, soft: null, step: 2, perPx: 2, snap: 20 },
  fogNear: { unit: 'px', min: 0, max: FOG_MAX - FOG_GAP, soft: [0, (c: FeelCtx) => 6 * c.home], step: 10, snap: 100, rest: (c: FeelCtx) => c.home },
  fogFar: { unit: 'px', max: FOG_MAX, soft: [0, (c: FeelCtx) => 8 * c.home], step: 10, snap: 100, rest: (c: FeelCtx) => 4 * c.home },
  fogAmount: { unit: '%', min: 0, max: 100, soft: [0, 100], step: 1, snap: 10, rest: 100 },
  skyTurn: { unit: 'deg', min: -180, max: 180, soft: [-180, 180], step: 1, precision: 1, snap: 15, rest: 0 },
  skyBrightness: { unit: '%', min: 0, max: 200, soft: [0, 200], step: 1, snap: 10, rest: 100 },
  skyBlur: { unit: '%', min: 0, max: 100, soft: [0, 100], step: 1, snap: 10, rest: 0 },
  sun: { unit: '%', min: 0, max: 100, soft: [0, 100], step: 1, snap: 10, rest: DEFAULT_SUN.sun * 100 },
  sunTurn: { unit: 'deg', min: -180, max: 180, soft: [-180, 180], step: 1, precision: 1, snap: 15, rest: DEFAULT_SUN.sunTurn },
  sunHeight: { unit: 'deg', min: 0, max: 90, soft: [0, 90], step: 1, precision: 1, snap: 15, rest: DEFAULT_SUN.sunHeight },

  // bend and pivot. center, middle and the pivots show percent but carry no scale: their sites pass shown values
  bendAngle: { unit: 'deg', min: -360, max: 360, soft: [-180, 180], step: 1, snap: 15, rest: 0, anim: { prop: 'bend.angle', types: V4 } },
  bendCenter: { unit: '%', min: -100, max: 100, soft: [-100, 100], step: 1, snap: 10, rest: 0 },
  bendMiddle: { unit: '%', min: -50, max: 50, soft: [-50, 50], step: 1, snap: 10, rest: 0 },
  pivotX: { unit: '%', min: -1000, max: 1000, soft: [-50, 50], step: 1, snap: 10, rest: 0 },
  pivotY: { unit: '%', min: -1000, max: 1000, soft: [-50, 50], step: 1, snap: 10, rest: 0 },
} as const satisfies Record<string, FeelEntry>;

export type FeelKey = keyof typeof FEEL;

const val = (n: Num, c: FeelCtx): number => (typeof n === 'function' ? n(c) : n);

export function resolveFeel(entry: FeelEntry, ctx: FeelCtx, o?: FeelOverride): Feel {
  const has = <K extends keyof FeelOverride>(k: K): boolean => !!o && k in o && o[k] !== undefined;
  const step = entry.step;
  const soft: Span | null = has('soft') ? (o!.soft ?? null) : entry.soft ? [val(entry.soft[0], ctx), val(entry.soft[1], ctx)] : null;
  const unit = entry.unit;
  return {
    scale: entry.scale ?? 1,
    unit,
    min: has('min') ? o!.min! : entry.min === undefined ? -Infinity : val(entry.min, ctx),
    max: has('max') ? o!.max! : entry.max === undefined ? Infinity : val(entry.max, ctx),
    soft,
    step,
    precision: has('precision') ? o!.precision! : (entry.precision ?? decimalsOf(step)),
    snap: entry.snap ?? (unit === 'deg' || unit === '°' ? 15 : step * 10),
    perPx: entry.perPx ?? step / JOG_PX,
    rest: has('rest') ? (o!.rest ?? null) : entry.rest === undefined ? null : val(entry.rest, ctx),
    origin: entry.origin ?? null,
  };
}

export function feelOf(key: FeelKey, ctx: FeelCtx, o?: FeelOverride): Feel {
  return resolveFeel(FEEL[key], ctx, o);
}

const effectCache = new WeakMap<EffectParam, FeelEntry>();

/** an effect param: face = hard = the def range, step = def step, rest = def default. cached per param object (WeakMap) */
export function effectFeel(param: EffectParam): FeelEntry {
  const hit = effectCache.get(param);
  if (hit) return hit;
  const unit = param.unit ?? '';
  const step = param.step;
  let snap = unit === 'deg' ? 15 : step * 10;
  const whole = Math.abs(snap / step - Math.round(snap / step)) <= 1e-6;
  if (!whole || snap > (param.max - param.min) / 2) snap = step;
  const entry: FeelEntry = {
    unit,
    min: param.min,
    max: param.max,
    soft: [param.min, param.max],
    step,
    precision: Math.min(4, decimalsOf(step)),
    snap,
    rest: param.default,
  };
  effectCache.set(param, entry);
  return entry;
}

/** an arrange slider (arrange3d.ts ARRANGE_SLIDERS / ARRANGE_EXTRA_SLIDERS): face = hard = its range, rest = ARRANGE_DEFAULTS[key] */
export function arrangeFeel(slider: { key: ArrangeKey; min: number; max: number; step: number; suffix: string }): FeelEntry {
  return {
    unit: slider.suffix,
    min: slider.min,
    max: slider.max,
    soft: [slider.min, slider.max],
    step: slider.step,
    snap: slider.suffix === 'deg' ? 15 : slider.step * 10,
    rest: ARRANGE_DEFAULTS[slider.key],
  };
}

/** the wiggle amount of "add wiggle" (keyActions.wiggleDefault gives def, stored units) */
export function wiggleFeel(def: number): FeelEntry {
  const step = def > 0 ? 10 ** Math.floor(Math.log10(def / 10)) : 1;
  return {
    unit: '',
    min: 0,
    soft: [0, 4 * def],
    step,
    precision: Math.min(4, decimalsOf(step)),
    snap: step * 10,
    rest: def,
  };
}
