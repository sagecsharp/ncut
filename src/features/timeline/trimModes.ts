/**
 * trim modes as pure plans: ripple, move the edit, slip, slide, stretch. a plan is a list of ops that
 * applyTrimPlan runs in one step (shrinking trims and speeds, one move, growing trims and speeds).
 * pure: only type imports from the stores, never reasons, shortcuts or the dom.
 */
import { MAX_SPEED, MIN_CLIP_DURATION, MIN_SPEED, isTimedClip, isVisualClip } from '../../types';
import type { Clip, Project } from '../../types';
import type { ClipMove, TrimOp } from '../../store/editorStore';
import type { TrimEdge } from '../../store/ui';
import { clamp } from '../../lib/time';
import { clipEnd, maxClipDuration, rangesOverlap } from '../../lib/timelineOps';
import { CUT_EPS } from '../../lib/transitions';
import { findFollowers, placeFollowers } from './effectFollow';
import type { ClipSpan } from './effectFollow';
import { planSyncShift, syncShiftMoves } from './syncShift';

export type P = Pick<Project, 'clips' | 'tracks' | 'assets'>;
export type Edge = 'start' | 'end';
export type TrimMode = 'ripple' | 'move-edit' | 'slip' | 'slide' | 'stretch';
export type TrimStopWhy = 'min-length' | 'media-start' | 'media-end' | 'overlap' | 'timeline-start'
  | 'speed-fast' | 'speed-slow' | 'needs-media' | 'no-edit' | 'locked';
export interface TrimStop { why: TrimStopWhy; clipId: string; otherId?: string } // otherId: what it would run into
export interface TrimPlan {
  mode: TrimMode; ops: TrimOp[];
  delta: number;          // used, r6 rounded. timeline s; slip: media s, + = later media
  stop: TrimStop | null;  // set exactly when the plan does less than asked
  moved: string[];        // ids the sync rule shifted
  lockedBehind: string[]; // locked track ids with a clip at or after the edit point
  freeBehind?: string[];  // unlocked sync lock off track ids that keep a clip at or after the edit point
  drift?: string[];       // clips that go out of sync: a pair in sync where one moves and its mate stays
  speed?: number;         // stretch: the grabbed clip's new speed
  trimStart?: number;     // slip: the grabbed clip's new trimStart
  key: string;            // `${mode}:${r6(delta)}`
}
export interface EditAt { clipId: string; edge: Edge; otherId?: string } // otherId: the clip across a touching edit

/** the clip before c on its track: the largest end at or before c's start. a tie goes to the first in project order */
export function prevOn(p: P, c: Clip): Clip | null {
  let best: Clip | null = null;
  for (const x of p.clips) {
    if (x.trackId !== c.trackId || x.id === c.id || clipEnd(x) > c.start + 1e-6) continue;
    if (!best || clipEnd(x) > clipEnd(best)) best = x;
  }
  return best;
}

/** the clip after c on its track: the smallest start at or after c's end. a tie goes to the first in project order */
export function nextOn(p: P, c: Clip): Clip | null {
  let best: Clip | null = null;
  for (const x of p.clips) {
    if (x.trackId !== c.trackId || x.id === c.id || x.start < clipEnd(c) - 1e-6) continue;
    if (!best || x.start < best.start) best = x;
  }
  return best;
}

/** the clip before c when there is no gap between them */
export function touchingBefore(p: P, c: Clip): Clip | null {
  const l = prevOn(p, c);
  return l && c.start - clipEnd(l) <= CUT_EPS ? l : null;
}

/** the clip after c when there is no gap between them */
export function touchingAfter(p: P, c: Clip): Clip | null {
  const r = nextOn(p, c);
  return r && r.start - clipEnd(c) <= CUT_EPS ? r : null;
}

/** id first, then the clips that share its group in project order. [id] for a missing or ungrouped clip */
export function groupPool(p: P, id: string): string[] {
  const c = p.clips.find((x) => x.id === id);
  if (!c || !c.group) return [id];
  return [id, ...p.clips.filter((x) => x.group === c.group && x.id !== id).map((x) => x.id)];
}

