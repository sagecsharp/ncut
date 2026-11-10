/**
 * pure snap math of the scene view's gizmos: a grid for the move arrows (ctrl / cmd) and 15 degree steps for the
 * rotation rings. no dom, tested in node.
 */

/** grid step of the move arrows, canvas px */
export const GRID_STEP = 50;
/** finer grid with shift also held */
export const GRID_STEP_FINE = 10;
/** step of the rotation rings, degrees */
export const ANGLE_STEP = 15;

/** the nearest multiple of `step` (a step that is not positive leaves the value alone) */
export function snapToStep(value: number, step: number): number {
  if (!(step > 0) || !Number.isFinite(value)) return value;
  // + 0 turns -0 into 0
  return Math.round(value / step) * step + 0;
}

/** the grid step for the modifiers held now: 50, or 10 with shift. 0 = no snapping (ctrl / cmd not held) */
export function gridStepFor(ctrl: boolean, shift: boolean): number {
  if (!ctrl) return 0;
  return shift ? GRID_STEP_FINE : GRID_STEP;
}

/** a dragged position value, snapped to the grid when ctrl / cmd is held */
export function snapPosition(value: number, ctrl: boolean, shift: boolean): number {
  return snapToStep(value, gridStepFor(ctrl, shift));
}

/**
 * a dragged rotation value in degrees: 15 degree steps while ctrl / cmd or shift is held (shift already did this
 * before ctrl joined it)
 */
export function snapAngle(value: number, ctrl: boolean, shift: boolean): number {
  return ctrl || shift ? snapToStep(value, ANGLE_STEP) : value;
}

/**
 * the movement of an arrow drag with the grid applied to where the value ends up (start + delta), so the clip lands
 * on a grid line and not just a grid step away from where it started
 */
export function snapDelta(start: number, delta: number, ctrl: boolean, shift: boolean): number {
  const step = gridStepFor(ctrl, shift);
  return step > 0 ? snapToStep(start + delta, step) - start : delta;
}
