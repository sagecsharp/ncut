/**
 * three point edit actions. runEdit applies a plan in stages as one undo step (it reads only its input: no ui target, no setting, no toast,
 * so the mcp tool can call it). editNow is what the keys, buttons and search rows run
 */
import type { Clip, Project } from '../../types';
import { uid } from '../../lib/id';
import { cleanRange } from '../../lib/inOut';
import { clipEnd } from '../../lib/timelineOps';
import { useEditor } from '../../store/editorStore';
import type { TrimOp } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { sourceAsset, useSource } from '../../store/source';
import { useUi } from '../../store/ui';
import { REASON_TEXT } from '../shell/reasons';
import { applyFollowerSpans } from './followApply';
import { EDIT_TEXT, editDoneText, editModeWord, editStopText, fillEditText } from './editText';
import { isEditStop, planEdit, planInsertMoves, selectedTargets } from './editPlan';
import type { EditInput, EditMode, EditPlan, EditResult } from './editPlan';
import { currentTargets, resetEditTargets, setEditTarget } from './editTargets';
import { cuttableAt, planRangeRemoval, splitOrigins, transitionsToDrop } from './rangeEdit';
import { clipLabel } from './trimText';
import { useSoundApart } from './soundSetting';
import { interaction } from './view';

const EPS = 1e-6;

const blank = (mode: EditMode): EditResult => ({
  ok: false, failed: null, mode, clips: [],
  start: 0, length: 0, from: 0, speed: 1,
  split: 0, moved: 0, removed: 0, trimmed: 0, slivers: 0, kept: 0, soundsKept: 0,
  lockedTracks: [], newTracks: [], rangeCleared: null,
});

/** neighbours that touch or overlap on one track, as 'a|b' keys (the clips sorted by start) */
function overlaps(p: Project, tracks: ReadonlySet<string>): Map<string, [Clip, Clip]> {
  const out = new Map<string, [Clip, Clip]>();
  for (const id of tracks) {
    const list = p.clips.filter((c) => c.trackId === id).sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1]!;
      const b = list[i]!;
      if (b.start < clipEnd(a) - EPS) out.set(`${a.id}|${b.id}`, [a, b]);
    }
  }
  return out;
}

/**
 * apply a three point edit in one undo step. a plan stop writes nothing and keeps redo. an apply stop rolls back to the exact
 * project (and loses redo, like lift). range given = never cleared, marks given = used as is
 */
