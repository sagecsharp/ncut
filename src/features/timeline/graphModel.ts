import { animProps, evalKeys, keyRange } from '../../lib/anim';
import { INFLUENCE_MIN, SPAN_EPS, SPEED_MAX, partHandles, partSpeed, speedAt } from '../../lib/keyBezier';
import type { HandleSide, ValueRange } from '../../lib/keyBezier';
import { feelForProp } from '../properties/feelForProp';
import type { Feel } from '../properties/fieldFeel';
import { propLimits } from '../../store/editorStore';
import type { KeyRef } from '../../store/ui';
import type { Clip, KeyHandle, Keyframe, Project } from '../../types';
import { clipDisplayName } from './effectTarget';
import type { GraphKind, Win } from './graphState';
import { keyedValues } from './keyLanesModel';
import { KEY_REF_EPS, laneId } from './keySelection';

/** one line of the graph: one animated value of one clip */
export interface GraphLine {
  id: string;
  clip: Clip;
  clipId: string;
  prop: string;
  label: string;
  clipName: string;
  color: string;
  dash: readonly number[];
  group: string;
  feel: Feel;
  int: boolean;
  range: ValueRange | undefined;
  limits: { min: number; max: number };
  keys: readonly Keyframe[];
  start: number;
  duration: number;
}

export interface GraphViewport { zoom: number; scrollLeft: number; width: number; height: number }

/** the points of the last draw, for hit testing */
export interface GraphHitIndex {
  kx: Float32Array;
  ky: Float32Array;
  kref: KeyRef[];
  kn: number;
  hx: Float32Array;
  hy: Float32Array;
  href: { ref: KeyRef; side: HandleSide }[];
  hn: number;
}

export type GraphHit =
  | { kind: 'handle'; ref: KeyRef; side: HandleSide }
  | { kind: 'key'; ref: KeyRef }
  | { kind: 'line'; line: string; t: number }
  | { kind: 'empty' };

const DASHES: readonly (readonly number[])[] = [[], [6, 3], [2, 3], [8, 3, 2, 3]];
const SPARE_COLORS = ['--graph-orange', '--graph-pink', '--graph-teal', '--graph-lime'];
/** samples over a part whose extremes have no closed form */
const SAMPLES = 32;
/** a pointer this close (css px) grabs a handle or a key */
const GRAB_PX = 6;
/** a pointer this close (css px, vertically) is on a line */
const LINE_PX = 5;
/** a key within this many px of a snap value jumps to it */
const SNAP_PX = 6;

export function buildGraphLines(p: Project, shown: readonly Clip[], hidden: ReadonlySet<string>): GraphLine[] {
  const tracks = new Map(p.tracks.map((t) => [t.id, t]));
  const out: GraphLine[] = [];
  shown.forEach((clip, ci) => {
    const track = tracks.get(clip.trackId);
    if (!track || track.locked) return;
    const infos = animProps(clip);
    const dash = DASHES[ci % DASHES.length]!;
    keyedValues(clip).forEach((d, index) => {
      const id = laneId(clip.id, d.prop);
      if (hidden.has(id)) return;
      const feel = feelForProp(d.prop, clip);
      out.push({
        id,
        clip,
        clipId: clip.id,
        prop: d.prop,
        label: d.label,
        clipName: clipDisplayName(clip),
        color: lineColor(clip, d.prop, index),
        dash,
        group: `${feel.unit}|${feel.scale}`,
        feel,
        int: infos.find((a) => a.prop === d.prop)?.int === true,
        range: keyRange(clip, d.prop),
        limits: propLimits(clip, d.prop) ?? { min: -Infinity, max: Infinity },
        keys: clip.keyframes![d.prop]!,
        start: clip.start,
        duration: clip.duration,
      });
    });
  });
  return out;
}

