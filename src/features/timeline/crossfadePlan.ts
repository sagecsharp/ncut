/**
 * crossfade planners. pure: a plan is data, crossfadeActions.ts runs it through the store. a string result is a reason.
 * rooms are the real ones of lib/audioCross.ts, held to whole frames here.
 */
import type { AudioClip, Clip, Crossfade, FadeShape, Project, VideoClip } from '../../types';
import { DEFAULT_CROSSFADE } from '../../types';
import { cleanCrossfade, crossfadeRoom, hasSound, sameCrossfade, soundAfter, soundBefore } from '../../lib/audioCross';
import type { CrossShort } from '../../lib/audioCross';
import { hasSoundApart, ownSoundsOf } from '../../lib/soundPair';
import { transitionSpan } from '../../lib/transitions';
import type { ClipPatch } from '../../store/editorStore';
import type { CrossfadePick, TrimEdge } from '../../store/ui';
import type { ReasonInput } from '../shell/reasons';
import { CROSS_TEXT, crossShortText } from './crossfadeText';

export type Place = 'center' | 'start' | 'end' | 'custom';
export interface CrossEdit { fromId: string; toId: string; trackId: string; time: number }
export interface CrossChange { length?: number; place?: Exclude<Place, 'custom'>; before?: number; after?: number; shape?: FadeShape; withTransition?: boolean; remove?: true }
export interface CrossPlan {
  patches: { id: string; patch: ClipPatch }[];
  added: string[];
  removed: string[];
  changed: string[];
  short: { id: string; side: 'before' | 'after'; why: CrossShort }[];
  skipped: { id: string; why: string }[];
}
export interface CrossInput { selection: readonly string[]; trimEdge: TrimEdge | null; pick: CrossfadePick | null; time: number }
export interface CrossStop { side: 'before' | 'after'; why: CrossShort | 'shortest' }

type SoundClip = VideoClip | AudioClip;

/** the words of reasons.ts REASON_TEXT that this file needs (reasons.ts imports this file, so it cannot import them) */
const ASK = { selectClip: 'select a clip first', soundFirst: 'select a clip with sound first', trackLocked: 'the track is locked' } as const;
/** a change that would change nothing */
const SAME = 'the crossfade already is like this';
const SAME_SHAPE = 'the fade shape already is like this';

const isSound = (c: Clip | undefined): c is SoundClip => !!c && (c.type === 'video' || c.type === 'audio');
const fpsOf = (p: Project): number => p.fps || 30;
/** whole frames of a time, and the frames a room holds */
const framesOf = (sec: number, fps: number): number => Math.round(sec * fps + 1e-9);
const roomFrames = (room: number, fps: number): number => Math.floor(room * fps + 1e-6);
const lockedIds = (p: Project): Set<string> => new Set(p.tracks.filter((t) => t.locked).map((t) => t.id));
const nameOf = (p: Project, id: string): string => {
  const c = p.clips.find((x) => x.id === id);
  return c ? c.name || c.type : '';
};
const emptyPlan = (): CrossPlan => ({ patches: [], added: [], removed: [], changed: [], short: [], skipped: [] });
const storedOf = (p: Project, id: string): Crossfade | null => {
  const c = p.clips.find((x) => x.id === id);
  return isSound(c) ? cleanCrossfade(c.crossfade) : null;
};

/** the id of the picked crossfade's clip while the pick counts: the selection is the very array it was made with */
export function pickCounts(p: Project, selection: readonly string[], pick: CrossfadePick | null): string | null {
  if (pick === null || pick.selection !== selection) return null;
  const c = p.clips.find((x) => x.id === pick.clipId);
  return c && (c.type === 'video' || c.type === 'audio') && c.crossfade ? pick.clipId : null;
}

/** where a crossfade sits on its edit. sides within half a frame of each other are centered */
export function placeOf(x: Crossfade, fps: number): Place {
  if (Math.abs(x.before - x.after) < 0.5 / fps) return 'center';
  if (x.before === 0) return 'start';
  if (x.after === 0) return 'end';
  return 'custom';
}

/** the clips that carry the sound of a clip: a picture with its sound apart gives its own sound clips */
export function soundClipsOf(p: Project, c: Clip): SoundClip[] {
  if (c.type === 'audio') return [c];
  if (c.type !== 'video') return [];
  return hasSoundApart(p.clips, c.id) ? ownSoundsOf(p.clips, c) : [c];
}

