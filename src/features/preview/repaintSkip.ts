/**
 * the decision to not repaint the canvas on an animation frame of a running clock when the picture cannot have
 * changed. pure (no dom): the engine collects the facts, this decides. see PreviewEngine.
 */

/** kill switch: false = every tick repaints, as before this optimization existed */
export const SKIP_UNCHANGED_FRAMES = true;

/** a clock step larger than this (seconds) is a jump (a seek while playing, a stalled frame, a fast shuttle): paint */
export const MAX_SKIP_TIME_STEP = 0.1;

/** what was true when a frame was painted (or, for `now`, what is true on this tick) */
export interface FrameRecord {
  /** the project object (immutable snapshots: another object = an edit) */
  project: unknown;
  /** FrameInfo.key */
  key: string;
  /** FrameInfo.allStatic */
  allStatic: boolean;
  time: number;
  /** how many video frames elements have presented so far */
  frames: number;
  /** backing size of the canvas */
  width: number;
  height: number;
}

export interface SkipFlags {
  enabled: boolean;
  playing: boolean;
  /** the scene view is showing (never skipped) */
  sceneView: boolean;
  /** something asked for a draw (invalidate, drawSoon, a store change) that has not happened yet */
  pending: boolean;
  /** every video on screen has a frame, is not seeking and can report presented frames (requestVideoFrameCallback) */
  videosReady: boolean;
}

/** true when this tick may leave the canvas as it is. every condition must hold */
export function canSkipRepaint(last: FrameRecord | null, now: FrameRecord, f: SkipFlags): boolean {
  if (!f.enabled || !f.playing || f.sceneView || f.pending || !f.videosReady) return false;
  if (!last) return false;
  if (!last.allStatic || !now.allStatic) return false;
  if (last.project !== now.project) return false;
  if (last.key !== now.key) return false;
  if (last.frames !== now.frames) return false;
  if (last.width !== now.width || last.height !== now.height) return false;
  if (!(Math.abs(now.time - last.time) <= MAX_SKIP_TIME_STEP)) return false;
  return true;
}