/** a css custom property name of the graph colors ('--graph-red' to '--graph-lime'). drawGraph reads it through css(token) */
export function lineColor(clip: Clip, prop: string, index: number): string {
  switch (prop) {
    case 'x':
    case 'scaleX':
    case 'rotX':
    case 'tilt':
      return '--graph-red';
    case 'y':
    case 'scaleY':
    case 'rotY':
      return '--graph-green';
    case 'pan':
      return clip.type === 'camera' ? '--graph-green' : '--graph-violet';
    case 'z':
    case 'scaleZ':
    case 'rotation':
    case 'roll':
      return '--graph-blue';
    case 'scale':
      return '--graph-amber';
    case 'opacity':
      return '--graph-gray';
    case 'volume':
      return '--graph-cyan';
    default:
      return SPARE_COLORS[index % SPARE_COLORS.length]!;
  }
}

/** a stored value of a line at a clip-local time: the value (whole numbers rounded like valueAt) or its speed per second */
export function lineValue(line: GraphLine, kind: GraphKind, t: number): number {
  if (kind === 'speed') return speedAt(line.keys, t, line.range);
  const v = evalKeys(line.keys, t, line.clip, line.prop);
  return line.int ? Math.round(v) : v;
}

/** where a key sits on its line, stored units: the key value (rounded when whole numbers), in the speed graph the speed there */
export function keyValueOf(line: GraphLine, kind: GraphKind, k: Keyframe): number {
  if (kind === 'speed') return lineValue(line, 'speed', k.t);
  return line.int ? Math.round(k.v) : k.v;
}

/** the clip-local span of a line that lies in [from, to] timeline seconds. null when it does not */
function spanOf(line: GraphLine, from?: number, to?: number): [number, number] | null {
  const a = from === undefined ? 0 : Math.max(0, from - line.start);
  const b = to === undefined ? line.duration : Math.min(line.duration, to - line.start);
  return a <= b ? [a, b] : null;
}

const SAMPLED: ReadonlySet<string> = new Set(['bezier', 'back', 'bounce', 'elastic']);

/** the shown values the line takes between clip-local times a and b, handed to add (stored times, shown by the caller) */
function extremes(line: GraphLine, kind: GraphKind, a: number, b: number, add: (v: number) => void): void {
  add(lineValue(line, kind, a));
  add(lineValue(line, kind, b));
  if (kind === 'speed') add(0);
  const keys = line.keys;
  if (kind === 'value') for (const k of keys) if (k.t >= a && k.t <= b) add(keyValueOf(line, kind, k));
  for (let i = 0; i < keys.length - 1; i++) {
    const p = keys[i]!, q = keys[i + 1]!;
    if (q.t - p.t <= SPAN_EPS || q.t <= a || p.t >= b) continue;
    const t0 = Math.max(p.t, a), t1 = Math.min(q.t, b);
    const whole = p.t >= a && q.t <= b;
    if (kind === 'speed') {
      for (let j = 0; j <= SAMPLES; j++) add(partSpeed(p, q, t0 + ((t1 - t0) * j) / SAMPLES));
    } else if (p.ease === 'bezier' && whole) {
      for (const v of bezierRoots(line, p, q)) add(v);
    } else if (SAMPLED.has(p.ease)) {
      for (let j = 0; j <= SAMPLES; j++) add(lineValue(line, kind, t0 + ((t1 - t0) * j) / SAMPLES));
    }
  }
}

/** the values of a custom part where its value stops rising or falling (V'(s) = 0 inside), clamped like bezierValue */
function bezierRoots(line: GraphLine, a: Keyframe, b: Keyframe): number[] {
  const h = partHandles(a, b);
  if (!h) return [];
  const span = b.t - a.t;
  const y1 = a.v + h.out.speed * h.out.influence * span;
  const y2 = b.v - h.in.speed * h.in.influence * span;
  const d0 = y1 - a.v, d1 = y2 - y1, d2 = b.v - y2;
  const size = Math.abs(d0) + Math.abs(d1) + Math.abs(d2);
  if (size === 0) return [];
  const qa = d0 - 2 * d1 + d2, qb = 2 * (d1 - d0), qc = d0;
  const roots: number[] = [];
  if (Math.abs(qa) <= 1e-12 * size) {
    if (qb !== 0) roots.push(-qc / qb);
  } else {
    const disc = qb * qb - 4 * qa * qc;
    if (disc >= 0) {
      const r = Math.sqrt(disc);
      roots.push((-qb - r) / (2 * qa), (-qb + r) / (2 * qa));
    }
  }
  const lo = Math.min(line.range?.lo ?? -Infinity, a.v, b.v);
  const hi = Math.max(line.range?.hi ?? Infinity, a.v, b.v);
  const out: number[] = [];
  for (const s of roots) {
    if (!(s > 0 && s < 1)) continue;
    const k = 1 - s;
    let v = k * k * k * a.v + 3 * k * k * s * y1 + 3 * k * s * s * y2 + s * s * s * b.v;
    v = v < lo ? lo : v > hi ? hi : v;
    out.push(line.int ? Math.round(v) : v);
  }
  return out;
}

