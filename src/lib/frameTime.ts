/**
 * a time that shows a picture: not before 0, not after the start of the last frame (every clip is only visible
 * before its end, so the end itself is empty). a time that is not a number counts as 0
 */
export function clampFrameTime(time: number, duration: number, fps: number): number {
  if (!Number.isFinite(time)) return 0;
  const last = Math.max(0, duration - 1 / (fps > 0 ? fps : 30));
  return Math.max(0, Math.min(last, time));
}
