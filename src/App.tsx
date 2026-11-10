import { useEffect, useState } from 'react';
import { Toasts } from './components/ui/Toasts';
import { EditorLayout } from './features/editor/EditorLayout';
import { ProjectsScreen } from './features/projects/ProjectsScreen';
import { useEditor } from './store/editorStore';
import { closeProject, openProjectById, projectIdFromHash } from './store/session';

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
      window.removeEventListener('dragover', blockFileNav);
      window.removeEventListener('drop', blockFileNav);
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, []);

  return (
    <>
      {booting ? <div className="empty">loading...</div> : hasProject ? <EditorLayout /> : <ProjectsScreen />}
      <Toasts />
    </>
  );
}
