import { memo, useCallback, useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import type { Project, Track } from '../../types';
import { transitionSpan } from '../../lib/transitions';
import { useEditor } from '../../store/editorStore';
import { ClipView } from './ClipView';
import { buildLaneIndex, spanInWindow, windowBounds, windowKey, windowMask } from './clipWindow';
import { laneHeight } from './layout';
import { selectTrackClips } from './trackClips';
import { TransitionMarker } from './TransitionMarker';
import { notifyClipMount, subscribeView, view } from './view';

interface Props {
  track: Track;
  zoom: number;
}

/**
 * one lane. subscribes to its own clips only (structurally shared per track), so editing a clip
 * on another track does not re-render this lane.
 *
 * a lane with many clips only mounts the ones near the scroll window (see clipWindow.ts) plus the
 * selected ones. the window is read from the view state in whole buckets, so scrolling re-renders the
 * lane only when it crosses a bucket. everything else (gestures, snapping, select all, marquee, menus)
 * reads the store, not these elements. the lane is as wide as the project (css var), not as its clips.
 */
export const TrackLane = memo(function TrackLane({ track, zoom }: Props) {
  const clips = useEditor((s) => selectTrackClips(s.project?.clips, track.id));
  const selection = useEditor((s) => s.selection);
  const assets = useEditor((s) => s.project?.assets);
  const selected = useMemo(() => new Set(selection), [selection]);
  const assetById = useMemo(() => new Map((assets ?? []).map((a) => [a.id, a])), [assets]);
  const laneH = laneHeight(track.kind);
  const count = clips.length;
  // '' (mount everything) for a small lane, else the bucketed window. re-renders only when it changes
  const getKey = useCallback(() => windowKey(view.scrollLeft, view.width, count), [count]);
  const key = useSyncExternalStore(subscribeView, getKey, getKey);
  // transitionSpan only looks at the clips of this track, so a project-shaped wrapper is enough here
  const spans = useMemo(() => {
    const scope = { clips } as Project;
    return clips.flatMap((c) => {
      const span = transitionSpan(scope, c);
      return span ? [span] : [];
    });
  }, [clips]);

  const index = useMemo(() => (key === '' ? null : buildLaneIndex(clips)), [clips, key === '']);
  const bounds = useMemo(() => windowBounds(key), [key]);
  const mask = useMemo(
    () => (index && bounds ? windowMask(index, zoom, bounds.start, bounds.end, (i) => selected.has(clips[i]!.id)) : null),
    [index, bounds, zoom, selected, clips],
  );
  const shownClips = useMemo(() => (mask ? clips.filter((_, i) => mask[i] === 1) : clips), [clips, mask]);
  const shownSpans = useMemo(
    () => (bounds ? spans.filter((sp) => selected.has(sp.to.id) || spanInWindow(sp.start, sp.end, zoom, bounds.start, bounds.end)) : spans),
    [spans, bounds, zoom, selected],
  );

  // clips that came in because the window moved (not through an edit) get their dom marks (link outlines)
  useLayoutEffect(() => {
    if (key !== '') notifyClipMount();
  }, [key, zoom]);

  return (
    <div
      className={`timeline-lane timeline-lane-area is-${track.kind}${track.locked ? ' is-locked' : ''}${
        track.hidden ? ' is-hidden-track' : ''
      }`}
      data-track-id={track.id}
    >
      {shownClips.map((c) => (
        <ClipView
          key={c.id}
          clip={c}
          selected={selected.has(c.id)}
          zoom={zoom}
          laneH={laneH}
          asset={'assetId' in c ? assetById.get(c.assetId) : undefined}
        />
      ))}
      {shownSpans.map((sp) => (
        <TransitionMarker
          key={sp.to.id}
          clipId={sp.to.id}
          transitionId={sp.id}
          start={sp.start}
          end={sp.end}
          zoom={zoom}
          laneH={laneH}
          selected={selected.has(sp.to.id)}
        />
      ))}
    </div>
  );
});
