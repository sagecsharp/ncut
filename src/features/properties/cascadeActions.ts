/**
 * cascade on the store: "stagger" (the selected clips start one after the other) and "fly" (each one
 * flies in or out). one undo step each, all or nothing. the planning lives in cascade.ts.
 */
import { worldTransform } from '../../engine/parent';
import { isVisualClip } from '../../types';
import type { Clip, Keyframes, Project, Transform } from '../../types';
import { clipEnd } from '../../lib/timelineOps';
import { useEditor } from '../../store/editorStore';
import type { ClipMove } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import { applyFollowerSpans } from '../timeline/followApply';
import { withFollowerMoves } from '../timeline/followMoves';
import { flyPlanFull, hashString, staggerPlan } from './cascade';
import type { CascadeOrder, FlyDirection, FlyKind, StaggerMode } from './cascade';

const EPS = 1e-6;

const toast = (msg: string, kind?: 'info' | 'error') => useUi.getState().toast(msg, kind);

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function isLocked(project: Project, c: Clip): boolean {
  return !!project.tracks.find((t) => t.id === c.trackId)?.locked;
}

/** the selected clips that pass `pick`, split into the ones that can change and the ones on locked tracks */
function pickSelection(project: Project, pick: (c: Clip) => boolean): { open: Clip[]; locked: number } {
  const sel = new Set(useEditor.getState().selection);
  const chosen = project.clips.filter((c) => sel.has(c.id) && pick(c));
  const open = chosen.filter((c) => !isLocked(project, c));
  return { open, locked: chosen.length - open.length };
}

/** true when a moved clip would overlap a clip that stays or another moved clip on the same track */
function collides(project: Project, moves: readonly { id: string; start: number; duration: number }[]): boolean {
  const moving = new Map(moves.map((m) => [m.id, m]));
  const byTrack = new Map<string, { id: string; start: number; end: number }[]>();
  for (const c of project.clips) {
    const m = moving.get(c.id);
    const start = m ? m.start : c.start;
    const list = byTrack.get(c.trackId) ?? [];
    list.push({ id: c.id, start, end: m ? m.start + m.duration : clipEnd(c) });
    byTrack.set(c.trackId, list);
  }
  for (const list of byTrack.values()) {
    if (!list.some((x) => moving.has(x.id))) continue;
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) {
      if (list[i]!.start < list[i - 1]!.end - EPS && (moving.has(list[i]!.id) || moving.has(list[i - 1]!.id))) return true;
    }
  }
  return false;
}

/**
 * "stagger": the selected clips start one after the other in `order`, `stepFrames` apart (0 = all start
 * together). 'move' keeps every length, 'trim' keeps every end. one undo step. the selection stays.
 */
