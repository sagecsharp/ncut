import { rulerLabelFor } from '../../lib/time';
import { useTimeDisplay } from '../../store/timeDisplay';

export function rulerLabel(t: number, fps: number, frameLabels: boolean): string {
  return rulerLabelFor(t, fps, frameLabels, useTimeDisplay.getState().mode);
}

export function subscribeRulerLabel(fn: () => void): () => void {
  return useTimeDisplay.subscribe((s, prev) => {
    if (s.mode !== prev.mode) fn();
  });
}
