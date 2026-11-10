/**
 * dialogs that only open on demand are separate chunks. the loaders are shared so the same import() can also be
 * started early (idle time after the editor opened, pointer over the button): a second call costs nothing.
 */
export const loadCommandPalette = () => import('./CommandPalette');
export const loadShortcutsDialog = () => import('./ShortcutsDialog');
export const loadProjectSettingsDialog = () => import('./ProjectSettingsDialog');
export const loadExportDialog = () => import('../export/ExportDialog');

/** start all of them when the browser has nothing better to do, so the first open has no wait */
export function preloadDialogsWhenIdle(): () => void {
  const run = () => {
    for (const load of [loadCommandPalette, loadShortcutsDialog, loadProjectSettingsDialog, loadExportDialog]) {
      load().catch(() => {});
    }
  };
  const w = globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
  if (typeof w.requestIdleCallback === 'function') {
    const id = w.requestIdleCallback(run, { timeout: 3000 });
    return () => w.cancelIdleCallback?.(id);
  }
  const t = setTimeout(run, 1500);
  return () => clearTimeout(t);
}