/** the first selected clip on an existing unlocked track, in track order then by start. timed: video or audio only */
export function selectedTrimClip(p: P, selection: readonly string[], timed = false): Clip | null {
  const sel = new Set(selection);
  const order = new Map<string, number>();
  p.tracks.forEach((t, i) => { if (!t.locked) order.set(t.id, i); });
  const list = p.clips.filter((c) => sel.has(c.id) && order.has(c.trackId) && (!timed || isTimedClip(c)));
  list.sort((a, b) => order.get(a.trackId)! - order.get(b.trackId)! || a.start - b.start);
  return list[0] ?? null;
}

export function emptyPlan(mode: TrimMode, stop: TrimStop | null = null, lockedBehind: string[] = []): TrimPlan {
  return { mode, ops: [], delta: 0, stop, moved: [], lockedBehind, key: mode + ':0' };
}


// shared rules of the planners (trim 3.3). private

const MIN = MIN_CLIP_DURATION;
const EMPTY: ReadonlySet<string> = new Set();

/** seconds rounded to 6 places, never -0 */
function r6(n: number): number {
  return Math.round(n * 1e6) / 1e6 + 0;
}

function stopOf(why: TrimStopWhy, clipId: string, otherId?: string): TrimStop {
  return otherId === undefined ? { why, clipId } : { why, clipId, otherId };
}

function clipMap(p: P): Map<string, Clip> {
  const m = new Map<string, Clip>();
  for (const c of p.clips) m.set(c.id, c);
  return m;
}

function edgeAt(c: Clip, edge: Edge): number {
  return edge === 'end' ? clipEnd(c) : c.start;
}

function trackLocked(p: P, c: Clip): boolean {
  for (const t of p.tracks) if (t.id === c.trackId) return t.locked;
  return false;
}

function mediaLength(p: P, c: Clip): number | undefined {
  if (!isTimedClip(c)) return undefined;
  for (const a of p.assets) if (a.id === c.assetId) return a.duration;
  return undefined;
}

/** timeline seconds a clip can still grow to the left: its media before the first frame */
function headRoom(c: Clip): number {
  return isTimedClip(c) ? c.trimStart / c.speed : Infinity;
}

/** timeline seconds a clip can still grow to the right: its media after the last frame */
function tailRoom(p: P, c: Clip): number {
  return maxClipDuration(c, mediaLength(p, c)) - c.duration;
}

/** the ids of the effect clips that follow their target (findFollowers is the rule) */
function followerIds(p: P): Set<string> {
  const targets: string[] = [];
  for (const c of p.clips) if (c.type === 'effect' && c.target) targets.push(c.target);
  if (targets.length === 0) return new Set();
  return new Set(findFollowers(p.clips, p.tracks, targets).map((e) => e.id));
}

/** how far an ask may go, with the stop of the tightest limit on each side */
interface Lim { lo: number; hi: number; loStop: TrimStop | null; hiStop: TrimStop | null }

function newLim(): Lim {
  return { lo: -Infinity, hi: Infinity, loStop: null, hiStop: null };
}

function atLeast(l: Lim, v: number, stop: TrimStop): void {
  if (v > l.lo) { l.lo = v; l.loStop = stop; }
}

function atMost(l: Lim, v: number, stop: TrimStop): void {
  if (v < l.hi) { l.hi = v; l.hiStop = stop; }
}

/**
 * a clip that is already past a limit may not get worse but never jumps: the bounds always hold 0. an ask that falls short of
 * where the limit is back in reach (the store would snap the edge to it) does nothing and says why
 */
function fit(l: Lim, asked: number): { d: number; stop: TrimStop | null } {
  if (Math.abs(asked) < 1e-9) return { d: 0, stop: null };
  const lo = Math.min(0, l.lo);
  const hi = Math.max(0, l.hi);
  // nothing in range lands back inside the other limit: the store would snap the edge, so the ask does nothing
  if (l.hi < -1e-6 && lo > l.hi + 1e-6) return { d: 0, stop: l.loStop };
  if (l.lo > 1e-6 && hi < l.lo - 1e-6) return { d: 0, stop: l.hiStop };
  const d = Math.min(hi, Math.max(lo, asked));
  if (l.hi < -1e-6 && d > l.hi + 1e-6) return { d: 0, stop: l.hiStop };
  if (l.lo > 1e-6 && d < l.lo - 1e-6) return { d: 0, stop: l.loStop };
  if (asked < lo - 1e-6) return { d, stop: l.loStop };
  if (asked > hi + 1e-6) return { d, stop: l.hiStop };
  return { d, stop: null };
}

