/**
 * the group bend, pure: clips measured in the world, one tube fitted through them, and the state of a selection as a
 * group bend. every member is measured from its picture middle (pictureBox), never from x / y, so a pivot does not move
 * the fit. no store, no dom.
 */
import { getClipBox } from '../../engine/draw';
import { pictureBox } from '../../engine/pivot';
import { cameraAt, cameraRig } from '../../engine/scene3d/camera';
import { DEG, dot, length, normalize, sub } from '../../engine/scene3d/math';
import type { Vec3 } from '../../engine/scene3d/math';
import { clipWorldModel } from '../../engine/scene3d/model';
import { evalKeys } from '../../lib/anim';
import { sameHandles } from '../../lib/keyBezier';
import { clamp } from '../../lib/time';
import type { BendAlong, Keyframe, Project, VisualClip } from '../../types';
import { resolveShown, worldClip } from '../preview/attached';

/** one clip of a group bend, measured in the world at a time */
export interface BendMember {
  id: string;
  /** world middle of the clip's picture (its own box, from its picture middle) */
  center: Vec3;
  /** world unit axes of the clip's own x and y */
  ax: Vec3;
  ay: Vec3;
  /** world unit normal of the front face (toward the viewer: -z of the clip) */
  n: Vec3;
  /** world length of the own box along x and y */
  ownW: number;
  ownH: number;
  /** world px per own-plane px (a scaled 3d or 2d parent; 1 without one) */
  k: number;
}

/**
 * every clip measured at `time` (keys resolved, resolveShown; a clip is read at the time held inside its own range).
 * a 3d clip through clipWorldModel with the project rig's eye (columns 0 and 1 give ax / ay and the lengths, column 2 the
 * normal, column 3 the picture middle; k = |column 0| / box.width). a 2d clip through worldClip: the picture middle
 * (pictureBox of its box), axes from box.rotation, n = (0, 0, -1), k = world scale / own scale.
 */
export function bendMembers(project: Project, clips: readonly VisualClip[], time: number): BendMember[] {
  return clips.map((raw) => {
    const t = clamp(time, raw.start, raw.start + raw.duration);
    if (raw.threeD) {
      const shown = resolveShown(raw, t);
      const box = getClipBox(project, shown);
      const eye = cameraRig(cameraAt(project, t), project.width, project.height).eye;
      const m = clipWorldModel(project, shown, t, box, eye);
      const c0: Vec3 = [m[0]!, m[1]!, m[2]!];
      const c1: Vec3 = [m[4]!, m[5]!, m[6]!];
      const c2: Vec3 = [m[8]!, m[9]!, m[10]!];
      const w = length(c0);
      const h = length(c1);
      const n = normalize(c2);
      return {
        id: raw.id,
        center: [m[12]!, m[13]!, m[14]!],
        ax: normalize(c0),
        ay: normalize(c1),
        n: [-n[0], -n[1], -n[2]],
        ownW: w,
        ownH: h,
        k: box.width > 0 ? w / box.width : 1,
      };
    }
    const own = resolveShown(raw, t);
    const world = worldClip(project, raw, t);
    const box = getClipBox(project, world);
    const pb = pictureBox(box);
    const a = box.rotation * DEG;
    const ownScale = own.transform.scale;
    return {
      id: raw.id,
      center: [pb.cx, pb.cy, 0],
      ax: [Math.cos(a), Math.sin(a), 0],
      ay: [-Math.sin(a), Math.cos(a), 0],
      n: [0, 0, -1],
      ownW: box.width,
      ownH: box.height,
      k: ownScale > 0 && world.transform.scale > 0 ? world.transform.scale / ownScale : 1,
    };
  });
}

export interface BendFit {
  per: Map<string, { along: BendAlong; center: number; span: number }>;
  /** world px of the whole row along the bend axis */
  length: number;
  /** every clip faces the same way in one plane and lines up with the axis: the bend joins up */
  onePlane: boolean;
}

