import { useEffect, useRef } from 'react';
import type { DragEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowLeftToLine, ArrowRightToLine, AudioLines, Brackets, Eraser, Film, Pause, Play, Plus, Repeat, SkipBack, SkipForward, StepBack, StepForward, Volume1, Volume2, VolumeX, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { isExporting } from '../../engine/exportState';
import { inOutSpan } from '../../lib/inOut';
import { inLabelTime, marksOf, outLabelTime } from '../../lib/marks';
import { beginDrag, endDrag } from '../../lib/dnd';
import { formatTimecode } from '../../lib/time';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useSource } from '../../store/source';
import { useUi } from '../../store/ui';
import { REASON_TEXT } from '../shell/reasons';
import { tip } from '../shell/tip';
import { emptySource, runSourceKey, sourceAdd, sourceAddPart } from './sourceKeys';
import type { ViewKey } from './sourceKeys';

interface KeyRow {
  keys: ViewKey;
  name: string;
  does?: string;
  Icon: LucideIcon;
}

/** 1 to 5, left of the play button's neighbours: the buttons that run a key of the source view */
const BEFORE: readonly KeyRow[] = [
  { keys: 'seek-start', name: 'jump to start', Icon: SkipBack },
  { keys: 'frame-back', name: 'previous frame', Icon: StepBack },
];
const AFTER: readonly KeyRow[] = [
  { keys: 'frame-forward', name: 'next frame', Icon: StepForward },
  { keys: 'seek-end', name: 'jump to end', does: 'the last frame', Icon: SkipForward },
];
/** 7 to 10 */
const MARKS: readonly KeyRow[] = [
  { keys: 'mark-in', name: 'mark in', does: 'the marked part starts at this frame', Icon: ArrowRightToLine },
  { keys: 'mark-out', name: 'mark out', does: 'the marked part ends with this frame', Icon: ArrowLeftToLine },
  { keys: 'play-in-out', name: 'play in to out', does: 'plays the marked part once. press again to stop', Icon: Brackets },
  { keys: 'clear-in-out', name: 'clear in and out', does: 'the whole media is used again', Icon: Eraser },
];

