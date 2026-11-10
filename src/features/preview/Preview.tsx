import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { DND_MIME, getDragPayload, isNcutDrag } from '../../lib/dnd';
import type { DragPayload } from '../../lib/dnd';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { PreviewEngine } from './PreviewEngine';
import { Transport } from './Transport';
import { TransformOverlay } from './TransformOverlay';
import './preview.css';

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
  const [fullscreen, setFullscreen] = useState(false);
  const empty = useEditor((s) => (s.project ? s.project.clips.length === 0 : true));

  // engine + layout: the canvas is the largest project-aspect rect that fits the stage
  useEffect(() => {
    const stage = stageRef.current;
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    if (!stage || !frame || !canvas) return;
    const engine = new PreviewEngine(canvas);
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
            : store.addText({ start, preset: payload.preset });
    if (id) store.select([id], 'replace');
  };

  return (
    <div className="panel preview">
      <div className="panel-header">
        <span className="panel-title">preview</span>
      </div>
      <div ref={stageRef} className="preview-stage" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        <div ref={frameRef} className="preview-frame">
          <canvas ref={canvasRef} className="preview-canvas" />
          <TransformOverlay />
          {empty && <div className="preview-hint">import media to get started</div>}
        </div>
      </div>
      <Transport fullscreen={fullscreen} onToggleFullscreen={toggleFullscreen} />
    </div>
  );
}
