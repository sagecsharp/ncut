import { DEFAULT_TRANSITION_DURATION } from '../../engine/transitions/registry';
import type { Transition } from '../../types';

/** the transition to store when `id` is applied to a clip: a tuned length is kept, a new one gets the default */
export function transitionFor(id: string, current: Transition | null | undefined): Transition {
  return { id, duration: current?.duration ?? DEFAULT_TRANSITION_DURATION };
}
