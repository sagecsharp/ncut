/**
 * shared, non-react view state of the timeline. scroll position and viewport size change at
 * scroll / resize rate, so they live outside react and canvases subscribe to them directly.
 *
 * coordinates: "lane x" = pixels from the left edge of the lane area (time * zoom). the headers
 * column is sticky and covers the first HEADER_W px of the scroller viewport, so the visible
 * lane range is [scrollLeft, scrollLeft + width].
 */

import { APPEARANCE_EVENT } from '../../lib/appearance';

export const view = {
  scrollLeft: 0,
  scrollTop: 0,
  /** width of the visible lane area (scroller client width minus the headers column) */
  width: 800,
  /** height of the scroller viewport */
  height: 300,
};

/** flags other parts of the timeline use to avoid fighting the user */
export const interaction = {
  /** a pointer gesture (drag, trim, scrub, marquee) is in progress */
  gestureActive: false,
  /** performance.now() until which the user is considered to be scrolling by hand */
  userScrollUntil: 0,
};

const listeners = new Set<() => void>();

export function subscribeView(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function notifyView(): void {
  for (const fn of listeners) fn();
}

export function markUserScroll(ms = 1200): void {
  interaction.userScrollUntil = performance.now() + ms;
}

export function resetView(): void {
  view.scrollLeft = 0;
  view.scrollTop = 0;
  interaction.gestureActive = false;
  interaction.userScrollUntil = 0;
}

const colorCache = new Map<string, string>();
let probe: HTMLSpanElement | null = null;

/**
 * value of a css custom property on :root for canvas drawing, cached until the theme changes.
 * color tokens are built from oklch() + calc() + var(), so they are resolved through a hidden
 * element to get a plain color string the canvas accepts.
 */
export function cssVar(name: string): string {
  let v = colorCache.get(name);
  if (v === undefined) {
    if (name.startsWith('--font')) {
      v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    } else {
      if (!probe) {
        probe = document.createElement('span');
        probe.style.display = 'none';
        document.body.appendChild(probe);
      }
      probe.style.color = `var(${name})`;
      v = getComputedStyle(probe).color;
    }
    colorCache.set(name, v);
  }
  return v;
}

let appearanceGen = 0;
/** bumps whenever theme / tint changes, so canvases can tell their pixels are stale */
export const getAppearanceGen = (): number => appearanceGen;

// theme / tint changed: drop cached colors and redraw every timeline canvas
if (typeof window !== 'undefined') {
  window.addEventListener(APPEARANCE_EVENT, () => {
    colorCache.clear();
    appearanceGen++;
    notifyView();
  });
}