/** the transport under the source view. a button with a key runs the key, so a click and the key say the same */
export function SourceTransport() {
  const assetId = useSource((s) => s.assetId);
  const playing = useSource((s) => s.playing);
  const asset = useEditor((s) => (assetId ? (s.project?.assets.find((a) => a.id === assetId) ?? null) : null));
  const fps = useEditor((s) => s.project?.fps ?? 30);
  const loop = usePlayback((s) => s.loop);
  const muted = usePlayback((s) => s.muted);
  const volume = usePlayback((s) => s.volume);
  // the export stops the source: the dialog opening is the cue to read isExporting again
  useUi((s) => s.dialog);
  const timeRef = useRef<HTMLSpanElement>(null);

  const picture = asset?.kind === 'image';
  const timed = !!asset && !picture;
  const duration = timed ? asset.duration : 0;
  const marks = marksOf(asset);
  const span = inOutSpan(marks, duration);
  const T = REASON_TEXT;
  const noMarks = !marks ? T.noInOut : null;
  const playOff = picture ? T.sourcePicture : isExporting() ? T.sourceExport : !asset ? T.sourceEmpty : null;

  // the current time is written straight to the dom: it changes every frame while playing
  useEffect(() => {
    let last = '';
    const write = (t: number) => {
      const text = formatTimecode(t, fps);
      if (text !== last && timeRef.current) {
        timeRef.current.textContent = text;
        last = text;
      }
    };
    write(useSource.getState().time);
    return useSource.subscribe((s, p) => {
      if (s.time !== p.time || s.assetId !== p.assetId) write(s.time);
    });
  }, [fps]);

  let markedText = '';
  if (marks && timed) {
    if (marks.in !== undefined && marks.out !== undefined && span) markedText = `in to out ${formatTimecode(span.end - span.start, fps)}`;
    else if (marks.in !== undefined) markedText = `in ${formatTimecode(inLabelTime(marks, fps), fps)}`;
    else if (marks.out !== undefined) markedText = `out ${formatTimecode(outLabelTime(marks, duration, fps), fps)}`;
  }

  const keyBtn = (r: KeyRow, off: string | null) => (
    <button
      key={r.keys}
      className="icon-btn"
      {...tip(r.name, { keys: r.keys, does: r.does, off: picture ? T.sourcePicture : off })}
      aria-label={r.name}
      disabled={picture}
      onClick={() => runSourceKey(r.keys)}
    >
      <r.Icon size={16} />
    </button>
  );

  const pb = usePlayback.getState;
  const shownVolume = muted ? 0 : volume;
  const VolumeIcon = shownVolume === 0 ? VolumeX : shownVolume < 0.5 ? Volume1 : Volume2;

  // the two halves of a video with sound: drag one onto the timeline, or click to add it at the playhead
  const handle = (parts: 'picture' | 'sound') => {
    const onDragStart = (e: DragEvent<HTMLSpanElement>) => {
      if (!asset) return;
      beginDrag(e, { kind: 'asset', assetId: asset.id, ...(marks ? { range: marks } : {}), parts });
    };
    const onKeyDown = (e: ReactKeyboardEvent<HTMLSpanElement>) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      // also after a mouse focus: space would play, enter would add twice
      e.preventDefault();
      if (!e.repeat) sourceAddPart(parts);
    };
    const common = {
      className: 'source-handle',
      role: 'button',
      tabIndex: 0,
      draggable: true,
      onDragStart,
      onDragEnd: endDrag,
      onClick: () => sourceAddPart(parts),
      onKeyDown,
    };
    return parts === 'picture' ? (
      <span
        {...common}
        {...tip('picture only', { does: 'drag it onto the timeline: the marked part without its sound. a click adds it at the playhead' })}
        aria-label="picture only"
      >
        <Film size={16} />
      </span>
    ) : (
      <span
        {...common}
        {...tip('sound only', { does: 'drag it onto the timeline: only the sound of the marked part, on an audio track. a click adds it at the playhead' })}
        aria-label="sound only"
      >
        <AudioLines size={16} />
      </span>
    );
  };

  return (
    <div className="preview-transport source-transport">
      {BEFORE.map((r) => keyBtn(r, null))}
      <button
        className="btn btn-primary preview-play"
        {...tip(playing ? 'pause' : 'play', { keys: 'play-pause', off: playOff })}
        aria-label={playing ? 'pause' : 'play'}
        disabled={playOff !== null}
        onClick={() => runSourceKey('play-pause')}
      >
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      {AFTER.map((r) => keyBtn(r, null))}
      <button
        className={`icon-btn${loop ? ' is-active' : ''}`}
        {...tip('loop', { does: 'start again at the end. with in and out points: play in to out again and again', on: loop })}
        aria-label="toggle loop"
        aria-pressed={loop}
        onClick={() => pb().setLoop(!loop)}
      >
        <Repeat size={16} />
      </button>
      {MARKS.map((r) => keyBtn(r, r.keys === 'play-in-out' || r.keys === 'clear-in-out' ? noMarks : null))}

      <div className="preview-time mono source-time" title="source playhead / media length">
        <span ref={timeRef}>{formatTimecode(0, fps)}</span>
        <span className="preview-time-sep">/</span>
        <span className="preview-time-total">{formatTimecode(duration, fps)}</span>
      </div>
      {markedText ? <span className="source-marked mono">{markedText}</span> : null}

      <div className="preview-spacer" />

      {asset?.kind === 'video' && asset.hasAudio ? (
        <>
          {handle('picture')}
          {handle('sound')}
        </>
      ) : null}
      <button className="icon-btn" {...tip('add to timeline', { does: 'the marked part at the playhead', why: 'source-add' })} aria-label="add to timeline" onClick={sourceAdd}>
        <Plus size={16} />
      </button>
      <button
        className="icon-btn"
        {...tip('mute the preview', { does: 'only the preview. the export keeps its sound', on: muted })}
        aria-label="mute the preview"
        aria-pressed={muted}
        onClick={() => {
          if (muted && pb().volume === 0) pb().setVolume(1);
          pb().setMuted(!muted);
        }}
      >
        <VolumeIcon size={16} />
      </button>
      <button className="icon-btn" {...tip('empty the source view', { does: 'the media stays in the project' })} aria-label="empty the source view" onClick={emptySource}>
        <X size={16} />
      </button>
    </div>
  );
}
