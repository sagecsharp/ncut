/**
 * which track a three point edit lands on, per part of the media. runtime only, never saved: another
 * project reads auto. no localStorage, no side effect at import.
 */
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { Track } from '../../types';
import { useEditor } from '../../store/editorStore';
import { AUTO_TARGETS, targetTrackId } from './editPlan';
import type { EditTarget, EditTargets } from './editPlan';

export interface EditTargetsState {
  projectId: string | null; // another project reads auto
  picture: EditTarget;
  sound: EditTarget;
  set(projectId: string, part: 'picture' | 'sound', t: EditTarget): void; // a new projectId starts from auto; no write when equal
  reset(): void; // projectId null, both null
}

export const useEditTargets = create<EditTargetsState>()((set, get) => ({
  projectId: null,
  picture: null,
  sound: null,
  set(pid, part, t) {
    const s = get();
    if (currentTargets(pid)[part] === t) return;
    const same = s.projectId === pid;
    set({ projectId: pid, picture: same ? s.picture : null, sound: same ? s.sound : null, [part]: t });
  },
  reset() {
    set({ projectId: null, picture: null, sound: null });
  },
}));

/** the targets of a project: auto for any other project than the stored one */
export function currentTargets(projectId: string | null): EditTargets {
  const s = useEditTargets.getState();
  return projectId !== null && s.projectId === projectId ? { picture: s.picture, sound: s.sound } : AUTO_TARGETS;
}

const partOf = (kind: Track['kind']): 'picture' | 'sound' => (kind === 'video' ? 'picture' : 'sound');

/** the open project. no write when equal. nothing without a project */
export function setEditTarget(part: 'picture' | 'sound', t: EditTarget): void {
  const pid = useEditor.getState().project?.id;
  if (!pid) return;
  useEditTargets.getState().set(pid, part, t);
}

export function resetEditTargets(): void {
  useEditTargets.getState().reset();
}

/** lit turns off (also on a locked track). unlit and locked: false, no change (the caller toasts). else the track is the target. true when it acted */
export function toggleTargetOf(track: Pick<Track, 'id' | 'kind' | 'locked'>): boolean {
  const p = useEditor.getState().project;
  if (!p) return false;
  const part = partOf(track.kind);
  const lit = targetTrackId(p.tracks, track.kind, currentTargets(p.id)[part]) === track.id;
  if (lit) {
    setEditTarget(part, false);
    return true;
  }
  if (track.locked) return false;
  setEditTarget(part, track.id);
  return true;
}

/** is this track the lit target of its part. primitives only */
export function useIsTarget(track: Pick<Track, 'id' | 'kind'>): boolean {
  const part = partOf(track.kind);
  const pid = useEditor((s) => s.project?.id ?? null);
  const t = useEditTargets((s) => (s.projectId === pid ? s[part] : null));
  return useEditor((s) => !!s.project && targetTrackId(s.project.tracks, track.kind, t) === track.id);
}

export function useTargets(): EditTargets {
  const pid = useEditor((s) => s.project?.id ?? null);
  return useEditTargets(useShallow((s): EditTargets => (pid !== null && s.projectId === pid ? { picture: s.picture, sound: s.sound } : AUTO_TARGETS)));
}
