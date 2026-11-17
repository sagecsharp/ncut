/**
 * the pointer shapes of trim mode (trim 4.3): 24 x 24 drawings, a black stroke under a white one so they read on any
 * clip color. the one place with fixed colors: a cursor image cannot use the theme tokens.
 */
import type { TrimCursor } from './trimPress';

interface Shape { paths: string[]; hot: [number, number]; fallback: string }

const ARROW_R = 'M10 12 H19 M16 9 L19 12 L16 15';
const ARROW_L = 'M14 12 H5 M8 9 L5 12 L8 15';

const SHAPES: Record<Exclude<TrimCursor, 'blocked'>, Shape> = {
  'ripple-start': { paths: ['M10 6 H7 V18 H10', ARROW_R], hot: [7, 12], fallback: 'ew-resize' },
  'ripple-end': { paths: ['M14 6 H17 V18 H14', ARROW_L], hot: [17, 12], fallback: 'ew-resize' },
  'move-edit': { paths: ['M9 6 H11 V18 H9', 'M15 6 H13 V18 H15', 'M8 12 H3 M5.5 9.5 L3 12 L5.5 14.5', 'M16 12 H21 M18.5 9.5 L21 12 L18.5 14.5'], hot: [12, 12], fallback: 'col-resize' },
  'slip': { paths: ['M9 6 V18 M15 6 V18', 'M4 12 H20 M7 9 L4 12 L7 15 M17 9 L20 12 L17 15'], hot: [12, 12], fallback: 'ew-resize' },
  'slide': { paths: ['M8 8 H16 V16 H8 Z', 'M2.5 12 H6 M4 10 L2.5 12 L4 14', 'M21.5 12 H18 M20 10 L21.5 12 L20 14'], hot: [12, 12], fallback: 'move' },
  'stretch-start': { paths: ['M8 6 H5 V18 H8', 'M10 8 L14 12 L10 16 M15 8 L19 12 L15 16'], hot: [5, 12], fallback: 'ew-resize' },
  'stretch-end': { paths: ['M16 6 H19 V18 H16', 'M14 8 L10 12 L14 16 M9 8 L5 12 L9 16'], hot: [19, 12], fallback: 'ew-resize' },
};

function svgOf(paths: string[]): string {
  const head = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">';
  const under = paths.map((d) => `<path d="${d}" stroke="black" stroke-width="3.5"/>`).join('');
  const over = paths.map((d) => `<path d="${d}" stroke="white" stroke-width="1.5"/>`).join('');
  return head + under + over + '</svg>';
}

function cursorOf(s: Shape): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svgOf(s.paths))}") ${s.hot[0]} ${s.hot[1]}, ${s.fallback}`;
}

/** each value is a whole css cursor value */
export const TRIM_CURSORS: Record<TrimCursor, string> = {
  'ripple-start': cursorOf(SHAPES['ripple-start']),
  'ripple-end': cursorOf(SHAPES['ripple-end']),
  'move-edit': cursorOf(SHAPES['move-edit']),
  'slip': cursorOf(SHAPES['slip']),
  'slide': cursorOf(SHAPES['slide']),
  'stretch-start': cursorOf(SHAPES['stretch-start']),
  'stretch-end': cursorOf(SHAPES['stretch-end']),
  'blocked': 'not-allowed',
};
