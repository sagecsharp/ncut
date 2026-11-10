/** small ui state shared across features: which dialogs are open, toasts. */
import { create } from 'zustand';
import { uid } from '../lib/id';

export type DialogName = 'export' | 'settings' | 'shortcuts';

export interface Toast {
  id: string;
  kind: 'info' | 'error' | 'success';
  message: string;
}

/** 'output' = what gets exported. 'scene' = the 3d world seen from a free editor camera. */
export type PreviewMode = 'output' | 'scene';

export interface UiState {
  dialog: DialogName | null;
  toasts: Toast[];
  previewMode: PreviewMode;
  setPreviewMode(mode: PreviewMode): void;
  openDialog(name: DialogName): void;
  closeDialog(): void;
  /** show a short message bottom-center. auto-dismisses. */
  toast(message: string, kind?: Toast['kind']): void;
  dismissToast(id: string): void;
}

export const useUi = create<UiState>()((set, get) => ({
  dialog: null,
  toasts: [],
  previewMode: 'output',
  setPreviewMode(mode) {
    if (get().previewMode !== mode) set({ previewMode: mode });
  },
  openDialog(name) {
    set({ dialog: name });
  },
  closeDialog() {
    set({ dialog: null });
  },
  toast(message, kind = 'info') {
    const id = uid('tst');
    set({ toasts: [...get().toasts, { id, kind, message }].slice(-4) });
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 6000 : 3000);
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));