/** the axis of the row: the leader's own x for 'width', its y for 'height' */
const axisOf = (m: BendMember, along: BendAlong): Vec3 => (along === 'height' ? m.ay : m.ax);

/** which own axis of a member lines up better with e, and the sign of that dot (1 at 0) */
function ownAxisFor(m: BendMember, e: Vec3): { along: BendAlong; sgn: number; align: number } {
  const dx = dot(m.ax, e);
  const dy = dot(m.ay, e);
  const useY = Math.abs(dy) > Math.abs(dx);
  const d = useY ? dy : dx;
  return { along: useY ? 'height' : 'width', sgn: d < 0 ? -1 : 1, align: Math.abs(d) };
}

/** lo / hi of every member corner along e */
function extent(members: readonly BendMember[], e: Vec3): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const m of members) {
    const mid = dot(m.center, e);
    // the half length of the box along e: |ax.e| ownW / 2 + |ay.e| ownH / 2 (the corners of a rectangle)
    const half = (Math.abs(dot(m.ax, e)) * m.ownW + Math.abs(dot(m.ay, e)) * m.ownH) / 2;
    if (mid - half < lo) lo = mid - half;
    if (mid + half > hi) hi = mid + half;
  }
  return { lo, hi };
}

/** every clip faces the same way in one plane and lines up with the axis */
function onePlaneOf(members: readonly BendMember[], e: Vec3): boolean {
  const first = members[0];
  if (!first) return false;
  for (const m of members) {
    if (ownAxisFor(m, e).align <= 0.999) return false;
    if (dot(m.n, first.n) <= 0.999) return false;
    if (Math.abs(dot(sub(m.center, first.center), first.n)) >= 0.5) return false;
  }
  return true;
}

/**
 * one tube through all the members. the axis e is the leader's (members[0]) x for 'width', y for 'height'.
 * lo / hi = the min / max of every member corner (middle +- ax ownW / 2 +- ay ownH / 2) along e. W = hi - lo.
 * the flat line sits at M = lo + (0.5 + middle) W.
 * per member: its own axis is x or y, whichever lines up better with e (|dot|), sgn = the sign of that dot (1 at 0).
 * center = (M - dot(middle, e)) sgn / W (clamped -1..1), span = W / k, along = the member's own axis.
 * onePlane: every |dot(axis, e)| > 0.999, dot(n, n0) > 0.999, |dot(middle - middle0, n0)| < 0.5 px.
 * null when W < 1 px or there are no members.
 */
export function fitBend(members: readonly BendMember[], along: BendAlong, middle = 0): BendFit | null {
  const lead = members[0];
  if (!lead) return null;
  const e = axisOf(lead, along);
  const { lo, hi } = extent(members, e);
  const W = hi - lo;
  if (!(W >= 1)) return null;
  const M = lo + (0.5 + middle) * W;
  const per = new Map<string, { along: BendAlong; center: number; span: number }>();
  for (const m of members) {
    const { along: own, sgn } = ownAxisFor(m, e);
    const center = clamp(((M - dot(m.center, e)) * sgn) / W, -1, 1);
    per.set(m.id, { along: own, center, span: W / (m.k > 0 ? m.k : 1) });
  }
  return { per, length: W, onePlane: onePlaneOf(members, e) };
}

export interface BendState {
  /** every member has a span and they share one tube and one flat line (within 1e-6 relative curvature and 0.5 px) */
  together: boolean;
  /** members whose bend does not match the leader's tube (moved, added, resized since the fit) */
  off: string[];
  /** some member's bend.angle keys are not the leader's keys shifted by keysFor */
  keysApart: boolean;
  onePlane: boolean;
  /** where the flat line sits on the row now, -0.5..0.5 (0 when it can not be read) */
  middle: number;
}

