/**
 * what a field of a clip may hold. the store writes most fields as they come (it trusts the ui), so a made up
 * blend mode or half a crop object would sit in the project and draw wrong or not at all. a client gets told instead.
 * a nested object may be given in part: it is laid over what the clip has (or over neutral values where there are any).
 */
import { CLIP_MOTIONS_IN, CLIP_MOTIONS_LOOP, DEFAULT_CLIP_MOTION_IN, DEFAULT_CLIP_MOTION_LOOP } from '../../engine/clipAnim';
import { DEFAULT_TEXT_ANIM_IN, DEFAULT_TEXT_ANIM_LOOP, TEXT_ANIMS_IN, TEXT_ANIMS_LOOP } from '../../engine/textAnim';
import { DEFAULT_TRANSITION_DURATION, getTransition, MAX_TRANSITION_DURATION, MIN_TRANSITION_DURATION } from '../../engine/transitions/registry';
import { BPM_MAX, BPM_MIN } from '../../lib/tempo';
import { BLEND_MODES, isVisualClip, MASK_SHAPES, MOTION_BLUR_STYLES, SHAPE_KINDS, SHAPES_3D, type Clip, type ClipType } from '../../types';
import { needProject, ToolError } from '../helpers';

/** returns the value to store. `cur` is what the clip holds there now */
type Check = (v: unknown, path: string, cur: unknown, clip: Clip) => unknown;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function kindOf(v: unknown): string {
  return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
}

export function num(min?: number, max?: number, int = false): Check {
  return (v, path) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new ToolError(`${path} must be a number, got ${kindOf(v)}`);
    if (int && !Number.isInteger(v)) throw new ToolError(`${path} must be a whole number`);
    if ((min !== undefined && v < min) || (max !== undefined && v > max)) {
      throw new ToolError(`${path} must be ${min !== undefined && max !== undefined ? `between ${min} and ${max}` : min !== undefined ? `at least ${min}` : `at most ${max}`}, got ${v}`);
    }
    return v;
  };
}

const bool: Check = (v, path) => {
  if (typeof v !== 'boolean') throw new ToolError(`${path} must be true or false, got ${kindOf(v)}`);
  return v;
};

function str(max = 20000): Check {
  return (v, path) => {
    if (typeof v !== 'string') throw new ToolError(`${path} must be a string, got ${kindOf(v)}`);
    if (v.length > max) throw new ToolError(`${path} is too long (at most ${max} characters)`);
    return v;
  };
}

