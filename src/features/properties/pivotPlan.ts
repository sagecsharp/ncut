import { getClipBox } from '../../engine/draw';
import { clipLookPoint, parentModelMatrix } from '../../engine/parent';
import { MEET_ORDER, PIVOT_SPOTS, type PivotSpot, normalizePivot, pivotOf, pivotOffset, samePivot, unturn } from '../../engine/pivot';
import { cameraAt, cameraRig } from '../../engine/scene3d/camera';
import type { Vec3 } from '../../engine/scene3d/math';
import { clipModelMatrix } from '../../engine/scene3d/model';
import { clamp } from '../../lib/time';
import { resolveShown, worldVectorToFrame } from '../preview/attached';
import { clipSpots } from '../preview/pivotMath';
import { isVisualClip } from '../../types';
import type { Pivot, Project, VisualClip } from '../../types';

export interface PivotPlan {
  /** the pivot to store: rounded to 4 decimals, null = the middle */
  pivot: Pivot | null;
  /** add to the clip's x / y / z: its static value, or every key of a keyed one. z is 0 for a 2d clip */
  dt: Vec3;
  /** add to each direct child's x / y (and z for a 3d child) the same way */
  children: { id: string; dv: Vec3 }[];
  /** direct children on locked tracks: when not empty the plan must not be written */
  locked: string[];
}

const visualOf = (project: Project, id: string): VisualClip | null => {
  const c = project.clips.find((x) => x.id === id);
  return c && isVisualClip(c) ? c : null;
};

/**
 * what to write so the clip gets the pivot `next` and neither it nor the clips attached to it move on screen at `time`
 * (clamped into the clip). null when the clip is not a picture clip or already has that pivot. the place that is kept is
 * the one under the clip's own motions (like reparentTransform).
 */
export function pivotPlan(project: Project, id: string, next: Pivot | null, time: number): PivotPlan | null {
  const clip = visualOf(project, id);
  if (!clip) return null;
  const want = normalizePivot(next);
  if (samePivot(clip.pivot, want)) return null;
  const T = clamp(time, clip.start, clip.start + clip.duration);
  // the place under the motions: without them the numbers are the ones the keys give
  const bare = clip.motionIn || clip.motionOut || clip.motionLoop ? ({ ...clip, motionIn: null, motionOut: null, motionLoop: null } as VisualClip) : clip;
  const proj = bare === clip ? project : { ...project, clips: project.clips.map((c) => (c.id === id ? bare : c)) };
  const shown = resolveShown(bare, T);
  const box = getClipBox(proj, shown);
  const tr = shown.transform;
  const threeD = !!shown.threeD;
  const f = pivotOf(clip);
  const g = want ?? { x: 0, y: 0 };
  const dpx = (g.x - f.x) * box.width;
  const dpy = (g.y - f.y) * box.height;
  let dt = pivotOffset(tr, threeD, dpx, dpy);

  // a look that turns: its basis depends on the position, so the closed form is a few px off. refine
  const lookPoint = clipLookPoint(proj, bare, T);
  const looks = threeD && (shown.lookAt === 'camera' || shown.lookAt === 'cameraY' || (shown.lookAt === 'clip' && !!lookPoint));
  if (looks) {
    const parentM = bare.parent ? parentModelMatrix(proj, bare, T) : null;
    const eye = cameraRig(cameraAt(proj, T), proj.width, proj.height).eye;
    const m0 = clipModelMatrix(box, tr, shown.lookAt, eye, parentM, lookPoint);
    // the picture middle now
    const goal: Vec3 = [m0[12]!, m0[13]!, m0[14]!];
    const nb = { width: box.width, height: box.height, rotation: box.rotation, px: g.x * box.width, py: g.y * box.height };
    // keep the dt with the smallest error seen: for a big picture the steps can swing away, so the result is never worse than the closed form
    let best = dt;
    let bestErr = Infinity;
    for (let i = 0; i <= 4; i++) {
      const t1 = { ...tr, x: tr.x + dt[0], y: tr.y + dt[1], z: (tr.z ?? 0) + dt[2] };
      const m = clipModelMatrix({ ...nb, cx: proj.width / 2 + t1.x, cy: proj.height / 2 + t1.y }, t1, shown.lookAt, eye, parentM, lookPoint);
      const err: Vec3 = [goal[0] - m[12]!, goal[1] - m[13]!, goal[2] - m[14]!];
      const n = Math.hypot(err[0], err[1], err[2]);
      if (n < bestErr) {
        bestErr = n;
        best = dt;
      }
      if (n < 1e-6 || i === 4) break;
      const d = parentM ? worldVectorToFrame(parentM, err) : err;
      if (!d) break;
      dt = [dt[0] + d[0], dt[1] + d[1], dt[2] + d[2]];
    }
    dt = best;
  }

  // the clips attached to it: their offsets live in this clip's frame, which moved by dt (its turn cancels)
  const lockedTracks = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id));
  const s = Math.abs(tr.scale) < 1e-9 ? 1 : tr.scale;
  const children: { id: string; dv: Vec3 }[] = [];
  const locked: string[] = [];
  for (const c of project.clips) {
    if (!isVisualClip(c) || c.parent !== id) continue;
    const v = threeD && c.threeD ? unturn(tr, true, dt) : unturn(tr, false, [dt[0], dt[1], 0]);
    const dv: Vec3 = [v[0] / -s, v[1] / -s, threeD && c.threeD ? v[2] / -s : 0];
    children.push({ id: c.id, dv });
    if (lockedTracks.has(c.trackId)) locked.push(c.id);
  }
  return { pivot: want, dt, children, locked };
}

/**
 * the spot of a clip where it meets the clip it is attached to: of all pairs between its 9 spots and the parent's 9 spots
 * plus the parent's pivot, the nearest (world px at `time`, clamped into each clip). pairs within 0.5 px of the best are
 * equal: then the own spot earliest in MEET_ORDER wins, then the parent's pivot, then its spots in MEET_ORDER.
 * null without a visual parent.
 */
export function meetSpot(project: Project, id: string, time: number): PivotSpot | null {
  const clip = visualOf(project, id);
  if (!clip || !clip.parent) return null;
  const parent = visualOf(project, clip.parent);
  if (!parent) return null;
  const T = clamp(time, clip.start, clip.start + clip.duration);
  const eye = cameraRig(cameraAt(project, T), project.width, project.height).eye;
  const own = clipSpots(project, clip, T, eye);
  const par = clipSpots(project, parent, clamp(T, parent.start, parent.start + parent.duration), eye);
  // the parent's points: its pivot first, then its spots in the meet order
  const targets: Vec3[] = [par.pivot, ...MEET_ORDER.map((i) => par.spots[i]!)];
  const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  let best = Infinity;
  for (const a of own.spots) for (const b of targets) best = Math.min(best, dist(a, b));
  for (const oi of MEET_ORDER) {
    for (const b of targets) {
      if (dist(own.spots[oi]!, b) <= best + 0.5) return PIVOT_SPOTS[oi]!;
    }
  }
  return null;
}
