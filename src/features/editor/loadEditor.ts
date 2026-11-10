/**
 * the editor screen is its own chunk: the projects screen does not need it. the import is started as soon as it is
 * known that a project will open (url hash, a pointer going down on a project card, a file handed over by the
 * shell), so the chunk loads while the project's data is read. calling it again is free (the module is cached).
 */
export const loadEditorLayout = () => import('./EditorLayout');

/** start the download without caring about the result (a failure shows up when React.lazy asks for it) */
export function preloadEditor(): void {
  loadEditorLayout().catch(() => {});
}
