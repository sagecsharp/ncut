import { SlidersVertical } from 'lucide-react';
import { useEditor } from '../../../store/editorStore';
import { useSolo } from '../../../store/solo';
import { useUi } from '../../../store/ui';
import { formatDbShort, formatPan, gainToDb, soloSet, trackPan, trackVolume } from '../../../lib/mix';
import { Row } from '../../properties/controls';
import { tip } from '../../shell/tip';

/** in the sound tab: what the clip's track does to its sound (level, pan, muted, not heard because of solo) */
export function TrackMixRow({ id }: { id: string }) {
  const solo = useSolo((s) => s.solo);
  const text = useEditor((s) => {
    const p = s.project;
    const c = p?.clips.find((x) => x.id === id);
    const t = p?.tracks.find((x) => x.id === c?.trackId);
    if (!p || !t) return null;
    if (t.muted) return `${t.name}: muted`;
    const set = soloSet(p, solo);
    if (set && !set.has(t.id)) return `${t.name}: not heard (solo)`;
    const parts: string[] = [];
    if (t.volume !== undefined) parts.push(`${formatDbShort(gainToDb(trackVolume(t)))} db`);
    if (t.pan !== undefined) parts.push(`pan ${formatPan(trackPan(t))}`);
    return parts.length > 0 ? `${t.name}: ${parts.join(', ')}` : null;
  });
  const trackId = useEditor((s) => s.project?.clips.find((x) => x.id === id)?.trackId ?? null);
  if (text === null || trackId === null) return null;
  return (
    <Row label="track" title="the track this clip is on changes its sound too. the mixer shows it">
      <span className="props-hint mixer-track-text">{text}</span>
      <button
        type="button"
        className="btn btn-sm"
        aria-label="mixer"
        {...tip('mixer', { does: 'open the mixer at this track', keys: 'open-mixer' })}
        onClick={() => useUi.getState().showMixer(trackId)}
      >
        <SlidersVertical size={12} />
        mixer
      </button>
    </Row>
  );
}
