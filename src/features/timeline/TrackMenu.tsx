import { useRef } from 'react';
import { ArrowRightToLine, ChevronsRightLeft, ListChecks } from 'lucide-react';
import { useEditor } from '../../store/editorStore';
import { closeGapsOnTrack, selectAfterPlayhead, selectTrackClips } from './actions';
import { useFloatingMenu } from './menuBehavior';

export interface TrackMenuRequest {
  x: number;
  y: number;
  trackId: string;
}

interface Props extends TrackMenuRequest {
  onClose(): void;
}

/** right click menu of a track header or an empty spot of a lane. */
export function TrackMenu({ x, y, trackId, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const pos = useFloatingMenu(ref, x, y, onClose);
  const track = useEditor((s) => s.project?.tracks.find((t) => t.id === trackId));
  if (!track) return null;
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };
  return (
    <div ref={ref} className="menu timeline-menu" style={{ left: pos.x, top: pos.y }} role="menu">
      <button className="menu-item" role="menuitem" title="select every clip on this track" onClick={run(() => selectTrackClips(trackId))}>
        <ListChecks size={14} />
        select everything on this track
      </button>
      <button
        className="menu-item"
        role="menuitem"
        title="select every clip that starts at or after the playhead (ctrl+shift+a)"
        onClick={run(() => selectAfterPlayhead())}
      >
        <ArrowRightToLine size={14} />
        select everything after the playhead
      </button>
      <div className="menu-sep" />
      <button
        className="menu-item"
        role="menuitem"
        disabled={track.locked}
        title="move the clips of this track left so they sit end to end"
        onClick={run(() => closeGapsOnTrack(trackId))}
      >
        <ChevronsRightLeft size={14} />
        close gaps on this track
      </button>
    </div>
  );
}