/**
 * one window per unit group (shown units, per second in the speed graph) over the lines between two timeline seconds (default: the
 * whole clips). holds the values at both ends, the keys, the extremes of custom parts, padded 8 %. a flat group gets five steps a side
 */
export function fitWindows(lines: readonly GraphLine[], kind: GraphKind, from?: number, to?: number): Record<string, Win> {
  const groups = new Map<string, { lo: number; hi: number; step: number }>();
  for (const line of lines) {
    const span = spanOf(line, from, to);
    if (!span) continue;
    let g = groups.get(line.group);
    if (!g) groups.set(line.group, (g = { lo: Infinity, hi: -Infinity, step: 0 }));
    g.step = Math.max(g.step, line.feel.step);
    const scale = line.feel.scale;
    extremes(line, kind, span[0], span[1], (v) => {
      const s = v * scale;
      if (!Number.isFinite(s)) return;
      if (s < g!.lo) g!.lo = s;
      if (s > g!.hi) g!.hi = s;
    });
  }
  const out: Record<string, Win> = {};
  for (const [id, g] of groups) {
    if (!(g.lo <= g.hi)) continue;
    if (g.hi - g.lo <= 1e-9 * Math.max(1, Math.abs(g.hi))) out[id] = { lo: g.lo - 5 * g.step, hi: g.hi + 5 * g.step };
    else {
      const pad = (g.hi - g.lo) * 0.08;
      out[id] = { lo: g.lo - pad, hi: g.hi + pad };
    }
  }
  return out;
}

/** the y (px from the top) of a shown value in a window. a window with no height puts everything in the middle */
export function yOf(v: number, w: Win, h: number): number {
  if (w.hi === w.lo) return h / 2;
  return ((w.hi - v) / (w.hi - w.lo)) * h;
}

/** the shown value at a y. the inverse of yOf */
export function vOf(y: number, w: Win, h: number): number {
  if (w.hi === w.lo || !(h > 0)) return w.lo;
  return w.hi - (y / h) * (w.hi - w.lo);
}

/** grid values of a window: 1, 2 or 5 times a power of ten, at least minGapPx apart */
export function niceTicks(w: Win, h: number, minGapPx = 28): number[] {
  const range = w.hi - w.lo;
  if (!(range > 0) || !(h > 0)) return [];
  const minStep = (minGapPx * range) / h;
  if (!(minStep > 0) || !Number.isFinite(minStep)) return [];
  const pow = Math.pow(10, Math.floor(Math.log10(minStep)));
  let step = pow * 10;
  for (const m of [1, 2, 5, 10]) {
    if (m * pow >= minStep * (1 - 1e-12)) {
      step = m * pow;
      break;
    }
  }
  const out: number[] = [];
  const first = Math.ceil(w.lo / step - 1e-9);
  const last = Math.floor(w.hi / step + 1e-9);
  for (let i = first; i <= last; i++) out.push(Number((i * step).toPrecision(12)));
  return out;
}

/** a dragged value snaps to the other keys of its line, 0 and the rest value when one is within 6 px. stored units, upp = stored units per px */
export function valueSnap(v: number, line: GraphLine, skip: number, upp: number, snapping: boolean): { v: number; hit: number | null } {
  if (!snapping || !(upp > 0) || !Number.isFinite(v)) return { v, hit: null };
  let best: number | null = null;
  let bestD = Infinity;
  const take = (c: number): void => {
    const d = Math.abs(c - v) / upp;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  };
  line.keys.forEach((k, i) => {
    if (i !== skip && k.t >= -KEY_REF_EPS && k.t <= line.duration + KEY_REF_EPS) take(k.v);
  });
  take(0);
  if (line.feel.rest !== null) take(line.feel.rest / line.feel.scale);
  if (best !== null && bestD <= SNAP_PX) return { v: best, hit: best };
  return { v, hit: null };
}

