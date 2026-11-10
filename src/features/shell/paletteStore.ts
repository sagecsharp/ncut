import { create } from 'zustand';

/** open state of the command palette (own store: the shortcut table opens it without importing react) */
export const usePalette = create<{ open: boolean }>(() => ({ open: false }));

export const openPalette = (): void => usePalette.setState({ open: true });
export const closePalette = (): void => usePalette.setState({ open: false });
