import { FoldVertical, UnfoldVertical } from 'lucide-react';
import { stepHeights } from '../../lib/trackTools';
import { useEditor } from '../../store/editorStore';
import { REASON_TEXT } from '../shell/reasons';
import { tip } from '../shell/tip';
import { stepTrackHeights } from './trackActions';

/** taller / shorter tracks buttons, right after zoom to fit */
export function TrackSizeButtons() {
  const tracks = useEditor((s) => s.project?.tracks);
  const shortOff = tracks && Object.keys(stepHeights(tracks, -1)).length === 0 ? REASON_TEXT.tracksShortest : null;
  const tallOff = tracks && Object.keys(stepHeights(tracks, 1)).length === 0 ? REASON_TEXT.tracksTallest : null;
  return (
    <>
      <span className="timeline-toolbar-sep" />
      <button
        className="icon-btn"
        onClick={() => stepTrackHeights(-1)}
        disabled={shortOff !== null}
        aria-label="shorter tracks"
        {...tip('shorter tracks', { does: 'every track one step shorter', keys: 'tracks-shorter', off: shortOff })}
      >
        <FoldVertical size={16} />
      </button>
      <button
        className="icon-btn"
        onClick={() => stepTrackHeights(1)}
        disabled={tallOff !== null}
        aria-label="taller tracks"
        {...tip('taller tracks', { does: 'every track one step taller', keys: 'tracks-taller', off: tallOff })}
      >
        <UnfoldVertical size={16} />
      </button>
    </>
  );
}
