/**
 * math of the output view's zoom and pan. pure, no dom.
 *
 * a zoom is 'fit' (the largest project-aspect rect that fits the panel) or a scale: css pixels per output pixel
 * (1 = 100 %, one output pixel is one css pixel). the pan is the offset of the canvas center from the panel center, css px.
 */

export type Zoom = 'fit' | number;

/** the zoom steps of the wheel, the menu and the step helpers (1 = 100 %) */
export const ZOOM_STEPS: readonly number[] = [0.25, 0.33, 0.5, 0.67, 1, 1.5, 2, 3, 4, 8];
export const MIN_ZOOM = ZOOM_STEPS[0]!;
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
/** how far past the edge of a zoomed canvas the pan may go, css px (so the edge can be brought to the middle of a corner) */
export const PAN_MARGIN = 32;

const EPS = 1.001;

/** scale of the fitted canvas: output pixels to css pixels */
export function fitScale(stageW: number, stageH: number, projW: number, projH: number): number {
  if (!(stageW > 0 && stageH > 0 && projW > 0 && projH > 0)) return 1;
  return Math.min(stageW / projW, stageH / projH);
}

export function resolveScale(zoom: Zoom, fit: number): number {
  return zoom === 'fit' ? fit : clampScale(zoom);
}

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

/** a scale that is within a hair of the fitted one is the fitted one */
export function normalizeZoom(scale: number, fit: number): Zoom {
  const s = clampScale(scale);
  return fit > 0 && Math.abs(s - fit) / fit < 0.01 ? 'fit' : s;
}

/**
 * the next step above (dir 1) or below (dir -1) a scale. stepping down onto or past the fitted size lands on 'fit';
 * at the ends of the range the zoom stays where it is.
 */
export function stepZoom(scale: number, dir: 1 | -1, fit: number): Zoom {
  if (dir > 0) {
    const next = ZOOM_STEPS.find((s) => s > scale * EPS);
    return next === undefined ? normalizeZoom(scale, fit) : normalizeZoom(next, fit);
  }
  let prev: number | undefined;
  for (const s of ZOOM_STEPS) if (s < scale / EPS) prev = s;
  if (scale > fit * EPS) {
    // zoomed in: the fitted size is the floor of the steps
    return prev === undefined || prev <= fit * EPS ? 'fit' : normalizeZoom(prev, fit);
  }
  // on the fitted size: nowhere lower to go. a size picked from the menu below the fitted one steps on down
  if (scale >= fit / EPS) return 'fit';
  return prev === undefined ? normalizeZoom(scale, fit) : normalizeZoom(prev, fit);
}

/**
 * the pan that keeps the output point under the pointer where it is while the scale changes by `k`.
 * `dx` / `dy` = pointer minus the canvas center, css px, before the change.
 */
export function zoomPan(panX: number, panY: number, dx: number, dy: number, k: number): { panX: number; panY: number } {
  return { panX: panX + dx * (1 - k), panY: panY + dy * (1 - k) };
}

function clampAxis(pan: number, frame: number, stage: number, margin: number): number {
  if (!(frame > stage)) return 0;
  const limit = (frame - stage) / 2 + margin;
  return Math.min(limit, Math.max(-limit, pan));
}

/**
 * keep the canvas from being lost: a canvas that fits the panel on an axis stays centered there, a larger one may
 * be moved until its edge is `margin` px past the panel edge.
 */
export function clampPan(panX: number, panY: number, frameW: number, frameH: number, stageW: number, stageH: number, margin = PAN_MARGIN): { panX: number; panY: number } {
  return { panX: clampAxis(panX, frameW, stageW, margin), panY: clampAxis(panY, frameH, stageH, margin) };
}

/** "43%" for a scale */
export function percentLabel(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

/** wheel delta in pixels whatever the delta mode (0 pixels, 1 lines, 2 pages) */
export function wheelPixels(deltaY: number, deltaMode: number): number {
  return deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 100 : deltaY;
}

/** how much wheel travel is one zoom step (a mouse notch is a step, a trackpad pinch adds up to one) */
export const WHEEL_STEP_PX = 60;

/**
 * adds a wheel delta to the running total and says whether a zoom step is due: -1 = zoom in (wheel up), 1 = zoom out,
 * 0 = not yet. the total restarts after a step.
 */
export function accumulateWheel(acc: number, delta: number): { acc: number; step: -1 | 0 | 1 } {
  const next = acc + delta;
  if (next <= -WHEEL_STEP_PX) return { acc: 0, step: -1 };
  if (next >= WHEEL_STEP_PX) return { acc: 0, step: 1 };
  return { acc: next, step: 0 };
}
