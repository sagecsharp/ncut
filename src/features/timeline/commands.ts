import { focusedByKeyboard } from '../../lib/pressKey';

export interface ClipMenuOpen {
  x?: number;
  y?: number;
  clipId?: string;
  focusFirst?: boolean;
}
export interface TrackMenuOpen {
  x: number;
  y: number;
  trackId: string;
  focusFirst?: boolean;
}

/** what the timeline can do for other parts of the editor. filled by Timeline.tsx while it is mounted */
export const timelineCommands: {
  fit?(): void;
  fitSelection?(): void;
  /** zoom and scroll so the time range fills the view (one time: scroll only) */
  fitTimes?(start: number, end: number): void;
  openClipMenu?(r?: ClipMenuOpen): void;
  openTrackMenu?(r: TrackMenuOpen): void;
} = {};

/** open the clip menu under a button (bottom left, 2 px below). focus goes in when the button was reached by keyboard */
export function openClipMenuAt(el: Element, clipId: string): void {
  const r = el.getBoundingClientRect();
  timelineCommands.openClipMenu?.({ x: r.left, y: r.bottom + 2, clipId, focusFirst: focusedByKeyboard() });
}

export function openTrackMenuAt(el: Element, trackId: string): void {
  const r = el.getBoundingClientRect();
  timelineCommands.openTrackMenu?.({ x: r.left, y: r.bottom + 2, trackId, focusFirst: focusedByKeyboard() });
}