/** a clip that cannot be edited now: on a locked track, or (timed) without media */
function guard(p: P, c: Clip, timed: boolean): TrimStop | null {
  if (trackLocked(p, c)) return stopOf('locked', c.id);
  if (timed && !isTimedClip(c)) return stopOf('needs-media', c.id);
  return null;
}

function edgeBounds(p: P, c: Clip, edge: Edge, l: Lim): void {
  if (edge === 'end') {
    atLeast(l, MIN - c.duration, stopOf('min-length', c.id));
    atMost(l, tailRoom(p, c), stopOf('media-end', c.id));
  } else {
    atMost(l, c.duration - MIN, stopOf('min-length', c.id));
    atLeast(l, -headRoom(c), stopOf('media-start', c.id));
  }
}

/** what is in the way of a clip's edge when no neighbour is trimmed along (modes other than ripple) */
function sideBounds(p: P, c: Clip, edge: Edge, l: Lim): void {
  if (edge === 'end') {
    const n = nextOn(p, c);
    if (n) atMost(l, n.start - clipEnd(c), stopOf('overlap', c.id, n.id));
    return;
  }
  const v = prevOn(p, c);
  if (v) atLeast(l, clipEnd(v) - c.start, stopOf('overlap', c.id, v.id));
  else atLeast(l, -c.start, stopOf('timeline-start', c.id));
}

/** g first, then the pool clips that pass ok on a track nothing else uses, never on a locked track */
function onePerTrack(p: P, byId: ReadonlyMap<string, Clip>, g: Clip, pool: readonly string[], ok: (c: Clip) => boolean): Clip[] {
  const out = [g];
  if (pool.length === 0) return out;
  const used = new Set([g.trackId]);
  for (const id of pool) {
    const c = byId.get(id);
    if (!c || used.has(c.trackId) || trackLocked(p, c) || !ok(c)) continue;
    used.add(c.trackId);
    out.push(c);
  }
  return out;
}

/** the three phases: a shrinking trims and speeds, b one move, c growing trims and speeds */
interface Phases { a: TrimOp[]; b: ClipMove[]; c: TrimOp[] }

function newPhases(): Phases {
  return { a: [], b: [], c: [] };
}

function phased(ph: Phases): TrimOp[] {
  return [...ph.a, ...(ph.b.length > 0 ? [{ kind: 'move' as const, moves: ph.b }] : []), ...ph.c];
}

/** does moving the edge to this time make the clip shorter */
function shrinks(c: Clip, edge: Edge, time: number): boolean {
  return edge === 'end' ? time < clipEnd(c) : time > c.start;
}

/** an edge trim into the phase its target decides, never the delta's sign. an edge that is there already adds nothing */
function addTrim(ph: Phases, c: Clip, edge: Edge, time: number): void {
  if (Math.abs(edgeAt(c, edge) - time) < 1e-9) return;
  (shrinks(c, edge, time) ? ph.a : ph.c).push({ kind: 'trim', id: c.id, edge, time });
}

interface Span { trackId: string; start: number; end: number }

/** the places of the clips the ops touch, if the ops landed (finish uses it, runTrimOps is the proof) */
function simulate(byId: ReadonlyMap<string, Clip>, ops: readonly TrimOp[]): Map<string, Span> {
  const out = new Map<string, Span>();
  const speeds = new Map<string, number>();
  const get = (id: string): Span | null => {
    let s = out.get(id);
    if (!s) {
      const c = byId.get(id);
      if (!c) return null;
      s = { trackId: c.trackId, start: c.start, end: clipEnd(c) };
      out.set(id, s);
    }
    return s;
  };
  for (const op of ops) {
    if (op.kind === 'move') {
      for (const m of op.moves) {
        const s = get(m.id);
        if (!s) continue;
        const len = s.end - s.start;
        s.trackId = m.trackId;
        s.start = m.start;
        s.end = m.start + len;
      }
    } else if (op.kind === 'trim') {
      const s = get(op.id);
      if (!s) continue;
      if (op.edge === 'end') s.end = op.time;
      else s.start = op.time;
    } else if (op.kind === 'speed') {
      const s = get(op.id);
      const c = byId.get(op.id);
      if (!s || !c || !isTimedClip(c)) continue;
      const was = speeds.get(op.id) ?? c.speed;
      const now = clamp(op.speed, MIN_SPEED, MAX_SPEED);
      s.end = s.start + ((s.end - s.start) * was) / now;
      speeds.set(op.id, now);
    }
  }
  return out;
}

