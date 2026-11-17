import { create } from 'zustand';

/** the move pivot mode: the selected clip's pivot is dragged on the preview, its other handles are hidden */
export const usePivotMode = create<{ on: boolean; set(on: boolean): void; toggle(): void }>((set, get) => ({
  on: false,
  set: (on) => set({ on }),
  toggle: () => set({ on: !get().on }),
}));
