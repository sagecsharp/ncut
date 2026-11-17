import { memo, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Eye, EyeOff, Headphones, Lock, MoveHorizontal, Music, Pin, Trash2, Unlock, Video, Volume2, VolumeX } from 'lucide-react';
import type { Track } from '../../types';
import { useEditor } from '../../store/editorStore';
import { useSolo } from '../../store/solo';
import { useSource } from '../../store/source';
import { useUi } from '../../store/ui';
import { soloActive, trackSoundLine } from '../../lib/mix';
import { HEAD_FULL_H, TRACK_H_MAX, TRACK_H_MIN, syncLockOf, trackHeightOf } from '../../lib/trackTools';
import { tip } from '../shell/tip';
import { openTrackMenuAt } from './commands';
import { startTrackMove, startTrackSize } from './headDrag';
import { headToggles } from './headToggles';
import type { HeadState, HeadToggle } from './headToggles';
import { selectTrackClips } from './trackClips';
import { setTrackHeight, toggleSyncLock } from './trackActions';
import { useTrackDrop } from './trackDrop';
import { TargetToggle } from './TargetToggle';
import '../media/mixer/mixer.css';

interface Props {
  track: Track;
}

/** the keys of the height edge: arrows 8 px, shift and page keys 32 px */
function heightKey(e: KeyboardEvent<HTMLElement>, h: number): number | null | undefined {
  if (e.ctrlKey || e.metaKey || e.altKey) return undefined;
  const big = e.shiftKey ? 32 : 8;
  switch (e.key) {
    case 'ArrowUp':
    case 'ArrowRight':
      return h + big;
    case 'ArrowDown':
    case 'ArrowLeft':
      return h - big;
    case 'PageUp':
      return h + 32;
    case 'PageDown':
      return h - 32;
    case 'Home':
      return TRACK_H_MIN;
    case 'End':
      return TRACK_H_MAX;
    case 'Enter':
      return null;
    default:
      return undefined;
  }
}

