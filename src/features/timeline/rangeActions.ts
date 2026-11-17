/**
 * the timeline in / out range: the rows and menus call these. runRangeEdit is lift and extract in one undo step.
 * each wrapper checks reasonFor first and toasts it. they run only for the timeline: onView routes the source view
 * elsewhere, so the source branch of the reasons is switched off here.
 */
import type { Project } from '../../types';
import { isVisualClip } from '../../types';
import { cleanRange, editSpan, editableTrackIds, frameAt, lastFrameIn, markClipSpan, markOutTime, rangeEditBlock, selectionSpan, withIn, withOut } from '../../lib/inOut';
import { formatSeconds, snapToFrame } from '../../lib/time';
import { clipEnd, projectDuration, rangesOverlap } from '../../lib/timelineOps';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { REASON_TEXT, reasonFor, reasonSnapshot } from '../shell/reasons';
import { crossfadesToDrop } from './crossfadePlan';
import { cuttableAt, lockedTracksHit, planCloseUp, planRangeRemoval, splitOrigins, syncOffTracksHit, transitionsToDrop } from './rangeEdit';
import { movingTracks, pairDrift } from './syncShift';
import { outOfSyncText } from './trimText';

export type RangeEditKind = 'lift' | 'extract';
export interface RangeEditResult {
  ok: boolean;
  /** why nothing changed: a reasons.ts text, or a stop that names a clip */
  reason?: string;
  in: number;
  out: number;
  removed: number;
  trimmed: number;
  splits: number;
  moved: number;
  slivers: number;
  lockedTracks: number;
  /** extract: unlocked sync lock off tracks that stayed where they were */
  syncOffTracks?: number;
  /** clips that went out of sync: a pair in sync where one moved and its mate stayed. clip ids */
  outOfSync?: string[];
}

const HINT_KEY = 'ncut.hint.markIn';
const HINT_MAX = 3;

const toast = (message: string): void => useUi.getState().toast(message);

/** a reason for this row on the timeline: toast it and say so */
function refused(id: string): boolean {
  const why = reasonFor(id, { ...reasonSnapshot(), source: undefined });
  if (why) toast(why);
  return why !== null;
}

/** i moved from the keyframe key to shift+k: say so the first few times it is pressed with a clip that has keyframes selected */
function markInHint(): void {
  const s = useEditor.getState();
  const picked = s.project?.clips.filter((c) => s.selection.includes(c.id)) ?? [];
  if (!picked.some((c) => isVisualClip(c) || c.type === 'camera')) return;
  try {
    const n = Number(localStorage.getItem(HINT_KEY)) || 0;
    if (n >= HINT_MAX) return;
    localStorage.setItem(HINT_KEY, String(n + 1));
  } catch {
    return;
  }
  toast('i marks the in point now. keyframes moved to shift+k');
}

function setIn(t: number): void {
  const ed = useEditor.getState();
  const r = withIn(ed.project?.range, t);
  ed.setRange(r.range);
  if (r.dropped) toast('in point set, the out point before it was cleared');
}

function setOut(t: number): void {
  const ed = useEditor.getState();
  const r = withOut(ed.project?.range, t);
  ed.setRange(r.range);
  if (r.dropped) toast('out point set, the in point after it was cleared');
}

/** i: the frame under the playhead is the first one inside */
export function markIn(): void {
  if (refused('mark-in')) return;
  const p = useEditor.getState().project;
  if (!p) return;
  setIn(frameAt(usePlayback.getState().time, p.fps));
  markInHint();
}

/** o: the frame under the playhead is the last one inside */
export function markOut(): void {
  if (refused('mark-out')) return;
  const p = useEditor.getState().project;
  if (!p) return;
  setOut(markOutTime(usePlayback.getState().time, p.fps, projectDuration(p)));
}

/** the ruler menu: the in point at the pointer */
export function markInAt(t: number): void {
  if (refused('mark-in')) return;
  const p = useEditor.getState().project;
  if (!p) return;
  setIn(snapToFrame(t, p.fps));
}

/** the ruler menu: the out point at the pointer */
export function markOutAt(t: number): void {
  if (refused('mark-out')) return;
  const p = useEditor.getState().project;
  if (!p) return;
  setOut(snapToFrame(t, p.fps));
}

/** x: in and out around the clip under the playhead (or the gap there) */
export function markClip(): void {
  if (refused('mark-clip')) return;
  const ed = useEditor.getState();
  const p = ed.project;
  if (!p) return;
  const span = markClipSpan(p, usePlayback.getState().time, ed.selection);
  if (!span) return;
  ed.setRange({ in: span.start, out: span.end });
  if (!span.clip) toast('marked the gap');
}

export function markSelection(): void {
  if (refused('mark-selection')) return;
  const ed = useEditor.getState();
  const p = ed.project;
  if (!p) return;
  const span = selectionSpan(p, ed.selection);
  if (span) ed.setRange({ in: span.start, out: span.end });
}

