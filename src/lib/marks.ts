/**
 * the marked part of one media file (the source view): frames, steps and the in / out labels. pure.
 * the frame rule itself (which frame o includes) is lib/inOut.ts, the same one the timeline uses.
 */
import type { InOutRange, MediaAsset } from '../types';
import { cleanRange, frameAt, lastFrameStart, markOutTime, withIn, withOut } from './inOut';
import { clamp } from './time';

export function frameIndexAt(t: number, fps: number): number {
  return Math.floor(t * fps + 1e-6);
}
export function frameStart(k: number, fps: number): number {
  return k / fps;
}
export function stepTime(t: number, n: number, fps: number, duration: number): number {
  const k = n < 0 ? Math.ceil(t * fps - 1e-6) : Math.floor(t * fps + 1e-6); // from between frames, back lands on the frame start
  return clamp(frameStart(k + n, fps), 0, lastFrameStart(0, duration, fps));
}
export function shownStart(t: number, playing: boolean, fps: number): number {
  return playing ? frameStart(frameIndexAt(t, fps), fps) : t;
}
export function marksOf(a: Pick<MediaAsset, 'kind' | 'marks'> | null | undefined): InOutRange | null {
  return !a || a.kind === 'image' ? null : cleanRange(a.marks);
}
/** i in the source view: the frame on screen is the first one inside */
export function markMediaIn(m: InOutRange | null | undefined, t0: number, fps: number) {
  return withIn(m, frameAt(t0, fps));
}
/** o in the source view: the frame on screen is the last one inside */
export function markMediaOut(m: InOutRange | null | undefined, t0: number, fps: number, duration: number) {
  return withOut(m, markOutTime(t0, fps, duration));
}
export function wholeMarks(duration: number): InOutRange {
  return { in: 0, out: duration };
}
export function goOutTime(m: InOutRange, duration: number, fps: number): number {
  return Math.max(m.in ?? 0, lastFrameStart(0, Math.min(m.out ?? duration, duration), fps));
}
export function inLabelTime(m: InOutRange, fps: number): number {
  return frameStart(frameIndexAt(m.in ?? 0, fps), fps);
}
export function outLabelTime(m: InOutRange, duration: number, fps: number): number {
  return Math.max(inLabelTime(m, fps), frameStart(frameIndexAt(goOutTime(m, duration, fps), fps), fps));
}
