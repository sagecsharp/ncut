import { memo, useMemo } from 'react';
import type { TrackKind } from '../../types';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import { spanInWindow } from './clipWindow';
import { CrossfadeBox } from './CrossfadeBox';
import { laneCrossfades } from './crossfadeGeometry';
import './crossfade.css';

interface Props {
  trackId: string;
  kind: TrackKind;
  locked: boolean;
  zoom: number;
  laneH: number;
  bounds: { start: number; end: number } | null;
  selected: ReadonlySet<string>;
}

/** the crossfade boxes of a lane. windowed like the transition bands, the selected and the picked one always stay */
export const CrossfadeLayer = memo(function CrossfadeLayer({ trackId, locked, zoom, laneH, bounds, selected }: Props) {
  const spans = useEditor((s) => laneCrossfades(s.project, trackId));
  const selection = useEditor((s) => s.selection);
  const pick = useUi((s) => s.crossfadePick);
  const shown = useMemo(
    () =>
      bounds
        ? spans.filter(
            (sp) => selected.has(sp.toId) || (pick !== null && pick.clipId === sp.toId) || spanInWindow(sp.start, sp.end, zoom, bounds.start, bounds.end),
          )
        : spans,
    [spans, bounds, zoom, selected, pick],
  );
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((sp) => (
        <CrossfadeBox
          key={sp.toId}
          span={sp}
          zoom={zoom}
          laneH={laneH}
          locked={locked}
          picked={pick !== null && pick.selection === selection && pick.clipId === sp.toId}
        />
      ))}
    </>
  );
});