/** the edit where a clip starts, without the lock check */
function editAt(p: Project, toId: string): CrossEdit | string {
  const to = p.clips.find((c) => c.id === toId);
  if (!isSound(to)) return CROSS_TEXT.crossNoEdit;
  const from = soundBefore(p, to);
  if (!from) return CROSS_TEXT.crossNoEdit;
  if (!hasSound(p, to) || !hasSound(p, from)) return hasSoundApart(p.clips, to.id) || hasSoundApart(p.clips, from.id) ? CROSS_TEXT.crossApart : CROSS_TEXT.crossNoSound;
  return { fromId: from.id, toId, trackId: to.trackId, time: to.start };
}

export function soundEditAt(p: Project, toId: string): CrossEdit | string {
  const e = editAt(p, toId);
  if (typeof e === 'string') return e;
  return lockedIds(p).has(e.trackId) ? ASK.trackLocked : e;
}

function sortEdits(p: Project, edits: Iterable<CrossEdit>): CrossEdit[] {
  const order = new Map(p.tracks.map((t, i) => [t.id, i]));
  return [...edits].sort((a, b) => a.time - b.time || (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0));
}

export function crossfadeTargets(p: Project, input: CrossInput): CrossEdit[] | string {
  const fps = fpsOf(p);
  const found = new Map<string, CrossEdit>();
  const add = (toId: string | undefined): void => {
    if (toId === undefined || found.has(toId)) return;
    const e = editAt(p, toId);
    if (typeof e !== 'string') found.set(toId, e);
  };
  const picked = pickCounts(p, input.selection, input.pick);
  if (picked !== null) {
    const e = editAt(p, picked);
    return typeof e === 'string' ? e : [e];
  }
  const edge = input.trimEdge;
  if (edge) {
    const clip = p.clips.find((c) => c.id === edge.clipId);
    if (clip) {
      for (const s of soundClipsOf(p, clip)) add(edge.both || edge.edge === 'end' ? soundAfter(p, s)?.id : s.id);
    }
    return found.size > 0 ? sortEdits(p, found.values()) : CROSS_TEXT.crossNoEdit;
  }
  if (input.selection.length > 0) {
    for (const id of input.selection) {
      const clip = p.clips.find((c) => c.id === id);
      if (!clip) continue;
      for (const s of soundClipsOf(p, clip)) {
        add(s.id);
        add(soundAfter(p, s)?.id);
      }
    }
    return found.size > 0 ? sortEdits(p, found.values()) : CROSS_TEXT.crossNoEdit;
  }
  for (const c of p.clips) if (isSound(c) && Math.abs(c.start - input.time) <= 0.5 / fps + 1e-9) add(c.id);
  return found.size > 0 ? sortEdits(p, found.values()) : CROSS_TEXT.crossNoEditHere;
}

/** every edit of a track between two clips with sound, by time */
export function editsOnTrack(p: Project, trackId: string): CrossEdit[] {
  const out = new Map<string, CrossEdit>();
  for (const c of p.clips) {
    if (c.trackId !== trackId || !isSound(c)) continue;
    const e = editAt(p, c.id);
    if (typeof e !== 'string') out.set(c.id, e);
  }
  return sortEdits(p, out.values());
}

/** the same take runs on: same media and speed, the clip after picks up where the clip before ends */
export function oneTake(from: VideoClip | AudioClip, to: VideoClip | AudioClip): boolean {
  return from.assetId === to.assetId && Math.abs(from.speed - to.speed) < 1e-9 && Math.abs(to.trimStart - (from.trimStart + from.duration * from.speed)) <= 0.001;
}

interface Fit { before: number; after: number; wantBefore: number; wantAfter: number; why: { before: CrossShort; after: CrossShort } }

/** the frames a side wants for a total length and a place */
function wantsOf(total: number, place: Place, fps: number): { before: number; after: number } {
  const all = Math.max(1, framesOf(total, fps));
  if (place === 'start') return { before: 0, after: all };
  if (place === 'end') return { before: all, after: 0 };
  const half = Math.max(1, Math.round((total * fps) / 2));
  return { before: half, after: half };
}

