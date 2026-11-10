import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { ArrowUpRight, Camera, Focus, Grid3x3, ImageDown, PictureInPicture2, Scan } from 'lucide-react';
import { DND_MIME, getDragPayload, isNcutDrag } from '../../lib/dnd';
import type { DragPayload } from '../../lib/dnd';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { resolveClip } from '../../lib/anim';
import type { SourceResolver } from '../../engine/draw';
import { useSceneCamera } from './sceneCamera';
import type { ViewPreset } from './sceneCamera';
import { useSceneTool, TOOL_KEYS } from './sceneTool';
import { cameraToView, frameSelected, setViewPreset, viewThroughCamera } from './sceneViews';
import { localDelta, withoutRidingChildren } from './attached';
import { CameraInset } from './CameraInset';
import { useCameraInset } from './insetState';
import { GuidesOverlay } from './GuidesOverlay';
import { beginPreviewGesture, endPreviewGesture } from './gesture';
import { useGuides } from './guides';
import { frameFileName, movableClipsAt, nudgeDelta } from './nudge';
import { PreviewEngine } from './PreviewEngine';
import { QUALITIES, parseQuality, usePreviewQuality } from './quality';
import { setPan, stepView, usePreviewView, viewMetrics } from './previewView';
import { Transport } from './Transport';
import { TransformOverlay } from './TransformOverlay';
import { ZoomControl } from './ZoomControl';
import { accumulateWheel, clampPan, fitScale, percentLabel, resolveScale, wheelPixels } from './zoomMath';
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
  const spaceRef = useRef({ hover: false, down: false, used: false });
  const panRef = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);
  const panNext = useRef<{ x: number; y: number } | null>(null);
  const panRaf = useRef(0);
  const [fullscreen, setFullscreen] = useState(false);
  const mode = useUi((s) => s.previewMode);
  const setMode = useUi((s) => s.setPreviewMode);
  const quality = usePreviewQuality((s) => s.quality);
  const setQuality = usePreviewQuality((s) => s.setQuality);
  const guidesOn = useGuides((s) => s.on);
  const toggleGuides = useGuides((s) => s.toggle);
  const insetOn = useCameraInset((s) => s.on);
  const toggleInset = useCameraInset((s) => s.toggle);
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
      // the canvas' css box: the fitted size, or the zoomed size moved by the pan. the overlays measure this box,
      // so zoom and pan reach them without further wiring. the scene view always shows the whole picture.
      const fit = fitScale(stageW, stageH, project.width, project.height);
      viewMetrics.stageW = stageW;
      viewMetrics.stageH = stageH;
      viewMetrics.fit = fit;
      const view = usePreviewView.getState();
      const zoom = useUi.getState().previewMode === 'output' ? view.zoom : 'fit';
      const k = resolveScale(zoom, fit);
      const w = Math.max(1, Math.floor(project.width * k));
      const h = Math.max(1, Math.floor(project.height * k));
      const pan = zoom === 'fit' ? { panX: 0, panY: 0 } : clampPan(view.panX, view.panY, w, h, stageW, stageH);
      frame.style.width = `${w}px`;
      frame.style.height = `${h}px`;
      frame.style.transform = pan.panX === 0 && pan.panY === 0 ? '' : `translate3d(${pan.panX}px, ${pan.panY}px, 0)`;
      // magnified pixels stay crisp instead of smearing
      canvas.style.imageRendering = k >= 2 ? 'pixelated' : '';
      engine.resize(w, h);
      // the zoom control shows the scale; a pan the new panel size no longer allows is pulled back
      // (the layout runs again with the same numbers and stops)
      const patch: { scale?: number; panX?: number; panY?: number } = {};
      if (percentLabel(view.scale) !== percentLabel(k)) patch.scale = k;
      if (zoom !== 'fit' && (pan.panX !== view.panX || pan.panY !== view.panY)) {
        patch.panX = pan.panX;
        patch.panY = pan.panY;
      }
      if (Object.keys(patch).length > 0) usePreviewView.setState(patch);
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

    const unView = usePreviewView.subscribe((s, p) => {
      if (s.zoom !== p.zoom || s.panX !== p.panX || s.panY !== p.panY) layout();
    });
    const unMode = useUi.subscribe((s, p) => {
      if (s.previewMode !== p.previewMode) layout();
    });

    return () => {
      ro.disconnect();
      unsub();
      unView();
      unMode();
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  // ctrl / meta + wheel zooms around the pointer, space (held) + drag or the middle button pans
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let acc = 0;
    let lastWheel = 0;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey) || useUi.getState().previewMode !== 'output') return;
      const frame = frameRef.current;
      if (!frame) return;
      // also stops the browser from zooming the whole page
      e.preventDefault();
      if (e.timeStamp - lastWheel > 250) acc = 0;
      lastWheel = e.timeStamp;
      const r = accumulateWheel(acc, wheelPixels(e.deltaY, e.deltaMode));
      acc = r.acc;
      if (r.step === 0) return;
      const fr = frame.getBoundingClientRect();
      stepView(r.step === -1 ? 1 : -1, e.clientX - (fr.left + fr.width / 2), e.clientY - (fr.top + fr.height / 2));
    };
    stage.addEventListener('wheel', onWheel, { passive: false });

    // space pans while the picture is zoomed in and the pointer is over it. the global shortcut would toggle play
    // on the key press, so this swallows the press and does the toggle itself on release when nothing was dragged
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !spaceRef.current.hover || useUi.getState().previewMode !== 'output') return;
      if (usePreviewView.getState().zoom === 'fit' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(t.tagName))) return;
      if (useUi.getState().dialog !== null || document.querySelector('.dialog-backdrop')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat || spaceRef.current.down) return;
      spaceRef.current.down = true;
      spaceRef.current.used = false;
      stage.classList.add('is-pan-ready');
    };
    const releaseSpace = (toggle: boolean) => {
      const sp = spaceRef.current;
      if (!sp.down) return;
      sp.down = false;
      stage.classList.remove('is-pan-ready');
      if (toggle && !sp.used) usePlayback.getState().toggle();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !spaceRef.current.down) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      releaseSpace(true);
    };
    const onBlur = () => releaseSpace(false);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      stage.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      cancelAnimationFrame(panRaf.current);
      if (panRef.current) endPreviewGesture();
      panRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // the inset draws with the engine's media sources (read when needed: the engine is made after the first render)
  const getResolve = useCallback((): SourceResolver | null => engineRef.current?.resolve ?? null, []);

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
    // the frame is the one at the playhead: stop first so it cannot move on while the picture renders
    usePlayback.getState().pause();
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

  // middle button, or space held + left button: move the zoomed picture. runs before the overlay sees the press.
  const onStagePanDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (useUi.getState().previewMode !== 'output' || panRef.current) return;
    const sp = spaceRef.current;
    const viaSpace = e.button === 0 && sp.down;
    if (e.button !== 1 && !viaSpace) return;
    e.preventDefault();
    e.stopPropagation();
    if (viaSpace) sp.used = true;
    const v = usePreviewView.getState();
    panRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, panX: v.panX, panY: v.panY };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.classList.add('is-panning');
    beginPreviewGesture();
  };
  const onStagePanMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = panRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    panNext.current = { x: e.clientX, y: e.clientY };
    if (panRaf.current) return;
    panRaf.current = requestAnimationFrame(() => {
      panRaf.current = 0;
      const to = panNext.current;
      const cur = panRef.current;
      panNext.current = null;
      if (to && cur) setPan(cur.panX + to.x - cur.x, cur.panY + to.y - cur.y);
    });
  };
  const onStagePanEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = panRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    cancelAnimationFrame(panRaf.current);
    panRaf.current = 0;
    if (e.type === 'pointerup') setPan(g.panX + e.clientX - g.x, g.panY + e.clientY - g.y);
    panRef.current = null;
    panNext.current = null;
    e.currentTarget.classList.remove('is-panning');
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    endPreviewGesture();
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
            <button
              className={`icon-btn${insetOn ? ' is-active' : ''}`}
              title={insetOn ? 'hide the camera view' : 'show the camera view (what the output looks like)'}
              aria-label="camera view"
              aria-pressed={insetOn}
              onClick={toggleInset}
            >
              <PictureInPicture2 size={14} />
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
        {mode === 'output' && <ZoomControl />}
        <button className="icon-btn" title="save this frame as a png" aria-label="save frame" disabled={empty} onClick={saveFrame}>
          <ImageDown size={14} />
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
        onPointerDownCapture={onStagePanDown}
        onPointerMove={onStagePanMove}
        onPointerUp={onStagePanEnd}
        onPointerCancel={onStagePanEnd}
        onPointerEnter={() => {
          spaceRef.current.hover = true;
        }}
        onPointerLeave={() => {
          spaceRef.current.hover = false;
        }}
        onKeyDown={onStageKeyDown}
        onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        <div ref={frameRef} className="preview-frame">
          <canvas ref={canvasRef} className="preview-canvas" />
          <GuidesOverlay />
          <TransformOverlay />
          <CameraInset getResolve={getResolve} />
          {empty && <div className="preview-hint">import media to get started</div>}
        </div>
      </div>
      <Transport fullscreen={fullscreen} onToggleFullscreen={toggleFullscreen} />
    </div>
  );
}
