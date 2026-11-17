/** tracks on solo: listening only. never saved, never in the history, never in the export. */
import { create } from 'zustand';
import { useEditor } from './editorStore';
import { sameIds } from './ui';
import { soundTracksOf, toggledSolo } from '../lib/mix';

export interface SoloState {
  /** track ids on solo. listening only: never saved, never in the history, never in the export */
  solo: readonly string[];
  toggleSolo(trackId: string, only?: boolean): void;
  setSolo(ids: readonly string[]): void;
  clearSolo(): void;
}

export const useSolo = create<SoloState>()((set, get) => ({
  solo: [],
  toggleSolo: (trackId, only) => {
    get().setSolo(toggledSolo(get().solo, trackId, !!only));
  },
  setSolo: (ids) => {
    const next = [...new Set(ids)];
    if (sameIds(get().solo, next)) return;
    set({ solo: next });
  },
  clearSolo: () => {
    if (get().solo.length === 0) return;
    set({ solo: [] });
  },
}));

/** solo the tracks of the selected clips, or every track again when exactly those are on solo */
export function soloSelectedTracks(): void {
  const { project, selection } = useEditor.getState();
  if (!project) return;
  const ids = soundTracksOf(project, selection);
  if (ids.length === 0) return;
  const st = useSolo.getState();
  if (sameIds(st.solo, ids)) st.clearSolo();
  else st.setSolo(ids);
}

// a new project starts with nothing on solo
useEditor.subscribe((s, prev) => {
  if (s.project?.id !== prev.project?.id) useSolo.getState().clearSolo();
});
