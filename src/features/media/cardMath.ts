/** the numbers behind a media card: the flip timer, the skim and the marks bar. pure */
import { inOutSpan } from '../../lib/inOut';
import type { AnyRange } from '../../lib/inOut';
import { inLabelTime, outLabelTime } from '../../lib/marks';
import { clamp, formatTimecode } from '../../lib/time';
import type { PreviewMode } from '../../store/ui';

/** a click on a card flips the preview to the source view after this long (a double click cancels it) */
export const FLIP_DELAY_MS = 250;
/** a double click this soon after a flip puts the old view back */
export const RESTORE_MS = 600;
/** the mouse rests this long over a video card before the skim starts */
export const SKIM_REST_MS = 150;
export const SKIM_COUNT = 24;
export const SKIM_H = 48;

export interface CardPress {
  id: string;
  at: number;
  prevMode: PreviewMode;
  flipped: boolean;
}

/** the view to put back: same card, it flipped the view, and the double click came soon enough */
export function restoreModeFor(press: CardPress | null | undefined, id: string, now: number): PreviewMode | null {
  if (!press || press.id !== id || !press.flipped || now - press.at > RESTORE_MS) return null;
  return press.prevMode;
}

/** the time of the file under x on a card of `width` px */
export function skimTime(x: number, width: number, duration: number): number {
  if (!(width > 0) || !(duration > 0)) return 0;
  return clamp(x / width, 0, 1) * duration;
}

/** the index of the time nearest to t. -1 for no times */
export function skimIndex(times: readonly number[], t: number): number {
  let best = -1;
  let dist = Infinity;
  for (let i = 0; i < times.length; i++) {
    const d = Math.abs(times[i]! - t);
    if (d < dist) {
      dist = d;
      best = i;
    }
  }
  return best;
}

/** the centered part of a picture that fills a box (object-fit: cover) */
export function coverRect(srcW: number, srcH: number, dstW: number, dstH: number): { sx: number; sy: number; sw: number; sh: number } {
  if (!(srcW > 0) || !(srcH > 0) || !(dstW > 0) || !(dstH > 0)) return { sx: 0, sy: 0, sw: Math.max(0, srcW), sh: Math.max(0, srcH) };
  const k = Math.max(dstW / srcW, dstH / srcH);
  const sw = dstW / k;
  const sh = dstH / k;
  return { sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh };
}

/** the marked part as a bar under the thumbnail, in percent. null without a part */
export function marksBar(m: AnyRange, duration: number): { left: number; width: number } | null {
  const span = inOutSpan(m, duration);
  if (!span) return null;
  return { left: (span.start / duration) * 100, width: ((span.end - span.start) / duration) * 100 };
}

export function marksTitle(info: string, m: NonNullable<AnyRange>, duration: number, fps: number): string {
  return `${info} - marked ${formatTimecode(inLabelTime(m, fps), fps)} to ${formatTimecode(outLabelTime(m, duration, fps), fps)}`;
}
