/**
 * text animations (types.ts TextAnim on a text clip: animIn, animOut, animLoop).
 * an animation moves / fades each letter (or word, or line, or the whole block) of a text clip.
 * the lists are what the ui offers; the motion is in the ENTER / LOOP tables below.
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

/* ---------- the motion ---------- */

/** how one letter (or the whole block) is changed. offsets are fractions of the font size, rot is radians. */
export interface GlyphState {
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  rot: number;
  alpha: number;
  /** 0..1 around the color wheel, replaces the text color */
  hue?: number;
  /** block only: where it turns / scales around, as a fraction of the box height from the center (-0.5 = top edge) */
  pivotY: number;
  /** block only: extra letter spacing as a fraction of the font size */
  spacing: number;
}

/** the untouched state. returned by identity so callers can skip work with `=== REST`. */
export const REST: GlyphState = Object.freeze({ dx: 0, dy: 0, sx: 1, sy: 1, rot: 0, alpha: 1, pivotY: 0, spacing: 0 }) as GlyphState;

type Unit = 'block' | 'char' | 'word' | 'line';

interface EnterSpec {
  unit: Unit;
  /** share of the whole duration one unit needs. 1 = everything together. 0 = one after the other, no overlap. */
  span: number;
  /** u: 0 = gone, 1 = at rest. t = clip-local seconds. write into st. */
  apply(st: GlyphState, u: number, t: number): void;
}

interface LoopSpec {
  unit: Unit;
  /** phase = radians (TAU per cycle), i = unit index, cycles = cycles since the clip started */
  apply(st: GlyphState, phase: number, i: number, cycles: number): void;
}

