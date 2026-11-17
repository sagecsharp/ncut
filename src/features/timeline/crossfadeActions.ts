/**
 * crossfade actions: the pick, the menu state and every way to add, change or remove a crossfade.
 * a plan comes from crossfadePlan.ts: one pushHistory, the patches with skipHistory, one toast at most.
 */
import { create } from 'zustand';
import type { FadeShape, Project } from '../../types';
import { cleanCrossfade, crossfadeSpan, soundAfter } from '../../lib/audioCross';
import type { CrossShort } from '../../lib/audioCross';
import { useEditor } from '../../store/editorStore';
import type { ActionOpts } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useTimeDisplay } from '../../store/timeDisplay';
import { useUi } from '../../store/ui';
import { reasonSnapshot } from '../shell/reasons';
import { crossfadeReason, crossfadeTrackIds, editsOnTrack, nudgePlan, oneTake, pickCounts, planFadeShapes, planSetCrossfade, planToggle, planTrackCrossfades, planWithTransition, soundEditAt } from './crossfadePlan';
import type { CrossChange, CrossPlan } from './crossfadePlan';
import { CROSS_TEXT, crossAddedManyText, crossAddedText, crossLengthText, crossRemovedText, fadeShapeText } from './crossfadeText';
import { interaction } from './view';

const ed = () => useEditor.getState();
const toast = (text: string): void => useUi.getState().toast(text);

/** the id of the picked crossfade's clip while the pick counts */
export function pickedCrossfade(): string | null {
  const p = useEditor.getState().project;
  return p ? pickCounts(p, useEditor.getState().selection, useUi.getState().crossfadePick) : null;
}

/** a click on a crossfade: the clip after becomes the whole selection and the pick counts for that very array */
export function pickCrossfade(toId: string): void {
  const p = useEditor.getState().project;
  if (!p || interaction.gestureActive) return;
  // a locked track cannot be selected: the selection stays as it was, and no pick
  const clip = p.clips.find((c) => c.id === toId);
  if (!clip || p.tracks.find((t) => t.id === clip.trackId)?.locked) {
    useUi.getState().setCrossfadePick(null);
    return;
  }
  useEditor.getState().select([toId], 'replace');
  const sel = useEditor.getState().selection;
  if (sel.length === 1 && sel[0] === toId) useUi.getState().setCrossfadePick({ clipId: toId, selection: sel });
  else useUi.getState().setCrossfadePick(null);
}

/** drops the pick. true when it counted, so the key stops there */
export function clearCrossfadePick(): boolean {
  const counted = pickedCrossfade() !== null;
  useUi.getState().setCrossfadePick(null);
  return counted;
}

export interface CrossfadeMenuOpen { clipId: string; at: { x: number; y: number } | null; focusFirst: boolean }
interface CrossfadeMenuState {
  menu: CrossfadeMenuOpen | null;
  open(m: CrossfadeMenuOpen): void;
  close(): void;
}

export const useCrossfadeMenu = create<CrossfadeMenuState>()((set, get) => ({
  menu: null,
  open: (m) => set({ menu: m }),
  close: () => {
    if (get().menu !== null) set({ menu: null });
  },
}));

/* ---------- running a plan ---------- */

/** the patches, as one undo step (opts: the caller's step, nothing of its own) */
function apply(plan: CrossPlan, opts?: ActionOpts): void {
  if (!opts) ed().pushHistory();
  const step = opts ?? { skipHistory: true };
  for (const x of plan.patches) ed().updateClip(x.id, x.patch, step);
}

const lengthText = (p: Project, sec: number): string => crossLengthText(sec, p.fps || 30, useTimeDisplay.getState().mode);

/** the sides a plan stored for a clip */
function storedSides(plan: CrossPlan, id: string): { before: number; after: number; shape: FadeShape } | null {
  const c = plan.patches.find((x) => x.id === id)?.patch.crossfade;
  return c ? { before: c.before, after: c.after, shape: c.shape ?? 'power' } : null;
}

