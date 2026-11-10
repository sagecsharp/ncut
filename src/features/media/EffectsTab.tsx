import { memo, useEffect, useMemo, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { Camera, Search, TriangleAlert } from 'lucide-react';
import { usePlayback } from '../../store/playback';
import { useEditor } from '../../store/editorStore';
import { beginDrag, endDrag } from '../../lib/dnd';
import { EFFECTS } from '../../engine/effects/registry';
import { EFFECT_CATEGORIES } from '../../engine/effects/types';
import type { EffectDef } from '../../engine/effects/types';
import { effectsSupported, renderEffects } from '../../engine/effects/runner';
import { drawTestPattern } from '../../engine/effects/testPattern';

/** thumbnails are the real effect running on the test card */
const SRC_W = 320;
const SRC_H = 180;
const THUMB_W = 192;
const THUMB_H = 108;
const CLIP_SECONDS = 3;
const CHANNEL = 'thumb';

/* ---------- shared thumbnail engine (module level, no react state) ---------- */

let sourceCanvas: HTMLCanvasElement | null = null;
/** bumped when the tab unmounts so late async results are dropped */
let generation = 0;
const stills = new Map<string, ImageBitmap>();
const savingStill = new Set<string>();
/** cards waiting for their first still, in order. one is rendered per animation frame. */
const queue = new Map<HTMLCanvasElement, EffectDef>();
let pumpRaf = 0;
let stopActive: (() => void) | null = null;

function getSource(): HTMLCanvasElement {
  if (sourceCanvas) return sourceCanvas;
  const c = document.createElement('canvas');
  c.width = SRC_W;
  c.height = SRC_H;
  const ctx = c.getContext('2d');
  if (ctx) drawTestPattern(ctx, SRC_W, SRC_H);
  sourceCanvas = c;
  return c;
}

/** run the effect at `time` and paint it on the card canvas right away (the runner reuses its canvas) */
function drawFrame(def: EffectDef, canvas: HTMLCanvasElement, time: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const source = getSource();
  const out = renderEffects(
    source,
    THUMB_W,
    THUMB_H,
    [{ def, time, duration: CLIP_SECONDS, amount: 1, seed: 7, params: {} }],
    { channel: CHANNEL, projectWidth: 1920, projectHeight: 1080 },
  );
  ctx.drawImage(out ?? source, 0, 0, canvas.width, canvas.height);
}

/** the cached still when we have it, otherwise render it once and cache it */
function paintStill(def: EffectDef, canvas: HTMLCanvasElement): void {
  const cached = stills.get(def.id);
  if (cached) {
    canvas.getContext('2d')?.drawImage(cached, 0, 0, canvas.width, canvas.height);
    return;
  }
  drawFrame(def, canvas, def.posterTime ?? 1);
  if (savingStill.has(def.id)) return;
  savingStill.add(def.id);
  const gen = generation;
  void createImageBitmap(canvas)
    .then((bmp) => {
      savingStill.delete(def.id);
      if (gen !== generation || stills.has(def.id)) bmp.close();
      else stills.set(def.id, bmp);
    })
    .catch(() => savingStill.delete(def.id));
}

function pump(): void {
  pumpRaf = 0;
  const first = queue.entries().next();
  if (first.done) return;
  const [canvas, def] = first.value;
  queue.delete(canvas);
  paintStill(def, canvas);
  if (queue.size > 0) pumpRaf = requestAnimationFrame(pump);
}

function requestStill(def: EffectDef, canvas: HTMLCanvasElement): void {
  if (stills.has(def.id)) {
    paintStill(def, canvas);
    return;
  }
  queue.set(canvas, def);
  if (!pumpRaf) pumpRaf = requestAnimationFrame(pump);
}

function cancelStill(canvas: HTMLCanvasElement): void {
  queue.delete(canvas);
}

function releaseThumbs(): void {
  generation++;
  if (pumpRaf) cancelAnimationFrame(pumpRaf);
  pumpRaf = 0;
  queue.clear();
  stopActive?.();
  for (const b of stills.values()) b.close();
  stills.clear();
  savingStill.clear();
  sourceCanvas = null;
}

/* ---------- card ---------- */

function addAtPlayhead(id: string): void {
  useEditor.getState().addEffect(id, { start: usePlayback.getState().time });
}

const EffectCard = memo(function EffectCard({ def }: { def: EffectDef }) {
  const [refs] = useState(() => ({
    card: null as HTMLDivElement | null,
    canvas: null as HTMLCanvasElement | null,
    stop: null as (() => void) | null,
  }));

  useEffect(() => {
    const canvas = refs.canvas;
    if (!canvas) return;
    requestStill(def, canvas);
    return () => {
      cancelStill(canvas);
      refs.stop?.();
    };
  }, [def, refs]);

  // only the card under the pointer / keyboard focus animates, on a raf loop that touches no react state
  const start = () => {
    const canvas = refs.canvas;
    if (refs.stop || !canvas || document.hidden) return;
    stopActive?.();
    let alive = true;
    let raf = 0;
    let t0 = -1;
    const tick = (now: number) => {
      if (!alive) return;
      if (t0 < 0) t0 = now;
      drawFrame(def, canvas, ((now - t0) / 1000) % CLIP_SECONDS);
      raf = requestAnimationFrame(tick);
    };
    const onVisibility = () => {
      if (document.hidden) stop();
    };
    const stop = () => {
      if (!alive) return;
      alive = false;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
      refs.card?.classList.remove('is-live');
      if (refs.stop === stop) refs.stop = null;
      if (stopActive === stop) stopActive = null;
      paintStill(def, canvas);
    };
    document.addEventListener('visibilitychange', onVisibility);
    refs.stop = stop;
    stopActive = stop;
    refs.card?.classList.add('is-live');
    raf = requestAnimationFrame(tick);
  };
  const stop = () => refs.stop?.();

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      addAtPlayhead(def.id);
    }
  };
  const onDragStart = (e: DragEvent<HTMLDivElement>) => {
    stop();
    beginDrag(e, { kind: 'effect', effect: def.id });
  };

  return (
    <div
      ref={(el) => {
        refs.card = el;
      }}
      className="media-fx-card"
      role="button"
      tabIndex={0}
      draggable
      title={`${def.description} - click to add at the playhead, or drag it onto the timeline`}
      onClick={() => addAtPlayhead(def.id)}
      onKeyDown={onKeyDown}
      onDragStart={onDragStart}
      onDragEnd={endDrag}
      onPointerEnter={start}
      onPointerLeave={stop}
      onFocus={(e) => {
        if (e.currentTarget.matches(':focus-visible')) start();
      }}
      onBlur={stop}
    >
      <div className="media-fx-thumb">
        <canvas
          ref={(el) => {
            refs.canvas = el;
          }}
          className="media-fx-canvas"
          width={THUMB_W}
          height={THUMB_H}
        />
      </div>
      <div className="media-fx-name">{def.name}</div>
    </div>
  );
});

