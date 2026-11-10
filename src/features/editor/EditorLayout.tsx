import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { FpsCounter } from '../../components/ui/FpsCounter';
import { clamp } from '../../lib/time';
import { useUi } from '../../store/ui';
import { ExportDialog } from '../export/ExportDialog';
import { MediaPanel } from '../media/MediaPanel';
import { Preview } from '../preview/Preview';
import { PropertiesPanel } from '../properties/PropertiesPanel';
import { Header } from '../shell/Header';
import { ProjectSettingsDialog } from '../shell/ProjectSettingsDialog';
import { ShortcutsDialog } from '../shell/ShortcutsDialog';
import { useShortcuts } from '../shell/useShortcuts';
import { Timeline } from '../timeline/Timeline';
import './editor.css';

const STORAGE_KEY = 'ncut.layout';

interface Sizes {
  left: number;
  right: number;
  bottom: number;
}

const DEFAULTS: Sizes = { left: 300, right: 300, bottom: 320 };

function loadSizes(): Sizes {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Sizes>) };
  } catch {
    // ignore
  }
  return DEFAULTS;
}

type Edge = keyof Sizes;

/**
 * the editor screen:
 *
 *   header
 *   media | preview | properties
 *   ------ timeline ------
 *
 * the three splitters are draggable and remembered in localStorage.
 */
export function EditorLayout() {
  const [sizes, setSizes] = useState<Sizes>(loadSizes);
  const dialog = useUi((s) => s.dialog);
  const closeDialog = useUi((s) => s.closeDialog);
  const drag = useRef<{ edge: Edge; startPos: number; startSize: number } | null>(null);

  useShortcuts();

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes));
    } catch {
      // ignore
    }
  }, [sizes]);

  const onDown = useCallback(
    (edge: Edge) => (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { edge, startPos: edge === 'bottom' ? e.clientY : e.clientX, startSize: sizes[edge] };
    },
    [sizes],
  );

  const onMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const pos = d.edge === 'bottom' ? e.clientY : e.clientX;
    const delta = pos - d.startPos;
    let next: number;
    if (d.edge === 'left') next = clamp(d.startSize + delta, 200, Math.max(200, window.innerWidth * 0.4));
    else if (d.edge === 'right') next = clamp(d.startSize - delta, 220, Math.max(220, window.innerWidth * 0.4));
    else next = clamp(d.startSize - delta, 140, Math.max(140, window.innerHeight - 220));
    setSizes((s) => ({ ...s, [d.edge]: next }));
  }, []);

  const onUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    drag.current = null;
  }, []);

  const splitter = (edge: Edge) => (
    <div
      className={`splitter splitter-${edge === 'bottom' ? 'h' : 'v'}`}
      onPointerDown={onDown(edge)}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={() => setSizes((s) => ({ ...s, [edge]: DEFAULTS[edge] }))}
      role="separator"
      aria-orientation={edge === 'bottom' ? 'horizontal' : 'vertical'}
    />
  );

  return (
    <div className="editor">
      <Header />
      <div className="editor-top">
        <div className="editor-pane" style={{ width: sizes.left }}>
          <MediaPanel />
        </div>
        {splitter('left')}
        <div className="editor-pane editor-pane-grow">
          <Preview />
        </div>
        {splitter('right')}
        <div className="editor-pane" style={{ width: sizes.right }}>
          <PropertiesPanel />
        </div>
      </div>
      {splitter('bottom')}
      <div className="editor-bottom" style={{ height: sizes.bottom }}>
        <Timeline />
      </div>

      <FpsCounter />
      <ExportDialog open={dialog === 'export'} onClose={closeDialog} />
      <ProjectSettingsDialog open={dialog === 'settings'} onClose={closeDialog} />
      <ShortcutsDialog open={dialog === 'shortcuts'} onClose={closeDialog} />
    </div>
  );
}
