/**
 * where an mcp cursor goes: a target (src/mcp/cursor.ts) turned into a point on the screen. the arithmetic is pure
 * (boxes and numbers in, a point out); the lookup of the elements goes through a small `Dom` so it tests in node.
 * nothing here changes the user's view: a spot that is out of sight is clamped to the edge of its panel, the scroll
 * position and the zoom of the timeline are never touched.
 */
import type { Target } from '../../mcp/cursor';
import { HEADER_W, RULER_H } from '../timeline/layout';

/** how far the drawn arrow reaches right of and below its tip (the svg in McpCursors.tsx) */
export const ARROW_W = 14;
export const ARROW_H = 21;

export interface Point {
  x: number;
  y: number;
}

/** what getBoundingClientRect gives (a DOMRect fits) */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

// ---------- pure arithmetic ----------

export function boxCenter(b: Box): Point {
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
}

/** a point inside the box (on its edge when it was outside) */
export function clampPoint(p: Point, b: Box): Point {
  return {
    x: Math.min(b.left + Math.max(0, b.width), Math.max(b.left, p.x)),
    y: Math.min(b.top + Math.max(0, b.height), Math.max(b.top, p.y)),
  };
}

/** the part two boxes share, or null when they do not touch */
export function intersect(a: Box, b: Box): Box | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (right < left || bottom < top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * the spot to point at on `box` while only `bounds` is in sight: the middle of the visible part, and for a box that
 * is out of sight the point of the bounds that is closest to it
 */
export function visibleSpot(box: Box, bounds: Box): Point {
  const part = intersect(box, bounds);
  return part ? boxCenter(part) : clampPoint(boxCenter(box), bounds);
}

/** screen x of a timeline time: the lane area starts at originX (screen), the timeline is scrolled by scrollLeft px */
export function timeToX(time: number, zoom: number, scrollLeft: number, originX: number): number {
  return originX + time * zoom - scrollLeft;
}

/**
 * screen point of a canvas point. `frame` is the project frame on screen (the canvas element), x / y are project
 * pixels with 0 / 0 in the middle.
 */
export function canvasToScreen(x: number, y: number, frame: Box, projectW: number, projectH: number): Point {
  const w = projectW > 0 ? projectW : 1;
  const h = projectH > 0 ? projectH : 1;
  return {
    x: frame.left + frame.width / 2 + (x * frame.width) / w,
    y: frame.top + frame.height / 2 + (y * frame.height) / h,
  };
}

/** where a cursor that never had a spot starts: the top middle of the window */
export function topMiddle(winW: number): Point {
  return { x: winW / 2, y: 0 };
}

/** a point inside a box at fractions of its size (0.5 / 0.5 is the middle) */
export function anchorPoint(b: Box, fx: number, fy: number): Point {
  return { x: b.left + b.width * fx, y: b.top + b.height * fy };
}

// ---------- the dom ----------

export interface Elem {
  getBoundingClientRect(): Box;
}

/** the part of the document the lookup needs */
export interface Dom {
  query(selector: string): Elem | null;
}

/** everything the lookup reads besides the elements */
export interface Env {
  dom: Dom;
  win: { width: number; height: number };
  /** timeline pixels per second (the editor store's zoom) */
  zoom: number;
  /** the timeline's horizontal scroll (timeline/view.ts) */
  scrollLeft: number;
  /** the open project's size, null when none is open */
  project: { width: number; height: number } | null;
  /** a clip of the open project (the lane of a clip that is not mounted is worked out from this) */
  clip(id: string): { start: number; duration: number; trackId: string } | undefined;
}

/**
 * inside a double quoted attribute selector. a quote and a backslash get a backslash; a control character (a newline in
 * a quoted css string is a syntax error) is written as a hex escape, which css ends with a space
 */
export function esc(s: string): string {
  return s.replace(/["\\\u0000-\u001f\u007f]/g, (ch) => (ch === '"' || ch === '\\' ? '\\' + ch : '\\' + ch.charCodeAt(0).toString(16) + ' '));
}

/** the box of an element, null when it is not there or has no size (display none) */
function boxOf(dom: Dom, selector: string): Box | null {
  let el: Elem | null;
  try {
    el = dom.query(selector);
  } catch {
    // an id the selector syntax can not hold: the element is not there
    return null;
  }
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** the part of the timeline where clips are seen: below the ruler, right of the headers */
function lanesBounds(scroller: Box): Box {
  return {
    left: scroller.left + HEADER_W,
    top: scroller.top + RULER_H,
    width: Math.max(0, scroller.width - HEADER_W),
    height: Math.max(0, scroller.height - RULER_H),
  };
}

function locateClip(id: string, env: Env): Point | null {
  const scroller = boxOf(env.dom, '.timeline-scroller');
  const bounds = scroller ? lanesBounds(scroller) : null;
  const own = boxOf(env.dom, `[data-clip-id="${esc(id)}"]`);
  if (own) return bounds ? visibleSpot(own, bounds) : boxCenter(own);
  // a lane with many clips only mounts the ones in view: work the place out from the store
  const clip = env.clip(id);
  if (!clip || !scroller || !bounds) return null;
  const lane = boxOf(env.dom, `.timeline-lane[data-track-id="${esc(clip.trackId)}"]`);
  if (!lane) return null;
  const left = timeToX(clip.start, env.zoom, env.scrollLeft, scroller.left + HEADER_W);
  return visibleSpot({ left, top: lane.top, width: Math.max(2, clip.duration * env.zoom), height: lane.height }, bounds);
}

function locateTrack(id: string, env: Env): Point | null {
  const scroller = boxOf(env.dom, '.timeline-scroller');
  const head = boxOf(env.dom, `.timeline-head[data-track-id="${esc(id)}"]`);
  if (head) {
    if (!scroller) return boxCenter(head);
    return visibleSpot(head, { left: scroller.left, top: scroller.top + RULER_H, width: HEADER_W, height: Math.max(0, scroller.height - RULER_H) });
  }
  const lane = boxOf(env.dom, `.timeline-lane[data-track-id="${esc(id)}"]`);
  if (!lane || !scroller) return null;
  return visibleSpot(lane, lanesBounds(scroller));
}

function locateTime(time: number, env: Env): Point | null {
  const scroller = boxOf(env.dom, '.timeline-scroller');
  const ruler = boxOf(env.dom, '.timeline-ruler');
  if (!scroller || !ruler) return null;
  const x = timeToX(time, env.zoom, env.scrollLeft, scroller.left + HEADER_W);
  const bounds = lanesBounds(scroller);
  return { x: clampPoint({ x, y: 0 }, bounds).x, y: ruler.top + ruler.height / 2 };
}

function locateCanvas(x: number, y: number, env: Env): Point | null {
  const frame = boxOf(env.dom, '.preview-frame');
  if (!frame || !env.project) return null;
  const p = canvasToScreen(x, y, frame, env.project.width, env.project.height);
  const stage = boxOf(env.dom, '.preview-stage');
  return stage ? clampPoint(p, stage) : p;
}

function locateMedia(id: string | undefined, env: Env): Point | null {
  const panel = boxOf(env.dom, '.media-panel');
  if (id !== undefined) {
    const card = boxOf(env.dom, `[data-asset-id="${esc(id)}"]`);
    if (card) return panel ? visibleSpot(card, panel) : boxCenter(card);
  }
  return panel ? anchorPoint(panel, 0.5, 0.3) : null;
}

const BUTTONS: Record<'undo' | 'redo' | 'export', string> = {
  undo: 'button[aria-label="undo"]',
  redo: 'button[aria-label="redo"]',
  export: '.shell-header .btn-primary',
};

function locateProjects(t: Extract<Target, { kind: 'projects' }>, env: Env): Point | null {
  if (t.id !== undefined) {
    const card = boxOf(env.dom, `[data-project-id="${esc(t.id)}"]`);
    if (card) return boxCenter(card);
  }
  if (t.create) {
    const b = boxOf(env.dom, 'button[title="new project (n)"]');
    if (b) return boxCenter(b);
  }
  const screen = boxOf(env.dom, '.projects');
  if (screen) return anchorPoint(screen, 0.5, 0.3);
  // the editor is open: the way back to the projects is its back button
  const back = boxOf(env.dom, 'button[aria-label="back to projects"]');
  return back ? boxCenter(back) : null;
}

/** the raw spot of a target, before it is kept inside the window */
function locateRaw(t: Target, env: Env): Point | null {
  switch (t.kind) {
    case 'clip':
      return locateClip(t.id, env);
    case 'clips':
      return t.ids[0] === undefined ? null : locateClip(t.ids[0], env);
    case 'track':
      return locateTrack(t.id, env);
    case 'time':
      return locateTime(t.time, env);
    case 'canvas':
      return locateCanvas(t.x, t.y, env);
    case 'preview': {
      const stage = boxOf(env.dom, '.preview-stage');
      return stage ? boxCenter(stage) : null;
    }
    case 'media':
      return locateMedia(t.id, env);
    case 'inspector': {
      const panel = boxOf(env.dom, '.props-panel');
      return panel ? anchorPoint(panel, 0.5, 0.25) : null;
    }
    case 'button': {
      const b = boxOf(env.dom, BUTTONS[t.which]);
      return b ? boxCenter(b) : null;
    }
    case 'projects':
      return locateProjects(t, env);
    case 'nowhere':
      return null;
  }
}

/**
 * the spot on the screen for a target, or null when it can not be found (the editor is not open, the element is not
 * there): the cursor then stays where it was
 */
export function locateTarget(t: Target, env: Env): Point | null {
  let p: Point | null;
  try {
    p = locateRaw(t, env);
  } catch {
    // never throw: one bad target must not stop the frame loop of the other cursors
    return null;
  }
  if (!p) return null;
  // the arrow is drawn right of and below its tip, so the tip keeps that much away from the right and bottom edge
  return clampPoint(p, {
    left: 0,
    top: 0,
    width: Math.max(0, env.win.width - ARROW_W),
    height: Math.max(0, env.win.height - ARROW_H),
  });
}