/** whole frames a side plays: held to the room, a centered one hands the rest of a short side over */
function fitFrames(p: Project, toId: string, total: number, place: Place): Fit | string {
  const room = crossfadeRoom(p, toId);
  if (!room) {
    const e = editAt(p, toId);
    return typeof e === 'string' ? e : CROSS_TEXT.crossNoEdit;
  }
  const fps = fpsOf(p);
  const rb = roomFrames(room.before, fps), ra = roomFrames(room.after, fps);
  const want = wantsOf(total, place, fps);
  let before = Math.min(want.before, rb), after = Math.min(want.after, ra);
  if (place !== 'start' && place !== 'end') {
    if (before < want.before) after = Math.min(ra, after + (want.before - before));
    else if (after < want.after) before = Math.min(rb, before + (want.after - after));
  }
  if (before + after < 1) return CROSS_TEXT.crossNoMedia;
  return { before, after, wantBefore: want.before, wantAfter: want.after, why: { before: room.whyBefore, after: room.whyAfter } };
}

const valueOf = (before: number, after: number, fps: number, shape: FadeShape | undefined, withTransition = false): Crossfade | null =>
  cleanCrossfade({ before: before / fps, after: after / fps, shape, withTransition: withTransition || undefined });

/** what a crossfade of this total length and place would store at an edit, or why not. a non power shape is kept, never withTransition */
export function fitCrossfade(p: Project, edit: CrossEdit, total: number, place: Place, shape?: FadeShape): Crossfade | string {
  const f = fitFrames(p, edit.toId, total, place);
  if (typeof f === 'string') return f;
  return valueOf(f.before, f.after, fpsOf(p), shape) ?? CROSS_TEXT.crossNoMedia;
}

/** the short entries of a fit: a side that plays less than it wanted, with its limit */
function shortOf(id: string, f: Fit, before: number, after: number): CrossPlan['short'] {
  const out: CrossPlan['short'] = [];
  if (before < f.wantBefore) out.push({ id, side: 'before', why: f.why.before });
  if (after < f.wantAfter) out.push({ id, side: 'after', why: f.why.after });
  return out;
}

const patchOf = (id: string, crossfade: Crossfade | null): { id: string; patch: ClipPatch } => ({ id, patch: { crossfade } });

/** add where none, the default length centered; where every target has one: remove them all */
export function planToggle(p: Project, input: CrossInput): CrossPlan | string {
  const t = crossfadeTargets(p, input);
  if (typeof t === 'string') return t;
  const locked = lockedIds(p);
  const plan = emptyPlan();
  const open: CrossEdit[] = [];
  for (const e of t) {
    if (locked.has(e.trackId)) plan.skipped.push({ id: e.toId, why: ASK.trackLocked });
    else open.push(e);
  }
  if (open.length === 0) return ASK.trackLocked;
  const have = open.filter((e) => storedOf(p, e.toId) !== null);
  if (have.length === open.length) {
    for (const e of open) {
      plan.patches.push(patchOf(e.toId, null));
      plan.removed.push(e.toId);
    }
    return plan;
  }
  const fps = fpsOf(p);
  let first = '';
  for (const e of open) {
    if (storedOf(p, e.toId) !== null) continue;
    const f = fitFrames(p, e.toId, DEFAULT_CROSSFADE, 'center');
    const v = typeof f === 'string' ? null : valueOf(f.before, f.after, fps, undefined);
    if (typeof f === 'string' || !v) {
      const why = typeof f === 'string' ? f : CROSS_TEXT.crossNoMedia;
      first = first || why;
      plan.skipped.push({ id: e.toId, why });
      continue;
    }
    plan.patches.push(patchOf(e.toId, v));
    plan.added.push(e.toId);
    plan.short.push(...shortOf(e.toId, f, f.before, f.after));
  }
  return plan.patches.length === 0 ? first || CROSS_TEXT.crossNoMedia : plan;
}

