/** small timeline actions shared by the shortcut table, the clip menu, the track menu and the toolbar */
import { freezeFrame } from '../preview/freezeFrame';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { planCloseGaps } from './gaps';
import { withFollowerMoves } from './followMoves';
import { GAP_SECONDS, planInsertGap } from './gapInsert';
import { revealScrollLeft } from './followScroll';
import { effectsOn } from './effectTarget';
import { notifyView, view } from './view';
import { idsAfter, idsLike, idsOnTrack } from './selectionRules';

/** group the given ids (needs 2+). returns true when a group was made. */
export function groupIdsNow(ids: string[]): boolean {
  const st = useEditor.getState();
  if (ids.length < 2) {
    useUi.getState().toast('select 2 or more clips to group');
    return false;
  }
  const made = st.groupClips(ids);
  useUi.getState().toast(made ? `grouped ${ids.length} clips` : 'those clips are already a group');
  return made !== null;
}

export function ungroupIdsNow(ids: string[]): void {
  const st = useEditor.getState();
  const had = st.project?.clips.some((c) => ids.includes(c.id) && c.group) ?? false;
  if (!had) {
    useUi.getState().toast('nothing grouped in the selection');
    return;
  }
  st.ungroupClips(ids);
  useUi.getState().toast('ungrouped');
}

/** freeze the frame at the playhead; toasts when there is nothing to freeze */
export function freezeAtPlayhead(): void {
  void freezeFrame().then((id) => {
    if (id === null) useUi.getState().toast('no video frame at the playhead');
  });
}

/** select every clip of the same kind as the selected ones (all texts, all clips of this effect ...) */
export function selectLike(): void {
  const st = useEditor.getState();
  if (!st.project) return;
  if (st.selection.length === 0) {
    useUi.getState().toast('select a clip first');
    return;
  }
  const ids = idsLike(st.project.clips, st.selection);
  st.select(ids, 'replace');
  const n = useEditor.getState().selection.length;
  useUi.getState().toast(n === 1 ? 'nothing else like it' : `${n} clips selected`);
}

/** select every clip that starts at or after the playhead, optionally on one track */
export function selectAfterPlayhead(trackId?: string): void {
  const st = useEditor.getState();
  if (!st.project) return;
  st.select(idsAfter(st.project, usePlayback.getState().time, trackId), 'replace');
}

export function selectTrackClips(trackId: string): void {
  const st = useEditor.getState();
  if (!st.project) return;
  st.select(idsOnTrack(st.project.clips, trackId), 'replace');
}

/** shift the clips of a track left so they sit end to end. one undo step. */
export function closeGapsOnTrack(trackId: string): void {
  const st = useEditor.getState();
  if (!st.project) return;
  const planned = planCloseGaps(st.project.clips, trackId);
  if (planned.length === 0) {
    useUi.getState().toast('no gaps on this track');
    return;
  }
  // effects that are put on the moved clips go with them, in the same undo step
  const moves = withFollowerMoves(st.project.clips, st.project.tracks, planned);
  if (!st.moveClips(moves)) useUi.getState().toast('could not close the gaps');
}

/**
 * open a gap: every clip that starts at or after `time` (default the playhead) moves right by one
 * second, on every unlocked track or on `trackId` only. one undo step, all or nothing.
 */
export function insertGapAt(time?: number, trackId?: string): void {
  const st = useEditor.getState();
  if (!st.project) return;
  const at = time ?? usePlayback.getState().time;
  const planned = planInsertGap(st.project.clips, st.project.tracks, at, GAP_SECONDS, trackId);
  if (planned.length === 0) {
    useUi.getState().toast('no clips after this point');
    return;
  }
  // an effect follows its clip: it goes with a clip that moves and stays with one that does not
  const moves = withFollowerMoves(st.project.clips, st.project.tracks, planned, true);
  if (moves.length === 0) {
    useUi.getState().toast('no clips after this point');
    return;
  }
  if (!st.moveClips(moves)) useUi.getState().toast('could not insert the gap');
}

/** scroll the timeline so a clip is in view (sideways by the view state, up / down by the element) */
export function revealClip(id: string): void {
  const st = useEditor.getState();
  const clip = st.project?.clips.find((c) => c.id === id);
  if (!clip) return;
  const scroller = document.querySelector<HTMLElement>('.timeline-scroller');
  if (!scroller) return;
  const next = revealScrollLeft(clip.start * st.zoom, (clip.start + clip.duration) * st.zoom, view.scrollLeft, view.width);
  if (next !== null) {
    scroller.scrollLeft = next;
    view.scrollLeft = scroller.scrollLeft;
    notifyView();
  }
  for (const el of scroller.querySelectorAll<HTMLElement>('[data-clip-id]')) {
    if (el.dataset.clipId === id) {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      break;
    }
  }
}

/** select the clip an effect is put on and bring it into view */
export function goToEffectTarget(effectId: string): void {
  const st = useEditor.getState();
  const e = st.project?.clips.find((c) => c.id === effectId);
  const target = e && e.type === 'effect' && e.target ? st.project?.clips.find((c) => c.id === e.target) : undefined;
  if (!target) {
    useUi.getState().toast('that clip is gone');
    return;
  }
  st.select([target.id], 'replace');
  revealClip(target.id);
}

/** select the effect clips that are put on any of these clips */
export function selectEffectsOf(ids: readonly string[]): void {
  const st = useEditor.getState();
  if (!st.project) return;
  const found = ids.flatMap((id) => effectsOn(st.project!.clips, id).map((e) => e.id));
  if (found.length === 0) return;
  st.select([...new Set(found)], 'replace');
}

/** make effect clips act on everything below their track again. one undo step. */
export function applyEffectsToEverything(ids: readonly string[]): void {
  const st = useEditor.getState();
  const targeted = (st.project?.clips ?? []).filter((c) => ids.includes(c.id) && c.type === 'effect' && c.target);
  if (targeted.length === 0) return;
  st.pushHistory();
  for (const c of targeted) st.updateClip(c.id, { target: null }, { skipHistory: true });
}