/** left column cell of a track row: kind icon, name (double click to rename), toggles, remove. a short row has one line */
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
  const dragging = useTrackDrop((s) => s.dragging === track.id);
  const dropSide = useTrackDrop((s) => (s.over === track.id ? s.side : null));
  const dropText = useTrackDrop((s) => (s.over === track.id ? s.label : ''));
  const h = trackHeightOf(track);
  const compact = h < HEAD_FULL_H;
  const syncOn = syncLockOf(track);
  const state: HeadState = { video: isVideo, target: shown, muted: !!track.muted, solo: on, hidden: !!track.hidden, locked: !!track.locked, syncOff: !syncOn };
  const list = headToggles(state, compact);

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

  const sync = (shift: boolean) => {
    if (!shift) {
      toggleSyncLock([track.id]);
      return;
    }
    const ids = (useEditor.getState().project?.tracks ?? []).filter((t) => t.kind === track.kind).map((t) => t.id);
    toggleSyncLock(ids, !syncOn);
  };

  const button = (id: HeadToggle) => {
    switch (id) {
      case 'target':
        return <TargetToggle key={id} track={track} />;
      case 'mute':
        return (
          <button
            key={id}
            className={`icon-btn icon-btn-sm${track.muted ? ' is-active' : ''}`}
            onClick={() => update({ muted: !track.muted })}
            {...tip('mute track', { does: 'no sound from this track', on: track.muted })}
            aria-label="mute track"
            aria-pressed={track.muted}
          >
            {track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
          </button>
        );
      case 'solo':
        return (
          <button
            key={id}
            className={'icon-btn icon-btn-sm' + (on ? ' is-solo' : '')}
            onClick={(e) => useSolo.getState().toggleSolo(track.id, e.altKey)}
            {...tip('solo track', { does: 'hear only the tracks on solo. for listening only: it is not saved and the export has every track. alt+click: solo only this track', on })}
            aria-label="solo track"
            aria-pressed={on}
          >
            <Headphones size={13} />
          </button>
        );
      case 'hide':
        return (
          <button
            key={id}
            className={`icon-btn icon-btn-sm${track.hidden ? ' is-active' : ''}`}
            onClick={() => update({ hidden: !track.hidden })}
            {...tip('hide track', { does: 'its clips are not drawn, in the preview and in the export', on: track.hidden })}
            aria-label="hide track"
            aria-pressed={track.hidden}
          >
            {track.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        );
      case 'lock':
        return (
          <button
            key={id}
            className={`icon-btn icon-btn-sm${track.locked ? ' is-active' : ''}`}
            onClick={() => update({ locked: !track.locked })}
            {...tip('lock track', { does: 'its clips cannot be moved or changed', on: track.locked })}
            aria-label="lock track"
            aria-pressed={track.locked}
          >
            {track.locked ? <Lock size={13} /> : <Unlock size={13} />}
          </button>
        );
      case 'sync':
        return (
          <button
            key={id}
            className={`icon-btn icon-btn-sm${syncOn ? '' : ' is-sync-off'}`}
            onClick={(e) => sync(e.shiftKey)}
            {...tip('sync lock', {
              does: 'on: ripple, insert and extract on other tracks move this track too, so it stays in sync. off: it stays where it is. shift+click: every track of this kind',
              on: syncOn,
            })}
            aria-label="sync lock"
            aria-pressed={syncOn}
          >
            {syncOn ? <MoveHorizontal size={13} /> : <Pin size={13} />}
          </button>
        );
    }
  };

  const kindButton = (
    <button
      type="button"
      className="timeline-head-kind"
      aria-label="track menu"
      onClick={(e) => openTrackMenuAt(e.currentTarget, track.id)}
      {...tip('track menu', { does: 'select, close gaps, insert a gap, transitions on every cut. a right click on the track works too' })}
    >
      {isVideo ? <Video size={13} /> : <Music size={13} />}
    </button>
  );

  const name = editing ? (
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
  );

  const cls = `timeline-head${track.locked ? ' is-locked' : ''}${active && !on ? ' is-unheard' : ''}${compact ? ' is-compact' : ''}${dragging ? ' is-drag-source' : ''}${
    dropSide ? ` is-drop-${dropSide}` : ''
  }`;

  return (
    <div className={cls} data-track-id={track.id} onPointerDown={(e) => startTrackMove(e.nativeEvent, track.id, e.currentTarget)}>
      {compact ? (
        <div className="timeline-head-top">
          {kindButton}
          {name}
          <div className="timeline-head-toggles">{list.map(button)}</div>
        </div>
      ) : (
        <>
          <div className="timeline-head-top">
            {kindButton}
            {name}
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
          <div className={`timeline-head-toggles${list.length >= 6 ? ' is-six' : ''}`}>
            {list.map(button)}
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
        </>
      )}
      {dropText ? <span className="timeline-head-drop">{dropText}</span> : null}
      <div
        className="timeline-head-size"
        role="slider"
        tabIndex={0}
        aria-label="track height"
        aria-orientation="vertical"
        aria-valuemin={TRACK_H_MIN}
        aria-valuemax={TRACK_H_MAX}
        aria-valuenow={h}
        aria-valuetext={`${h} px`}
        onPointerDown={(e) => {
          // a mouse press does not leave the focus on the edge (its arrows and home / end are for the keyboard): tab still reaches it
          if ((e.pointerType === 'mouse' || e.pointerType === 'pen') && e.button === 0) {
            e.preventDefault();
            const active = document.activeElement;
            if (active instanceof HTMLElement && active !== document.body) active.blur();
          }
          startTrackSize(e.nativeEvent, track.id, e.currentTarget.closest('.timeline-head') as HTMLElement);
        }}
        onMouseDown={(e) => e.preventDefault()}
        onDoubleClick={() => setTrackHeight(track.id, null)}
        onKeyDown={(e) => {
          const next = heightKey(e, h);
          if (next === undefined) return;
          e.preventDefault();
          setTrackHeight(track.id, next);
        }}
        {...tip('track height', { does: 'drag to make the track taller or shorter. shift+drag: every track of its kind. double click: normal height', keys: ['tracks-shorter', 'tracks-taller'] })}
      >
        <span className="timeline-head-size-readout" aria-hidden="true">
          {h} px
        </span>
      </div>
    </div>
  );
});