/** add (or remove) at every edit of the tracks. add skips the edits that have one, one take edits and locked tracks */
export function planTrackCrossfades(p: Project, trackIds: readonly string[], mode: 'add' | 'remove'): CrossPlan | string {
  const locked = lockedIds(p);
  const open = [...new Set(trackIds)].filter((id) => !locked.has(id));
  if (trackIds.length > 0 && open.length === 0) return ASK.trackLocked;
  const plan = emptyPlan();
  const fps = fpsOf(p);
  if (mode === 'remove') {
    const tracks = new Set(open);
    for (const c of p.clips) {
      if (!tracks.has(c.trackId) || !isSound(c) || storedOf(p, c.id) === null) continue;
      plan.patches.push(patchOf(c.id, null));
      plan.removed.push(c.id);
    }
    return plan.patches.length === 0 ? CROSS_TEXT.crossNoneTrack : plan;
  }
  const edits = open.flatMap((id) => editsOnTrack(p, id));
  if (edits.length === 0) return CROSS_TEXT.crossNoEditTrack;
  const without = edits.filter((e) => storedOf(p, e.toId) === null);
  if (without.length === 0) return CROSS_TEXT.crossAllHave;
  let first = '';
  for (const e of without) {
    const from = p.clips.find((c) => c.id === e.fromId);
    const to = p.clips.find((c) => c.id === e.toId);
    if (isSound(from) && isSound(to) && oneTake(from, to)) {
      plan.skipped.push({ id: e.toId, why: CROSS_TEXT.crossOneTake });
      continue;
    }
    const f = fitFrames(p, e.toId, DEFAULT_CROSSFADE, 'center');
    const v = typeof f === 'string' ? null : valueOf(f.before, f.after, fps, undefined);
    if (typeof f === 'string' || !v) {
      const why = typeof f === 'string' ? f : CROSS_TEXT.crossNoMedia;
      first = first || why;
      plan.skipped.push({ id: e.toId, why });
      continue;
    }
    plan.patches.push(patchOf(e.toId, v));
    plan.added.push(e.toId);
    plan.short.push(...shortOf(e.toId, f, f.before, f.after));
  }
  if (plan.patches.length > 0) return plan;
  return first || CROSS_TEXT.crossOneTake;
}

/** the transition halves around an edit: before and after in seconds */
function transitionHalves(p: Project, to: Clip): { before: number; after: number } | null {
  if (to.type !== 'video' || !to.transition) return null;
  const ts = transitionSpan(p, to);
  return ts && ts.from ? { before: to.start - ts.start, after: ts.end - to.start } : null;
}