export function clearInOut(): void {
  if (refused('clear-in-out')) return;
  useEditor.getState().setRange(null);
}

/** only the out point stays */
export function clearIn(): void {
  if (refused('clear-in')) return;
  const ed = useEditor.getState();
  const r = cleanRange(ed.project?.range);
  ed.setRange(r?.out !== undefined ? { out: r.out } : null);
}

/** only the in point stays */
export function clearOut(): void {
  if (refused('clear-out')) return;
  const ed = useEditor.getState();
  const r = cleanRange(ed.project?.range);
  ed.setRange(r?.in !== undefined ? { in: r.in } : null);
}

export function goIn(): void {
  if (refused('go-in')) return;
  const r = cleanRange(useEditor.getState().project?.range);
  if (r?.in !== undefined) usePlayback.getState().seek(r.in);
}

/** the last frame inside, not the out point itself */
export function goOut(): void {
  if (refused('go-out')) return;
  const p = useEditor.getState().project;
  const t = p ? lastFrameIn(p.range, p.fps) : null;
  if (t !== null) usePlayback.getState().seek(t);
}

export function playInOut(): void {
  if (refused('play-in-out')) return;
  usePlayback.getState().playInToOut();
}

const EPS = 1e-6;

const nothing = (over: Partial<RangeEditResult> = {}): RangeEditResult => ({ ok: false, in: 0, out: 0, removed: 0, trimmed: 0, splits: 0, moved: 0, slivers: 0, lockedTracks: 0, ...over });

/** the first overlap on an unlocked track that was not there before, or the first unlocked clip left in the span */
function firstOverlap(before: Project, after: Project): { a: string; b: string } | null {
  const open = editableTrackIds(after);
  const had = new Set<string>();
  for (const t of before.tracks) {
    const list = before.clips.filter((c) => c.trackId === t.id).sort((x, y) => x.start - y.start);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (rangesOverlap(list[i]!.start, clipEnd(list[i]!), list[j]!.start, clipEnd(list[j]!))) had.add(list[i]!.id + '|' + list[j]!.id);
  }
  for (const t of after.tracks) {
    if (!open.has(t.id)) continue;
    const list = after.clips.filter((c) => c.trackId === t.id).sort((x, y) => x.start - y.start);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (rangesOverlap(list[i]!.start, clipEnd(list[i]!), list[j]!.start, clipEnd(list[j]!)) && !had.has(list[i]!.id + '|' + list[j]!.id)) return { a: list[i]!.name, b: list[j]!.name };
      }
    }
  }
  return null;
}

/**
 * lift or extract the span between the in and out points, in one undo step. nothing is written when a reason applies
 * or a stop happens (a clip that cannot be split, a clash): a stop after the first write rolls back and loses the redo list
 */