/** the spans of the clips the ops touch, as runTrimOps would leave them */
export function simulateOps(p: P, ops: readonly TrimOp[]): Map<string, { trackId: string; start: number; end: number }> {
  return simulate(clipMap(p), ops);
}

/** the effects that follow a changed clip take its new span when their track has room, else they stay (like a drag today) */
function followOps(p: P, byId: ReadonlyMap<string, Clip>, ph: Phases): void {
  const spans = simulate(byId, phased(ph));
  if (spans.size === 0) return;
  const ids = [...spans.keys()];
  const followers = findFollowers(p.clips, p.tracks, ids, new Set(ids));
  if (followers.length === 0) return;
  const changes = new Map<string, ClipSpan>();
  for (const [id, s] of spans) {
    const c = byId.get(id)!;
    if (!isVisualClip(c)) continue;
    if (Math.abs(s.start - c.start) < 1e-9 && Math.abs(s.end - clipEnd(c)) < 1e-9 && s.trackId === c.trackId) continue;
    changes.set(id, { start: s.start, duration: s.end - s.start, trackId: s.trackId });
  }
  for (const r of placeFollowers(p.clips, followers, changes)) {
    const f = byId.get(r.id)!;
    const end = r.start + r.duration;
    const startMoved = Math.abs(r.start - f.start) >= 1e-9;
    const endMoved = Math.abs(end - clipEnd(f)) >= 1e-9;
    if (!startMoved && !endMoved) continue;
    if (Math.abs(r.duration - f.duration) < 1e-9) {
      ph.b.push({ id: f.id, trackId: f.trackId, start: r.start });
    } else {
      if (startMoved) addTrim(ph, f, 'start', r.start);
      if (endMoved) addTrim(ph, f, 'end', end);
    }
  }
}

/** simulate the ops, refuse what would start before 0 or overlap, else the plan */
function finish(p: P, byId: ReadonlyMap<string, Clip>, mode: TrimMode, ops: TrimOp[], d: number, stop: TrimStop | null, x: Partial<Pick<TrimPlan, 'moved' | 'lockedBehind' | 'freeBehind' | 'drift' | 'speed' | 'trimStart'>> = {}): TrimPlan {
  const lockedBehind = x.lockedBehind ?? [];
  const spans = simulate(byId, ops);
  const tracks = new Set<string>();
  for (const [id, s] of spans) {
    if (s.start < -1e-6) return emptyPlan(mode, stopOf('timeline-start', id), lockedBehind);
    tracks.add(s.trackId);
    tracks.add(byId.get(id)!.trackId);
  }
  if (tracks.size > 0) {
    const by = new Map<string, { id: string; start: number; end: number }[]>();
    for (const c of p.clips) {
      const s = spans.get(c.id);
      const t = s ? s.trackId : c.trackId;
      if (!tracks.has(t)) continue;
      let list = by.get(t);
      if (!list) by.set(t, (list = []));
      list.push({ id: c.id, start: s ? s.start : c.start, end: s ? s.end : clipEnd(c) });
    }
    for (const list of by.values()) {
      list.sort((a, b) => a.start - b.start);
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1]!;
        const b = list[i]!;
        if (!rangesOverlap(a.start, a.end, b.start, b.end)) continue;
        return emptyPlan(mode, spans.has(b.id) ? stopOf('overlap', b.id, a.id) : stopOf('overlap', a.id, b.id), lockedBehind);
      }
    }
  }
  const delta = r6(d);
  const plan: TrimPlan = { mode, ops, delta, stop, moved: x.moved ?? [], lockedBehind, key: `${mode}:${delta}` };
  if (x.freeBehind && x.freeBehind.length > 0) plan.freeBehind = x.freeBehind;
  if (x.drift && x.drift.length > 0) plan.drift = x.drift;
  if (x.speed !== undefined) plan.speed = x.speed;
  if (x.trimStart !== undefined) plan.trimStart = x.trimStart;
  return plan;
}

