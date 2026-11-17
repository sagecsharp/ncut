/** the maths of the pivot mark on the preview: where a picture's spots are and where a ray meets its plane. pure, no dom. */
import { getClipBox, visibleClipsAt } from '../../engine/draw';
import { clipLookPoint } from '../../engine/parent';
import { PIVOT_SPOTS, pictureBox, samePivot } from '../../engine/pivot';
import { rayPlane } from '../../engine/scene3d/camera';
import { DEG, type Vec3, cross, dot, sub, transformPoint } from '../../engine/scene3d/math';
import { clipModelMatrix, clipWorldModel } from '../../engine/scene3d/model';
import type { Project, VisualClip } from '../../types';
import { resolveShown, worldClip } from './attached';
import { usesParentFrame } from './overlayMath';

/** the 9 spots of a clip's picture in the world (canvas px, z away) in PIVOT_SPOTS order, and its pivot (its position) */
export interface ClipSpots {
  spots: Vec3[];
  pivot: Vec3;
}

/**
 * where a clip's spots are at a time: the unpadded, uncropped picture. a 2d clip lies in the canvas plane (z 0) through
 * pictureBox of its world box. a 3d clip goes through the same model as clipQuad (usesParentFrame: resolveShown +
 * clipWorldModel, else worldClip + clipModelMatrix with clipLookPoint). `eye` is the eye the look turns to.
 */
export function clipSpots(project: Project, clip: VisualClip, time: number, eye: Vec3): ClipSpots {
  if (!clip.threeD) {
    const box = getClipBox(project, worldClip(project, clip, time));
    const pic = pictureBox(box);
    const a = pic.rotation * DEG;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const spots = PIVOT_SPOTS.map((sp): Vec3 => {
      const x = sp.x * pic.width;
      const y = sp.y * pic.height;
      return [pic.cx + x * c - y * s, pic.cy + x * s + y * c, 0];
    });
    return { spots, pivot: [box.cx, box.cy, 0] };
  }
  const framed = usesParentFrame(clip);
  const shown = framed ? resolveShown(clip, time) : worldClip(project, clip, time);
  const box = getClipBox(project, shown);
  const model = framed
    ? clipWorldModel(project, shown, time, box, eye)
    : clipModelMatrix(box, shown.transform, shown.lookAt, eye, null, shown.lookAt === 'clip' ? clipLookPoint(project, shown, time) : null);
  const spots = PIVOT_SPOTS.map((sp): Vec3 => {
    const p = transformPoint(model, sp.x, sp.y, 0);
    return [p[0], p[1], p[2]];
  });
  // the position: the same model without the pivot, its translation is the frame's
  const bare = framed ? clipWorldModel(project, shown, time, { ...box, px: 0, py: 0 }, eye) : clipModelMatrix({ ...box, px: 0, py: 0 }, shown.transform, shown.lookAt, eye, null, shown.lookAt === 'clip' ? clipLookPoint(project, shown, time) : null);
  return { spots, pivot: [bare[12]!, bare[13]!, bare[14]!] };
}

/**
 * where a ray hits the plane of a picture, as fractions of its box from its middle (the pivot units). spots from clipSpots
 * (0 top left, 2 top right, 4 middle, 6 bottom left). null when the plane is seen edge on (|n . dir| < 1e-6 |n| |dir|)
 * or the box has no size. a 2d clip in the output view uses origin (px, py, -1) and dir (0, 0, 1).
 */
export function fractionOnPlane(spots: readonly Vec3[], origin: Vec3, dir: Vec3): [number, number] | null {
  const s0 = spots[0];
  const s2 = spots[2];
  const s6 = spots[6];
  const c = spots[4];
  if (!s0 || !s2 || !s6 || !c) return null;
  const ex = sub(s2, s0);
  const ey = sub(s6, s0);
  const n = cross(ex, ey);
  const nl = Math.hypot(n[0], n[1], n[2]);
  const dl = Math.hypot(dir[0], dir[1], dir[2]);
  if (!(nl > 0) || !(dl > 0) || Math.abs(dot(n, dir)) < 1e-6 * nl * dl) return null;
  const hit = rayPlane(origin, dir, c, n);
  if (!hit) return null;
  const d = sub(hit, c);
  const exx = dot(ex, ex);
  const exy = dot(ex, ey);
  const eyy = dot(ey, ey);
  const det = exx * eyy - exy * exy;
  if (!(det > 1e-9)) return null;
  const dx = dot(d, ex);
  const dy = dot(d, ey);
  return [(eyy * dx - exy * dy) / det, (exx * dy - exy * dx) / det];
}

