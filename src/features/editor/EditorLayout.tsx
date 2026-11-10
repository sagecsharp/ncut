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
import { LAYOUT_RESET_EVENT, LAYOUT_STORAGE_KEY as STORAGE_KEY } from './layoutReset';
import './editor.css';

interface Sizes {
  left: number;
  right: number;
  bottom: number;
}

/** the five media tabs need about 280px */
export const MIN_LEFT = 280;

const DEFAULTS: Sizes = { left: 300, right: 300, bottom: 320 };

/** single source of the panel limits. also used on load and when the window shrinks */
function clampSizes(s: Sizes): Sizes {
  const fin = (v: number, d: number) => (Number.isFinite(v) ? v : d);
  return {
    left: clamp(fin(s.left, DEFAULTS.left), MIN_LEFT, Math.max(MIN_LEFT, window.innerWidth * 0.4)),
    right: clamp(fin(s.right, DEFAULTS.right), 280, Math.max(280, window.innerWidth * 0.4)),
    bottom: clamp(fin(s.bottom, DEFAULTS.bottom), 140, Math.max(140, window.innerHeight - 220)),
  };
}

function loadSizes(): Sizes {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return clampSizes({ ...DEFAULTS, ...(JSON.parse(raw) as Partial<Sizes>) });
  } catch {
    // ignore
  }
  return clampSizes(DEFAULTS);
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

  useEffect(() => {
    const onResize = () =>
      setSizes((s) => {
        const n = clampSizes(s);
        return n.left === s.left && n.right === s.right && n.bottom === s.bottom ? s : n;
      });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // settings > reset layout: the saved sizes are already cleared, go back to the defaults
  useEffect(() => {
    const onReset = () => setSizes(clampSizes(DEFAULTS));
    window.addEventListener(LAYOUT_RESET_EVENT, onReset);
    return () => window.removeEventListener(LAYOUT_RESET_EVENT, onReset);
  }, []);

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
    const raw = d.edge === 'left' ? d.startSize + delta : d.startSize - delta;
    const next = clampSizes({ ...DEFAULTS, [d.edge]: raw })[d.edge];
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