export function runEdit(input: EditInput): EditResult {
  const ed = useEditor.getState();
  const start = ed.project;
  if (!start) return { ...blank(input.mode), failed: 'plan', reason: 'open a project first' };
  const p0: Project = start;
  const stopped = (reason: string): EditResult => ({ ...blank(input.mode), failed: 'apply', reason });
  const plan = planEdit(p0, input, { clip: () => uid('clp'), group: () => uid('grp') });
  if (isEditStop(plan)) return { ...blank(input.mode), failed: 'plan', reason: editStopText(plan, p0) };
  const skip = { skipHistory: true };
  const cur = (): Project => useEditor.getState().project!;
  const word = editModeWord(input.mode);
  ed.pushHistory();
  try {
    const result = apply(plan);
    return result;
  } catch (e) {
    ed.rollback();
    throw e;
  }

  function stop(reason: string): EditResult {
    ed.rollback();
    return stopped(reason);
  }

  function apply(plan: EditPlan): EditResult {
    // 3. the new tracks, once; every key goes through the map
    const keyMap = new Map<string, string>();
    for (const t of plan.newTracks) keyMap.set(t.key, ed.addTrack(t.kind, skip));
    const real = (id: string): string => keyMap.get(id) ?? id;
    const landing = plan.targetIds.map(real);
    const landingSet = new Set(landing);
    const prep = plan.prep;
    let trimmed = 0;
    let slivers = 0;
    let moved = 0;
    let lockedBehind: string[] = [];
    let afterSplits: Project | null = null;
    const trimAll = (trims: readonly { id: string; edge: 'start' | 'end'; time: number }[]): void => {
      for (const t of trims) {
        const before = cur();
        if (!before.clips.some((c) => c.id === t.id)) continue;
        ed.trimClip(t.id, t.edge, t.time, skip);
        if (cur() !== before) trimmed++;
        applyFollowerSpans(before, t.id, skip);
      }
    };
    if (plan.mode === 'insert' && prep) {
      // 4. insert: slivers go, the clips over the edit point are cut, everything after it moves
      if (prep.deletes.length > 0) ed.deleteClips(prep.deletes, skip);
      trimAll(prep.trims);
      slivers = prep.slivers;
      const cut = prep.split.filter((id) => cur().clips.some((c) => c.id === id));
      if (cut.length > 0) {
        ed.splitClips(prep.at, cut, skip);
        for (const id of cut) {
          const c = cur().clips.find((x) => x.id === id);
          if (!c || Math.abs(clipEnd(c) - prep.at) > EPS) return stop(fillEditText(EDIT_TEXT.splitStop, { mode: word, clip: clipLabel(cur(), id) }));
        }
      }
      afterSplits = cur();
      const plannedMoves = planInsertMoves(afterSplits, prep.at, prep.by, landingSet, prep.atOf);
      lockedBehind = plannedMoves.lockedBehind;
      if (plannedMoves.moves.length > 0) {
        if (!ed.moveClips(plannedMoves.moves, skip)) {
          const first = afterSplits.clips.find((c) => c.id === plannedMoves.moves[0]!.id);
          return stop(fillEditText(EDIT_TEXT.moveStop, { clip: clipLabel(afterSplits, first?.id ?? '') }));
        }
        moved = plannedMoves.moves.length;
      }
    }
    if (plan.clear) {
      // 5. overwrite and fit: the landing tracks are cut at both ends, the inside goes
      for (const t of [plan.clear.end, plan.clear.start]) {
        const ids = cuttableAt(cur(), t).filter((id) => landingSet.has(cur().clips.find((c) => c.id === id)!.trackId));
        if (ids.length > 0) ed.splitClips(t, ids, skip);
      }
      afterSplits = cur();
      const rp = planRangeRemoval({ ...afterSplits, clips: afterSplits.clips.filter((c) => landingSet.has(c.trackId)) }, plan.clear);
      if (rp.blocked) return stop(fillEditText(EDIT_TEXT.splitStop, { mode: word, clip: clipLabel(afterSplits, rp.blocked.id) }));
      if (rp.deletes.length > 0) ed.deleteClips(rp.deletes, skip);
      trimAll(rp.trims);
      slivers = rp.slivers;
    }
    if (plan.mode !== 'replace') {
      // 6. the new clips
      const entries = plan.clips.map((e) => ({ ...e, clip: { ...e.clip, trackId: real(e.clip.trackId) } as Clip }));
      if (!ed.insertClips(entries, skip)) {
        const t = cur().tracks.find((x) => x.id === entries[0]?.clip.trackId);
        return stop(fillEditText(EDIT_TEXT.placeStop, { mode: word, track: t?.name ?? 'a track' }));
      }
    } else if (plan.replace) {
      // 7. replace: the media swaps, then it slips
      const rep = plan.replace;
      if (rep.swap && !ed.replaceClipAsset(rep.clipId, input.assetId, skip)) return stop(editStopText({ why: 'replace-kind', clipId: rep.clipId }, p0));
      const slips: TrimOp[] = [];
      if (p0.clips.find((c) => c.id === rep.clipId)?.type !== 'image') slips.push({ kind: 'slip', id: rep.clipId, trimStart: rep.trimStart });
      for (const s of rep.sounds) slips.push({ kind: 'slip', id: s.id, trimStart: s.trimStart });
      if (slips.length > 0 && !ed.applyTrimPlan(slips, skip)) return stop(fillEditText(EDIT_TEXT.slipStop, { clip: clipLabel(p0, rep.clipId) }));
    }
    if (plan.mode !== 'replace') {
      // 8. a transition whose clip before is another clip now goes
      for (const id of transitionsToDrop(p0, cur(), splitOrigins(p0, afterSplits ?? p0))) ed.updateClip(id, { transition: null }, skip);
    }
    // 9. nothing may overlap that did not before, the new clips sit where they were planned
    const done = cur();
    const open = new Set(done.tracks.filter((t) => !t.locked).map((t) => t.id));
    const had = overlaps(p0, open);
    for (const [key, [a, b]] of overlaps(done, open)) {
      if (!had.has(key)) return stop(fillEditText(EDIT_TEXT.overlapStop, { mode: word, clip: clipLabel(done, b.id), other: clipLabel(done, a.id) }));
    }
    if (plan.mode !== 'replace') {
      for (const e of plan.clips) {
        const c = done.clips.find((x) => x.id === e.clip.id);
        if (!c || c.trackId !== real(e.clip.trackId) || Math.abs(c.start - e.clip.start) > EPS) {
          return stop(fillEditText(EDIT_TEXT.placeStop, { mode: word, track: done.tracks.find((x) => x.id === real(e.clip.trackId))?.name ?? 'a track' }));
        }
      }
    } else if (plan.replace) {
      const was = p0.clips.find((c) => c.id === plan.replace!.clipId)!;
      const c = done.clips.find((x) => x.id === was.id);
      if (!c || Math.abs(c.start - was.start) > EPS || Math.abs(c.duration - was.duration) > EPS) return stop(fillEditText(EDIT_TEXT.slipStop, { clip: clipLabel(p0, was.id) }));
    }
    // 10. selection, playhead, the range that was used
    const ids = plan.replace ? [plan.replace.clipId, ...plan.replace.sounds.map((s) => s.id)] : plan.clips.map((e) => e.clip.id);
    ed.select(ids, 'replace');
    if (plan.playheadAfter !== null) usePlayback.getState().seek(plan.playheadAfter);
    let rangeCleared = null;
    if (input.range === undefined && plan.usedRange) {
      rangeCleared = cleanRange(p0.range);
      ed.setRange(null);
    }
    const now = new Set(done.clips.map((c) => c.id));
    const known = new Set(p0.clips.map((c) => c.id));
    const planned = new Set(plan.clips.map((e) => e.clip.id));
    const lockedTracks = done.tracks.filter((t) => lockedBehind.includes(t.id) || prep?.lockedSpan.includes(t.id)).map((t) => t.id);
    return {
      ...blank(input.mode), ok: true, failed: null, clips: ids,
      start: plan.points.start, length: plan.points.length, from: plan.points.from, speed: plan.points.speed,
      split: done.clips.filter((c) => !known.has(c.id) && !planned.has(c.id)).length,
      moved,
      removed: p0.clips.filter((c) => !now.has(c.id)).length,
      trimmed,
      slivers,
      kept: prep?.kept ?? 0,
      soundsKept: plan.replace?.soundsKept ?? 0,
      lockedTracks,
      newTracks: [...keyMap.values()],
      rangeCleared,
    };
  }
}

