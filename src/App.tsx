import { Suspense, lazy, useEffect, useState } from 'react';
import { Toasts } from './components/ui/Toasts';
import { loadEditorLayout, preloadEditor } from './features/editor/loadEditor';
import { ProjectsScreen } from './features/projects/ProjectsScreen';
import { useEditor } from './store/editorStore';
import { closeProject, openProjectById, projectIdFromHash } from './store/session';

// the editor is its own chunk (the projects screen is all that is needed to start). preloadEditor() is called as soon as
// a project is known to open, so the chunk loads while the project's data is read
const EditorLayout = lazy(() => loadEditorLayout().then((m) => ({ default: m.EditorLayout })));

/** routes between the projects screen and the editor based on the url hash (#/project/<id>) */
export function App() {
  const hasProject = useEditor((s) => s.project !== null);
  const [booting, setBooting] = useState(() => projectIdFromHash() !== null);

  useEffect(() => {
    let cancelled = false;
    const sync = async () => {
      const id = projectIdFromHash();
      const openId = useEditor.getState().project?.id ?? null;
      if (id === openId) {
        setBooting(false);
        return;
      }
      if (id) {
        const ok = await openProjectById(id).catch(() => false);
        if (!ok && !cancelled) history.replaceState(null, '', location.pathname + location.search);
      } else {
        await closeProject();
      }
      if (!cancelled) setBooting(false);
    };
    void sync();
    // a pointer going down on a project card: the project will open, fetch the editor now (the data read takes longer)
    const warmEditor = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest('.projects-card')) preloadEditor();
    };
    window.addEventListener('pointerdown', warmEditor, true);
    // a file dropped outside a drop zone would make the browser open it and leave the editor
    const blockFileNav = (e: DragEvent) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', blockFileNav);
    window.addEventListener('drop', blockFileNav);
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      cancelled = true;
      window.removeEventListener('pointerdown', warmEditor, true);
      window.removeEventListener('dragover', blockFileNav);
      window.removeEventListener('drop', blockFileNav);
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, []);

  return (
    <>
      {booting ? (
        <div className="empty">loading...</div>
      ) : hasProject ? (
        <Suspense fallback={<div className="empty">loading...</div>}>
          <EditorLayout />
        </Suspense>
      ) : (
        <ProjectsScreen />
      )}
      <Toasts />
    </>
  );
}
