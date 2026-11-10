import { useEffect, useRef } from 'react';
import {
  Camera,
  Copy,
  Flag,
  ListEnd,
  Magnet,
  Maximize2,
  Music,
  Plus,
  Redo2,
  Scan,
  Scissors,
  Snowflake,
  Trash2,
  Undo2,
  Video,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { formatDuration, formatTimecode } from '../../lib/time';
import { projectDuration } from '../../lib/timelineOps';
import { MAX_ZOOM, MIN_ZOOM, useCanRedo, useCanUndo, useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { freezeAtPlayhead } from './actions';

interface Props {
  /** zoom to an absolute px/second value, keeping the playhead steady in the viewport */
  onZoom(zoom: number): void;
  onFit(): void;
  onFitSelection(): void;
}

const SLIDER_STEPS = 1000;
const LOG_RANGE = Math.log(MAX_ZOOM / MIN_ZOOM);

function zoomToSlider(zoom: number): number {
  return Math.round((Math.log(Math.max(MIN_ZOOM, zoom) / MIN_ZOOM) / LOG_RANGE) * SLIDER_STEPS);
}
function sliderToZoom(v: number): number {
  return MIN_ZOOM * Math.exp((v / SLIDER_STEPS) * LOG_RANGE);
}

export function TimelineToolbar({ onZoom, onFit, onFitSelection }: Props) {
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();
  const selectedCount = useEditor((s) => s.selection.length);
  const hasSelection = selectedCount > 0;
  const hasClips = useEditor((s) => (s.project?.clips.length ?? 0) > 0);
  const snapping = useEditor((s) => s.snapping);
  const zoom = useEditor((s) => s.zoom);
  const fps = useEditor((s) => s.project?.fps ?? 30);
  const duration = useEditor((s) => (s.project ? projectDuration(s.project) : 0));
  const tcRef = useRef<HTMLSpanElement>(null);

  // timecode text is written straight to the dom, never through react state
  useEffect(() => {
    const el = tcRef.current;
    if (!el) return;
    const update = () => {
      const text = formatTimecode(usePlayback.getState().time, fps);
      if (el.textContent !== text) el.textContent = text;
    };
    update();
    return usePlayback.subscribe(update);
  }, [fps]);

  const ed = () => useEditor.getState();

  return (
    <div className="panel-header timeline-toolbar">
      <button className="icon-btn" onClick={() => ed().undo()} disabled={!canUndo} title="undo" aria-label="undo">
        <Undo2 size={16} />
      </button>
      <button className="icon-btn" onClick={() => ed().redo()} disabled={!canRedo} title="redo" aria-label="redo">
        <Redo2 size={16} />
      </button>
      <span className="timeline-toolbar-sep" />
      <button
        className="icon-btn"
        onClick={() => ed().splitClips(usePlayback.getState().time)}
        disabled={!hasClips}
        title="split at playhead (selected clips, or every clip under it)"
        aria-label="split at playhead"
      >
        <Scissors size={16} />
      </button>
      <button
        className="icon-btn"
        onClick={() => ed().deleteClips(ed().selection)}
        disabled={!hasSelection}
        title="delete selected clips"
        aria-label="delete"
      >
        <Trash2 size={16} />
      </button>
      <button
        className="icon-btn"
        onClick={() => ed().deleteClips(ed().selection, { ripple: true })}
        disabled={!hasSelection}
        title="ripple delete: delete and close the gap"
        aria-label="ripple delete"
      >
        <ListEnd size={16} />
      </button>
      <button
        className="icon-btn"
        onClick={() => ed().duplicateClips(ed().selection)}
        disabled={!hasSelection}
        title="duplicate selected clips"
        aria-label="duplicate"
      >
        <Copy size={16} />
      </button>
      <button
        className="icon-btn"
        onClick={freezeAtPlayhead}
        disabled={!hasClips}
        title="freeze frame (shift+f)"
        aria-label="freeze frame"
      >
        <Snowflake size={16} />
      </button>
      <span className="timeline-toolbar-sep" />
      <button
        className={`icon-btn${snapping ? ' is-active' : ''}`}
        onClick={() => ed().setSnapping(!snapping)}
        title={snapping ? 'snapping on' : 'snapping off'}
        aria-label="toggle snapping"
        aria-pressed={snapping}
      >
        <Magnet size={16} />
      </button>
      <span className="timeline-toolbar-sep" />
      <button
        className="icon-btn"
        onClick={() => ed().addMarker(usePlayback.getState().time)}
        title="add marker at the playhead"
        aria-label="add marker"
      >
        <Flag size={16} />
      </button>
      <span className="timeline-toolbar-sep" />
      <button
        className="icon-btn timeline-add-track"
        onClick={() => ed().addTrack('video')}
        title="add video track"
        aria-label="add video track"
      >
        <Plus size={11} />
        <Video size={15} />
      </button>
      <button
        className="icon-btn timeline-add-track"
        onClick={() => ed().addTrack('audio')}
        title="add audio track"
        aria-label="add audio track"
      >
        <Plus size={11} />
        <Music size={15} />
      </button>
      <span className="timeline-toolbar-sep" />
      <button
        className="icon-btn"
        onClick={() => ed().addCamera({ start: usePlayback.getState().time })}
        title="add 3d camera"
        aria-label="add 3d camera"
      >
        <Camera size={16} />
      </button>

      <span className="spacer" />

      <span className="timeline-timecode mono" title="playhead position / project length">
        <span ref={tcRef} className="timeline-timecode-now" />
        <span className="timeline-timecode-total"> / {formatDuration(duration)}</span>
        {hasSelection ? <span className="timeline-selection"> | {selectedCount} selected</span> : null}
      </span>

      <span className="spacer" />

      <button
        className="icon-btn"
        onClick={() => onZoom(zoom / 1.4)}
        disabled={zoom <= MIN_ZOOM}
        title="zoom out"
        aria-label="zoom out"
      >
        <ZoomOut size={16} />
      </button>
      <input
        className="range timeline-zoom"
        type="range"
        min={0}
        max={SLIDER_STEPS}
        step={1}
        value={zoomToSlider(zoom)}
        onChange={(e) => onZoom(sliderToZoom(Number(e.target.value)))}
        onPointerUp={(e) => e.currentTarget.blur()}
        title="zoom"
        aria-label="zoom"
      />
      <button
        className="icon-btn"
        onClick={() => onZoom(zoom * 1.4)}
        disabled={zoom >= MAX_ZOOM}
        title="zoom in"
        aria-label="zoom in"
      >
        <ZoomIn size={16} />
      </button>
      <button
        className="icon-btn"
        onClick={onFitSelection}
        disabled={!hasSelection}
        title="zoom to the selected clips"
        aria-label="zoom to selection"
      >
        <Scan size={16} />
      </button>
      <button className="icon-btn" onClick={onFit} title="zoom to fit (shift+z)" aria-label="zoom to fit">
        <Maximize2 size={16} />
      </button>
    </div>
  );
}