/** one toast at most. a change alone toasts nothing */
function report(p: Project, plan: CrossPlan): void {
  if (plan.removed.length > 0) {
    toast(crossRemovedText(plan.removed.length));
    return;
  }
  if (plan.added.length === 0) return;
  const one = plan.added.length === 1 && plan.skipped.length === 0 ? storedSides(plan, plan.added[0]!) : null;
  if (one) {
    toast(crossAddedText(lengthText(p, one.before), lengthText(p, one.after), one.shape));
    return;
  }
  const shorter = new Set(plan.short.map((s) => s.id)).size;
  const taken = plan.skipped.filter((s) => s.why === CROSS_TEXT.crossOneTake).length;
  toast(crossAddedManyText(plan.added.length, shorter, taken));
}

const inputNow = () => ({ selection: ed().selection, trimEdge: useUi.getState().trimEdge, pick: useUi.getState().crossfadePick, time: usePlayback.getState().time });

/** the key: crossfade the sound at the picked crossfade, the selected edge, the ends of the selected clips or the playhead's edit. again: remove */
export function crossfadeNow(): void {
  const p = ed().project;
  if (!p || interaction.gestureActive) return;
  const plan = planToggle(p, inputNow());
  if (typeof plan === 'string') {
    toast(plan);
    return;
  }
  apply(plan);
  report(p, plan);
}

/** true whenever a pick counts, so delete never deletes the clip behind a picked crossfade */
export function removePickedCrossfade(): boolean {
  const id = pickedCrossfade();
  if (id === null) return false;
  const p = ed().project;
  if (!p || interaction.gestureActive) return true;
  const plan = planSetCrossfade(p, id, { remove: true });
  if (typeof plan === 'string') {
    toast(plan);
    return true;
  }
  apply(plan);
  report(p, plan);
  return true;
}

/** comma and period: the picked crossfade a frame shorter or longer on each side (10 with shift). true whenever a pick counts */
export function nudgeCrossfade(frames: number): boolean {
  const id = pickedCrossfade();
  if (id === null) return false;
  const p = ed().project;
  if (!p || interaction.gestureActive) return true;
  const plan = nudgePlan(p, id, frames);
  if (typeof plan === 'string') toast(plan);
  else apply(plan);
  return true;
}

/** a crossfade at every edit of the tracks (null: the tracks of the selected clips), or none */
export function crossfadeTracksNow(trackIds: readonly string[] | null, mode: 'add' | 'remove'): void {
  const p = ed().project;
  if (!p || interaction.gestureActive) return;
  let ids = trackIds;
  if (ids === null) {
    const why = crossfadeReason(mode === 'add' ? 'crossfade-track' : 'crossfade-track-off', reasonSnapshot());
    if (why) {
      toast(why);
      return;
    }
    ids = crossfadeTrackIds(p, ed().selection);
  }
  const plan = planTrackCrossfades(p, ids, mode);
  if (typeof plan === 'string') {
    toast(plan);
    return;
  }
  apply(plan);
  report(p, plan);
}

/** the stored total (before + after) of a clip's crossfade, or null when it has none */
const totalOf = (id: string): number | null => {
  const c = ed().project?.clips.find((x) => x.id === id);
  const x = c && (c.type === 'video' || c.type === 'audio') ? cleanCrossfade(c.crossfade) : null;
  return x ? x.before + x.after : null;
};

/**
 * change one crossfade. opts: inside a live edit or a step the caller opened (no history of its own, no toasts).
 * answers the stored total, null when the clip has none
 */
export function setCrossfadeNow(toId: string, change: CrossChange, opts?: ActionOpts): number | null {
  const p = ed().project;
  if (!p || interaction.gestureActive) return null;
  const plan = planSetCrossfade(p, toId, change);
  if (typeof plan === 'string') {
    if (!opts && plan !== CROSS_TEXT.crossNoneTrack) toast(plan);
    return totalOf(toId);
  }
  apply(plan, opts);
  if (!opts) report(p, plan);
  return totalOf(toId);
}

/** the fade shape of the clips (null: the selected clips) */
export function fadeShapeNow(ids: readonly string[] | null, shape: FadeShape): void {
  const p = ed().project;
  if (!p || interaction.gestureActive) return;
  const plan = planFadeShapes(p, ids ?? ed().selection, shape);
  if (typeof plan === 'string') {
    toast(plan);
    return;
  }
  apply(plan);
  toast(fadeShapeText(shape, plan.changed.length));
}