export function staggerSelection(order: CascadeOrder, stepFrames: number, mode: StaggerMode, seed?: number): void {
  const st = useEditor.getState();
  const project = st.project;
  if (!project) return;
  const { open, locked } = pickSelection(project, () => true);
  if (open.length < 2) {
    toast(locked > 0 ? 'those clips are on locked tracks' : 'select 2 or more clips');
    return;
  }
  // "random" is the same order every time for the same clips: the seed comes from what is selected
  const stable = seed ?? hashString(open.map((c) => c.id).sort().join('|'));
  // attached clips are ordered by where they are on the canvas, not by their place under the parent
  const where = (c: Clip, time: number) => (isVisualClip(c) && c.parent ? worldTransform(project, c, time) : null);
  const plan = staggerPlan(open, order, stepFrames, project.fps, { mode, seed: stable, tracks: project.tracks, where });
  const notes = (changed: number): string => {
    let msg = `${changed} ${plural(changed, 'clip', 'clips')} staggered`;
    if (plan.left.length > 0) msg += `, ${plan.left.length} left out (would get too short)`;
    if (locked > 0) msg += `, ${locked} on locked tracks left out`;
    return msg;
  };
  if (plan.places.length === 0) {
    toast(plan.left.length > 0 ? `nothing changed, ${plan.left.length} ${plural(plan.left.length, 'clip would', 'clips would')} get too short` : 'already like that');
    return;
  }
  if (mode === 'move' && collides(project, plan.places)) {
    toast('a clip would run into another clip on its track, nothing moved', 'error');
    return;
  }

  st.pushHistory();
  const opts = { skipHistory: true };
  const fail = (): void => {
    // only what this plan wrote so far (nothing written: nothing is taken back)
    useEditor.getState().rollback();
    toast('could not move the clips', 'error');
  };
  if (mode === 'move') {
    const moves: ClipMove[] = [];
    for (const p of plan.places) {
      const c = project.clips.find((k) => k.id === p.id);
      if (c) moves.push({ id: p.id, trackId: c.trackId, start: p.start });
    }
    const cur = useEditor.getState().project;
    if (!cur) return fail();
    const all = withFollowerMoves(cur.clips, cur.tracks, moves);
    if (!useEditor.getState().moveClips(all, opts)) return fail();
  } else {
    for (const p of plan.places) {
      const before = useEditor.getState().project;
      useEditor.getState().trimClip(p.id, 'start', p.start, opts);
      applyFollowerSpans(before, p.id, opts);
      const now = useEditor.getState().project?.clips.find((c) => c.id === p.id);
      if (!now || Math.abs(now.start - p.start) > 1e-4) return fail();
    }
  }
  toast(notes(plan.places.length));
}

/**
 * "fly": every selected visual clip flies in (or out) with keyframes. one undo step. the selection stays.
 * `duration` is in seconds (a clip shorter than that flies over its whole length), `amount` is 0..1.
 */
export function flySelection(kind: FlyKind, direction: FlyDirection, amount: number, duration: number, seed = Math.floor(Math.random() * 1e9)): void {
  const st = useEditor.getState();
  const project = st.project;
  if (!project) return;
  const { open, locked } = pickSelection(project, isVisualClip);
  if (open.length === 0) {
    toast(locked > 0 ? 'those clips are on locked tracks' : 'select pictures, text or shapes to fly');
    return;
  }
  const ordered = [...open].sort((a, b) => a.start - b.start);
  const writes: { clip: Clip; keys: Keyframes; unkeyed: { prop: string; value: number }[] }[] = [];
  ordered.forEach((clip, i) => {
    const { keys, unkeyed } = flyPlanFull(clip, i, ordered.length, { kind, direction, amount, duration, seed, width: project.width, height: project.height });
    if (Object.keys(keys).length > 0) writes.push({ clip, keys, unkeyed });
  });
  if (writes.length === 0) {
    toast('nothing to change, the clips are too short for that length');
    return;
  }
  st.pushHistory();
  for (const w of writes) {
    const merged: Keyframes = { ...w.clip.keyframes, ...w.keys };
    // a property left with fewer than 2 keys is no animation: its keys go and it rests on its static value
    for (const u of w.unkeyed) delete merged[u.prop];
    useEditor.getState().setClipKeyframes(w.clip.id, merged, { skipHistory: true, time: w.clip.start });
    // setClipKeyframes froze those properties at the clip start (the far pose of a fly in): write the rest pose over it
    if (w.unkeyed.length > 0) {
      const patch: Record<string, number> = {};
      for (const u of w.unkeyed) patch[u.prop] = u.value;
      useEditor.getState().updateTransform(w.clip.id, patch as Partial<Transform>, { skipHistory: true });
    }
  }
  const n = writes.length;
  let msg = `${n} ${plural(n, 'clip flies', 'clips fly')} ${direction === 'in' ? 'in' : 'out'}`;
  const skipped = ordered.length - n;
  if (skipped > 0) msg += `, ${skipped} left out (too short)`;
  const notVisual = useEditor.getState().selection.length - open.length - locked;
  if (notVisual > 0) msg += `, ${notVisual} not ${plural(notVisual, 'a picture', 'pictures')} left out`;
  if (locked > 0) msg += `, ${locked} on locked tracks left out`;
  toast(msg);
}
