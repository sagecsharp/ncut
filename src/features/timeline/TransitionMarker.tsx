import { memo } from 'react';
import { Blend } from 'lucide-react';
import { getTransition } from '../../engine/transitions/registry';
import { CLIP_INSET } from './layout';

interface Props {
  clipId: string;
  transitionId: string;
  /** timeline seconds covered by the transition (transitionSpan) */
  start: number;
  end: number;
  zoom: number;
  laneH: number;
  selected: boolean;
}

const BAND_H = 14;

/**
 * the band of a clip's transition. it lives in the lane (not inside the clip box) because it
 * straddles the cut. pressing it acts on the incoming clip (data-transition-clip), the handle on
 * its right edge changes the duration.
 */
export const TransitionMarker = memo(function TransitionMarker({ clipId, transitionId, start, end, zoom, laneH, selected }: Props) {
  const w = Math.max(6, (end - start) * zoom);
  const y = CLIP_INSET + Math.round((laneH - CLIP_INSET * 2 - BAND_H) / 2);
  const name = getTransition(transitionId)?.name ?? transitionId;
  return (
    <div
      className={`timeline-transition${selected ? ' is-selected' : ''}`}
      data-transition-clip={clipId}
      title={`transition: ${name}`}
      style={{ transform: `translate3d(${start * zoom}px,${y}px,0)`, width: w, height: BAND_H }}
    >
      {w >= 22 ? <Blend size={11} aria-hidden="true" /> : null}
      <div className="timeline-transition-handle" data-transition-handle={clipId} title="drag to change the transition length" />
    </div>
  );
});