/** the crossfade of a clip follows its transition, or keeps its own sides */
export function crossfadeWithTransitionNow(toId: string, on: boolean): void {
  const p = ed().project;
  if (!p || interaction.gestureActive) return;
  const plan = planWithTransition(p, toId, on);
  if (typeof plan === 'string') {
    toast(plan);
    return;
  }
  apply(plan);
  report(p, plan);
}

/** opens the menu of the picked crossfade under its box. true whenever a pick counts */
export function crossfadeMenuNow(): boolean {
  const id = pickedCrossfade();
  if (id === null) return false;
  useCrossfadeMenu.getState().open({ clipId: id, at: null, focusFirst: true });
  return true;
}

/* ---------- mcp ---------- */

export interface CrossRequest { ids?: readonly string[]; at?: 'start' | 'end' | 'both'; track?: string; change: CrossChange }
export interface CrossResult {
  set: { clip: string; edit: number; before: number; after: number; shape: FadeShape; short?: CrossShort }[];
  removed: string[];
  skipped: { id: string; why: string }[];
}

/** inside the caller's one undo step. a string when nothing could be set or removed */
export function setCrossfades(req: CrossRequest, opts: ActionOpts): CrossResult | string {
  const p = ed().project;
  if (!p) return CROSS_TEXT.crossNoEdit;
  const out: CrossResult = { set: [], removed: [], skipped: [] };
  // the clips that start an edit, by clip id
  const targets: string[] = [];
  const add = (id: string): void => {
    if (!targets.includes(id)) targets.push(id);
  };
  if (req.track !== undefined) {
    const adding = req.change.remove !== true;
    for (const e of editsOnTrack(p, req.track)) {
      const from = p.clips.find((c) => c.id === e.fromId);
      const to = p.clips.find((c) => c.id === e.toId);
      const held = !!to && (to.type === 'video' || to.type === 'audio') && !!to.crossfade;
      if (adding && !held && from && to && (from.type === 'video' || from.type === 'audio') && (to.type === 'video' || to.type === 'audio') && oneTake(from, to)) {
        out.skipped.push({ id: e.toId, why: CROSS_TEXT.crossOneTake });
        continue;
      }
      add(e.toId);
    }
    // a crossfade that waits has no edit: removing takes it too
    if (!adding) for (const c of p.clips) if (c.trackId === req.track && (c.type === 'video' || c.type === 'audio') && c.crossfade) add(c.id);
  } else {
    const at = req.at ?? 'both';
    for (const id of req.ids ?? []) {
      const clip = p.clips.find((c) => c.id === id);
      if (!clip) {
        out.skipped.push({ id, why: CROSS_TEXT.crossNoEdit });
        continue;
      }
      const toIds: string[] = [];
      if (at !== 'end') toIds.push(clip.id);
      if (at !== 'start') {
        const after = soundAfter(p, clip);
        if (after) toIds.push(after.id);
        else out.skipped.push({ id, why: CROSS_TEXT.crossNoEdit });
      }
      for (const to of toIds) {
        // a crossfade to remove may wait: it has no edit, the clip itself is the target
        if (req.change.remove) {
          add(to);
          continue;
        }
        const e = soundEditAt(p, to);
        if (typeof e === 'string') out.skipped.push({ id: to, why: e });
        else add(e.toId);
      }
    }
  }
  const asks = req.change;
  for (const id of targets) {
    const plan = planSetCrossfade(p, id, asks);
    if (typeof plan === 'string') {
      out.skipped.push({ id, why: plan });
      continue;
    }
    apply(plan, opts);
    out.removed.push(...plan.removed);
    for (const x of plan.patches) {
      if (!x.patch.crossfade) continue;
      const clip = ed().project?.clips.find((c) => c.id === x.id);
      const span = ed().project && clip ? crossfadeSpan(ed().project!, clip) : null;
      const v = x.patch.crossfade;
      const short = plan.short.find((s) => s.id === x.id)?.why ?? span?.shortBefore ?? span?.shortAfter ?? undefined;
      out.set.push({
        clip: x.id,
        edit: clip?.start ?? 0,
        before: span ? span.before : v.before,
        after: span ? span.after : v.after,
        shape: v.shape ?? 'power',
        ...(short ? { short } : {}),
      });
    }
  }
  if (out.set.length === 0 && out.removed.length === 0) return out.skipped[0]?.why ?? CROSS_TEXT.crossNoEdit;
  return out;
}
