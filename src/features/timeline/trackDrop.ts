/** the reorder drag of a track header, for the rows to draw. never saved, never in the history */
import { create } from 'zustand';

export interface TrackDropState {
  /** the track being dragged */
  dragging: string | null;
  /** the track the drop line sits on */
  over: string | null;
  side: 'above' | 'below' | null;
  /** the words on the drop line, like "on top of video 2" */
  label: string;
}

const EMPTY: TrackDropState = { dragging: null, over: null, side: null, label: '' };

export const useTrackDrop = create<TrackDropState>()(() => EMPTY);

export function setTrackDrop(partial: Partial<TrackDropState>): void {
  const cur = useTrackDrop.getState();
  for (const k of Object.keys(partial) as (keyof TrackDropState)[]) {
    if (partial[k] !== cur[k]) {
      useTrackDrop.setState(partial);
      return;
    }
  }
}

/** nothing dragged. no write when it is empty already */
export function clearTrackDrop(): void {
  const cur = useTrackDrop.getState();
  if (cur.dragging === null && cur.over === null && cur.side === null && cur.label === '') return;
  useTrackDrop.setState(EMPTY);
}
