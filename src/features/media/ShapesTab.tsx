import { memo, useEffect, useRef } from 'react';
import { drawShape } from '../../engine/shape';
import { createShapeClip } from '../../lib/factory';
import { beginDrag, endDrag } from '../../lib/dnd';
import { APPEARANCE_EVENT } from '../../lib/appearance';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { cssVar } from '../timeline/view';
import { SHAPE_PRESETS, fitPreview } from './shapePresets';
import type { ShapePreset } from './shapePresets';

/** preview canvas, css px. drawn once per card (and again when the theme changes) */
const PREVIEW_W = 120;
const PREVIEW_H = 56;
/** the shapes are drawn inside this box so they never touch the edge */
const BOX_W = 96;
const BOX_H = 40;
/** the frame-sized cards are previewed with a 16:9 stand-in */
const FRAME_RATIO = 16 / 9;

function canvasSize(): { w: number; h: number } {
  const p = useEditor.getState().project;
  return { w: p?.width ?? 1920, h: p?.height ?? 1080 };
}

function isFrameCard(id: string): boolean {
  return id === 'background' || id === 'solid-background';
}

/** draw the card once, in the theme's text color (two grays for the gradient card) */
function drawPreview(canvas: HTMLCanvasElement, preset: ShapePreset): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const bw = Math.round(PREVIEW_W * dpr);
  const bh = Math.round(PREVIEW_H * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, bw, bh);

  const text = cssVar('--text');
  const fields = preset.build(1920, 1080);
  const frame = isFrameCard(preset.id);
  // size relative to the ratio only, so the preview never depends on the open project
  const srcW = frame ? 1000 * FRAME_RATIO : (fields.width ?? 400);
  const srcH = frame ? 1000 : (fields.height ?? 400);
  const box = fitPreview(srcW, srcH, BOX_W, BOX_H);
  const k = box.w / srcW;

  const clip = createShapeClip('preview', 0, {
    ...fields,
    color: preset.id === 'background' ? cssVar('--text-dim') : text,
    color2: preset.id === 'background' ? cssVar('--text-faint') : null,
    stroke: fields.stroke ? { color: text, width: Math.max(1, fields.stroke.width * k) } : null,
  });

  ctx.setTransform(dpr, 0, 0, dpr, (PREVIEW_W / 2) * dpr, (PREVIEW_H / 2) * dpr);
  drawShape(ctx, clip, box.w, box.h, 1);
}

function addPreset(preset: ShapePreset): void {
  const { w, h } = canvasSize();
  // addShape selects the new clip itself
  useEditor.getState().addShape({ start: usePlayback.getState().time, preset: preset.build(w, h) });
}

const ShapeCard = memo(function ShapeCard({ preset }: { preset: ShapePreset }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => drawPreview(canvas, preset);
    draw();
    window.addEventListener(APPEARANCE_EVENT, draw);
    return () => window.removeEventListener(APPEARANCE_EVENT, draw);
  }, [preset]);

  return (
    <button
      className="media-text-card media-shape-card"
      draggable
      title={`add ${preset.label} (${preset.hint}) at the playhead, or drag it onto the timeline`}
      onClick={() => addPreset(preset)}
      onDragStart={(e) => {
        const { w, h } = canvasSize();
        beginDrag(e, { kind: 'shape', preset: preset.build(w, h) });
      }}
      onDragEnd={endDrag}
    >
      <span className="media-text-preview">
        <canvas ref={canvasRef} className="media-shape-canvas" width={PREVIEW_W} height={PREVIEW_H} />
      </span>
      <span className="media-text-meta">
        <span className="media-text-label">{preset.label}</span>
      </span>
    </button>
  );
});

export function ShapesTab() {
  return (
    <div className="media-text-tab media-shape-tab">
      {SHAPE_PRESETS.map((p) => (
        <ShapeCard key={p.id} preset={p} />
      ))}
    </div>
  );
}