// the planners

/**
 * ripple trim: an edge moves by `asked` (+ = right) and what follows on every unlocked track moves with it, so no gap opens.
 * heads: the grabbed clip, its pool clips with the same edge (one per track) and the effects that follow them
 */
export function planRipple(p: P, clipId: string, edge: Edge, asked: number, pool: readonly string[] = []): TrimPlan {
  const byId = clipMap(p);
  const g = byId.get(clipId);
  if (!g) return emptyPlan('ripple');
  const bad = guard(p, g, false);
  if (bad) return emptyPlan('ripple', bad);
  if (!Number.isFinite(asked)) return emptyPlan('ripple');
  const end = edge === 'end';
  const at = edgeAt(g, edge);
  const fol = pool.length > 0 ? followerIds(p) : EMPTY;
  const heads = onePerTrack(p, byId, g, pool, (x) => !fol.has(x.id) && Math.abs(edgeAt(x, edge) - at) <= CUT_EPS);
  const headIds = new Set(heads.map((h) => h.id));
  const edited = [...heads, ...findFollowers(p.clips, p.tracks, headIds, headIds)];
  const editedIds = new Set<string>();
  const editedTracks = new Set<string>();
  const atOf = new Map<string, number>();
  for (const c of edited) {
    editedIds.add(c.id);
    editedTracks.add(c.trackId);
    atOf.set(c.trackId, edgeAt(c, edge));
  }
  const shift = planSyncShift(p, at, editedIds, editedTracks, atOf);
  const lim = newLim();
  for (const c of edited) edgeBounds(p, c, edge, lim);
  if (shift.first && shift.room !== Infinity) {
    const why = shift.stay ? stopOf('overlap', shift.first.id, shift.stay.id) : stopOf('timeline-start', shift.first.id);
    if (end) atLeast(lim, -shift.room, why);
    else atMost(lim, shift.room, why);
  }
  const { d, stop } = fit(lim, asked);
  if (Math.abs(d) < 1e-9) return emptyPlan('ripple', stop, shift.lockedBehind);
  const grow = end ? d : -d;
  const shifted = syncShiftMoves(shift, grow);
  const ph = newPhases();
  ph.b.push(...shifted);
  for (const c of edited) {
    if (end) addTrim(ph, c, 'end', clipEnd(c) + grow);
    else if (d > 0) {
      // the head loses its front, then goes back to where it started: its keys stay with the picture
      ph.a.push({ kind: 'trim', id: c.id, edge: 'start', time: c.start + d });
      ph.b.push({ id: c.id, trackId: c.trackId, start: c.start });
    } else {
      ph.b.push({ id: c.id, trackId: c.trackId, start: c.start + grow });
      ph.c.push({ kind: 'trim', id: c.id, edge: 'start', time: c.start });
    }
  }
  return finish(p, byId, 'ripple', phased(ph), d, stop, { moved: shifted.map((m) => m.id), lockedBehind: shift.lockedBehind, freeBehind: shift.freeBehind, drift: shift.drift });
}

