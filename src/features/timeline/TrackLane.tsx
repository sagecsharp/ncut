import { memo, useMemo } from 'react';
import type { Track } from '../../types';
import { useEditor } from '../../store/editorStore';
import { ClipView } from './ClipView';
import { laneHeight } from './layout';
import { selectTrackClips } from './trackClips';

interface Props {
  track: Track;
  zoom: number;
}

/**
 * one lane. subscribes to its own clips only (structurally shared per track), so editing a clip
 * on another track does not re-render this lane.
 */
export const TrackLane = memo(function TrackLane({ track, zoom }: Props) {
  const clips = useEditor((s) => selectTrackClips(s.project?.clips, track.id));
  const selection = useEditor((s) => s.selection);
  const assets = useEditor((s) => s.project?.assets);
  const selected = useMemo(() => new Set(selection), [selection]);
  const assetById = useMemo(() => new Map((assets ?? []).map((a) => [a.id, a])), [assets]);
  const laneH = laneHeight(track.kind);

  return (
    <div
      className={`timeline-lane timeline-lane-area is-${track.kind}${track.locked ? ' is-locked' : ''}${
        track.hidden ? ' is-hidden-track' : ''
      }`}
      data-track-id={track.id}
    >
      {clips.map((c) => (
        <ClipView
          key={c.id}
          clip={c}
          selected={selected.has(c.id)}
          zoom={zoom}
          laneH={laneH}
          asset={'assetId' in c ? assetById.get(c.assetId) : undefined}
        />
      ))}
    </div>
  );
});
