/**
 * the store side of bend: bend clips as one surface, each on its own, leave a group bend, take bends off. every write
 * goes through setBends (one mutate, one undo step): pushHistory once unless opts.skipHistory, then every write skips history.
 */
import { getClipBox } from '../../engine/draw';
import { knownShape } from '../../engine/scene3d/meshes';
import { KEY_EPS, evalKeys, keyIndexAt, withKeyAt, withValueAt, withoutKeyAt } from '../../lib/anim';
import { useEditor } from '../../store/editorStore';
import type { ActionOpts, BendWrite } from '../../store/editorStore';
import { isVisualClip } from '../../types';
import type { BendAlong, ClipBend, Easing, Keyframe, Project, VisualClip } from '../../types';
import { resolveShown } from '../preview/attached';
import { bendMembers, bendState, fitBend, keysFor } from './bendGroup';

/** what to change on a set of clips. a missing field keeps what is there */
export interface BendChange {
  angle?: number;
  along?: BendAlong;
  /** as one: where the row stays flat, -0.5..0.5 */
  middle?: number;
  /** lay the bend over the clips where they are now */
  fit?: boolean;
  /** 'toggle' = a key at time on or off (like the diamond), 'add' = a key at time with the angle */
  key?: 'toggle' | 'add';
  ease?: Easing;
}

export interface BendResult {
  bent: string[];
  skipped: { id: string; why: string }[];
  /** the group the clips were put in (as one), else null */
  group: string | null;
  onePlane: boolean;
  along: BendAlong;
  angle: number;
}

const SKIP = { skipHistory: true } as const;

/** a 3d clip that is a solid (only a plane bends) */
const isSolid = (c: VisualClip): boolean => !!c.threeD && knownShape(c.shape) !== 'plane';

const isLocked = (p: Project, trackId: string): boolean => !!p.tracks.find((t) => t.id === trackId)?.locked;

/** the clips of `ids` that can bend (picture clips on unlocked tracks, 2d or a 3d plane) in project order, and the 3d solids that can not */
export function bendTargets(project: Project, ids: readonly string[]): { clips: VisualClip[]; solids: VisualClip[] } {
  const want = new Set(ids);
  const clips: VisualClip[] = [];
  const solids: VisualClip[] = [];
  for (const c of project.clips) {
    if (!want.has(c.id) || !isVisualClip(c) || isLocked(project, c.trackId)) continue;
    if (isSolid(c)) solids.push(c);
    else clips.push(c);
  }
  return { clips, solids };
}

/** the first clip that can bend, in project order (it leads a group bend: its angle and keys are the group's) */
export function bendLeader(project: Project | null, ids: readonly string[]): VisualClip | null {
  if (!project) return null;
  return bendTargets(project, ids).clips[0] ?? null;
}

/** why each clip of `ids` that is not in `bent` was left out, in the order of ids */
export function skippedOf(project: Project, ids: readonly string[], bent: readonly string[]): { id: string; why: string }[] {
  const out: { id: string; why: string }[] = [];
  const done = new Set(bent);
  for (const id of ids) {
    if (done.has(id)) continue;
    const c = project.clips.find((x) => x.id === id);
    if (!c) continue;
    if (!isVisualClip(c)) out.push({ id, why: 'only picture clips bend' });
    else if (isLocked(project, c.trackId)) out.push({ id, why: 'its track is locked' });
    else if (isSolid(c)) out.push({ id, why: 'a 3d shape other than plane does not bend' });
  }
  return out;
}

/** the stored bend of a clip with new numbers. width is the default axis, so it is left out */
function bendOf(angle: number, along: BendAlong, center: number | undefined, span: number | undefined): ClipBend {
  return { angle, ...(along === 'height' ? { along } : {}), ...(center ? { center } : {}), ...(span ? { span } : {}) };
}

const angleNow = (c: VisualClip, time: number): number => {
  const keys = c.keyframes?.['bend.angle'];
  return keys && keys.length > 0 ? evalKeys(keys, time - c.start) : (c.bend?.angle ?? 0);
};

/**
 * the angle and the bend.angle keys of one clip after a change at a timeline time. keys: undefined = keep them,
 * null = remove them, a list = these (clip-local). the key goes to timeline time `time`, not clamped into the clip.
 */