/** move the edit between left and the clip touching it: one gets longer, the other shorter, nothing else moves. asked: + = right */
export function planMoveEdit(p: P, leftId: string, rightId: string, asked: number, pool: readonly string[] = []): TrimPlan {
  const byId = clipMap(p);
  const l = byId.get(leftId);
  const r = byId.get(rightId);
  if (!l || !r) return emptyPlan('move-edit');
  const touch = touchingAfter(p, l);
  if (!touch || touch.id !== r.id) return emptyPlan('move-edit', stopOf('no-edit', l.id));
  for (const c of [l, r]) {
    const bad = guard(p, c, false);
    if (bad) return emptyPlan('move-edit', bad);
  }
  if (!Number.isFinite(asked)) return emptyPlan('move-edit');
  const at = r.start;
  const pairs: { l: Clip; r: Clip }[] = [{ l, r }];
  if (pool.length > 0) {
    const fol = followerIds(p);
    const used = new Set([l.trackId]);
    for (const id of pool) {
      const x = byId.get(id);
      if (!x || used.has(x.trackId) || trackLocked(p, x) || fol.has(x.id)) continue;
      let pair: { l: Clip; r: Clip } | null = null;
      if (Math.abs(clipEnd(x) - at) <= CUT_EPS) {
        const n = touchingAfter(p, x);
        if (n && !fol.has(n.id)) pair = { l: x, r: n };
      }
      if (!pair && Math.abs(x.start - at) <= CUT_EPS) {
        const b = touchingBefore(p, x);
        if (b && !fol.has(b.id)) pair = { l: b, r: x };
      }
      if (!pair) continue;
      used.add(x.trackId);
      pairs.push(pair);
    }
  }
  const lim = newLim();
  for (const q of pairs) {
    atLeast(lim, q.l.start + MIN - q.r.start, stopOf('min-length', q.l.id));
    atMost(lim, q.l.start + maxClipDuration(q.l, mediaLength(p, q.l)) - q.r.start, stopOf('media-end', q.l.id));
    atLeast(lim, -headRoom(q.r), stopOf('media-start', q.r.id));
    atMost(lim, clipEnd(q.r) - MIN - q.r.start, stopOf('min-length', q.r.id));
  }
  const { d, stop } = fit(lim, asked);
  if (Math.abs(d) < 1e-9) return emptyPlan('move-edit', stop);
  const ph = newPhases();
  for (const q of pairs) {
    addTrim(ph, q.r, 'start', q.r.start + d);
    addTrim(ph, q.l, 'end', q.r.start + d);
  }
  followOps(p, byId, ph);
  return finish(p, byId, 'move-edit', phased(ph), d, stop);
}

/** slip: another part of the media in the same place and length. sourceDelta in media seconds, + = later media */
export function planSlip(p: P, clipId: string, sourceDelta: number, pool: readonly string[] = []): TrimPlan {
  const byId = clipMap(p);
  const g = byId.get(clipId);
  if (!g) return emptyPlan('slip');
  const bad = guard(p, g, true);
  if (bad) return emptyPlan('slip', bad);
  if (!isTimedClip(g) || !Number.isFinite(sourceDelta)) return emptyPlan('slip');
  const mates = onePerTrack(p, byId, g, pool, (x) => isTimedClip(x) && x.assetId === g.assetId && Math.abs(x.speed - g.speed) < 1e-9 && rangesOverlap(x.start, clipEnd(x), g.start, clipEnd(g)));
  const lim = newLim();
  for (const c of mates) {
    if (!isTimedClip(c)) continue;
    atLeast(lim, -c.trimStart, stopOf('media-start', c.id));
    const len = mediaLength(p, c);
    if (len !== undefined && len > 0) atMost(lim, Math.max(0, len - c.duration * c.speed - c.trimStart), stopOf('media-end', c.id));
  }
  const { d, stop } = fit(lim, sourceDelta);
  if (Math.abs(d) < 1e-9) return emptyPlan('slip', stop);
  const ops: TrimOp[] = [];
  for (const c of mates) if (isTimedClip(c)) ops.push({ kind: 'slip', id: c.id, trimStart: c.trimStart + d });
  return finish(p, byId, 'slip', ops, d, stop, { trimStart: g.trimStart + d });
}

