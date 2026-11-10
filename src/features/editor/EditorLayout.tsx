import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { FpsCounter } from '../../components/ui/FpsCounter';
import { clamp } from '../../lib/time';
import { useUi } from '../../store/ui';
import { MediaPanel } from '../media/MediaPanel';
import { Preview } from '../preview/Preview';
import { PropertiesPanel } from '../properties/PropertiesPanel';
import { Header } from '../shell/Header';
import { loadExportDialog, loadProjectSettingsDialog, loadShortcutsDialog, preloadDialogsWhenIdle } from '../shell/lazyDialogs';
import { useShortcuts } from '../shell/useShortcuts';
import { Timeline } from '../timeline/Timeline';
import { LAYOUT_RESET_EVENT, LAYOUT_STORAGE_KEY as STORAGE_KEY } from './layoutReset';
import './editor.css';

// dialogs are chunks of their own, fetched when first opened (and early, in idle time). a key that opens one only
// sets the store's dialog name, so the first press is never lost: the dialog shows as soon as its code is there
const ExportDialog = lazy(() => loadExportDialog().then((m) => ({ default: m.ExportDialog })));
const ProjectSettingsDialog = lazy(() => loadProjectSettingsDialog().then((m) => ({ default: m.ProjectSettingsDialog })));
const ShortcutsDialog = lazy(() => loadShortcutsDialog().then((m) => ({ default: m.ShortcutsDialog })));

interface Sizes {
  left: number;
  right: number;
  bottom: number;
}

/** the five media tabs need about 280px */
export const MIN_LEFT = 280;

const DEFAULTS: Sizes = { left: 300, right: 300, bottom: 320 };

/**
 * single source of the panel limits. the state (and what is saved) holds the sizes the user asked
 * for; this is applied on top when drawing, so a window that was small for a moment does not
 * shrink the panels for good.
 */
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
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Sizes>;
      const pick = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
      return { left: pick(saved.left, DEFAULTS.left), right: pick(saved.right, DEFAULTS.right), bottom: pick(saved.bottom, DEFAULTS.bottom) };
    }
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
  // bumped when the window changes size, so the limits are applied again
  const [, setViewport] = useState(0);
  const shown = clampSizes(sizes);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const dialog = useUi((s) => s.dialog);
  const closeDialog = useUi((s) => s.closeDialog);
  const drag = useRef<{ edge: Edge; startPos: number; startSize: number } | null>(null);

  useShortcuts();
  useEffect(() => preloadDialogsWhenIdle(), []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes));
    } catch {
      // ignore
    }
  }, [sizes]);

  useEffect(() => {
    const onResize = () => setViewport((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // settings > reset layout: the saved sizes are already cleared, go back to the defaults
  useEffect(() => {
    const onReset = () => setSizes(DEFAULTS);
    window.addEventListener(LAYOUT_RESET_EVENT, onReset);
    return () => window.removeEventListener(LAYOUT_RESET_EVENT, onReset);
  }, []);

  const onDown = useCallback(
    (edge: Edge) => (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { edge, startPos: edge === 'bottom' ? e.clientY : e.clientX, startSize: shownRef.current[edge] };
    },
    [],
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
        <div className="editor-pane" style={{ width: shown.left }}>
          <MediaPanel />
        </div>
        {splitter('left')}
        <div className="editor-pane editor-pane-grow">
          <Preview />
        </div>
        {splitter('right')}
        <div className="editor-pane" style={{ width: shown.right }}>
          <PropertiesPanel />
        </div>
      </div>
      {splitter('bottom')}
      <div className="editor-bottom" style={{ height: shown.bottom }}>
        <Timeline />
      </div>

      <FpsCounter />
      <Suspense fallback={null}>
        {dialog === 'export' ? <ExportDialog open onClose={closeDialog} /> : null}
        {dialog === 'settings' ? <ProjectSettingsDialog open onClose={closeDialog} /> : null}
        {dialog === 'shortcuts' ? <ShortcutsDialog open onClose={closeDialog} /> : null}
      </Suspense>
    </div>
  );
}