const inf = (x: number): number => (x < INFLUENCE_MIN ? INFLUENCE_MIN : x > 1 ? 1 : x);
const spd = (x: number): number => (x < -SPEED_MAX ? -SPEED_MAX : x > SPEED_MAX ? SPEED_MAX : x);

/**
 * the handle a pointer at clip-local time t and stored value v (speed graph: stored speed) makes for one side of key i.
 * no neighbour on that side, or a pointer that is not finite: last
 */
export function handleFromPointer(keys: readonly Keyframe[], i: number, side: HandleSide, t: number, v: number, kind: GraphKind, last: KeyHandle): KeyHandle {
  const key = keys[i];
  const near = side === 'out' ? keys[i + 1] : keys[i - 1];
  if (!key || !near || !Number.isFinite(t) || !Number.isFinite(v)) return last;
  const span = Math.abs(near.t - key.t);
  if (!(span > 0)) return last;
  if (kind === 'speed') return { speed: spd(v), influence: inf(Math.abs(t - key.t) / span) };
  const dt = side === 'out' ? t - key.t : key.t - t;
  if (dt < INFLUENCE_MIN * span) return { speed: last.speed, influence: INFLUENCE_MIN };
  return { speed: spd((v - key.v) / (t - key.t)), influence: inf(dt / span) };
}

/** what a pointer at (x, y) css px of the plot touches: a handle, else a key (6 px, nearest), else a line (5 px vertically, inside its span) */
export function hitGraph(index: GraphHitIndex, lines: readonly GraphLine[], windows: Record<string, Win>, kind: GraphKind, vp: GraphViewport, x: number, y: number): GraphHit {
  const reach = GRAB_PX * GRAB_PX;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < index.hn; i++) {
    const dx = index.hx[i]! - x, dy = index.hy[i]! - y;
    const d = dx * dx + dy * dy;
    if (d <= reach && d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best >= 0) {
    const h = index.href[best]!;
    return { kind: 'handle', ref: h.ref, side: h.side };
  }
  bestD = Infinity;
  for (let i = 0; i < index.kn; i++) {
    const dx = index.kx[i]! - x, dy = index.ky[i]! - y;
    const d = dx * dx + dy * dy;
    if (d <= reach && d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best >= 0) return { kind: 'key', ref: index.kref[best]! };
  let hit: GraphHit = { kind: 'empty' };
  bestD = Infinity;
  const time = (x + vp.scrollLeft) / vp.zoom;
  for (const line of lines) {
    const w = windows[line.group];
    if (!w) continue;
    const t = time - line.start;
    if (t < 0 || t > line.duration) continue;
    const d = Math.abs(yOf(lineValue(line, kind, t) * line.feel.scale, w, vp.height) - y);
    if (d <= LINE_PX && d < bestD) {
      bestD = d;
      hit = { kind: 'line', line: line.id, t };
    }
  }
  return hit;
}

/** the inside keys whose spot on the plot lies in the box (corners in any order) */
export function keysInGraphBox(lines: readonly GraphLine[], windows: Record<string, Win>, kind: GraphKind, vp: GraphViewport, box: { x0: number; x1: number; y0: number; y1: number }): KeyRef[] {
  const x0 = Math.min(box.x0, box.x1), x1 = Math.max(box.x0, box.x1);
  const y0 = Math.min(box.y0, box.y1), y1 = Math.max(box.y0, box.y1);
  const out: KeyRef[] = [];
  for (const line of lines) {
    const w = windows[line.group];
    if (!w) continue;
    for (const k of line.keys) {
      if (k.t < -KEY_REF_EPS || k.t > line.duration + KEY_REF_EPS) continue;
      const x = (line.start + k.t) * vp.zoom - vp.scrollLeft;
      if (x < x0 || x > x1) continue;
      const y = yOf(keyValueOf(line, kind, k) * line.feel.scale, w, vp.height);
      if (y >= y0 && y <= y1) out.push({ clipId: line.clipId, prop: line.prop, t: k.t });
    }
  }
  return out;
}
