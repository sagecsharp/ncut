/**
 * the sample plan of a clip's motion blur by style (ClipMotionBlur.style). pure: no dom, no canvas.
 * draw.ts paints one copy of the clip per sample, `offset` seconds from the frame time.
 */
import type { MotionBlurStyle } from '../types';

/** most separate copies a 'ghost' blur draws, however many samples are set */
export const MAX_GHOST_COPIES = 5;

/** the share of a 'trail' blur the newest copy (the clip itself) keeps, so it reads sharp */
export const TRAIL_HEAD_SHARE = 0.5;

export interface BlurSample {
  /** seconds relative to the frame time. oldest first. */
  offset: number;
  weight: number;
}

export interface BlurPlan {
  /**
   * false = the copies are summed ('lighter'): the weights add up to 1.
   * true  = the copies are laid on top of each other in order, oldest first ('source-over'): every weight is the
   *         opacity of that copy (0..1), the last one (the clip itself) is 1.
   */
  over: boolean;
  samples: BlurSample[];
}

/**
 * the copies of a blur with `n` samples (>= 2) over a shutter that is open `span` seconds.
 * 'even'  : n copies centered on the frame time, [-span / 2, span / 2], equal weights 1 / n. draw.ts takes this
 *           style from motionBlurTimes (the same times, kept exactly as they always were); it is here for completeness.
 * 'trail' : n copies from the past only, [-span, 0]. the newest (offset 0) keeps TRAIL_HEAD_SHARE, the rest share
 *           the remaining weight, squared falloff toward the past. weights sum to 1.
 * 'ghost' : min(n, MAX_GHOST_COPIES) copies spread over [-span, 0], opacity rising toward the clip, the clip itself
 *           (offset 0) at 1. drawn over each other (see BlurPlan.over).
 */
export function blurPlan(style: MotionBlurStyle | undefined, n: number, span: number): BlurPlan {
  const count = Math.max(2, Math.floor(n));
  const len = Math.max(0, span);
  if (style === 'trail') {
    const samples: BlurSample[] = [];
    const rest = count - 1;
    let sum = 0;
    for (let i = 0; i < rest; i++) sum += ((i + 1) / rest) ** 2;
    for (let i = 0; i < rest; i++) {
      samples.push({ offset: -len * ((count - 1 - i) / (count - 1)), weight: ((1 - TRAIL_HEAD_SHARE) * ((i + 1) / rest) ** 2) / sum });
    }
    samples.push({ offset: 0, weight: TRAIL_HEAD_SHARE });
    return { over: false, samples };
  }
  if (style === 'ghost') {
    const g = Math.min(MAX_GHOST_COPIES, count);
    const samples: BlurSample[] = [];
    for (let k = 0; k < g; k++) {
      const last = k === g - 1;
      samples.push({ offset: last ? 0 : -len * ((g - 1 - k) / (g - 1)), weight: last ? 1 : (0.5 * (k + 1)) / g });
    }
    return { over: true, samples };
  }
  const half = len / 2;
  const samples: BlurSample[] = [];
  for (let i = 0; i < count; i++) samples.push({ offset: -half + (2 * half * i) / (count - 1), weight: 1 / count });
  return { over: false, samples };
}
