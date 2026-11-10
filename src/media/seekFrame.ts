/**
 * seek a video element and wait until the picture of the new position is really on the element.
 *
 * the 'seeked' event only says the data is there. what a canvas reads with drawImage can still be the frame
 * from BEFORE the seek for a moment (seen in chrome with elements that are not in the page): a freeze frame or a
 * thumbnail drawn right at 'seeked' then shows the wrong picture. requestVideoFrameCallback fires when the new
 * frame is presented, so that is what we wait for; without it a short pause does the job.
 */

interface FrameCallbackVideo {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
}

/** how long to wait for the new frame after 'seeked' before drawing anyway (a seek onto the frame already shown presents nothing new) */
export const FRAME_WAIT_MS = 250;
/** a presented frame counts as the frame of the seek when its media time is this close to the target, seconds */
export const FRAME_NEAR_S = 0.25;
/** the pause used when the browser has no requestVideoFrameCallback */
export const FRAME_PAUSE_MS = 80;

/** how the wait ends, as pure decisions (tested without a dom) */
export function frameWaitPlan(hasCallback: boolean): { waitMs: number; useCallback: boolean } {
  return hasCallback ? { waitMs: FRAME_WAIT_MS, useCallback: true } : { waitMs: FRAME_PAUSE_MS, useCallback: false };
}

/**
 * set currentTime and resolve true once the frame at `t` can be drawn, false on an error or when the seek
 * itself takes longer than `timeoutMs`. never rejects.
 */
export function seekFrame(v: HTMLVideoElement, t: number, timeoutMs: number): Promise<boolean> {
  // already on that position with a picture: nothing will be presented, and nothing has to be
  if (Math.abs(v.currentTime - t) < 1e-3 && v.readyState >= 2 && !v.seeking) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let presented = false;
    let seeked = false;
    let waitTimer: ReturnType<typeof setTimeout> | null = null;
    let handle: number | null = null;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(seekTimer);
      if (waitTimer) clearTimeout(waitTimer);
      if (handle !== null) {
        try {
          (v as unknown as FrameCallbackVideo).cancelVideoFrameCallback?.(handle);
        } catch {
          /* nothing to cancel */
        }
      }
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('error', onError);
      resolve(ok);
    };
    const seekTimer = setTimeout(finish, timeoutMs, false);
    const rvfc = (v as unknown as FrameCallbackVideo).requestVideoFrameCallback;
    const plan = frameWaitPlan(typeof rvfc === 'function');
    const onSeeked = (): void => {
      seeked = true;
      if (presented) finish(true);
      // the frame was not presented yet (or never will be: same frame as before): draw after a short wait at the latest
      else waitTimer = setTimeout(finish, plan.waitMs, true);
    };
    const onError = (): void => finish(false);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('error', onError);
    const onFrame = (_now: number, meta?: { mediaTime: number }): void => {
      if (settled) return;
      // a frame from before the seek can still be on its way (the first frame after loading): not the one we want
      if (meta && typeof meta.mediaTime === 'number' && Math.abs(meta.mediaTime - t) > FRAME_NEAR_S) {
        ask();
        return;
      }
      presented = true;
      if (seeked) finish(true);
    };
    const ask = (): void => {
      try {
        handle = rvfc!.call(v, onFrame);
      } catch {
        /* the timed wait after 'seeked' covers it */
      }
    };
    // asked for before the seek, so the frame the seek brings is never missed
    if (plan.useCallback) ask();
    try {
      v.currentTime = t;
    } catch {
      finish(false);
    }
  });
}