/** pauses both players. null without source media */
export function editInputNow(mode: EditMode): EditInput | null {
  usePlayback.getState().pause();
  useSource.getState().pause();
  const asset = sourceAsset();
  const ed = useEditor.getState();
  const p = ed.project;
  if (!asset || !p) return null;
  return {
    mode,
    assetId: asset.id,
    playhead: usePlayback.getState().time,
    sourceTime: useSource.getState().time,
    targets: currentTargets(p.id),
    apart: useSoundApart.getState().apart,
    selection: ed.selection,
  };
}

/** keys, buttons, search rows */
export function editNow(mode: EditMode): void {
  if (interaction.gestureActive) return;
  const toast = useUi.getState().toast;
  const input = editInputNow(mode);
  if (!input) {
    toast(REASON_TEXT.sourceEmpty);
    return;
  }
  const p0 = useEditor.getState().project!;
  const r = runEdit(input);
  if (!r.ok) {
    toast(r.reason ?? EDIT_TEXT.mediaGone, r.failed === 'apply' ? 'error' : 'info');
    return;
  }
  const after = useEditor.getState().project;
  const asset = p0.assets.find((a) => a.id === input.assetId);
  const was = p0.clips.find((c) => c.id === r.clips[0]);
  const swapped = !(was && 'assetId' in was && was.assetId === input.assetId);
  const cleared = r.rangeCleared;
  toast(
    editDoneText(r, p0, asset?.name ?? '', swapped),
    'info',
    cleared
      ? {
          label: 'undo',
          run: () => {
            if (useEditor.getState().project !== after) {
              toast(EDIT_TEXT.undoLate);
              return;
            }
            useEditor.getState().undo();
            useEditor.getState().setRange(cleared);
          },
        }
      : undefined,
  );
}

export function targetsAutoNow(): void {
  resetEditTargets();
  useUi.getState().toast(EDIT_TEXT.targetsAuto);
}

export function targetSelectedNow(): void {
  const { project, selection } = useEditor.getState();
  const t = project ? selectedTargets(project, selection) : null;
  if (!project || !t) {
    useUi.getState().toast(EDIT_TEXT.targetsNone);
    return;
  }
  const names: string[] = [];
  for (const part of ['picture', 'sound'] as const) {
    const id = t[part];
    if (typeof id !== 'string') continue;
    setEditTarget(part, id);
    names.push(project.tracks.find((k) => k.id === id)?.name ?? id);
  }
  useUi.getState().toast(EDIT_TEXT.targetsSet.replace('{tracks}', names.join(' and ')));
}
