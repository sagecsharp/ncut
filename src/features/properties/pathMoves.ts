/**
 * ready-made motion paths for a clip, written as ordinary keyframes on its position (pure, no store).
 * the path is laid so its first point is the clip's pose at local 0; closed paths (whole laps) end
 * there too. curves are sampled as linear keys. key times are CLIP LOCAL seconds.
 *
 * y grows downwards, z grows away from the viewer. a flat clip moves in the picture plane (x / y), a
 * 3d clip (threeD) moves in the ground plane (x / z) like an orbit.
 */
import { valueAt } from '../../lib/anim';
import type { Clip, Keyframe, Keyframes } from '../../types';
import { MAX_KEYS_PER_PROP, MIN_GAP, hash01 } from './keyTools';

export type PathKind = 'circle' | 'eight' | 'spiral' | 'swing' | 'hop' | 'zigzag' | 'drift';

export interface PathOptions {
  kind: PathKind;
  /** radius / reach in project pixels */
  size: number;
  /** laps / swings / hops over the clip, 0.25..10 */
  turns: number;
  /** the other direction */
  reverse: boolean;
  /** turn to look along the path */
  face: boolean;
  /** drift only: same seed = same path (default: made from the clip id) */
  seed?: number;
}

export const DEFAULT_PATH: PathOptions = { kind: 'circle', size: 200, turns: 1, reverse: false, face: false };
export const MIN_TURNS = 0.25;
export const MAX_TURNS = 10;

export const PATH_KINDS: { id: PathKind; label: string; hint: string }[] = [
  { id: 'circle', label: 'circle', hint: 'goes around in a circle and comes back to where it started' },
  { id: 'eight', label: 'figure eight', hint: 'draws an eight and comes back to where it started' },
  { id: 'spiral', label: 'spiral', hint: 'circles outward from where it is (a 3d clip also rises)' },
  { id: 'swing', label: 'swing', hint: 'swings left and right like a pendulum' },
  { id: 'hop', label: 'hop', hint: 'bounces up and down in place' },
  { id: 'zigzag', label: 'zigzag', hint: 'sweeps left and right while moving down (a 3d clip moves away)' },
  { id: 'drift', label: 'drift', hint: 'wanders slowly around and comes back to where it started' },
];

const SAMPLES_PER_LAP = 24;
const SWING_ANGLE = (40 * Math.PI) / 180;
const DEG = 180 / Math.PI;
const TAU = Math.PI * 2;

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const cl = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** the properties a path writes for this clip (the action clears exactly those) */
export function pathProps(clip: Clip, opts: Pick<PathOptions, 'kind' | 'face'>): string[] {
  const d3 = !!(clip as { threeD?: boolean }).threeD;
  if (opts.kind === 'hop') return ['y'];
  let props: string[];
  if (opts.kind === 'spiral') props = d3 ? ['x', 'y', 'z'] : ['x', 'y'];
  else if (opts.kind === 'swing') props = ['x', 'y'];
  else props = d3 ? ['x', 'z'] : ['x', 'y'];
  // a swing tilts in roll on both kinds of clip, the others turn along the path
  if (opts.face) props.push(opts.kind === 'swing' || !d3 ? 'rotation' : 'rotY');
  return props;
}

/** a number from a string (for the drift seed) */
export function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** n + 1 times: n equal segments over the clip, the last exactly at the duration */
function times(n: number, duration: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((duration * i) / n);
  out.push(duration);
  return out;
}

/** segments for a sampled curve: about `spl` a lap, never past the key cap, never keys closer than MIN_GAP */
function segments(laps: number, spl: number, duration: number): number {
  const perLap = Math.max(1, Math.min(spl, Math.floor((MAX_KEYS_PER_PROP - 1) / laps)));
  const n = Math.min(Math.ceil(laps * perLap), MAX_KEYS_PER_PROP - 1, Math.floor(duration / (MIN_GAP * 1.01)));
  return Math.max(1, n);
}

/**
 * heading (radians) of the travel at every sample: the headings of the straight segments, unwrapped so they never
 * jump by 360, averaged at the samples between two segments and extended at the two ends (so a full circle
 * sweeps exactly 360)
 */
function headings(a: number[], b: number[]): number[] {
  const segs: number[] = [];
  let prev = 0;
  let have = false;
  for (let i = 1; i < a.length; i++) {
    const da = a[i]! - a[i - 1]!;
    const db = b[i]! - b[i - 1]!;
    let h = prev;
    if (Math.hypot(da, db) >= 1e-9) {
      h = Math.atan2(da, -db);
      if (have) {
        while (h - prev > Math.PI) h -= TAU;
        while (h - prev < -Math.PI) h += TAU;
      } else {
        // segments before the first move take its heading
        for (let j = 0; j < segs.length; j++) segs[j] = h;
        have = true;
      }
    }
    segs.push(h);
    prev = h;
  }
  const n = segs.length;
  if (n === 0) return [0];
  const out: number[] = [segs[0]! - ((n > 1 ? segs[1]! - segs[0]! : 0) / 2)];
  for (let i = 1; i < n; i++) out.push((segs[i - 1]! + segs[i]!) / 2);
  out.push(segs[n - 1]! + (n > 1 ? segs[n - 1]! - segs[n - 2]! : 0) / 2);
  return out;
}

/**
 * the keyframes for a path over the clip. returns {} for a clip that is not visual or has no length.
 * `project` only keeps the size in a sane range.
 */