/** a point the pivot mark can snap to, in css px of the overlay */
export interface PivotSnap {
  x: number;
  y: number;
  /** what the label shows */
  label: string;
  /** a spot of the clip itself: the exact fractions (no ray, no rounding noise) */
  spot?: [number, number];
}

/** how many other clips the snaps reach */
const SNAP_CLIPS = 16;

/**
 * the snap points for the pivot of `clip`: its own 9 spots (labels from PIVOT_SPOTS), and for the 16 other picture clips
 * on screen nearest to its position: their position ("pivot of {name}" when they have a pivot, else "middle of {name}"),
 * their picture middle when they have a pivot ("middle of {name}"), and their other 8 spots ("{spot label} of {name}").
 * {name} is the clip name, or its type when it has none. `toScreen` projects a world point to css px (ok false =
 * behind the camera, left out). it also gets the clip the point belongs to, so a flat clip can be drawn flat.
 * on screen = in range at `time`, track not hidden, not a face source.
 */
export function pivotSnaps(
  project: Project,
  clip: VisualClip,
  time: number,
  eye: Vec3,
  toScreen: (p: Vec3, of: VisualClip) => { x: number; y: number; ok: boolean },
): PivotSnap[] {
  const out: PivotSnap[] = [];
  const own = clipSpots(project, clip, time, eye);
  PIVOT_SPOTS.forEach((sp, i) => {
    const s = toScreen(own.spots[i]!, clip);
    if (s.ok) out.push({ x: s.x, y: s.y, label: sp.label, spot: [sp.x, sp.y] });
  });
  const here = toScreen(own.pivot, clip);
  const others: Array<{ clip: VisualClip; spots: ClipSpots; dist: number }> = [];
  for (const other of visibleClipsAt(project, time)) {
    if (other.id === clip.id) continue;
    const spots = clipSpots(project, other, time, eye);
    const at = toScreen(spots.pivot, other);
    // the nearest to where this clip is: on screen when both are, else in the world
    const dist = at.ok && here.ok ? Math.hypot(at.x - here.x, at.y - here.y) : Math.hypot(spots.pivot[0] - own.pivot[0], spots.pivot[1] - own.pivot[1], spots.pivot[2] - own.pivot[2]) * 1e3;
    others.push({ clip: other, spots, dist });
  }
  others.sort((a, b) => a.dist - b.dist);
  for (const o of others.slice(0, SNAP_CLIPS)) {
    const name = o.clip.name || o.clip.type;
    const set = !samePivot(o.clip.pivot, null);
    const at = toScreen(o.spots.pivot, o.clip);
    if (at.ok) out.push({ x: at.x, y: at.y, label: `${set ? 'pivot' : 'middle'} of ${name}` });
    PIVOT_SPOTS.forEach((sp, i) => {
      // the middle is the position itself without a pivot
      if (i === 4 && !set) return;
      const s = toScreen(o.spots.spots[i]!, o.clip);
      if (s.ok) out.push({ x: s.x, y: s.y, label: `${sp.label} of ${name}` });
    });
  }
  return out;
}

/** the nearest snap within `radius` css px of (x, y), or null */
export function nearestSnap(snaps: readonly PivotSnap[], x: number, y: number, radius: number): PivotSnap | null {
  let best: PivotSnap | null = null;
  let bestD = radius;
  for (const s of snaps) {
    const d = Math.hypot(s.x - x, s.y - y);
    if (d <= bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

/**
 * how far the pivot of a flat picture moves when its box goes from w0 x h0 to w1 x h1 and its middle moves by (dx, dy)
 * (canvas px). the edge handles write this, so the opposite edge stays put with a pivot too
 */
export function pivotFollow(rotation: number, fx: number, fy: number, w0: number, h0: number, w1: number, h1: number, dx: number, dy: number): { dx: number; dy: number } {
  const ex = fx * (w1 - w0);
  const ey = fy * (h1 - h0);
  const a = rotation * DEG;
  return { dx: dx + ex * Math.cos(a) - ey * Math.sin(a), dy: dy + ex * Math.sin(a) + ey * Math.cos(a) };
}
