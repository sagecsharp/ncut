/**
 * arrange in 3d: pure layout math. every layout returns one pose per clip, in the order the clips are given
 * (the first clip is the front / first one). units are canvas pixels and degrees, x right, y down, +z away
 * from the viewer, z 0 = the canvas plane. rotY + turns the plane to the right (see types.ts).
 * a single clip always lands centered and flat.
 */
import type { Clip, Project, VisualClip } from '../../types';
import { isVisualClip } from '../../types';

export type ArrangeKind = 'ring' | 'row' | 'stack' | 'fan' | 'grid' | 'spiral';

export interface ArrangePose {
  x: number;
  y: number;
  z: number;
  rotY: number;
  rotation: number;
}

export interface ArrangeOpts {
  /** ring / spiral: distance of the clips from the vertical axis (px) */
  radius?: number;
  /** row / grid: empty space between neighbours (px) */
  gap?: number;
  /** stack: distance between two cards in z (px) */
  depthGap?: number;
  /** fan: angle from the first to the last card (degrees) */
  spread?: number;
  /** ring / spiral: clips face away from the middle (true, default) or toward it */
  outward?: boolean;
  /** row / grid: size of one clip (px), the pitch is size + gap. missing = 0 */
  itemW?: number;
  itemH?: number;
}

export type ArrangeKey = 'radius' | 'gap' | 'depthGap' | 'spread';

export const ARRANGE_DEFAULTS: Record<ArrangeKey, number> = { radius: 600, gap: 40, depthGap: 60, spread: 70 };

/** the slider that belongs to each layout */
export const ARRANGE_SLIDERS: Record<ArrangeKind, { key: ArrangeKey; label: string; min: number; max: number; step: number; suffix: string }> = {
  ring: { key: 'radius', label: 'radius', min: 50, max: 2000, step: 10, suffix: 'px' },
  row: { key: 'gap', label: 'gap', min: 0, max: 600, step: 5, suffix: 'px' },
  stack: { key: 'depthGap', label: 'depth gap', min: 0, max: 600, step: 5, suffix: 'px' },
  fan: { key: 'spread', label: 'spread', min: 0, max: 180, step: 1, suffix: 'deg' },
  grid: { key: 'gap', label: 'gap', min: 0, max: 600, step: 5, suffix: 'px' },
  spiral: { key: 'radius', label: 'radius', min: 50, max: 2000, step: 10, suffix: 'px' },
};

/** fan: distance from the pivot (below the cards) to the cards */
const FAN_RADIUS = 600;
/** fan: cards a hair apart in z so they never fight for the same depth */
const FAN_Z = 4;
/** stack: offset between neighbouring cards */
const STACK_DX = 16;
const STACK_DY = 10;
/** spiral: climb (up) and recede per clip, as a part of the radius */
const SPIRAL_CLIMB = 0.12;
const SPIRAL_RECEDE = 0.08;

const r2 = (v: number) => {
  const n = Math.round(v * 100) / 100;
  return n === 0 ? 0 : n; // no -0
};
const rad = (deg: number) => (deg * Math.PI) / 180;

/** an angle in degrees brought into (-180, 180] */
export function wrapDegrees(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}

function pose(x: number, y: number, z: number, rotY = 0, rotation = 0): ArrangePose {
  return { x: r2(x), y: r2(y), z: r2(z), rotY: r2(wrapDegrees(rotY)), rotation: r2(rotation) };
}

export function arrange(kind: ArrangeKind, count: number, opts: ArrangeOpts = {}): ArrangePose[] {
  const n = Math.max(0, Math.floor(count));
  const out: ArrangePose[] = [];
  if (n === 0) return out;
  const radius = Math.max(0, opts.radius ?? ARRANGE_DEFAULTS.radius);
  const gap = Math.max(0, opts.gap ?? ARRANGE_DEFAULTS.gap);
  const depthGap = Math.max(0, opts.depthGap ?? ARRANGE_DEFAULTS.depthGap);
  const spread = opts.spread ?? ARRANGE_DEFAULTS.spread;
  const outward = opts.outward ?? true;
  const mid = (n - 1) / 2;

  if (kind === 'row') {
    const pitch = (opts.itemW ?? 0) + gap;
    for (let i = 0; i < n; i++) out.push(pose((i - mid) * pitch, 0, 0));
  } else if (kind === 'stack') {
    for (let i = 0; i < n; i++) out.push(pose((i - mid) * STACK_DX, (i - mid) * STACK_DY, i * depthGap));
  } else if (kind === 'fan') {
    const step = n > 1 ? spread / (n - 1) : 0;
    for (let i = 0; i < n; i++) {
      const a = (i - mid) * step;
      out.push(pose(FAN_RADIUS * Math.sin(rad(a)), FAN_RADIUS * (1 - Math.cos(rad(a))), i * FAN_Z, 0, a));
    }
  } else if (kind === 'grid') {
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const pitchX = (opts.itemW ?? 0) + gap;
    const pitchY = (opts.itemH ?? 0) + gap;
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / cols);
      const inRow = row === rows - 1 ? n - row * cols : cols; // the last row is centered on its own
      const col = i - row * cols;
      out.push(pose((col - (inRow - 1) / 2) * pitchX, (row - (rows - 1) / 2) * pitchY, 0));
    }
  } else {
    // ring and spiral: the first clip stands in front (z 0), the circle's middle is `radius` behind it
    const spiral = kind === 'spiral';
    for (let i = 0; i < n; i++) {
      const deg = (360 * i) / n;
      const x = radius * Math.sin(rad(deg));
      const z = radius * (1 - Math.cos(rad(deg))) + (spiral ? i * radius * SPIRAL_RECEDE : 0);
      const y = spiral ? -(i - mid) * radius * SPIRAL_CLIMB : 0;
      out.push(pose(x, y, z, outward ? deg : deg + 180));
    }
  }
  return out;
}

export interface ArrangeTargets {
  /** the selected visual clips in stacking order (track order, top first, then start time) */
  clips: VisualClip[];
  /** selected visual clips that were left out: attached to a parent or on a locked track */
  skipped: number;
}

export function arrangeTargets(project: Pick<Project, 'clips' | 'tracks'>, ids: readonly string[]): ArrangeTargets {
  const order = new Map(project.tracks.map((t, i) => [t.id, i]));
  const locked = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id));
  const picked = project.clips.filter((c: Clip): c is VisualClip => ids.includes(c.id) && isVisualClip(c));
  const clips = picked.filter((c) => !c.parent && !locked.has(c.trackId));
  clips.sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0) || a.start - b.start);
  return { clips, skipped: picked.length - clips.length };
}
