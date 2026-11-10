import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { ArrowUpRight, Camera, Focus, Grid3x3, Image as ImageIcon, Scan } from 'lucide-react';
import { DND_MIME, getDragPayload, isNcutDrag } from '../../lib/dnd';
import type { DragPayload } from '../../lib/dnd';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { resolveClip } from '../../lib/anim';
import { useSceneCamera } from './sceneCamera';
import type { ViewPreset } from './sceneCamera';
import { useSceneTool, TOOL_KEYS } from './sceneTool';
import { cameraToView, frameSelected, setViewPreset, viewThroughCamera } from './sceneViews';
import { localDelta, withoutRidingChildren } from './attached';
import { GuidesOverlay } from './GuidesOverlay';
import { useGuides } from './guides';
import { frameFileName, movableClipsAt, nudgeDelta } from './nudge';
import { PreviewEngine } from './PreviewEngine';
import { QUALITIES, parseQuality, usePreviewQuality } from './quality';
import { Transport } from './Transport';
import { TransformOverlay } from './TransformOverlay';
import './preview.css';

const VIEW_BUTTONS: ReadonlyArray<{ label: string; title: string; run: () => void }> = [
  ...(['front', 'top', 'side'] as ViewPreset[]).map((name) => ({ label: name, title: `${name} view`, run: () => setViewPreset(name) })),
  { label: 'camera', title: 'look through the project camera at the playhead', run: viewThroughCamera },
];

function readPayload(e: DragEvent): DragPayload | null {
  const live = getDragPayload();
  if (live) return live;
  try {
    const raw = e.dataTransfer.getData(DND_MIME);
    return raw ? (JSON.parse(raw) as DragPayload) : null;
  } catch {
    return null;
  }
}

