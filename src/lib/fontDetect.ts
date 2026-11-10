/**
 * does a font family really render? document.fonts.load resolves with an empty list for an unknown family and
 * document.fonts.check answers true for it in some browsers, so the only reliable test is to measure.
 * pure: the width function is injected. import-safe in node.
 */

import { createCanvas } from './canvas';

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong']);

/** a css generic family or an empty name: always there */
export function isGenericFamily(family: string): boolean {
  const f = family.trim().toLowerCase();
  return f === '' || GENERIC.has(f);
}

/** width of the sample text in the given css font, or null when it cannot be measured */
export type WidthOf = (font: string) => number | null;

/**
 * true when the family draws differently from the plain fallback, tested against monospace and against serif
 * (a family that happens to match one fallback still differs from the other). unmeasurable = true (nothing changes).
 */
export function familyRenders(family: string, weight: number, measure: WidthOf): boolean {
  if (isGenericFamily(family)) return true;
  try {
    const q = family.replace(/["\\]/g, '');
    const w = weight >= 600 ? 700 : 400;
    const pairs: Array<[string, string]> = [
      [`${w} 72px "${q}", monospace`, `${w} 72px monospace`],
      [`${w} 72px "${q}", serif`, `${w} 72px serif`],
    ];
    for (const [withFamily, plain] of pairs) {
      const a = measure(withFamily);
      const b = measure(plain);
      if (a === null || b === null) return true;
      if (a !== b) return true;
    }
    return false;
  } catch {
    return true;
  }
}

const SAMPLE = 'AaBbCcWwIil 0123456789 mmmmmmmm';
let ctx: { font: string; measureText(s: string): { width: number } } | null | undefined;

function getCtx(): NonNullable<typeof ctx> | null {
  if (ctx !== undefined) return ctx;
  ctx = null;
  try {
    if (typeof OffscreenCanvas !== 'undefined') ctx = new OffscreenCanvas(8, 8).getContext('2d');
    else if (typeof document !== 'undefined') ctx = createCanvas(8, 8).getContext('2d');
  } catch {
    ctx = null;
  }
  return ctx;
}

/** measure on a 2d canvas; null without one (tests, node) */
export const canvasWidth: WidthOf = (font) => {
  const c = getCtx();
  if (!c) return null;
  c.font = font;
  return c.measureText(SAMPLE).width;
};