export function runRangeEdit(kind: RangeEditKind): RangeEditResult {
  const ed = useEditor.getState();
  const p0 = ed.project;
  if (!p0) return nothing({ reason: 'open a project first' });
  const extract = kind === 'extract';
  const block = rangeEditBlock(p0, extract);
  if (block) return nothing({ reason: block === 'both' ? REASON_TEXT.inOutBoth : block === 'nothing' ? REASON_TEXT.inOutNothing : block === 'sync-off' ? REASON_TEXT.inOutSyncOff : REASON_TEXT.inOutLocked });
  const span = editSpan(p0.range)!;
  const lockedTracks = lockedTracksHit(p0, span, extract);
  const open = extract ? movingTracks(p0.tracks, new Set()) : editableTrackIds(p0);
  const skip = { skipHistory: true };
  const stop = (reason: string): RangeEditResult => {
    ed.rollback();
    return nothing({ reason, in: span.start, out: span.end });
  };
  ed.pushHistory();
  try {
    const cur = (): Project => useEditor.getState().project!;
    const atEnd = cuttableAt(cur(), span.end, open);
    if (atEnd.length > 0) ed.splitClips(span.end, atEnd, { ...skip, open });
    const atStart = cuttableAt(cur(), span.start, open);
    if (atStart.length > 0) ed.splitClips(span.start, atStart, { ...skip, open });
    const afterSplits = cur();
    const origins = splitOrigins(p0, afterSplits);
    const known = new Set(p0.clips.map((c) => c.id));
    const plan = planRangeRemoval(afterSplits, span, open);
    if (plan.blocked) return stop(`${kind} stopped: "${plan.blocked.name}" could not be split at the in or out point`);
    if (plan.deletes.length > 0) ed.deleteClips(plan.deletes, skip);
    let trimmed = 0;
    for (const t of plan.trims) {
      const was = cur();
      if (!was.clips.some((c) => c.id === t.id)) continue;
      ed.trimClip(t.id, t.edge, t.time, skip);
      if (cur() !== was) trimmed++;
    }
    let moved = 0;
    let outOfSync: string[] = [];
    if (extract) {
      const cu = planCloseUp(cur(), span, open);
      if (cu.clash) return stop(`extract stopped: "${cu.clash.clip.name}" would overlap "${cu.clash.other.name}"`);
      if (cu.moves.length > 0) {
        const was = cur();
        outOfSync = pairDrift(was.clips, new Set(cu.moves.map((m) => m.id)), new Set());
        if (!ed.moveClips(cu.moves, skip)) {
          const m = cu.moves.find((x) => was.clips.some((c) => c.id === x.id));
          const c = m ? was.clips.find((x) => x.id === m.id) : undefined;
          return stop(`extract stopped: "${c?.name ?? 'a clip'}" could not move`);
        }
        moved = cu.moves.length;
      }
    }
    for (const c of afterSplits.clips) {
      if (!isVisualClip(c) || !c.transition) continue;
      const back = cur().clips.find((x) => x.id === c.id);
      if (back && isVisualClip(back) && !back.transition) ed.updateClip(c.id, { transition: c.transition }, skip);
    }
    for (const c of afterSplits.clips) {
      if ((c.type !== 'video' && c.type !== 'audio') || !c.crossfade) continue;
      const back = cur().clips.find((x) => x.id === c.id);
      if (back && (back.type === 'video' || back.type === 'audio') && !back.crossfade) ed.updateClip(c.id, { crossfade: c.crossfade }, skip);
    }
    for (const id of transitionsToDrop(p0, cur(), origins)) ed.updateClip(id, { transition: null }, skip);
    for (const id of crossfadesToDrop(p0, cur(), origins)) ed.updateClip(id, { crossfade: null }, skip);
    const done = cur();
    const hit = firstOverlap(p0, done);
    if (hit) return stop(`${kind} stopped: "${hit.a}" would overlap "${hit.b}"`);
    if (!extract) {
      const unlocked = editableTrackIds(done);
      const left = done.clips.find((c) => unlocked.has(c.trackId) && c.start < span.end - EPS && clipEnd(c) > span.start + EPS);
      if (left) return stop(`lift stopped: "${left.name}" is still between the in and out points`);
    }
    if (done === p0) {
      ed.rollback();
      return nothing({ reason: REASON_TEXT.inOutNothing, in: span.start, out: span.end });
    }
    ed.setRange(extract ? { in: span.start } : p0.range ?? null);
    usePlayback.getState().seek(span.start);
    const now = new Set(done.clips.map((c) => c.id));
    const removed = p0.clips.filter((c) => !now.has(c.id)).length;
    const splits = done.clips.filter((c) => !known.has(c.id)).length;
    const syncOff = extract ? syncOffTracksHit(p0, span).length : 0;
    return {
      ok: true, in: span.start, out: span.end, removed, trimmed, splits, moved, slivers: plan.slivers, lockedTracks,
      ...(syncOff > 0 ? { syncOffTracks: syncOff } : {}),
      ...(outOfSync.length > 0 ? { outOfSync } : {}),
    };
  } catch (e) {
    ed.rollback();
    throw e;
  }
}

function rangeEditToast(kind: RangeEditKind, r: RangeEditResult, p: Project | null): string {
  const len = formatSeconds(r.out - r.in);
  let text = kind === 'lift' ? `lifted ${len} between the in and out points, the gap stays` : `extracted ${len}, the clips after it moved up`;
  if (r.lockedTracks > 0) text += `. ${r.lockedTracks} locked track${r.lockedTracks > 1 ? 's' : ''} stayed where ${r.lockedTracks > 1 ? 'they were' : 'it was'}`;
  if (r.syncOffTracks) text += `. ${r.syncOffTracks} track${r.syncOffTracks > 1 ? 's' : ''} with sync lock off stayed as ${r.syncOffTracks > 1 ? 'they were' : 'it was'}`;
  if (r.outOfSync?.length && p) text += '. ' + outOfSyncText(p, r.outOfSync);
  if (r.slivers > 0) text += `. ${r.slivers} piece${r.slivers > 1 ? 's' : ''} shorter than 0.05 s went too`;
  return text;
}

function runAndToast(kind: RangeEditKind): void {
  const why = reasonFor(kind, { ...reasonSnapshot(), source: undefined });
  if (why) {
    toast(why);
    return;
  }
  const r = runRangeEdit(kind);
  if (r.ok) toast(rangeEditToast(kind, r, useEditor.getState().project));
  else if (r.reason) useUi.getState().toast(r.reason, 'error');
}

/** ; take out what is between in and out, the gap stays */
export function lift(): void {
  runAndToast('lift');
}

/** ' take out what is between in and out and close up */
export function extract(): void {
  runAndToast('extract');
}