function applyAngle(c: VisualClip, change: BendChange, time: number, fps: number): { angle: number; keys: Keyframe[] | null | undefined } {
  const cur = angleNow(c, time);
  const angle = change.angle ?? cur;
  const keyed = (c.keyframes?.['bend.angle']?.length ?? 0) > 0;
  const base = { ...c, bend: { ...(c.bend ?? { angle: 0 }), angle: c.bend?.angle ?? 0 } } as VisualClip;
  let out: VisualClip = base;
  let touched = false;
  if (change.key === 'toggle') {
    const tol = 0.5 / Math.max(1, fps);
    if (keyIndexAt(c.keyframes?.['bend.angle'] ?? [], time - c.start, tol) >= 0) out = withoutKeyAt(base, 'bend.angle', time, tol);
    else out = withKeyAt(base, 'bend.angle', time, angle, change.ease);
    touched = true;
  } else if (change.key === 'add') {
    out = withKeyAt(base, 'bend.angle', time, angle, change.ease);
    touched = true;
  } else if (keyed && change.angle !== undefined) {
    out = withValueAt(base, 'bend.angle', time, angle);
    touched = true;
  } else if (keyed && change.ease !== undefined && keyIndexAt(c.keyframes?.['bend.angle'] ?? [], time - c.start) >= 0) {
    out = withKeyAt(base, 'bend.angle', time, cur, change.ease);
    touched = true;
  }
  if (!touched) return { angle, keys: keyed ? undefined : null };
  const keys = out.keyframes?.['bend.angle'];
  // the last key off: the value it held is the plain angle now
  if (!keys || keys.length === 0) return { angle: out.bend?.angle ?? angle, keys: null };
  return { angle, keys };
}

/**
 * bend clips as one surface. groups them first when they are not exactly one group. fits (fitBend) when along, middle or
 * fit is given, or when the clips are bent as one for the first time (a new group or no span on the leader); else every member keeps its along, center and span.
 * the angle goes to the leader at `time` (withValueAt, or withKeyAt / withoutKeyAt for key), the leader's keys go to
 * every member through keysFor; without keys every member gets the plain angle and no keys. ONE setBends call.
 * history: pushHistory unless opts.skipHistory, then every write with skipHistory. null when fewer than two clips can bend.
 */
export function bendTogether(ids: readonly string[], change: BendChange, time: number, opts: ActionOpts): BendResult | null {
  const st = useEditor.getState();
  const p0 = st.project;
  if (!p0) return null;
  const { clips: targets } = bendTargets(p0, ids);
  if (targets.length < 2) return null;
  if (!opts.skipHistory) st.pushHistory();
  // a group that already holds exactly these clips (plus clips that can not bend) stays as it is
  const targetIds = new Set(targets.map((c) => c.id));
  const g0 = targets[0]!.group;
  const keepGroup =
    !!g0 &&
    targets.every((c) => c.group === g0) &&
    bendTargets(
      p0,
      p0.clips.filter((c) => c.group === g0 && !targetIds.has(c.id)).map((c) => c.id),
    ).clips.length === 0;
  const group = keepGroup
    ? null
    : st.groupClips(
        targets.map((c) => c.id),
        SKIP,
      );
  const p = useEditor.getState().project!;
  const clips = bendTargets(p, ids).clips;
  const lead = clips[0]!;
  const members = bendMembers(p, clips, time);
  const state = bendState(members, clips, time);
  const along: BendAlong = change.along ?? (lead.bend?.along === 'height' ? 'height' : 'width');
  // an angle change alone never refits, unless these clips get bent as one for the first time
  const refit = change.along !== undefined || change.middle !== undefined || !!change.fit || !(lead.bend?.span! > 0) || group !== null;
  const fit = refit ? fitBend(members, along, change.middle ?? state.middle) : null;
  const { angle, keys } = applyAngle(lead, change, time, p.fps);
  // keys: undefined = the leader keeps the keys it has, null = none
  const leadKeys = keys === undefined ? (lead.keyframes?.['bend.angle'] ?? []) : (keys ?? []);
  // without a refit a member keeps its own span (split text pieces at the edge have a longer one): its angle goes by its world length over the leader's, so every member stays on one tube
  const kOf = new Map(members.map((m) => [m.id, m.k]));
  const leadLen = (lead.bend?.span ?? 0) * (kOf.get(lead.id) ?? 1);
  const writes: BendWrite[] = clips.map((c) => {
    const f = fit?.per.get(c.id);
    const keep = c.bend;
    const own = (keep?.span ?? 0) * (kOf.get(c.id) ?? 1);
    const r = leadKeys.length === 0 && leadLen > 0 && own > 0 ? own / leadLen : 1;
    const bend = f
      ? bendOf(angle, f.along, f.center, f.span)
      : bendOf(angle * r, keep?.along === 'height' ? 'height' : 'width', keep?.center, keep?.span);
    return { id: c.id, bend, keys: leadKeys.length > 0 ? keysFor(leadKeys, lead.start, c.start) : null };
  });
  st.setBends(writes, SKIP);
  const bent = clips.map((c) => c.id);
  const gid = useEditor.getState().project?.clips.find((c) => c.id === lead.id)?.group ?? group ?? null;
  return {
    bent,
    skipped: skippedOf(p, ids, bent),
    group: gid,
    onePlane: fit ? fit.onePlane : state.onePlane,
    along,
    angle,
  };
}

