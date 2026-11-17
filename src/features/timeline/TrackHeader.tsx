import { memo, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Eye, EyeOff, Headphones, Lock, Music, Trash2, Unlock, Video, Volume2, VolumeX } from 'lucide-react';
import type { Track } from '../../types';
import { useEditor } from '../../store/editorStore';
import { useSolo } from '../../store/solo';
import { useSource } from '../../store/source';
import { useUi } from '../../store/ui';
import { soloActive, trackSoundLine } from '../../lib/mix';
import { tip } from '../shell/tip';
import { openTrackMenuAt } from './commands';
import { selectTrackClips } from './trackClips';
import { TargetToggle } from './TargetToggle';
import '../media/mixer/mixer.css';

interface Props {
  track: Track;
}

/** left column cell of a track row: kind icon, name (double click to rename), toggles, remove. */
export const TrackHeader = memo(function TrackHeader({ track }: Props) {
  const clipCount = useEditor((s) => selectTrackClips(s.project?.clips, track.id).length);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(track.name);
  const [confirm, setConfirm] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const isVideo = track.kind === 'video';
  const solo = useSolo((s) => s.solo);
  const on = solo.includes(track.id);
  const active = useEditor((st) => soloActive(st.project, solo));
  const soundLine = trackSoundLine(track);
  const shown = useSource((s) => s.assetId !== null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  useEffect(() => {
    if (!confirm) return;
    const timer = window.setTimeout(() => setConfirm(false), 2500);
    return () => window.clearTimeout(timer);
  }, [confirm]);

  const update = (patch: Partial<Pick<Track, 'muted' | 'hidden' | 'locked'>>) => {
    useEditor.getState().updateTrack(track.id, patch);
  };

  const commit = () => {
    setEditing(false);
    const name = draft.trim();
    if (name && name !== track.name) useEditor.getState().updateTrack(track.id, { name });
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') setEditing(false);
  };

  const remove = () => {
    if (clipCount > 0 && !confirm) {
      setConfirm(true);
      return;
    }
    useEditor.getState().removeTrack(track.id);
  };

  return (
    <div className={`timeline-head${track.locked ? ' is-locked' : ''}${active && !on ? ' is-unheard' : ''}`} data-track-id={track.id}>
      <div className="timeline-head-top">
        <button
          type="button"
          className="timeline-head-kind"
          aria-label="track menu"
          onClick={(e) => openTrackMenuAt(e.currentTarget, track.id)}
          {...tip('track menu', { does: 'select, close gaps, insert a gap, transitions on every cut. a right click on the track works too' })}
        >
          {isVideo ? <Video size={13} /> : <Music size={13} />}
        </button>
        {editing ? (
          <input
            ref={inputRef}
            className="input input-sm timeline-head-input"
            value={draft}
            maxLength={40}
            aria-label="track name"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={onKey}
          />
        ) : (
          <span
            className="timeline-head-name"
            title="double click to rename"
            onDoubleClick={() => {
              setDraft(track.name);
              setEditing(true);
            }}
          >
            {track.name}
          </span>
        )}
        <button
          className={`icon-btn icon-btn-sm timeline-head-remove${confirm ? ' is-confirm' : ''}`}
          onClick={remove}
          onBlur={() => setConfirm(false)}
          {...tip(confirm ? 'click again to remove the track and its clips' : 'remove track', { does: 'a track with clips asks for a second click' })}
          aria-label="remove track"
        >
          <Trash2 size={13} />
        </button>
      </div>
      <div className="timeline-head-toggles">
        {shown ? <TargetToggle track={track} /> : null}
        <button
          className={`icon-btn icon-btn-sm${track.muted ? ' is-active' : ''}`}
          onClick={() => update({ muted: !track.muted })}
          {...tip('mute track', { does: 'no sound from this track', on: track.muted })}
          aria-label="mute track"
          aria-pressed={track.muted}
        >
          {track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
        </button>
        <button
          className={'icon-btn icon-btn-sm' + (on ? ' is-solo' : '')}
          onClick={(e) => useSolo.getState().toggleSolo(track.id, e.altKey)}
          {...tip('solo track', { does: 'hear only the tracks on solo. for listening only: it is not saved and the export has every track. alt+click: solo only this track', on })}
          aria-label="solo track"
          aria-pressed={on}
        >
          <Headphones size={13} />
        </button>
        {isVideo ? (
          <button
            className={`icon-btn icon-btn-sm${track.hidden ? ' is-active' : ''}`}
            onClick={() => update({ hidden: !track.hidden })}
            {...tip('hide track', { does: 'its clips are not drawn, in the preview and in the export', on: track.hidden })}
            aria-label="hide track"
            aria-pressed={track.hidden}
          >
            {track.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        ) : null}
        <button
          className={`icon-btn icon-btn-sm${track.locked ? ' is-active' : ''}`}
          onClick={() => update({ locked: !track.locked })}
          {...tip('lock track', { does: 'its clips cannot be moved or changed', on: track.locked })}
          aria-label="lock track"
          aria-pressed={track.locked}
        >
          {track.locked ? <Lock size={13} /> : <Unlock size={13} />}
        </button>
        {soundLine ? (
          <button
            className="timeline-head-mix"
            onClick={() => useUi.getState().showMixer(track.id)}
            {...tip('mixer', { does: 'this track has its own level or pan. click to open the mixer at it', keys: 'open-mixer' })}
          >
            {soundLine}
          </button>
        ) : null}
      </div>
    </div>
  );
});