/** slide: the clip moves by `asked` and its neighbours trim to stay touching. partners have the same span */
export function planSlide(p: P, clipId: string, asked: number, pool: readonly string[] = []): TrimPlan {
  const byId = clipMap(p);
  const g = byId.get(clipId);
  if (!g) return emptyPlan('slide');
  const bad = guard(p, g, false);
  if (bad) return emptyPlan('slide', bad);
  if (!Number.isFinite(asked)) return emptyPlan('slide');
  const fol = pool.length > 0 ? followerIds(p) : EMPTY;
  const mates = onePerTrack(p, byId, g, pool, (x) => !fol.has(x.id) && Math.abs(x.start - g.start) < 1e-6 && Math.abs(x.duration - g.duration) < 1e-6);
  const lim = newLim();
  const sides = mates.map((c) => ({ c, l: touchingBefore(p, c), r: touchingAfter(p, c) }));
  for (const { c, l, r } of sides) {
    if (l) {
      atLeast(lim, l.start + MIN - c.start, stopOf('min-length', l.id));
      atMost(lim, l.start + maxClipDuration(l, mediaLength(p, l)) - c.start, stopOf('media-end', l.id));
    } else sideBounds(p, c, 'start', lim);
    if (r) {
      atMost(lim, clipEnd(r) - MIN - clipEnd(c), stopOf('min-length', r.id));
      atLeast(lim, -headRoom(r), stopOf('media-start', r.id));
    } else sideBounds(p, c, 'end', lim);
  }
  const { d, stop } = fit(lim, asked);
  if (Math.abs(d) < 1e-9) return emptyPlan('slide', stop);
  const ph = newPhases();
  for (const { c, l, r } of sides) {
    ph.b.push({ id: c.id, trackId: c.trackId, start: c.start + d });
    if (l) addTrim(ph, l, 'end', c.start + d);
    if (r) addTrim(ph, r, 'start', clipEnd(c) + d);
  }
  followOps(p, byId, ph);
  return finish(p, byId, 'slide', phased(ph), d, stop);
}

/** stretch: an edge moves by `asked` and the speed follows, so the same media fills the new length (0.25x to 4x). partners have the same span and speed */
export function planStretch(p: P, clipId: string, edge: Edge, asked: number, pool: readonly string[] = []): TrimPlan {
  const byId = clipMap(p);
  const g = byId.get(clipId);
  if (!g) return emptyPlan('stretch');
  const bad = guard(p, g, true);
  if (bad) return emptyPlan('stretch', bad);
  if (!isTimedClip(g) || !Number.isFinite(asked)) return emptyPlan('stretch');
  const end = edge === 'end';
  const mates = onePerTrack(p, byId, g, pool, (x) => isTimedClip(x) && Math.abs(x.speed - g.speed) < 1e-9 && Math.abs(x.start - g.start) < 1e-6 && Math.abs(x.duration - g.duration) < 1e-6);
  const lim = newLim();
  for (const c of mates) {
    if (!isTimedClip(c)) continue;
    const src = c.duration * c.speed;
    const most = src / MIN_SPEED - c.duration;
    const least = Math.max(src / MAX_SPEED, MIN) - c.duration;
    const fast = stopOf(src / MAX_SPEED < MIN ? 'min-length' : 'speed-fast', c.id);
    const slow = stopOf('speed-slow', c.id);
    if (end) {
      atLeast(lim, least, fast);
      atMost(lim, most, slow);
    } else {
      atMost(lim, -least, fast);
      atLeast(lim, -most, slow);
    }
    sideBounds(p, c, edge, lim);
  }
  const { d, stop } = fit(lim, asked);
  if (Math.abs(d) < 1e-9) return emptyPlan('stretch', stop);
  const grow = end ? d : -d;
  const ph = newPhases();
  let speed = g.speed;
  for (const c of mates) {
    if (!isTimedClip(c)) continue;
    const len = c.duration + grow;
    const next = clamp((c.duration * c.speed) / len, MIN_SPEED, MAX_SPEED);
    if (c.id === g.id) speed = next;
    const op: TrimOp = { kind: 'speed', id: c.id, speed: next };
    if (end) (grow < 0 ? ph.a : ph.c).push(op);
    else if (grow > 0) {
      ph.b.push({ id: c.id, trackId: c.trackId, start: clipEnd(c) - len });
      ph.c.push(op);
    } else {
      ph.a.push(op);
      ph.b.push({ id: c.id, trackId: c.trackId, start: clipEnd(c) - len });
    }
  }
  followOps(p, byId, ph);
  return finish(p, byId, 'stretch', phased(ph), d, stop, { speed });
}

// entry points

function trackIndex(p: P): Map<string, number> {
  const m = new Map<string, number>();
  p.tracks.forEach((t, i) => m.set(t.id, i));
  return m;
}

/**
 * q (edge 'start') and w (edge 'end'): ripple trim the clip under the playhead to the playhead. the selected clips, else all.
 * leader: q the latest start, w the earliest end, ties by track order
 */