const COLOR = /^(#[0-9a-f]{3}|#[0-9a-f]{4}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\([0-9.,%\s/]+\)|hsla?\([0-9.,%\sdeg/]+\))$/i;

const color: Check = (v, path) => {
  if (typeof v !== 'string' || !COLOR.test(v.trim())) throw new ToolError(`${path} must be a color like #ff8800`);
  return v.trim();
};

function oneOf(list: readonly (string | number)[]): Check {
  return (v, path) => {
    if (!list.includes(v as string | number)) throw new ToolError(`${path} must be one of: ${list.join(', ')}`);
    return v;
  };
}

function orNull(check: Check): Check {
  return (v, path, cur, clip) => (v === null ? null : check(v, path, cur, clip));
}

/**
 * an object with known fields. what is given lies over the clip's current object, that over `base`
 * (neutral values, when the thing has any). every `need` field has to be there in the end.
 */
function obj(fields: Record<string, Check>, need: readonly string[], base: Record<string, unknown> = {}): Check {
  return (v, path, cur, clip) => {
    if (!isObject(v)) throw new ToolError(`${path} must be an object (or null to take it away), got ${kindOf(v)}`);
    const had = isObject(cur) ? cur : {};
    const out: Record<string, unknown> = { ...base, ...had };
    for (const [k, value] of Object.entries(v)) {
      const check = fields[k];
      if (!check) throw new ToolError(`${path}.${k} is not a known field (known: ${Object.keys(fields).join(', ')})`);
      if (value === undefined) continue;
      out[k] = check(value, `${path}.${k}`, had[k], clip);
    }
    const missing = need.filter((k) => out[k] === undefined);
    if (missing.length > 0) throw new ToolError(`${path} also needs ${missing.join(', ')} (fields: ${Object.keys(fields).join(', ')})`);
    return out;
  };
}

/** an id out of a list of { id } */
function idOf(list: readonly { id: string }[], what: string, where: string): Check {
  return (v, path) => {
    if (typeof v !== 'string' || !list.some((x) => x.id === v)) throw new ToolError(`${path}: there is no ${what} "${String(v)}". list_options with kind ${where} lists them`);
    return v;
  };
}

/** the id of another picture clip (video, image, text, shape) */
const pictureClip: Check = (v, path, _cur, clip) => {
  if (typeof v !== 'string') throw new ToolError(`${path} must be a clip id or null`);
  if (v === clip.id) throw new ToolError(`${path} cannot be the clip itself`);
  const target = needProject().clips.find((c) => c.id === v);
  if (!target) throw new ToolError(`${path}: no clip with the id ${v}. get_project lists the clips`);
  if (!isVisualClip(target)) throw new ToolError(`${path} must be a video, image, text or shape clip, ${v} is a ${target.type} clip`);
  return v;
};

const transition: Check = orNull(
  obj(
    {
      id: (v, path) => {
        if (typeof v !== 'string' || !getTransition(v)) throw new ToolError(`${path}: there is no transition "${String(v)}". list_options with kind transitions lists them`);
        return v;
      },
      duration: num(MIN_TRANSITION_DURATION, MAX_TRANSITION_DURATION),
    },
    ['id', 'duration'],
    { duration: DEFAULT_TRANSITION_DURATION },
  ),
);

function anim(list: readonly { id: string }[], what: string, duration: number): Check {
  return orNull(obj({ id: idOf(list, what, 'motions'), duration: num(0.05, 60) }, ['id', 'duration'], { duration }));
}

const stroke = (maxWidth: number): Check => orNull(obj({ color, width: num(0, maxWidth) }, ['color', 'width']));

/** every picture clip (video, image, text, shape) */
const PICTURE: Record<string, Check> = {
  threeD: bool,
  lookAt: oneOf(['none', 'camera', 'cameraY', 'clip']),
  lookTarget: orNull(pictureClip),
  shape: oneOf(SHAPES_3D),
  shapeDepth: num(1, 10000),
  transition,
  blend: oneOf(BLEND_MODES),
  crop: orNull(obj({ left: num(0, 0.95), top: num(0, 0.95), right: num(0, 0.95), bottom: num(0, 0.95) }, ['left', 'top', 'right', 'bottom'], { left: 0, top: 0, right: 0, bottom: 0 })),
  radius: num(0, 1),
  motionIn: anim(CLIP_MOTIONS_IN, 'clip motion', DEFAULT_CLIP_MOTION_IN),
  motionOut: anim(CLIP_MOTIONS_IN, 'clip motion', DEFAULT_CLIP_MOTION_IN),
  motionLoop: anim(CLIP_MOTIONS_LOOP, 'looping clip motion', DEFAULT_CLIP_MOTION_LOOP),
  motionBlur: orNull(obj({ shutter: num(0, 2), samples: num(2, 32, true), style: oneOf(MOTION_BLUR_STYLES) }, ['shutter', 'samples'], { shutter: 0.5, samples: 8 })),
  adjust: orNull(
    obj(
      { brightness: num(-1, 1), contrast: num(-1, 1), saturation: num(-1, 1), temperature: num(-1, 1), hue: num(-180, 180) },
      ['brightness', 'contrast', 'saturation', 'temperature', 'hue'],
      { brightness: 0, contrast: 0, saturation: 0, temperature: 0, hue: 0 },
    ),
  ),
  chromaKey: orNull(obj({ color, tolerance: num(0, 1), softness: num(0, 1), spill: num(0, 1) }, ['color', 'tolerance', 'softness', 'spill'])),
  mask: orNull(
    obj(
      { shape: oneOf(MASK_SHAPES), x: num(-1, 1), y: num(-1, 1), width: num(0, 3), height: num(0, 3), rotation: num(-360, 360), feather: num(0, 1), invert: bool, radius: num(0, 1) },
      ['shape', 'x', 'y', 'width', 'height', 'rotation', 'feather', 'invert'],
      { x: 0, y: 0, width: 1, height: 1, rotation: 0, feather: 0, invert: false },
    ),
  ),
};

/** a fade cannot be longer than the clip (the store would cut it back and say nothing) */
const fade: Check = (v, path, _cur, clip) => {
  num(0)(v, path, undefined, clip);
  if ((v as number) > clip.duration + 1e-6) throw new ToolError(`${path} cannot be longer than the clip (the clip is ${Math.round(clip.duration * 1000) / 1000} s long), got ${v as number}`);
  return v;
};

const BASE: Record<string, Check> = {
  name: str(200),
  fadeIn: fade,
  fadeOut: fade,
};

const SOUND: Record<string, Check> = {
  volume: num(0, 2),
  muted: bool,
  // null takes the tempo away
  bpm: orNull(num(BPM_MIN, BPM_MAX)),
};

const TEXT: Record<string, Check> = {
  text: str(),
  fontFamily: str(200),
  fontSize: num(4, 1000),
  fontWeight: oneOf([400, 700]),
  italic: bool,
  color,
  background: orNull(color),
  align: oneOf(['left', 'center', 'right']),
  letterSpacing: num(-0.5, 2),
  lineHeight: num(0.5, 3),
  uppercase: bool,
  stroke: stroke(0.5),
  stroke2: stroke(0.5),
  shadow: orNull(obj({ color, opacity: num(0, 1), blur: num(0, 1), distance: num(0, 1), angle: num(-360, 360) }, ['color', 'opacity', 'blur', 'distance', 'angle'])),
  backgroundRadius: num(0, 1),
  backgroundPadding: num(0, 2),
  gradient: orNull(obj({ from: color, to: color, angle: num(-360, 360) }, ['from', 'to', 'angle'], { angle: 90 })),
  curve: num(-360, 360),
  wrapWidth: num(0, 20000),
  highlight: orNull(obj({ color, mode: oneOf(['word', 'fill']), background: orNull(color), offset: num(), fullDuration: num(0) }, ['color', 'mode'])),
  extrude: orNull(obj({ depth: num(0.01, 1), angle: num(0, 360), color }, ['depth', 'angle', 'color'])),
  counter: orNull(
    obj(
      {
        from: num(),
        to: num(),
        decimals: num(0, 4, true),
        separator: bool,
        ease: oneOf(['linear', 'out', 'in-out']),
        hold: num(0),
        format: oneOf(['number', 'time']),
        fixedWidth: bool,
        offset: num(),
        fullDuration: num(0),
      },
      ['from', 'to', 'decimals'],
      { decimals: 0 },
    ),
  ),
  underline: bool,
  strike: bool,
  hollow: bool,
  backgroundPerLine: bool,
  animIn: anim(TEXT_ANIMS_IN, 'text animation', DEFAULT_TEXT_ANIM_IN),
  animOut: anim(TEXT_ANIMS_IN, 'text animation', DEFAULT_TEXT_ANIM_IN),
  animLoop: anim(TEXT_ANIMS_LOOP, 'looping text animation', DEFAULT_TEXT_ANIM_LOOP),
};

const SHAPE: Record<string, Check> = {
  kind: oneOf(SHAPE_KINDS),
  width: num(1, 20000),
  height: num(1, 20000),
  color,
  color2: orNull(color),
  gradientAngle: num(-360, 360),
  gradientRadial: bool,
  filled: bool,
  stroke: stroke(500),
  points: num(3, 12, true),
  inner: num(0.1, 0.95),
  drawStart: num(0, 1),
  drawEnd: num(0, 1),
};

const EFFECT: Record<string, Check> = {
  amount: num(0, 1),
  seed: num(),
  timeOffset: num(),
  fullDuration: num(0),
  target: orNull(pictureClip),
};

const CAMERA: Record<string, Check> = {
  x: num(),
  y: num(),
  z: num(),
  pan: num(),
  tilt: num(),
  roll: num(),
  fov: num(5, 150),
  target: orNull(pictureClip),
  focusStrength: num(0, 1),
  focusDistance: num(1),
  focusRange: num(0),
  focusOnTarget: bool,
};

const BY_TYPE: Record<ClipType, Record<string, Check>> = {
  video: { ...BASE, ...PICTURE, ...SOUND },
  image: { ...BASE, ...PICTURE },
  audio: { ...BASE, ...SOUND },
  text: { ...BASE, ...PICTURE, ...TEXT },
  shape: { ...BASE, ...PICTURE, ...SHAPE },
  effect: { ...BASE, ...EFFECT },
  camera: { ...BASE, ...CAMERA },
};

/** true when this file knows what the field of that clip type may hold */
export function knowsField(type: ClipType, key: string): boolean {
  return key in BY_TYPE[type];
}

/**
 * the value to store for one field of a patch, or a ToolError that says what is wrong with it.
 * only call it for fields knowsField says yes to.
 */
export function checkField(clip: Clip, key: string, value: unknown): unknown {
  const check = BY_TYPE[clip.type][key];
  return check(value, key, (clip as unknown as Record<string, unknown>)[key], clip);
}

/** a number for a field that has no entry in the tables above (a transform field, the speed) */
export function checkNumber(v: unknown, path: string, min?: number, max?: number): number {
  return num(min, max)(v, path, undefined, undefined as unknown as Clip) as number;
}
