/**
 * pure scroll rules for keeping the playhead in view. time can run forward, backwards and fast
 * (usePlayback rate), so the page that scrolls in is always placed in the direction of travel.
 */

/** px kept between the playhead and the edge it is heading for after a page scroll */
export const FOLLOW_LEAD = 40;
/** px at the right edge that count as "about to leave" */
export const FOLLOW_EDGE = 6;

/**
 * the scrollLeft to use so the playhead at lane x `x` stays visible, or null when it already is.
 * playing forward the playhead lands near the left edge, backwards near the right edge, so the
 * page lasts as long as possible. paused (a seek, a step) it is centered.
 * `rate` is usePlayback's rate (negative = backwards).
 */
export function followScrollLeft(x: number, scrollLeft: number, width: number, playing: boolean, rate: number): number | null {
  if (x >= scrollLeft && x <= scrollLeft + width - FOLLOW_EDGE) return null;
  let next: number;
  if (!playing) next = x - width / 2;
  else if (rate < 0) next = x - (width - FOLLOW_LEAD - FOLLOW_EDGE);
  else next = x - FOLLOW_LEAD;
  return Math.max(0, next);
}

/**
 * the scrollLeft that brings the lane range [x0, x1] into view, or null when it already is visible.
 * a range wider than the view shows its start.
 */
export function revealScrollLeft(x0: number, x1: number, scrollLeft: number, width: number): number | null {
  const pad = 40;
  if (x0 >= scrollLeft && x1 <= scrollLeft + width) return null;
  if (x1 - x0 + pad * 2 >= width) return Math.max(0, x0 - pad);
  return Math.max(0, (x0 + x1) / 2 - width / 2);
}

/**
 * how far to scroll sideways or down so a box [top, bottom] fits the port [portTop, portBottom]
 * (same numbers as scrollIntoView with block "nearest"): 0 when it is already in view or bigger than the
 * port on both sides, else the smallest move that brings the nearest edge in.
 */
export function nearestScrollDelta(top: number, bottom: number, portTop: number, portBottom: number): number {
  const above = top < portTop;
  const below = bottom > portBottom;
  if (above === below) return 0; // fully inside, or covers the port
  const fits = bottom - top <= portBottom - portTop;
  if (above) return fits ? top - portTop : bottom - portBottom;
  return fits ? bottom - portBottom : top - portTop;
}