/** one crossfade changed: length keeps the place, a place keeps the total, before and after set a side. what it asks is held to the rooms */
export function planSetCrossfade(p: Project, toId: string, change: CrossChange): CrossPlan | string {
  const to = p.clips.find((c) => c.id === toId);
  if (!isSound(to)) return CROSS_TEXT.crossNoEdit;
  if (lockedIds(p).has(to.trackId)) return ASK.trackLocked;
  const cur = cleanCrossfade(to.crossfade);
  const plan = emptyPlan();
  if (change.remove) {
    if (!cur) return CROSS_TEXT.crossNoneTrack;
    plan.patches.push(patchOf(toId, null));
    plan.removed.push(toId);
    return plan;
  }
  const edit = editAt(p, toId);
  if (typeof edit === 'string') return edit;
  const fps = fpsOf(p);
  const shape: FadeShape = change.shape ?? cur?.shape ?? 'power';
  const keepShape = shape === 'power' ? undefined : shape;
  let value: Crossfade | null;
  let fit: Fit | null = null;
  let played = { before: 0, after: 0 };
  if (change.withTransition === true) {
    const h = transitionHalves(p, to);
    if (!h) return CROSS_TEXT.crossNoTransition;
    value = cleanCrossfade({ before: h.before, after: h.after, shape: keepShape, withTransition: true });
    if (!value) return CROSS_TEXT.crossNoTransition;
  } else if (change.withTransition === false && change.length === undefined && change.place === undefined && change.before === undefined && change.after === undefined) {
    if (!cur?.withTransition) return SAME;
    const h = transitionHalves(p, to) ?? { before: cur.before, after: cur.after };
    value = cleanCrossfade({ before: h.before, after: h.after, shape: keepShape });
  } else if (change.before !== undefined || change.after !== undefined) {
    const room = crossfadeRoom(p, toId);
    if (!room) return CROSS_TEXT.crossNoEdit;
    const rb = roomFrames(room.before, fps), ra = roomFrames(room.after, fps);
    const wantB = change.before !== undefined ? framesOf(change.before, fps) : framesOf(cur?.before ?? 0, fps);
    const wantA = change.after !== undefined ? framesOf(change.after, fps) : framesOf(cur?.after ?? 0, fps);
    const b = Math.min(rb, Math.max(0, wantB)), a = Math.min(ra, Math.max(0, wantA));
    if (b + a < 1) return wantB + wantA < 1 ? crossShortText('before', 'shortest', '', '') : CROSS_TEXT.crossNoMedia;
    fit = { before: b, after: a, wantBefore: wantB, wantAfter: wantA, why: { before: room.whyBefore, after: room.whyAfter } };
    played = { before: b, after: a };
    value = valueOf(b, a, fps, keepShape);
  } else if (change.length !== undefined || change.place !== undefined) {
    // a linked crossfade plays the live transition halves, not the ones stored at switch-on
    const asked = cur && cur.withTransition ? (transitionHalves(p, to) ?? cur) : cur;
    const place = change.place ?? (asked ? placeOf(asked, fps) : 'center');
    let total = change.length ?? (asked ? asked.before + asked.after : DEFAULT_CROSSFADE);
    if (place === 'custom' && asked) {
      // a custom place scales both sides
      const room = crossfadeRoom(p, toId);
      if (!room) return CROSS_TEXT.crossNoEdit;
      total = Math.max(total, 1 / fps);
      const k = total / (asked.before + asked.after);
      const rb = roomFrames(room.before, fps), ra = roomFrames(room.after, fps);
      const wantB = Math.max(0, framesOf(asked.before * k, fps)), wantA = Math.max(0, framesOf(asked.after * k, fps));
      const b = Math.min(rb, wantB), a = Math.min(ra, wantA);
      if (b + a < 1) return CROSS_TEXT.crossNoMedia;
      fit = { before: b, after: a, wantBefore: wantB, wantAfter: wantA, why: { before: room.whyBefore, after: room.whyAfter } };
    } else {
      const f = fitFrames(p, toId, total, place);
      if (typeof f === 'string') return f;
      fit = f;
    }
    played = { before: fit.before, after: fit.after };
    value = valueOf(fit.before, fit.after, fps, keepShape);
  } else if (cur) {
    // a shape alone keeps the sides, and the transition link
    value = cleanCrossfade({ ...cur, shape: keepShape });
  } else {
    const f = fitFrames(p, toId, DEFAULT_CROSSFADE, 'center');
    if (typeof f === 'string') return f;
    fit = f;
    played = { before: f.before, after: f.after };
    value = valueOf(f.before, f.after, fps, keepShape);
  }
  if (!value) return CROSS_TEXT.crossNoMedia;
  if (sameCrossfade(cur, value)) return SAME;
  plan.patches.push(patchOf(toId, value));
  (cur ? plan.changed : plan.added).push(toId);
  if (fit) plan.short.push(...shortOf(toId, fit, played.before, played.after));
  return plan;
}

/** the fade shape of the selected clips with sound (a picture with its sound apart: its sound clips). linear writes null */
export function planFadeShapes(p: Project, ids: readonly string[], shape: FadeShape): CrossPlan | string {
  const locked = lockedIds(p);
  const plan = emptyPlan();
  const seen = new Set<string>();
  const v = shape === 'linear' ? null : shape;
  let any = false;
  let open = 0;
  for (const id of ids) {
    const c = p.clips.find((x) => x.id === id);
    if (!c) continue;
    for (const s of soundClipsOf(p, c)) {
      if (seen.has(s.id) || !hasSound(p, s)) continue;
      seen.add(s.id);
      any = true;
      if (locked.has(s.trackId)) {
        plan.skipped.push({ id: s.id, why: ASK.trackLocked });
        continue;
      }
      open++;
      const inNow = s.fadeInShape === 'power' || s.fadeInShape === 'smooth' ? s.fadeInShape : 'linear';
      const outNow = s.fadeOutShape === 'power' || s.fadeOutShape === 'smooth' ? s.fadeOutShape : 'linear';
      if (inNow === shape && outNow === shape) continue;
      plan.patches.push({ id: s.id, patch: { fadeInShape: v, fadeOutShape: v } });
      plan.changed.push(s.id);
    }
  }
  if (!any) return ASK.soundFirst;
  if (plan.patches.length === 0) return open === 0 ? ASK.trackLocked : SAME_SHAPE;
  return plan;
}