/* ---------- 3d group ---------- */

function addCameraAtPlayhead(): void {
  // addCamera selects the new clip itself
  useEditor.getState().addCamera({ start: usePlayback.getState().time });
}

const CAMERA_TIP = 'a camera clip moves the view for every 3d clip under it';

function CameraCard() {
  return (
    <div
      className="media-fx-card"
      role="button"
      tabIndex={0}
      draggable
      aria-label="camera"
      title={`${CAMERA_TIP} - click to add at the playhead, or drag it onto the timeline`}
      onClick={addCameraAtPlayhead}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          addCameraAtPlayhead();
        }
      }}
      onDragStart={(e) => beginDrag(e, { kind: 'camera' })}
      onDragEnd={endDrag}
    >
      <div className="media-fx-thumb media-fx-thumb-icon">
        <Camera size={28} />
      </div>
      <div className="media-fx-name">camera</div>
    </div>
  );
}

/* ---------- tab ---------- */

export function EffectsTab() {
  const [supported] = useState(() => effectsSupported());
  const [query, setQuery] = useState('');

  useEffect(() => releaseThumbs, []);

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const match = (e: EffectDef) => !q || e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q);
    return EFFECT_CATEGORIES.map((c) => ({
      id: c.id,
      label: c.label,
      items: EFFECTS.filter((e) => e.category === c.id && match(e)),
    })).filter((g) => g.items.length > 0);
  }, [q]);
  const shown = groups.reduce((n, g) => n + g.items.length, 0);

  if (!supported) {
    return (
      <div className="media-tab">
        <div className="empty">
          <TriangleAlert size={20} />
          <span>effects need webgl2, which this browser does not offer</span>
        </div>
      </div>
    );
  }

  return (
    <div className="media-tab">
      <div className="media-filters">
        <div className="media-search">
          <Search size={13} />
          <input
            className="input input-sm"
            placeholder="search effects"
            title="search effects by name or description"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="media-fx-hint">
          {q ? `${shown} of ${EFFECTS.length} effects` : 'an effect changes everything below its track'}
        </div>
      </div>
      <div className="media-scroll">
        {!q || 'camera'.includes(q) || '3d'.includes(q) ? (
          <section className="media-fx-group">
            <h3 className="media-fx-heading">3d</h3>
            <div className="media-grid">
              <CameraCard />
            </div>
          </section>
        ) : null}
        {groups.length === 0 ? (
          <div className="empty">no matching effects</div>
        ) : (
          groups.map((g) => (
            <section key={g.id} className="media-fx-group">
              <h3 className="media-fx-heading">{g.label}</h3>
              <div className="media-grid">
                {g.items.map((def) => (
                  <EffectCard key={def.id} def={def} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
