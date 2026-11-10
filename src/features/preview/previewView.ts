/**
 * zoom and pan of the output view (not the scene view, which has its own camera). module level, not persisted, and
 * back to 'fit' when another project opens.
 *
 * Preview.tsx measures the panel and applies the view to the canvas frame's css box; the overlays measure that box,
 * so they follow without knowing about zoom.
 */
import { create } from 'zustand';
import { useEditor } from '../../store/editorStore';
import { type Zoom, clampPan, resolveScale, stepZoom, zoomPan } from './zoomMath';

interface ViewState {
  zoom: Zoom;
  /** offset of the canvas center from the panel center, css px */
  panX: number;
  panY: number;
  /** the scale in effect (css px per output px), written by the layout; the zoom control shows it */
  scale: number;
  reset(): void;
}

export const usePreviewView = create<ViewState>((set) => ({
  zoom: 'fit',
  panX: 0,
  panY: 0,
  scale: 1,
  reset() {
    set({ zoom: 'fit', panX: 0, panY: 0 });
  },
}));

/** what the layout last measured: the panel's content box and the fitted scale */
export const viewMetrics = { stageW: 0, stageH: 0, fit: 1 };

/** canvas css size at a zoom for the open project (fit uses the measured fitted scale) */
function frameSize(zoom: Zoom): { w: number; h: number } | null {
  const p = useEditor.getState().project;
  if (!p) return null;
  const k = resolveScale(zoom, viewMetrics.fit);
  return { w: Math.max(1, Math.floor(p.width * k)), h: Math.max(1, Math.floor(p.height * k)) };
}

/** set zoom and pan together; the pan is clamped for the new size and 'fit' always sits in the middle */
export function setView(zoom: Zoom, panX = 0, panY = 0): void {
  const size = frameSize(zoom);
  let x = 0;
  let y = 0;
  if (zoom !== 'fit' && size) {
    const c = clampPan(panX, panY, size.w, size.h, viewMetrics.stageW, viewMetrics.stageH);
    x = c.panX;
    y = c.panY;
  }
  const s = usePreviewView.getState();
  if (s.zoom === zoom && s.panX === x && s.panY === y) return;
  usePreviewView.setState({ zoom, panX: x, panY: y });
}

/** move the canvas, keeping it reachable */
export function setPan(panX: number, panY: number): void {
  setView(usePreviewView.getState().zoom, panX, panY);
}

/**
 * change the zoom keeping one point still: `dx` / `dy` = that point minus the canvas center (css px). without a
 * point the middle of the panel stays where it is.
 */
export function zoomTo(zoom: Zoom, dx?: number, dy?: number): void {
  const s = usePreviewView.getState();
  const s0 = resolveScale(s.zoom, viewMetrics.fit);
  const s1 = resolveScale(zoom, viewMetrics.fit);
  const p = zoomPan(s.panX, s.panY, dx ?? -s.panX, dy ?? -s.panY, s0 > 0 ? s1 / s0 : 1);
  setView(zoom, p.panX, p.panY);
}

/** one step in or out (see stepZoom) around a point */
export function stepView(dir: 1 | -1, dx?: number, dy?: number): void {
  const s = usePreviewView.getState();
  zoomTo(stepZoom(resolveScale(s.zoom, viewMetrics.fit), dir, viewMetrics.fit), dx, dy);
}

// another project: look at the whole picture again
useEditor.subscribe((s, p) => {
  if (s.project?.id !== p.project?.id) usePreviewView.getState().reset();
});