/** the crossfade follows the transition of its clip (on), or keeps the sides it has now (off) */
export function planWithTransition(p: Project, toId: string, on: boolean): CrossPlan | string {
  const to = p.clips.find((c) => c.id === toId);
  if (!isSound(to) || to.type !== 'video' || !to.transition) return CROSS_TEXT.crossNoTransition;
  const e = soundEditAt(p, toId);
  if (typeof e === 'string') return e;
  return planSetCrossfade(p, toId, { withTransition: on });
}

/** a crossfade drag. start is what plays. an end moves its side (the other follows while centered, alt: this end only), the middle moves both across the edit */
export function dragCrossfade(
  p: Project,
  toId: string,
  grab: 'before' | 'after' | 'body',
  start: Crossfade,
  delta: number,
  alt: boolean,
  snap: number,
): { value: Crossfade; stop: CrossStop | null } {
  const room = crossfadeRoom(p, toId);
  if (!room) return { value: start, stop: null };
  const fps = fpsOf(p);
  const rb = roomFrames(room.before, fps), ra = roomFrames(room.after, fps);
  const sb = framesOf(start.before, fps), sa = framesOf(start.after, fps);
  const d = delta * fps;
  const shape = start.shape === 'linear' || start.shape === 'smooth' ? start.shape : undefined;
  const make = (b: number, a: number): Crossfade => valueOf(b, a, fps, shape) ?? start;
  if (grab === 'body') {
    const total = sb + sa;
    const lo = Math.max(0, total - ra), hi = Math.min(rb, total);
    if (lo > hi) return { value: start, stop: null };
    const raw = sb - d;
    let b = Math.round(raw);
    let stop: CrossStop | null = null;
    // the places that catch: starts at, centered on, ends at the edit
    let best = -1, bestD = Infinity;
    for (const t of [0, Math.round(total / 2), total]) {
      if (t < lo || t > hi) continue;
      if (Math.abs(raw - t) < bestD) { best = t; bestD = Math.abs(raw - t); }
    }
    if (best >= 0 && bestD <= snap * fps) b = best;
    else if (b < lo) {
      b = lo;
      if (lo > 0) stop = { side: 'after', why: room.whyAfter };
    } else if (b > hi) {
      b = hi;
      if (hi < total) stop = { side: 'before', why: room.whyBefore };
    }
    return { value: make(b, total - b), stop };
  }
  const centered = !alt && Math.abs(start.before - start.after) < 0.5 / fps && Math.min(rb, ra) >= 1;
  if (centered) {
    const raw = grab === 'before' ? sb - d : sa + d;
    let v = Math.round(raw);
    let stop: CrossStop | null = null;
    const hi = Math.min(rb, ra);
    if (v > hi) {
      v = hi;
      // the side whose room is smaller ends it
      stop = rb < ra ? { side: 'before', why: room.whyBefore } : ra < rb ? { side: 'after', why: room.whyAfter } : { side: grab, why: grab === 'before' ? room.whyBefore : room.whyAfter };
    } else if (v < 1) {
      v = 1;
      stop = { side: grab, why: 'shortest' };
    }
    return { value: make(v, v), stop };
  }
  const roomF = grab === 'before' ? rb : ra;
  const why = grab === 'before' ? room.whyBefore : room.whyAfter;
  const other = grab === 'before' ? sa : sb;
  let v = Math.round(grab === 'before' ? sb - d : sa + d);
  let stop: CrossStop | null = null;
  if (v > roomF) {
    v = roomF;
    stop = { side: grab, why };
  }
  if (v < 0) v = 0;
  if (v + other < 1) {
    // one frame is the least a crossfade has
    if (roomF < 1) return { value: start, stop: { side: grab, why } };
    v = 1;
    stop = { side: grab, why: 'shortest' };
  }
  return { value: grab === 'before' ? make(v, other) : make(other, v), stop };
}

