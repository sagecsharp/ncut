/**
 * arrange in 3d: pure layout math. every layout returns one pose per clip, in the order the clips are given
 * (the first clip is the front / first one). units are canvas pixels and degrees, x right, y down, +z away
 * from the viewer, z 0 = the canvas plane. rotY + turns the plane to the right (see types.ts).
 * a single clip always lands centered and flat.
 */
import type { Clip, Project, VisualClip } from '../../types';
import { isVisualClip } from '../../types';

export type ArrangeKind = 'ring' | 'row' | 'stack' | 'fan' | 'grid' | 'spiral' | 'sphere' | 'scatter' | 'wave' | 'stairs';

export interface ArrangePose {
  x: number;
  y: number;
  z: number;
  rotY: number;
  rotation: number;
  /** tilt (degrees). only the layouts that lean clips set it (sphere), the others leave it out = 0 */
  rotX?: number;
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
  /** ring / spiral / sphere: clips face away from the middle (true, default) or toward it */
  outward?: boolean;
  /** row / grid: size of one clip (px), the pitch is size + gap. missing = 0 */
  itemW?: number;
  itemH?: number;
  /** scatter: the random pattern. the same seed always gives the same layout. */
  seed?: number;
  /** wave: height of the sine (px) */
  amplitude?: number;
  /** stairs: depth of one step (px), the rise is a part of it */
  step?: number;
}

export type ArrangeKey = 'radius' | 'gap' | 'depthGap' | 'spread' | 'seed' | 'amplitude' | 'step';

export const ARRANGE_DEFAULTS: Record<ArrangeKey, number> = { radius: 600, gap: 40, depthGap: 60, spread: 70, seed: 1, amplitude: 150, step: 80 };

/** the slider that belongs to each layout */
export const ARRANGE_SLIDERS: Record<ArrangeKind, { key: ArrangeKey; label: string; min: number; max: number; step: number; suffix: string }> = {
  ring: { key: 'radius', label: 'radius', min: 50, max: 2000, step: 10, suffix: 'px' },
  row: { key: 'gap', label: 'gap', min: 0, max: 600, step: 5, suffix: 'px' },
  stack: { key: 'depthGap', label: 'depth gap', min: 0, max: 600, step: 5, suffix: 'px' },
  fan: { key: 'spread', label: 'spread', min: 0, max: 180, step: 1, suffix: 'deg' },
  grid: { key: 'gap', label: 'gap', min: 0, max: 600, step: 5, suffix: 'px' },
  spiral: { key: 'radius', label: 'radius', min: 50, max: 2000, step: 10, suffix: 'px' },
  sphere: { key: 'radius', label: 'radius', min: 50, max: 2000, step: 10, suffix: 'px' },
  scatter: { key: 'seed', label: 'shuffle', min: 1, max: 999, step: 1, suffix: '' },
  wave: { key: 'amplitude', label: 'height', min: 0, max: 800, step: 5, suffix: 'px' },
  stairs: { key: 'step', label: 'step', min: 0, max: 400, step: 5, suffix: 'px' },
};

/** layouts with a second slider: the size of the box scatter fills (the radius of the other layouts) */
export const ARRANGE_EXTRA_SLIDERS: Partial<Record<ArrangeKind, { key: ArrangeKey; label: string; min: number; max: number; step: number; suffix: string }>> = {
  scatter: { key: 'radius', label: 'size', min: 50, max: 2000, step: 10, suffix: 'px' },
};

/** the layouts that read the `outward` option (the switch is only shown for these) */
export const ARRANGE_READS_OUTWARD: Record<ArrangeKind, boolean> = {
  ring: true,
  row: false,
  stack: false,
  fan: false,
  grid: false,
  spiral: true,
  sphere: true,
  scatter: false,
  wave: false,
  stairs: false,
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

/** wave: one full sine every this many clips */
const WAVE_PERIOD = 6;
/** stairs: how much of a step's depth is its rise */
const STAIRS_RISE = 0.75;
/** scatter: the box is this wide / tall / deep, as parts of the size slider (z starts at 0, never behind the camera) */
const SCATTER_W = 1.5;
const SCATTER_H = 0.8;
const SCATTER_D = 1.5;
/** scatter: clips turn a little, up to this many degrees either way */
const SCATTER_TURN = 20;

/** small deterministic random numbers in [0, 1) (mulberry32) */
function seeded(seed: number): () => number {
  let a = Math.floor(Number.isFinite(seed) ? seed : 1) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r2 = (v: number) => {
  const n = Math.round(v * 100) / 100;
  return n === 0 ? 0 : n; // no -0
};
const rad = (deg: number) => (deg * Math.PI) / 180;
const DEG = Math.PI / 180;

/** an angle in degrees brought into (-180, 180] */
export function wrapDegrees(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}

function pose(x: number, y: number, z: number, rotY = 0, rotation = 0, rotX?: number): ArrangePose {
  const p: ArrangePose = { x: r2(x), y: r2(y), z: r2(z), rotY: r2(wrapDegrees(rotY)), rotation: r2(rotation) };
  if (rotX !== undefined) p.rotX = r2(rotX);
  return p;
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

  if (n === 1) {
    out.push(pose(0, 0, 0)); // one clip: centered and flat, whatever the layout
  } else if (kind === 'row') {
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
  } else if (kind === 'sphere') {
    // fibonacci sphere: even points from the top down, the golden angle apart. the middle of the ball is
    // `radius` behind the first clip's depth; point 0 is turned to the front. every clip faces outward, or
    // inward (turned 180 degrees around y, tilt negated) when `outward` is false.
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const up = 1 - (2 * (i + 0.5)) / n; // 1 = top, -1 = bottom
      const ring = Math.sqrt(Math.max(0, 1 - up * up));
      const a = i * golden - Math.PI / 2;
      const ox = ring * Math.cos(a);
      const oy = -up; // y is down
      const oz = ring * Math.sin(a);
      const turn = Math.atan2(ox, -oz) / DEG;
      const tilt = Math.asin(Math.max(-1, Math.min(1, -oy))) / DEG;
      out.push(pose(radius * ox, radius * oy, radius * (1 + oz), outward ? turn : turn + 180, 0, outward ? tilt : -tilt));
    }
  } else if (kind === 'scatter') {
    const rnd = seeded(opts.seed ?? ARRANGE_DEFAULTS.seed);
    for (let i = 0; i < n; i++) {
      const x = (rnd() * 2 - 1) * radius * SCATTER_W;
      const y = (rnd() * 2 - 1) * radius * SCATTER_H;
      const z = rnd() * radius * SCATTER_D; // z >= 0: always in front of the home camera, which sits far behind the canvas plane
      out.push(pose(x, y, z, (rnd() * 2 - 1) * SCATTER_TURN));
    }
  } else if (kind === 'wave') {
    const amp = Math.max(0, opts.amplitude ?? ARRANGE_DEFAULTS.amplitude);
    const pitch = (opts.itemW ?? 0) + gap;
    for (let i = 0; i < n; i++) {
      const a = ((i - mid) * 2 * Math.PI) / WAVE_PERIOD;
      out.push(pose((i - mid) * pitch, amp * Math.sin(a), amp * (1 - Math.cos(a))));
    }
  } else if (kind === 'stairs') {
    const step = Math.max(0, opts.step ?? ARRANGE_DEFAULTS.step);
    for (let i = 0; i < n; i++) out.push(pose(0, (mid - i) * step * STAIRS_RISE, i * step));
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