export function pathKeys(clip: Clip, opts: PathOptions, project: { width: number; height: number }): Keyframes {
  if (!(clip.duration > MIN_GAP * 2)) return {};
  if (clip.type !== 'video' && clip.type !== 'image' && clip.type !== 'text' && clip.type !== 'shape') return {};
  const d3 = !!clip.threeD;
  const dur = clip.duration;
  const reach = Math.max(project.width, project.height, 1) * 4;
  const size = cl(Number.isFinite(opts.size) ? opts.size : 0, 0, reach);
  const turns = cl(Number.isFinite(opts.turns) ? opts.turns : 1, MIN_TURNS, MAX_TURNS);
  const dir = opts.reverse ? -1 : 1;
  const at = (prop: string) => valueAt(clip, prop, clip.start) ?? 0;
  const base: Record<string, number> = { x: at('x'), y: at('y'), z: at('z'), rotation: at('rotation'), rotY: at('rotY') };

  let t: number[];
  /** offsets from the start pose: a = x, b = y (flat) or z (3d), c = y rise of a 3d spiral */
  let a: number[] = [];
  let b: number[] = [];
  let c: number[] | null = null;
  /** the swing tilts with the arc instead of looking along it */
  let tilt: number[] | null = null;

  if (opts.kind === 'circle' || opts.kind === 'eight' || opts.kind === 'spiral' || opts.kind === 'drift') {
    const spl = opts.kind === 'eight' ? SAMPLES_PER_LAP * 2 : opts.kind === 'drift' ? SAMPLES_PER_LAP * 3 : SAMPLES_PER_LAP;
    const laps = opts.kind === 'drift' ? Math.max(1, Math.round(turns)) : turns;
    const n = segments(laps, spl, dur);
    t = times(n, dur);
    // drift: three whole-number harmonics, so it is smooth and closed
    const seed = opts.seed ?? seedOf(clip.id);
    const harm = [1, 2, 3].map((k) => ({ k, amp: size / (k * 1.5), pa: hash01(seed, k) * TAU, pb: hash01(seed, k + 10) * TAU }));
    const wave = (u: number, second: boolean) => harm.reduce((s, h) => s + h.amp * Math.sin(TAU * h.k * laps * u + (second ? h.pb : h.pa)), 0);
    const w0a = wave(0, false);
    const w0b = wave(0, true);
    if (opts.kind === 'spiral' && d3) c = [];
    for (let i = 0; i <= n; i++) {
      const u = i === n ? 1 : i / n;
      const th = TAU * turns * u * dir;
      if (opts.kind === 'circle') {
        a.push(size * Math.sin(th));
        b.push(size * (1 - Math.cos(th)));
      } else if (opts.kind === 'eight') {
        a.push(size * Math.sin(th));
        b.push((size / 2) * Math.sin(2 * th));
      } else if (opts.kind === 'spiral') {
        const r = size * u;
        a.push(r * Math.sin(th));
        b.push(-r * Math.cos(th));
        c?.push(-size * u);
      } else {
        const uu = dir === 1 ? u : 1 - u;
        a.push(wave(uu, false) - w0a);
        b.push(wave(uu, true) - w0b);
      }
    }
  } else if (opts.kind === 'swing') {
    const n = segments(turns, SAMPLES_PER_LAP, dur);
    t = times(n, dur);
    // size is the sideways reach, so the pendulum is that much longer than it
    const len = size / Math.sin(SWING_ANGLE);
    tilt = [];
    for (let i = 0; i <= n; i++) {
      const p = SWING_ANGLE * Math.sin(TAU * turns * (i === n ? 1 : i / n)) * dir;
      a.push(len * Math.sin(p));
      b.push(-len * (1 - Math.cos(p)));
      tilt.push(p * DEG);
    }
  } else if (opts.kind === 'hop') {
    const hops = Math.max(1, Math.round(turns));
    const per = Math.max(1, Math.min(SAMPLES_PER_LAP, Math.floor((MAX_KEYS_PER_PROP - 1) / hops)));
    const n = Math.max(1, Math.min(hops * per, Math.floor(dur / (MIN_GAP * 1.01))));
    t = times(n, dur);
    for (let i = 0; i <= n; i++) b.push(-size * Math.abs(Math.sin(Math.PI * hops * (i === n ? 1 : i / n))));
    a = b.map(() => 0);
  } else {
    // zigzag: a vertex every quarter of a period, straight legs between them
    const q = Math.max(1, Math.min(Math.round(turns * 4), MAX_KEYS_PER_PROP - 1, Math.floor(dur / (MIN_GAP * 1.01))));
    t = times(q, dur);
    const wave = [0, 1, 0, -1];
    for (let i = 0; i <= q; i++) {
      a.push(size * wave[i % 4]! * dir);
      b.push(size * (i / q));
    }
  }

  const out: Keyframes = {};
  const put = (prop: string, offsets: number[]) => {
    const from = base[prop]!;
    const keys: Keyframe[] = offsets.map((d, i) => ({ t: t[i]!, v: from + round3(d), ease: 'linear' }));
    out[prop] = keys;
  };
  if (opts.kind === 'hop') {
    put('y', b);
  } else {
    put('x', a);
    if (d3 && opts.kind !== 'swing') {
      put('z', b);
      if (c) put('y', c);
    } else put('y', b);
  }

  if (opts.face && opts.kind !== 'hop') {
    const deg = tilt ?? headings(a, b).map((h, _i, all) => (h - all[0]!) * DEG);
    put(tilt || !d3 ? 'rotation' : 'rotY', deg);
  }
  return out;
}
