/**
 * track tools: track heights, the order of tracks and the sync lock switch. no gesture guard: the height drag calls
 * setTrackHeight while it runs. a track height is a view setting (no undo step), the other two are steps.
 */
import { normalHeights, stepHeights, stepIndex, syncLockOf, tracksOf } from '../../lib/trackTools';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import { REASON_TEXT } from '../shell/reasons';

const toast = (message: string): void => useUi.getState().toast(message);

/** the toast shown last, and when */
let lastToast: { text: string; at: number } | null = null;

/** a held key toasts once: the same text again within 3000 ms is dropped */
function toastOnce(message: string): void {
  const now = Date.now();
  if (lastToast && lastToast.text === message && now - lastToast.at < 3000) return;
  lastToast = { text: message, at: now };
  toast(message);
}

/** every track one step taller (1) or shorter (-1). already at the end: says so */
export function stepTrackHeights(dir: 1 | -1): void {
  const p = useEditor.getState().project;
  if (!p) return;
  const patch = stepHeights(p.tracks, dir);
  if (Object.keys(patch).length === 0) toastOnce(dir > 0 ? REASON_TEXT.tracksTallest : REASON_TEXT.tracksShortest);
  else useEditor.getState().setTrackHeights(patch);
}

/** every track back to its normal height */
export function normalTrackHeights(): void {
  const p = useEditor.getState().project;
  if (!p) return;
  const patch = normalHeights(p.tracks);
  if (Object.keys(patch).length === 0) toast(REASON_TEXT.tracksNormal);
  else useEditor.getState().setTrackHeights(patch);
}

/** one track's height. null: back to normal */
export function setTrackHeight(trackId: string, h: number | null): void {
  if (!useEditor.getState().project) return;
  useEditor.getState().setTrackHeights({ [trackId]: h });
}

/** a track one place up (-1) or down (1) inside its kind. a locked track stays, the end of its kind says so */
export function moveTrackStep(trackId: string, dir: -1 | 1): void {
  const p = useEditor.getState().project;
  if (!p) return;
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t) return;
  if (t.locked) {
    toast(REASON_TEXT.trackLocked);
    return;
  }
  const to = stepIndex(p.tracks, trackId, dir);
  if (to === null) toast(dir < 0 ? REASON_TEXT.trackTop : REASON_TEXT.trackBottom);
  else useEditor.getState().moveTrack(trackId, to);
}

/** the first track that holds a selected clip */
export function moveSelectedTrack(dir: -1 | 1): void {
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return;
  const id = tracksOf(p, st.selection)[0];
  if (id === undefined) toast(REASON_TEXT.selectClip);
  else moveTrackStep(id, dir);
}

/** the sync lock of these tracks. on missing: all on goes off for all, else all go on. one undo step */
export function toggleSyncLock(trackIds: readonly string[], on?: boolean): void {
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return;
  const listed = p.tracks.filter((t) => trackIds.includes(t.id));
  const target = on ?? !listed.every(syncLockOf);
  const changed = listed.filter((t) => syncLockOf(t) !== target);
  if (changed.length === 0) return;
  st.pushHistory();
  for (const t of changed) useEditor.getState().updateTrack(t.id, { syncLock: target }, { skipHistory: true });
  toast(`sync lock ${target ? 'on' : 'off'}: ${changed.map((t) => t.name).join(', ')}`);
}

/** the sync lock of the tracks that hold a selected clip */
export function toggleSelectedSyncLock(): void {
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return;
  const ids = tracksOf(p, st.selection);
  if (ids.length === 0) toast(REASON_TEXT.selectClip);
  else toggleSyncLock(ids);
}
