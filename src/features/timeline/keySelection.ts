/** the selected keyframes of the keyframe panel: pure helpers on a project and a list of key refs */
import type { Clip, Project } from '../../types';
import type { KeyRef } from '../../store/ui';

/** two refs name the same key when their times are this close (clip-local seconds) */
export const KEY_REF_EPS = 1e-4;

/** the id of one value of one clip: a line of the keyframe panel and the graph */
export const laneId = (clipId: string, prop: string) => `${clipId}\u0000${prop}`;

/** clips that exist, on a track that exists and is not locked */
function usableClips(p: Project): Map<string, Clip> {
  const locked = new Set(p.tracks.filter((t) => t.locked).map((t) => t.id));
  const tracks = new Set(p.tracks.map((t) => t.id));
  const out = new Map<string, Clip>();
  for (const c of p.clips) if (tracks.has(c.trackId) && !locked.has(c.trackId)) out.set(c.id, c);
  return out;
}

const inside = (clip: Clip, t: number) => t >= -KEY_REF_EPS && t <= clip.duration + KEY_REF_EPS;

/** the selection, unlocked, by track index, start, id */
export function shownKeyClips(p: Project, selection: readonly string[]): Clip[] {
  const usable = usableClips(p);
  const order = new Map(p.tracks.map((t, i) => [t.id, i]));
  const ids = new Set(selection);
  const out: Clip[] = [];
  for (const [id, c] of usable) if (ids.has(id)) out.push(c);
  return out.sort((a, b) => (order.get(a.trackId)! - order.get(b.trackId)!) || a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** index of the key a ref names (binary search, KEY_REF_EPS), -1 when gone or outside 0..duration */
export function refIndex(clip: Clip, ref: KeyRef): number {
  const keys = clip.keyframes?.[ref.prop];
  if (!keys || keys.length === 0) return -1;
  let lo = 0;
  let hi = keys.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]!.t < ref.t) lo = mid + 1;
    else hi = mid;
  }
  // the nearest is lo or the one before it
  let best = lo;
  if (lo > 0 && Math.abs(keys[lo - 1]!.t - ref.t) < Math.abs(keys[lo]!.t - ref.t)) best = lo - 1;
  const k = keys[best]!;
  if (Math.abs(k.t - ref.t) > KEY_REF_EPS || !inside(clip, k.t)) return -1;
  return best;
}

/** refs that still name a key of a shown, unlocked clip; the same array when nothing is dropped */
export function liveKeySel(p: Project, sel: readonly KeyRef[], shown?: ReadonlySet<string>): KeyRef[] {
  const usable = usableClips(p);
  const live = sel.filter((r) => {
    const c = usable.get(r.clipId);
    return c !== undefined && (shown === undefined || shown.has(r.clipId)) && refIndex(c, r) >= 0;
  });
  return live.length === sel.length ? (sel as KeyRef[]) : live;
}

/** every inside key of the clips, in ids order (usable clips only). the refs carry the stored time */
export function allKeyRefs(p: Project, ids: readonly string[]): KeyRef[] {
  const usable = usableClips(p);
  const out: KeyRef[] = [];
  for (const id of ids) {
    const c = usable.get(id);
    if (!c?.keyframes) continue;
    for (const [prop, keys] of Object.entries(c.keyframes)) for (const k of keys) if (inside(c, k.t)) out.push({ clipId: id, prop, t: k.t });
  }
  return out;
}

/** the inside keys that sit at a timeline time, within tol seconds */
export function keyRefsAt(p: Project, ids: readonly string[], time: number, tol: number): KeyRef[] {
  const usable = usableClips(p);
  return allKeyRefs(p, ids).filter((r) => Math.abs(r.t - (time - usable.get(r.clipId)!.start)) <= tol);
}

export type PickMode = 'replace' | 'add' | 'toggle';

/** the same key in a selection, within KEY_REF_EPS */
export function hasRef(sel: readonly KeyRef[], r: KeyRef): boolean {
  return sel.some((s) => s.clipId === r.clipId && s.prop === r.prop && Math.abs(s.t - r.t) <= KEY_REF_EPS);
}

/** the selection after a pick. toggle: all of refs selected ? they go : the missing come. always a new array */
export function pickKeys(sel: readonly KeyRef[], refs: readonly KeyRef[], mode: PickMode): KeyRef[] {
  if (mode === 'replace') return [...refs];
  if (mode === 'add') return [...sel, ...refs.filter((r) => !hasRef(sel, r))];
  if (refs.every((r) => hasRef(sel, r))) return sel.filter((s) => !hasRef(refs, s));
  return [...sel, ...refs.filter((r) => !hasRef(sel, r))];
}

/** the selected times of each value, sorted, by laneId */
export function selByLane(sel: readonly KeyRef[]): Map<string, Float64Array> {
  const lists = new Map<string, number[]>();
  for (const r of sel) {
    const id = laneId(r.clipId, r.prop);
    const l = lists.get(id);
    if (l) l.push(r.t);
    else lists.set(id, [r.t]);
  }
  const out = new Map<string, Float64Array>();
  for (const [id, l] of lists) out.set(id, Float64Array.from(l).sort());
  return out;
}

const remembered = new WeakMap<readonly Clip[], KeyRef[]>();
/** the key selection of a project state, found again when undo brings that state back */
export function rememberKeySel(clips: readonly Clip[], sel: readonly KeyRef[]): void {
  remembered.set(clips, [...sel]);
}
export function keySelFor(clips: readonly Clip[]): KeyRef[] | undefined {
  return remembered.get(clips);
}
