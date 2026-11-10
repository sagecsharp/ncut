/** small timeline actions shared by the shortcut table, the clip menu, the track menu and the toolbar */
import { freezeFrame } from '../preview/freezeFrame';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { planCloseGaps } from './gaps';
import { idsAfter, idsOnTrack } from './selectionRules';

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
  const moves = planCloseGaps(st.project.clips, trackId);
  if (moves.length === 0) {
    useUi.getState().toast('no gaps on this track');
    return;
  }
  if (!st.moveClips(moves)) useUi.getState().toast('could not close the gaps');
}