export function planRippleToPlayhead(p: P, selection: readonly string[], time: number, edge: Edge): { plan: TrimPlan | null; leader: Clip | null; reason: 'no-clip' | 'not-on-selection' | 'locked' | null; stop: TrimStop | null } {
  const sel = new Set(selection);
  const picked = sel.size > 0 ? p.clips.filter((c) => sel.has(c.id)) : [];
  const scope = picked.length > 0 ? picked : p.clips;
  const fol = followerIds(p);
  const hit = scope.filter((c) => !trackLocked(p, c) && !fol.has(c.id) && c.start + 1e-6 < time && time < clipEnd(c) - 1e-6);
  if (hit.length === 0) {
    // the playhead is on clips, but every one of them is on a locked track: say that, not that there is no clip
    const shut = scope.find((c) => trackLocked(p, c) && !fol.has(c.id) && c.start + 1e-6 < time && time < clipEnd(c) - 1e-6);
    if (shut) return { plan: null, leader: null, reason: 'locked', stop: stopOf('locked', shut.id) };
    return { plan: null, leader: null, reason: picked.length > 0 ? 'not-on-selection' : 'no-clip', stop: null };
  }
  const order = trackIndex(p);
  const at = (c: Clip): number => (edge === 'start' ? c.start : clipEnd(c));
  let leader = hit[0]!;
  for (const c of hit) {
    const better = edge === 'start' ? at(c) - at(leader) : at(leader) - at(c);
    if (better > 1e-9 || (Math.abs(better) <= 1e-9 && (order.get(c.trackId) ?? 0) < (order.get(leader.trackId) ?? 0))) leader = c;
  }
  return { plan: planRipple(p, leader.id, edge, time - at(leader), scope.map((c) => c.id)), leader, reason: null, stop: null };
}

/** the plan for a selected edge moved by `asked`: both (the edit between two clips) moves the edit, a single edge ripples. null when its clip is gone */
export function edgePlan(p: P, e: TrimEdge, asked: number, pool: readonly string[]): TrimPlan | null {
  const c = p.clips.find((x) => x.id === e.clipId);
  if (!c) return null;
  if (!e.both) return planRipple(p, e.clipId, e.edge, asked, pool);
  const r = touchingAfter(p, c);
  if (!r) return emptyPlan('move-edit', stopOf('no-edit', c.id));
  return planMoveEdit(p, c.id, r.id, asked, pool);
}

/** the clip edges within half a frame of the time, on unlocked tracks, never an effect that follows. a touching pair is one entry */
export function editsAt(p: P, time: number, fps: number, prefer: readonly string[] = []): EditAt[] {
  const tol = 0.5 / fps + 1e-9;
  const fol = followerIds(p);
  const open = new Set<string>();
  for (const t of p.tracks) if (!t.locked) open.add(t.id);
  const order = trackIndex(p);
  const near = prefer.length > 0 ? new Set(p.clips.filter((c) => prefer.includes(c.id)).map((c) => c.trackId)) : EMPTY;
  const found = new Map<string, EditAt & { dist: number; track: string }>();
  for (const c of p.clips) {
    if (!open.has(c.trackId) || fol.has(c.id)) continue;
    for (const edge of ['start', 'end'] as const) {
      const dist = Math.abs(edgeAt(c, edge) - time);
      if (dist > tol) continue;
      let at: EditAt = { clipId: c.id, edge };
      let track = c.trackId;
      if (edge === 'start') {
        const l = touchingBefore(p, c);
        if (l && !fol.has(l.id)) { at = { clipId: l.id, edge: 'end', otherId: c.id }; track = l.trackId; }
      } else {
        const r = touchingAfter(p, c);
        if (r && !fol.has(r.id)) at = { clipId: c.id, edge: 'end', otherId: r.id };
      }
      const key = at.clipId + ':' + at.edge;
      const had = found.get(key);
      if (!had || dist < had.dist) found.set(key, { ...at, dist, track });
    }
  }
  const list = [...found.values()];
  list.sort((a, b) => Number(!near.has(a.track)) - Number(!near.has(b.track)) || (order.get(a.track) ?? 0) - (order.get(b.track) ?? 0) || a.dist - b.dist);
  return list.map(({ clipId, edge, otherId }) => (otherId === undefined ? { clipId, edge } : { clipId, edge, otherId }));
}
