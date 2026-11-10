import { memo, useEffect, useMemo, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { Search } from 'lucide-react';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import { beginDrag, endDrag } from '../../lib/dnd';
import { isVisualClip } from '../../types';
import type { VisualClip } from '../../types';
import { TRANSITIONS, TRANSITION_CATEGORIES } from '../../engine/transitions/registry';
import type { TransitionDef } from '../../engine/transitions/registry';
import { transitionFor } from './transitionApply';
import { FavoriteStar } from './FavoriteStar';
import { pickFavorites, useFavorites } from './favorites';
import { renderTransition } from '../../engine/transitions/runner';
import { drawTestPattern } from '../../engine/effects/testPattern';

const SRC_W = 320;
const SRC_H = 180;
const THUMB_W = 192;
const THUMB_H = 108;
const LOOP_MS = 1200;

/* ---------- the two pictures every thumbnail blends (built once) ---------- */

let pictures: { a: HTMLCanvasElement; b: HTMLCanvasElement } | null = null;
/** true while the tab is unmounted / being torn down: nothing is rendered (it would rebuild the pictures) */
let disposed = false;

function bigLetter(ctx: CanvasRenderingContext2D, letter: string): void {
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 8;
  ctx.font = `bold ${Math.round(SRC_H * 0.8)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.strokeText(letter, SRC_W / 2, SRC_H / 2 + 6);
  ctx.fillText(letter, SRC_W / 2, SRC_H / 2 + 6);
  ctx.restore();
}

function getPictures(): { a: HTMLCanvasElement; b: HTMLCanvasElement } {
  if (pictures) return pictures;
  const make = (letter: string, invert: boolean) => {
    const c = document.createElement('canvas');
    c.width = SRC_W;
    c.height = SRC_H;
    const ctx = c.getContext('2d');
    if (ctx) {
      drawTestPattern(ctx, SRC_W, SRC_H);
      if (invert) {
        ctx.save();
        ctx.globalCompositeOperation = 'difference';
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, SRC_W, SRC_H);
        ctx.restore();
      }
      bigLetter(ctx, letter);
    }
    return c;
  };
  pictures = { a: make('a', false), b: make('b', true) };
  return pictures;
}

/** blend a and b at `progress` and paint it on the card canvas right away (the runner reuses its canvas) */
function drawFrame(def: TransitionDef, canvas: HTMLCanvasElement, progress: number): void {
  if (disposed) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { a, b } = getPictures();
  const out = renderTransition(a, b, def, progress, THUMB_W, THUMB_H, {
    projectWidth: 1920,
    projectHeight: 1080,
    channel: 'thumb',
  });
  if (out) {
    ctx.drawImage(out, 0, 0, canvas.width, canvas.height);
    return;
  }
  // no gpu result: left half a, right half b
  const w = canvas.width;
  const h = canvas.height;
  ctx.drawImage(a, 0, 0, SRC_W / 2, SRC_H, 0, 0, w / 2, h);
  ctx.drawImage(b, SRC_W / 2, 0, SRC_W / 2, SRC_H, w / 2, 0, w / 2, h);
}

/* ---------- first stills: one card per animation frame ---------- */

const queue = new Map<HTMLCanvasElement, TransitionDef>();
let pumpRaf = 0;
let stopActive: (() => void) | null = null;

function pump(): void {
  pumpRaf = 0;
  const first = queue.entries().next();
  if (first.done) return;
  const [canvas, def] = first.value;
  queue.delete(canvas);
  drawFrame(def, canvas, 0.5);
  if (queue.size > 0) pumpRaf = requestAnimationFrame(pump);
}

function requestStill(def: TransitionDef, canvas: HTMLCanvasElement): void {
  queue.set(canvas, def);
  if (!pumpRaf) pumpRaf = requestAnimationFrame(pump);
}

function releaseThumbs(): void {
  disposed = true;
  if (pumpRaf) cancelAnimationFrame(pumpRaf);
  pumpRaf = 0;
  queue.clear();
  stopActive?.();
  pictures = null;
}

/* ---------- apply ---------- */

function applyTo(def: TransitionDef): void {
  const { project, selection, updateClip } = useEditor.getState();
  const targets = project ? project.clips.filter((c): c is VisualClip => selection.includes(c.id) && isVisualClip(c)) : [];
  if (targets.length === 0) {
    useUi.getState().toast('select a clip first, or drag this onto a clip');
    return;
  }
  useEditor.getState().pushHistory();
  for (const c of targets) updateClip(c.id, { transition: transitionFor(def.id, c.transition) }, { skipHistory: true });
}

/* ---------- card ---------- */

const TransitionCard = memo(function TransitionCard({ def }: { def: TransitionDef }) {
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
      queue.delete(canvas);
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
      drawFrame(def, canvas, ((now - t0) % LOOP_MS) / LOOP_MS);
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
      drawFrame(def, canvas, 0.5);
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
      applyTo(def);
    }
  };
  const onDragStart = (e: DragEvent<HTMLDivElement>) => {
    stop();
    beginDrag(e, { kind: 'transition', transition: def.id });
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
      aria-label={`${def.name} transition`}
      title={`${def.name} - click to apply to the selected clips, or drag it onto a clip`}
      onClick={() => applyTo(def)}
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
        <FavoriteStar kind="transitions" id={def.id} name={def.name} />
      </div>
      <div className="media-fx-name">{def.name}</div>
    </div>
  );
});

/* ---------- tab ---------- */

export function TransitionsTab() {
  const [query, setQuery] = useState('');

  useEffect(() => {
    disposed = false;
    return releaseThumbs;
  }, []);

  const q = query.trim().toLowerCase();
  const groups = useMemo(
    () =>
      TRANSITION_CATEGORIES.map((c) => ({
        id: c.id,
        label: c.label,
        items: TRANSITIONS.filter((t) => t.category === c.id && (!q || t.name.toLowerCase().includes(q))),
      })).filter((g) => g.items.length > 0),
    [q],
  );
  const starred = useFavorites((s) => s.transitions);
  const favorites = useMemo(() => pickFavorites(starred, TRANSITIONS, (t) => !q || t.name.toLowerCase().includes(q)), [starred, q]);

  return (
    <div className="media-tab">
      <div className="media-filters">
        <div className="media-search">
          <Search size={13} />
          <input
            className="input input-sm"
            placeholder="search transitions"
            title="search transitions by name"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="media-fx-hint">a transition blends into a clip from the one before it</div>
      </div>
      <div className="media-scroll">
        {favorites.length > 0 ? (
          <section className="media-fx-group">
            <h3 className="media-fx-heading">favorites</h3>
            <div className="media-grid">
              {favorites.map((def) => (
                <TransitionCard key={def.id} def={def} />
              ))}
            </div>
          </section>
        ) : null}
        {groups.length === 0 ? (
          <div className="empty">nothing matches</div>
        ) : (
          groups.map((g) => (
            <section key={g.id} className="media-fx-group">
              <h3 className="media-fx-heading">{g.label}</h3>
              <div className="media-grid">
                {g.items.map((def) => (
                  <TransitionCard key={def.id} def={def} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
