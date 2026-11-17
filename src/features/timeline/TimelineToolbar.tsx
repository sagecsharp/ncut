import { useEffect, useRef } from 'react';
import {
  Brackets,
  Camera,
  Diamond,
  CopyPlus,
  Flag,
  ListEnd,
  Magnet,
  Music,
  PanelLeftClose,
  PanelRightClose,
  Plus,
  Redo2,
  Scan,
  Scissors,
  Snowflake,
  Trash2,
  Undo2,
  UnfoldHorizontal,
  Video,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { formatDuration, formatTimecode } from '../../lib/time';
import { projectDuration } from '../../lib/timelineOps';
import { MAX_ZOOM, MIN_ZOOM, useCanRedo, useCanUndo, useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { REASON_TEXT } from '../shell/reasons';
import { tip } from '../shell/tip';
import { freezeAtPlayhead, trimToPlayhead } from './actions';
import { toggleKeyPanel } from './keyLaneActions';
import { useKeyPanel } from './keyPanelState';
import { toggleTrimMode } from './trimActions';
import { TrackSizeButtons } from './TrackSizeButtons';

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
  const trimMode = useUi((s) => s.trimMode);
  const keyPanelOpen = useKeyPanel((s) => s.open);
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
      <button
        className="icon-btn"
        onClick={() => ed().undo()}
        disabled={!canUndo}
        aria-label="undo"
        {...tip('undo', { keys: 'undo', off: canUndo ? null : REASON_TEXT.noUndo })}
      >
        <Undo2 size={16} />
      </button>
      <button
        className="icon-btn"
        onClick={() => ed().redo()}
        disabled={!canRedo}
        aria-label="redo"
        {...tip('redo', { keys: 'redo', off: canRedo ? null : REASON_TEXT.noRedo })}
      >
        <Redo2 size={16} />
      </button>
      <span className="timeline-toolbar-sep" />
      <button
        className="icon-btn"
        onClick={() => ed().splitClips(usePlayback.getState().time)}
        disabled={!hasClips}
        aria-label="split at playhead"
        {...tip('split', {
          does: 'the selected clips become two at the playhead. nothing selected: every clip under it',
          keys: 'split',
          off: hasClips ? null : REASON_TEXT.addClip,
          why: 'split',
        })}
      >
        <Scissors size={16} />
      </button>
      <button
        className="icon-btn"
        onClick={() => trimToPlayhead('start')}
        disabled={!hasClips}
        aria-label="trim start"
        {...tip('trim start', {
          does: 'the selected clips start at the playhead. nothing selected: the clips under it',
          keys: 'trim-start',
          off: hasClips ? null : REASON_TEXT.addClip,
          why: 'trim-start',
        })}
      >
        <PanelLeftClose size={16} />
      </button>
      <button
        className="icon-btn"
        onClick={() => trimToPlayhead('end')}
        disabled={!hasClips}
        aria-label="trim end"
        {...tip('trim end', {
          does: 'the selected clips end at the playhead. nothing selected: the clips under it',
          keys: 'trim-end',
          off: hasClips ? null : REASON_TEXT.addClip,
          why: 'trim-end',
        })}
      >
        <PanelRightClose size={16} />
      </button>
      <button
        className="icon-btn"
        onClick={() => ed().deleteClips(ed().selection)}
        disabled={!hasSelection}
        aria-label="delete"
        {...tip('delete', { does: 'delete the selected clips. the gap stays', keys: 'delete', off: hasSelection ? null : REASON_TEXT.selectClip })}
      >
        <Trash2 size={16} />
      </button>
      <button
        className="icon-btn"
        onClick={() => ed().deleteClips(ed().selection, { ripple: true })}
        disabled={!hasSelection}
        aria-label="ripple delete"
        {...tip('ripple delete', { does: 'delete the selected clips and close the gap', keys: 'ripple-delete', off: hasSelection ? null : REASON_TEXT.selectClip })}
      >
        <ListEnd size={16} />
      </button>
      <button
        className="icon-btn"
        onClick={() => ed().duplicateClips(ed().selection)}
        disabled={!hasSelection}
        aria-label="duplicate"
        {...tip('duplicate', { does: 'copies of the selected clips, right after them', keys: 'duplicate', off: hasSelection ? null : REASON_TEXT.selectClip })}
      >
        <CopyPlus size={16} />
      </button>
      <button
        className="icon-btn"
        onClick={freezeAtPlayhead}
        disabled={!hasClips}
        aria-label="freeze frame"
        {...tip('freeze frame', {
          does: 'the frame at the playhead becomes a still',
          keys: 'freeze-frame',
          off: hasClips ? null : REASON_TEXT.addClip,
          why: 'freeze-frame',
        })}
      >
        <Snowflake size={16} />
      </button>
      <span className="timeline-toolbar-sep" />
      <button
        className={`icon-btn${snapping ? ' is-active' : ''}`}
        onClick={() => ed().setSnapping(!snapping)}
        aria-label="snapping"
        aria-pressed={snapping}
        {...tip('snapping', {
          does: 'clips stick to clip edges, markers and the playhead while you drag',
          keys: 'snapping',
          on: snapping,
        })}
      >
        <Magnet size={16} />
      </button>
      <button
        className={`icon-btn${trimMode ? ' is-active' : ''}`}
        onClick={() => toggleTrimMode()}
        aria-label="trim mode"
        aria-pressed={trimMode}
        {...tip('trim mode', {
          does: 'edges ripple trim, where two clips touch the edit moves, the middle of a clip slips (alt: slides), shift on an edge stretches',
          keys: 'trim-mode',
          on: trimMode,
        })}
      >
        <Brackets size={16} />
      </button>
      <button
        className={'icon-btn' + (keyPanelOpen ? ' is-active' : '')}
        onClick={() => toggleKeyPanel()}
        aria-label="keyframe panel"
        aria-pressed={keyPanelOpen}
        {...tip('keyframe panel', {
          does: 'one row per animated value of the selected clips, under the tracks. select keyframes there to move, stretch, copy or delete them',
          keys: 'key-panel',
          on: keyPanelOpen,
        })}
      >
        <Diamond size={16} />
      </button>
      <span className="timeline-toolbar-sep" />
      <button
        className="icon-btn"
        onClick={() => ed().addMarker(usePlayback.getState().time)}
        aria-label="add marker"
        {...tip('add marker', { does: 'a marker at the playhead', keys: 'marker-add' })}
      >
        <Flag size={16} />
      </button>
      <span className="timeline-toolbar-sep" />
      <button
        className="icon-btn timeline-add-track"
        onClick={() => ed().addTrack('video')}
        aria-label="add video track"
        {...tip('add video track', { does: 'a new empty video track' })}
      >
        <Plus size={11} />
        <Video size={15} />
      </button>
      <button
        className="icon-btn timeline-add-track"
        onClick={() => ed().addTrack('audio')}
        aria-label="add audio track"
        {...tip('add audio track', { does: 'a new empty audio track' })}
      >
        <Plus size={11} />
        <Music size={15} />
      </button>
      <span className="timeline-toolbar-sep" />
      <button
        className="icon-btn"
        onClick={() => ed().addCamera({ start: usePlayback.getState().time })}
        aria-label="add 3d camera"
        {...tip('add 3d camera', { does: 'a camera clip at the playhead. 3d clips are seen through it', keys: 'add-camera' })}
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
        aria-label="zoom out"
        {...tip('zoom out', { keys: 'zoom-out', off: zoom <= MIN_ZOOM ? REASON_TEXT.zoomedOut : null })}
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
        aria-label="timeline zoom"
        {...tip('timeline zoom', { does: 'ctrl + wheel over the timeline zooms too', keys: ['zoom-out', 'zoom-in'] })}
      />
      <button
        className="icon-btn"
        onClick={() => onZoom(zoom * 1.4)}
        disabled={zoom >= MAX_ZOOM}
        aria-label="zoom in"
        {...tip('zoom in', { keys: 'zoom-in', off: zoom >= MAX_ZOOM ? REASON_TEXT.zoomedIn : null })}
      >
        <ZoomIn size={16} />
      </button>
      <button
        className="icon-btn"
        onClick={onFitSelection}
        disabled={!hasSelection}
        aria-label="zoom to selection"
        {...tip('zoom to selection', { does: 'the selected clips fill the timeline', off: hasSelection ? null : REASON_TEXT.selectClip })}
      >
        <Scan size={16} />
      </button>
      <button
        className="icon-btn"
        onClick={onFit}
        aria-label="zoom to fit"
        {...tip('zoom to fit', { does: 'the whole project fits the timeline', keys: 'zoom-fit' })}
      >
        <UnfoldHorizontal size={16} />
      </button>
      <TrackSizeButtons />
    </div>
  );
}