/** a clip's bend angle: from its keys at `time` when it has some, else the stored one */
function angleOf(c: VisualClip, time: number | undefined): number {
  const keys = c.keyframes?.['bend.angle'];
  if (keys && keys.length > 0 && time !== undefined) return evalKeys(keys, time - c.start, c, 'bend.angle');
  return c.bend?.angle ?? 0;
}

const sameKeys = (a: readonly Keyframe[], b: readonly Keyframe[]): boolean =>
  a.length === b.length && a.every((k, i) => Math.abs(k.t - b[i]!.t) < 1e-6 && Math.abs(k.v - b[i]!.v) < 1e-9 && k.ease === b[i]!.ease && sameHandles(k, b[i]!));

/**
 * the state of a selection as a group bend, from the leader (clips[0]): its world curvature rad(angle) / (span k) and
 * its flat line along e (middle + sgn center span k) against every other member's. `members` and `clips` run in the same
 * order. `time` (optional) reads keyed angles at that timeline time; without it the stored angle counts.
 */
export function bendState(members: readonly BendMember[], clips: readonly VisualClip[], time?: number): BendState {
  const lead = clips[0];
  const m0 = members[0];
  const none: BendState = { together: false, off: [], keysApart: false, onePlane: false, middle: 0 };
  if (!lead || !m0) return none;
  const along: BendAlong = lead.bend?.along === 'height' ? 'height' : 'width';
  const e = axisOf(m0, along);
  const onePlane = onePlaneOf(members, e);
  const { lo, hi } = extent(members, e);
  const W = hi - lo;
  const leadSpan = lead.bend?.span;
  const readable = !!lead.bend && typeof leadSpan === 'number' && leadSpan > 0 && m0.k > 0;
  // the leader's curvature (rad per world px) and flat line along e
  const curve0 = readable ? (angleOf(lead, time) * DEG) / (leadSpan! * m0.k) : 0;
  const flat0 = readable ? dot(m0.center, e) + (lead.bend!.center ?? 0) * leadSpan! * m0.k : 0;
  const off: string[] = [];
  let keysApart = false;
  const leadKeys = lead.keyframes?.['bend.angle'] ?? [];
  clips.forEach((c, i) => {
    const m = members[i];
    if (!m) return;
    if (i > 0) {
      const want = keysFor(leadKeys, lead.start, c.start);
      if (!sameKeys(c.keyframes?.['bend.angle'] ?? [], want)) keysApart = true;
    }
    if (!readable) {
      if (i > 0) off.push(c.id);
      return;
    }
    if (i === 0) return;
    const span = c.bend?.span;
    if (!c.bend || typeof span !== 'number' || !(span > 0) || !(m.k > 0)) {
      off.push(c.id);
      return;
    }
    // the member's own bend axis against the row axis
    const own = c.bend.along === 'height' ? m.ay : m.ax;
    const d = dot(own, e);
    const sgn = d < 0 ? -1 : 1;
    const curve = (angleOf(c, time) * DEG) / (span * m.k);
    const tol = 1e-6 * Math.max(Math.abs(curve0), 1e-9);
    const flat = dot(m.center, e) + sgn * (c.bend.center ?? 0) * span * m.k;
    if (Math.abs(d) < 0.5 || Math.abs(curve - curve0) > tol || Math.abs(flat - flat0) > 0.5) off.push(c.id);
  });
  const together = readable && clips.length >= 2 && off.length === 0;
  const middle = readable && W >= 1 ? clamp((flat0 - lo) / W - 0.5, -0.5, 0.5) : 0;
  return { together, off, keysApart, onePlane, middle };
}

/** the leader's bend.angle keys moved to a member: the same timeline times (t + leaderStart - memberStart), not clamped */
export function keysFor(leaderKeys: readonly Keyframe[], leaderStart: number, memberStart: number): Keyframe[] {
  const d = leaderStart - memberStart;
  return leaderKeys.map((k) => ({ ...k, t: k.t + d }));
}