/** bend every clip around its own middle: center and span dropped, the angle (and key) per clip at `time`. one undo step */
export function bendEach(ids: readonly string[], change: BendChange, time: number, opts: ActionOpts): BendResult | null {
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return null;
  const { clips } = bendTargets(p, ids);
  if (clips.length === 0) return null;
  if (!opts.skipHistory) st.pushHistory();
  let angle = 0;
  let along: BendAlong = change.along ?? 'width';
  const writes: BendWrite[] = clips.map((c, i) => {
    const a = applyAngle(c, change, time, p.fps);
    const own: BendAlong = change.along ?? (c.bend?.along === 'height' ? 'height' : 'width');
    if (i === 0) {
      angle = a.angle;
      along = own;
    }
    return { id: c.id, bend: bendOf(a.angle, own, undefined, undefined), keys: a.keys };
  });
  st.setBends(writes, SKIP);
  const bent = clips.map((c) => c.id);
  return { bent, skipped: skippedOf(p, ids, bent), group: null, onePlane: true, along, angle };
}

const sameKeyList = (a: readonly Keyframe[], b: readonly Keyframe[]): boolean =>
  a.length === b.length && a.every((k, i) => Math.abs(k.t - b[i]!.t) <= KEY_EPS && Math.abs(k.v - b[i]!.v) <= 1e-9 && k.ease === b[i]!.ease);

/** give every clip the leader's bend.angle keys (keysFor). one undo step. answers how many clips changed */
export function matchBendKeys(ids: readonly string[], opts: ActionOpts): number {
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return 0;
  const { clips } = bendTargets(p, ids);
  const lead = clips[0];
  if (!lead) return 0;
  const leadKeys = lead.keyframes?.['bend.angle'] ?? [];
  const writes: BendWrite[] = [];
  for (const c of clips.slice(1)) {
    const have = c.keyframes?.['bend.angle'] ?? [];
    const want = keysFor(leadKeys, lead.start, c.start);
    if (sameKeyList(have, want)) continue;
    writes.push({ id: c.id, bend: c.bend ?? { angle: 0 }, keys: want.length > 0 ? want : null });
  }
  if (writes.length === 0) return 0;
  if (!opts.skipHistory) st.pushHistory();
  st.setBends(writes, SKIP);
  return writes.length;
}

/** the other clips bent together with this one: same group, a span set, on an unlocked track, in project order */
export function bendMates(project: Project, clip: VisualClip): VisualClip[] {
  const g = clip.group;
  // a clip that left the shared bend (no span) has no mates
  if (!g || !(typeof clip.bend?.span === 'number' && clip.bend.span > 0)) return [];
  return project.clips.filter((c): c is VisualClip => isVisualClip(c) && c.id !== clip.id && c.group === g && !isLocked(project, c.trackId) && !!c.bend && typeof c.bend.span === 'number' && c.bend.span > 0);
}

/** leave the shared bend: angle (and every key value) times own / span, center and span dropped. it keeps how much it bends, round its own middle */
export function bendAlone(id: string, time: number, opts: ActionOpts): boolean {
  const st = useEditor.getState();
  const p = st.project;
  const c = p?.clips.find((x) => x.id === id);
  if (!p || !c || !isVisualClip(c) || isLocked(p, c.trackId) || isSolid(c)) return false;
  const span = c.bend?.span;
  if (!c.bend || typeof span !== 'number' || !(span > 0)) return false;
  const box = getClipBox(p, resolveShown(c, Math.min(Math.max(time, c.start), c.start + c.duration)));
  const own = c.bend.along === 'height' ? box.height : box.width;
  const ratio = own / span;
  const keys = c.keyframes?.['bend.angle'];
  if (!opts.skipHistory) st.pushHistory();
  st.setBends(
    [
      {
        id,
        bend: bendOf(c.bend.angle * ratio, c.bend.along === 'height' ? 'height' : 'width', undefined, undefined),
        keys: keys && keys.length > 0 ? keys.map((k) => ({ ...k, v: k.v * ratio })) : undefined,
      },
    ],
    SKIP,
  );
  return true;
}

/** take the bend off: bend null and the bend.angle keys removed, for every bent clip of ids. one undo step. answers how many */
export function flattenBends(ids: readonly string[], opts: ActionOpts): number {
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return 0;
  const want = new Set(ids);
  const writes: BendWrite[] = [];
  for (const c of p.clips) {
    if (!want.has(c.id) || !isVisualClip(c) || isLocked(p, c.trackId)) continue;
    if (!c.bend && (c.keyframes?.['bend.angle']?.length ?? 0) === 0) continue;
    writes.push({ id: c.id, bend: null, keys: null });
  }
  if (writes.length === 0) return 0;
  if (!opts.skipHistory) st.pushHistory();
  st.setBends(writes, SKIP);
  return writes.length;
}
