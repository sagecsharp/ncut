import { useEditor } from '../../store/editorStore';
import { ClipInspector } from './ClipInspector';
import { MultiInspector } from './MultiInspector';
import { ProjectInspector } from './ProjectInspector';
import './properties.css';

/**
 * right panel. subscribes only to the selection size and first id (primitives), so it does not
 * re-render while clips are dragged around. the inspectors below subscribe to what they show.
 */
export function PropertiesPanel() {
  const hasProject = useEditor((s) => s.project !== null);
  const count = useEditor((s) => s.selection.length);
  const first = useEditor((s) => s.selection[0]);

  if (!hasProject) {
    return (
      <section className="panel props-panel">
        <div className="panel-header">
          <span className="panel-title">properties</span>
        </div>
        <div className="empty">no project open</div>
      </section>
    );
  }
  if (count === 0 || first === undefined) return <ProjectInspector />;
  if (count === 1) return <ClipInspector key={first} id={first} />;
  return <MultiInspector />;
}