export function Preview() {
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PreviewEngine | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const mode = useUi((s) => s.previewMode);
  const setMode = useUi((s) => s.setPreviewMode);
  const quality = usePreviewQuality((s) => s.quality);
  const setQuality = usePreviewQuality((s) => s.setQuality);
  const guidesOn = useGuides((s) => s.on);
  const toggleGuides = useGuides((s) => s.toggle);
  const empty = useEditor((s) => (s.project ? s.project.clips.length === 0 : true));

  // engine + layout: the canvas is the largest project-aspect rect that fits the stage
  useEffect(() => {
    const stage = stageRef.current;
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    if (!stage || !frame || !canvas) return;
    const engine = new PreviewEngine(canvas);
    engineRef.current = engine;
    let stageW = 0;
    let stageH = 0;

    const layout = () => {
      const project = useEditor.getState().project;
      if (!project || stageW <= 0 || stageH <= 0) return;
      const k = Math.min(stageW / project.width, stageH / project.height);
      const w = Math.max(1, Math.floor(project.width * k));
      const h = Math.max(1, Math.floor(project.height * k));
      frame.style.width = `${w}px`;
      frame.style.height = `${h}px`;
      engine.resize(w, h);
    };

    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      stageW = e.contentRect.width;
      stageH = e.contentRect.height;
      layout();
    });
    ro.observe(stage);

    const unsub = useEditor.subscribe((s, p) => {
      if (!s.project) return;
      if (!p.project || s.project.width !== p.project.width || s.project.height !== p.project.height) layout();
    });

    return () => {
      ro.disconnect();
      unsub();
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void stage.requestFullscreen().catch(() => undefined);
  }, []);

  const saveFrame = useCallback(() => {
    const engine = engineRef.current;
    const project = useEditor.getState().project;
    if (!engine || !project) return;
    const time = usePlayback.getState().time;
    void engine
      .frameBlob()
      .then((blob) => {
        if (!blob) throw new Error('no frame');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = frameFileName(project.name, time, project.fps);
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      })
      .catch(() => useUi.getState().toast('could not save the frame', 'error'));
  }, []);

  // clicking the picture puts the keyboard focus on the stage (the overlay cancels the default focus change),
  // so the arrow keys can nudge the selected clip
  const onStagePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button === 0) e.currentTarget.focus({ preventScroll: true });
  };

  // arrows nudge the selected visual clips by 1 px (shift = 10) through setClipValue, so keyframes are honoured.
  // left / right fall through to the global frame stepping when nothing can be nudged.
  const onStageKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // scene view tools: w e r pick the tool, f frames the selection. only while the scene view has the focus
    // (e and r are global shortcuts: stop them here so they do not also fire)
    const fromTools = e.target instanceof Element && !!e.target.closest('.scene-tools');
    if (useUi.getState().previewMode === 'scene' && !e.shiftKey && (e.target === e.currentTarget || fromTools) && !e.repeat) {
      const key = e.key.toLowerCase();
      const tool = TOOL_KEYS[key];
      if (tool || key === 'f') {
        e.preventDefault();
        e.stopPropagation();
        if (tool) useSceneTool.getState().setTool(tool);
        else frameSelected();
        return;
      }
    }
    if (e.target !== e.currentTarget) return;
    const d = nudgeDelta(e.key, e.shiftKey);
    if (!d) return;
    const store = useEditor.getState();
    const project = store.project;
    if (!project || store.selection.length === 0) return;
    const time = usePlayback.getState().time;
    const targets = withoutRidingChildren(project, movableClipsAt(project, store.selection, time));
    if (targets.length === 0) return;
    e.preventDefault();
    // the first press is one undo step, held-key repeats join it
    const opts = e.repeat ? { skipHistory: true } : undefined;
    if (!e.repeat && targets.length > 1) store.pushHistory();
    const inner = targets.length > 1 ? { skipHistory: true } : opts;
    for (const c of targets) {
      const t = resolveClip(c, time).transform;
      // right is right on screen, also for a clip attached to a turned or scaled parent
      const l = localDelta(project, c, time, d[0], d[1]);
      if (d[0] !== 0) store.setClipValue(c.id, 'x', time, t.x + l.x, inner);
      if (d[1] !== 0) store.setClipValue(c.id, 'y', time, t.y + l.y, inner);
    }
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!isNcutDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    stageRef.current?.classList.add('is-drop');
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (e.relatedTarget instanceof Node && stageRef.current?.contains(e.relatedTarget)) return;
    stageRef.current?.classList.remove('is-drop');
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    stageRef.current?.classList.remove('is-drop');
    if (!isNcutDrag(e)) return;
    e.preventDefault();
    const payload = readPayload(e);
    if (!payload) return;
    const store = useEditor.getState();
    const start = usePlayback.getState().time;
    // a transition belongs on a clip in the timeline, not on the picture
    if (payload.kind === 'transition') return;
    const id =
      payload.kind === 'asset'
        ? store.insertAsset(payload.assetId, { start })
        : payload.kind === 'effect'
          ? store.addEffect(payload.effect, { start })
          : payload.kind === 'camera'
            ? store.addCamera({ start })
            : payload.kind === 'shape'
              ? store.addShape({ start, preset: payload.preset })
              : store.addText({ start, preset: payload.preset });
    if (id) store.select([id], 'replace');
  };

  return (
    <div className="panel preview">
      <div className="panel-header">
        <span className="panel-title">preview</span>
        {mode === 'scene' && (
          <>
            <button className="icon-btn" title="reset view" aria-label="reset view" onClick={() => useSceneCamera.getState().reset()}>
              <Focus size={14} />
            </button>
            <div className="preview-seg" role="group" aria-label="view">
              {VIEW_BUTTONS.map(({ label, title, run }) => (
                <button key={label} type="button" className="preview-seg-btn" title={title} onClick={run}>
                  {label}
                </button>
              ))}
            </div>
            <button className="icon-btn" title="frame selected (f)" aria-label="frame selected" onClick={frameSelected}>
              <Scan size={14} />
            </button>
            <button className="icon-btn preview-camview" title="move the camera to this view" aria-label="move the camera to this view" onClick={cameraToView}>
              <Camera size={14} />
              <ArrowUpRight size={9} className="preview-camview-arrow" />
            </button>
          </>
        )}
        <button
          className={`icon-btn${guidesOn ? ' is-active' : ''}`}
          title={guidesOn ? 'hide guides' : 'show guides (thirds, center, title safe)'}
          aria-label="guides"
          aria-pressed={guidesOn}
          onClick={toggleGuides}
        >
          <Grid3x3 size={14} />
        </button>
        <button className="icon-btn" title="save frame as png" aria-label="save frame" disabled={empty} onClick={saveFrame}>
          <ImageIcon size={14} />
        </button>
        <select
          className="select input-sm preview-quality"
          value={quality}
          title="preview quality: lower is faster, the export is not affected"
          aria-label="preview quality"
          onChange={(e) => setQuality(parseQuality(e.target.value))}
        >
          {QUALITIES.map((q) => (
            <option key={q.id} value={q.id} title={q.title}>
              {q.id}
            </option>
          ))}
        </select>
        <div className="preview-seg" role="group" aria-label="preview mode">
          {(['output', 'scene'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`preview-seg-btn${mode === m ? ' is-active' : ''}`}
              aria-pressed={mode === m}
              title={m === 'output' ? 'what gets exported' : 'the 3d world from a free camera'}
              onClick={() => setMode(m)}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={stageRef}
        className="preview-stage"
        tabIndex={0}
        onPointerDown={onStagePointerDown}
        onKeyDown={onStageKeyDown}
        onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        <div ref={frameRef} className="preview-frame">
          <canvas ref={canvasRef} className="preview-canvas" />
          <GuidesOverlay />
          <TransformOverlay />
          {empty && <div className="preview-hint">import media to get started</div>}
        </div>
      </div>
      <Transport fullscreen={fullscreen} onToggleFullscreen={toggleFullscreen} />
    </div>
  );
}
