/** small ui state shared across features: which dialogs are open, toasts. */
import { create } from 'zustand';
import { uid } from '../lib/id';

export type DialogName = 'export' | 'settings' | 'shortcuts';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: string;
  kind: 'info' | 'error' | 'success';
  message: string;
  /** a button on the toast. a toast with one stays 10 s */
  action?: ToastAction;
}

/** 'output' = what gets exported. 'scene' = the 3d world seen from a free editor camera. */
export type PreviewMode = 'output' | 'scene';

export interface UiState {
  dialog: DialogName | null;
  toasts: Toast[];
  previewMode: PreviewMode;
  projectsVersion: number;
  /** the properties panel shows the project (canvas, sky, fog, light) while a clip is selected */
  projectPanel: boolean;
  /** a section the properties panel should open, scroll to and focus. n counts up so the same id can be asked twice */
  reveal: { id: string; n: number } | null;
  showProjectPanel(on: boolean): void;
  revealSection(id: string): void;
  setPreviewMode(mode: PreviewMode): void;
  /** bumped when stored projects change outside the projects screen (mcp) */
  projectsChanged(): void;
  openDialog(name: DialogName): void;
  closeDialog(): void;
  /** show a short message bottom-center. auto-dismisses. */
  toast(message: string, kind?: Toast['kind'], action?: ToastAction): void;
  dismissToast(id: string): void;
}

/** the same ids, in any order */
export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id)) && new Set(b).size === set.size;
}

export const useUi = create<UiState>()((set, get) => ({
  dialog: null,
  toasts: [],
  previewMode: 'output',
  projectsVersion: 0,
  projectPanel: false,
  reveal: null,
  showProjectPanel(on) {
    if (get().projectPanel !== on) set({ projectPanel: on });
  },
  revealSection(id) {
    set({ reveal: { id, n: (get().reveal?.n ?? 0) + 1 } });
  },
  setPreviewMode(mode) {
    if (get().previewMode !== mode) set({ previewMode: mode });
  },
  projectsChanged() {
    set({ projectsVersion: get().projectsVersion + 1 });
  },
  openDialog(name) {
    set({ dialog: name });
  },
  closeDialog() {
    set({ dialog: null });
  },
  toast(message, kind = 'info', action) {
    const id = uid('tst');
    const t: Toast = action ? { id, kind, message, action } : { id, kind, message };
    set({ toasts: [...get().toasts, t].slice(-4) });
    setTimeout(() => get().dismissToast(id), action ? 10000 : kind === 'error' ? 6000 : 3000);
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));