const easeOut = (u: number) => 1 - Math.pow(1 - u, 3);
const backOut = (u: number) => 1 + 2.70158 * Math.pow(u - 1, 3) + 1.70158 * Math.pow(u - 1, 2);
function bounceOut(u: number): number {
  const n = 7.5625;
  const d = 2.75;
  if (u < 1 / d) return n * u * u;
  if (u < 2 / d) return n * (u -= 1.5 / d) * u + 0.75;
  if (u < 2.5 / d) return n * (u -= 2.25 / d) * u + 0.9375;
  return n * (u -= 2.625 / d) * u + 0.984375;
}
const rand = (a: number, b: number) => {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const ENTER: Record<string, EnterSpec> = {
  fade: {
    unit: 'block',
    span: 1,
    apply: (st, u) => {
      st.alpha *= u;
    },
  },
  typewriter: {
    unit: 'char',
    span: 0,
    apply: (st, u) => {
      st.alpha *= u > 0 ? 1 : 0;
    },
  },
  cascade: {
    unit: 'char',
    span: 0.35,
    apply: (st, u) => {
      st.alpha *= easeOut(u);
    },
  },
  rise: {
    unit: 'char',
    span: 0.4,
    apply: (st, u) => {
      st.dy += (1 - easeOut(u)) * 0.7;
      st.alpha *= Math.min(1, u * 2);
    },
  },
  drop: {
    unit: 'char',
    span: 0.45,
    apply: (st, u) => {
      st.dy -= (1 - bounceOut(u)) * 1.4;
      st.alpha *= Math.min(1, u * 4);
    },
  },
  'slide-left': {
    unit: 'block',
    span: 1,
    apply: (st, u) => {
      st.dx += (1 - easeOut(u)) * 2.5;
      st.alpha *= easeOut(u);
    },
  },
  'slide-right': {
    unit: 'block',
    span: 1,
    apply: (st, u) => {
      st.dx -= (1 - easeOut(u)) * 2.5;
      st.alpha *= easeOut(u);
    },
  },
  pop: {
    unit: 'char',
    span: 0.4,
    apply: (st, u) => {
      const s = Math.max(0, backOut(u));
      st.sx *= s;
      st.sy *= s;
      st.alpha *= Math.min(1, u * 4);
    },
  },
  zoom: {
    unit: 'block',
    span: 1,
    apply: (st, u) => {
      const s = 0.3 + 0.7 * easeOut(u);
      st.sx *= s;
      st.sy *= s;
      st.alpha *= easeOut(u);
    },
  },
  spin: {
    unit: 'char',
    span: 0.5,
    apply: (st, u) => {
      const e = easeOut(u);
      st.rot -= (1 - e) * (Math.PI / 2);
      st.sx *= e;
      st.sy *= e;
      st.alpha *= Math.min(1, u * 3);
    },
  },
  stretch: {
    unit: 'block',
    span: 1,
    apply: (st, u) => {
      st.spacing += (1 - easeOut(u)) * 0.8;
      st.alpha *= easeOut(u);
    },
  },
  flicker: {
    unit: 'block',
    span: 1,
    apply: (st, u, t) => {
      if (u < 1) st.alpha *= rand(Math.floor(t * 24), 3) < u ? 1 : 0.08;
    },
  },
  words: {
    unit: 'word',
    span: 0.4,
    apply: (st, u) => {
      st.dy += (1 - easeOut(u)) * 0.35;
      st.alpha *= easeOut(u);
    },
  },
  lines: {
    unit: 'line',
    span: 0.5,
    apply: (st, u) => {
      st.dy += (1 - easeOut(u)) * 0.5;
      st.alpha *= easeOut(u);
    },
  },
};

const LOOP: Record<string, LoopSpec> = {
  wave: {
    unit: 'char',
    apply: (st, ph, i) => {
      st.dy += Math.sin(ph - i * 0.6) * 0.12;
    },
  },
  wobble: {
    unit: 'char',
    apply: (st, ph, i) => {
      st.rot += Math.sin(ph - i * 0.7) * 0.14;
    },
  },
  pulse: {
    unit: 'block',
    apply: (st, ph) => {
      const s = 1 + 0.06 * Math.sin(ph);
      st.sx *= s;
      st.sy *= s;
    },
  },
  bounce: {
    unit: 'char',
    apply: (st, ph, i) => {
      st.dy -= Math.abs(Math.sin(ph * 0.5 - i * 0.3)) * 0.3;
    },
  },
  shake: {
    unit: 'char',
    apply: (st, _ph, i, cycles) => {
      const step = Math.floor(cycles * 14);
      st.dx += (rand(i, step) - 0.5) * 0.08;
      st.dy += (rand(i + 31, step) - 0.5) * 0.08;
    },
  },
  float: {
    unit: 'block',
    apply: (st, ph) => {
      st.dy += Math.sin(ph) * 0.12;
      st.rot += Math.sin(ph * 0.5 + 1) * 0.03;
    },
  },
  pendulum: {
    unit: 'block',
    apply: (st, ph) => {
      st.rot += Math.sin(ph) * 0.1;
      st.pivotY = -0.5;
    },
  },
  jelly: {
    unit: 'char',
    apply: (st, ph, i) => {
      const k = Math.sin(ph - i * 0.5) * 0.14;
      st.sx *= 1 + k;
      st.sy *= 1 - k;
    },
  },
  blink: {
    unit: 'block',
    apply: (st, ph) => {
      st.alpha *= 0.2 + 0.8 * (0.5 + 0.5 * Math.cos(ph));
    },
  },
  rainbow: {
    unit: 'char',
    apply: (st, _ph, i, cycles) => {
      st.hue = cycles + i * 0.04;
    },
  },
};

/** the animations of a clip looked up once per frame */
export interface TextAnimUnits {
  enter: EnterSpec | null;
  exit: EnterSpec | null;
  loop: LoopSpec | null;
}

export function textAnimUnits(clip: TextClip): TextAnimUnits {
  return {
    enter: clip.animIn ? (ENTER[clip.animIn.id] ?? null) : null,
    exit: clip.animOut ? (ENTER[clip.animOut.id] ?? null) : null,
    loop: clip.animLoop ? (LOOP[clip.animLoop.id] ?? null) : null,
  };
}

/** progress of unit i of n when the whole thing is at p (0..1), units starting one after the other */
export function stagger(p: number, i: number, n: number, span: number): number {
  if (n <= 1) return p;
  const s = Math.max(span, 1 / n);
  const start = ((1 - s) * i) / (n - 1);
  return Math.min(1, Math.max(0, (p - start) / s));
}

function fresh(): GlyphState {
  return { dx: 0, dy: 0, sx: 1, sy: 1, rot: 0, alpha: 1, pivotY: 0, spacing: 0 };
}

const inProgress = (clip: TextClip, local: number): number =>
  clip.animIn && clip.animIn.duration > 0 ? Math.min(1, Math.max(0, local / clip.animIn.duration)) : 1;
const outProgress = (clip: TextClip, local: number): number =>
  clip.animOut && clip.animOut.duration > 0 ? Math.min(1, Math.max(0, (clip.duration - local) / clip.animOut.duration)) : 1;

/** what the animations do to the whole text block at a clip-local time */
export function blockState(clip: TextClip, local: number): GlyphState {
  const { enter, exit, loop } = textAnimUnits(clip);
  let st: GlyphState | null = null;
  if (enter && enter.unit === 'block') {
    const p = inProgress(clip, local);
    if (p < 1) enter.apply((st ??= fresh()), p, local);
  }
  if (exit && exit.unit === 'block') {
    const p = outProgress(clip, local);
    if (p < 1) exit.apply((st ??= fresh()), p, local);
  }
  if (loop && loop.unit === 'block' && clip.animLoop) {
    const cycles = local / Math.max(0.05, clip.animLoop.duration);
    loop.apply((st ??= fresh()), cycles * Math.PI * 2, 0, cycles);
  }
  return st ?? REST;
}

/** what the animations do to one letter. returns REST (by identity) when it is untouched. */
export function glyphState(
  clip: TextClip,
  local: number,
  index: number,
  count: number,
  word: number,
  words: number,
  line: number,
  lines: number,
  units: TextAnimUnits,
): GlyphState {
  let st: GlyphState | null = null;
  const pick = (unit: Unit): [number, number] => (unit === 'word' ? [word, words] : unit === 'line' ? [line, lines] : [index, count]);
  const { enter, exit, loop } = units;
  if (enter && enter.unit !== 'block') {
    const p = inProgress(clip, local);
    if (p < 1) {
      const [i, n] = pick(enter.unit);
      const u = stagger(p, i, n, enter.span);
      if (u < 1) enter.apply((st ??= fresh()), u, local);
    }
  }
  if (exit && exit.unit !== 'block') {
    const p = outProgress(clip, local);
    if (p < 1) {
      const [i, n] = pick(exit.unit);
      const u = stagger(p, i, n, exit.span);
      if (u < 1) exit.apply((st ??= fresh()), u, local);
    }
  }
  if (loop && loop.unit !== 'block' && clip.animLoop) {
    const cycles = local / Math.max(0.05, clip.animLoop.duration);
    const [i] = pick(loop.unit);
    loop.apply((st ??= fresh()), cycles * Math.PI * 2, i, cycles);
  }
  return st ?? REST;
}