/** a key nudge: the sides over 0 move by frames. rooms and the one frame floor apply, a stop is the answer when nothing moves */
export function nudgePlan(p: Project, toId: string, frames: number): CrossPlan | string {
  const to = p.clips.find((c) => c.id === toId);
  if (!isSound(to)) return CROSS_TEXT.crossNoEdit;
  const cur = cleanCrossfade(to.crossfade);
  if (!cur) return CROSS_TEXT.crossNoEdit;
  if (lockedIds(p).has(to.trackId)) return ASK.trackLocked;
  const room = crossfadeRoom(p, toId);
  if (!room) return CROSS_TEXT.crossNoEdit;
  const fps = fpsOf(p);
  const rb = roomFrames(room.before, fps), ra = roomFrames(room.after, fps);
  const asked = cur.withTransition ? (transitionHalves(p, to) ?? cur) : cur;
  const sb = framesOf(asked.before, fps), sa = framesOf(asked.after, fps);
  const stops: CrossStop[] = [];
  const move = (old: number, roomF: number, side: 'before' | 'after', why: CrossShort): number => {
    if (old <= 0) return old;
    if (frames > 0) {
      const n = Math.max(old, Math.min(old + frames, roomF));
      if (n < old + frames) stops.push({ side, why });
      return n;
    }
    const n = Math.max(1, old + frames);
    if (n > old + frames) stops.push({ side, why: 'shortest' });
    return n;
  };
  const nb = move(sb, rb, 'before', room.whyBefore);
  const na = move(sa, ra, 'after', room.whyAfter);
  const value = valueOf(nb, na, fps, cur.shape);
  if (!value || (nb === sb && na === sa)) {
    const s = stops[0];
    return s ? crossShortText(s.side, s.why, nameOf(p, room.fromId), nameOf(p, toId)) : SAME;
  }
  const plan = emptyPlan();
  plan.patches.push(patchOf(toId, value));
  plan.changed.push(toId);
  return plan;
}

/** the ids of crossfades whose clip before is another clip after an edit (the render rule soundBefore, like transitionsToDrop) */
export function crossfadesToDrop(before: Project, after: Project, origins: ReadonlyMap<string, string>): string[] {
  const was = new Map<string, Clip>();
  for (const c of before.clips) was.set(c.id, c);
  const out: string[] = [];
  for (const c of after.clips) {
    if (!isSound(c) || !c.crossfade) continue;
    const old = was.get(c.id);
    if (!old) continue;
    const had = isSound(old) ? (soundBefore(before, old)?.id ?? null) : null;
    const now = soundBefore(after, c)?.id ?? null;
    const same = now === null ? had === null : (origins.get(now) ?? now) === had;
    if (!same) out.push(c.id);
  }
  return out;
}

/** the tracks of the sound of the selected clips (a picture with its sound apart: the tracks of its sound clips) */
export function crossfadeTrackIds(p: Project, selection: readonly string[]): string[] {
  const out = new Set<string>();
  for (const id of selection) {
    const c = p.clips.find((x) => x.id === id);
    if (!c) continue;
    for (const s of soundClipsOf(p, c)) if (hasSound(p, s)) out.add(s.trackId);
  }
  return [...out];
}

const SHAPE_OF: Record<string, FadeShape> = { 'fade-shape-power': 'power', 'fade-shape-linear': 'linear', 'fade-shape-smooth': 'smooth' };

/** why a crossfade row would do nothing now, or null */
export function crossfadeReason(id: string, s: ReasonInput): string | null {
  const p = s.project;
  if (!p) return null;
  if (id === 'crossfade') {
    const plan = planToggle(p, { selection: s.selection, trimEdge: s.trimEdge ?? null, pick: s.crossfadePick ?? null, time: s.time });
    return typeof plan === 'string' ? plan : null;
  }
  if (id === 'crossfade-track' || id === 'crossfade-track-off') {
    if (s.selection.length === 0) return ASK.selectClip;
    const tracks = crossfadeTrackIds(p, s.selection);
    if (tracks.length === 0) return ASK.soundFirst;
    const plan = planTrackCrossfades(p, tracks, id === 'crossfade-track' ? 'add' : 'remove');
    return typeof plan === 'string' ? plan : null;
  }
  const shape = SHAPE_OF[id];
  if (shape) {
    const plan = planFadeShapes(p, s.selection, shape);
    return typeof plan === 'string' ? plan : null;
  }
  return null;
}
