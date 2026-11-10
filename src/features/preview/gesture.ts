/**
 * "a drag in the preview is running" flag. while it is set, keyboard shortcuts are swallowed before they reach
 * the global handler (an undo in the middle of a drag would corrupt the history, split / delete would pull the
 * clip out from under the pointer). it also raises the timeline's own gesture flag.
 *
 * the guard lives in the preview (a capture listener on window), so no other file has to know about it.
 */
import { interaction } from '../timeline/view';

let active = false;

export function previewGestureActive(): boolean {
  return active;
}

export function beginPreviewGesture(): void {
  active = true;
  interaction.gestureActive = true;
}

export function endPreviewGesture(): void {
  if (!active) return;
  active = false;
  interaction.gestureActive = false;
}

/**
 * install the shortcut guard. returns the cleanup (also ends a running gesture, for unmounts).
 * the flag is dropped by any pointerup / pointercancel / blur as a safety net, so a lost pointer can never
 * leave the keyboard dead.
 */
export function installGestureGuard(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (active) e.stopImmediatePropagation();
  };
  const drop = () => endPreviewGesture();
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('pointerup', drop, true);
  window.addEventListener('pointercancel', drop, true);
  window.addEventListener('blur', drop);
  return () => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('pointerup', drop, true);
    window.removeEventListener('pointercancel', drop, true);
    window.removeEventListener('blur', drop);
    endPreviewGesture();
  };
}
