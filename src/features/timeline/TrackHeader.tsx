import { memo, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Eye, EyeOff, Lock, Music, Trash2, Unlock, Video, Volume2, VolumeX } from 'lucide-react';
import type { Track } from '../../types';
import { useEditor } from '../../store/editorStore';
import { selectTrackClips } from './trackClips';

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
    <div className={`timeline-head${track.locked ? ' is-locked' : ''}`}>
      <div className="timeline-head-top">
        <span className="timeline-head-kind" title={`${track.kind} track`}>
          {isVideo ? <Video size={13} /> : <Music size={13} />}
        </span>
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
          title={confirm ? 'click again to remove the track and its clips' : 'remove track'}
          aria-label="remove track"
        >
          <Trash2 size={13} />
        </button>
      </div>
      <div className="timeline-head-toggles">
        <button
          className={`icon-btn icon-btn-sm${track.muted ? ' is-active' : ''}`}
          onClick={() => update({ muted: !track.muted })}
          title={track.muted ? 'unmute track' : 'mute track'}
          aria-label="mute track"
          aria-pressed={track.muted}
        >
          {track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
        </button>
        {isVideo ? (
          <button
            className={`icon-btn icon-btn-sm${track.hidden ? ' is-active' : ''}`}
            onClick={() => update({ hidden: !track.hidden })}
            title={track.hidden ? 'show track' : 'hide track'}
            aria-label="hide track"
            aria-pressed={track.hidden}
          >
            {track.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        ) : null}
        <button
          className={`icon-btn icon-btn-sm${track.locked ? ' is-active' : ''}`}
          onClick={() => update({ locked: !track.locked })}
          title={track.locked ? 'unlock track' : 'lock track'}
          aria-label="lock track"
          aria-pressed={track.locked}
        >
          {track.locked ? <Lock size={13} /> : <Unlock size={13} />}
        </button>
      </div>
    </div>
  );
});
