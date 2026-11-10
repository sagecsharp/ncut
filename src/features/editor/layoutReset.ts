/** reset the panel sizes. kept apart from EditorLayout so the settings dialog can import it without a cycle. */
export const LAYOUT_STORAGE_KEY = 'ncut.layout';
export const LAYOUT_RESET_EVENT = 'ncut:reset-layout';

/** forget the saved panel sizes and tell the mounted editor to go back to the defaults */
export function resetLayout(): void {
  try {
    localStorage.removeItem(LAYOUT_STORAGE_KEY);
  } catch {
    // ignore
  }
  window.dispatchEvent(new Event(LAYOUT_RESET_EVENT));
}
