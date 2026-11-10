import { useEditor } from '../../store/editorStore';
import type { ActionOpts } from '../../store/editorStore';

/**
 * one interaction = one undo step, without empty steps.
 * a field calls beginEdit() when its interaction starts (focus, scrub start, pointerdown).
 * the first real change after that records the undo step (the project is still unchanged at that point),
 * every following change of the same interaction is applied with skipHistory.
 */
let armed = false;

export function beginEdit(): void {
  armed = true;
}

/** call right before applying a live change. returns the opts to pass to the store action. */
export function liveOpts(): ActionOpts {
  if (armed) {
    armed = false;
    useEditor.getState().pushHistory();
  }
  return { skipHistory: true };
}

export function even(v: number): number {
  return Math.max(2, Math.round(v / 2) * 2);
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isHex(v: string): boolean {
  return HEX.test(v);
}

/** <input type=color> only accepts #rrggbb */
export function toColorInput(v: string): string {
  if (!HEX.test(v)) return '#000000';
  if (v.length === 4) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase();
  return v.slice(0, 7).toLowerCase();
}
