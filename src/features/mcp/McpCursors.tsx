import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import { useEditor } from '../../store/editorStore';
import { isFading, useMcpCursors, type McpCursor } from '../../store/mcpCursors';
import { view } from '../timeline/view';
import type { Target } from '../../mcp/cursor';
import { locateTarget, topMiddle, type Env, type Point } from './locate';
import './mcpCursors.css';

/** the label under the name hides this long after the last activity */
const QUIET_MS = 3000;
/** the tag flips to the other side of the arrow this close to the right / bottom edge of the window: as far as the tag
 * reaches (13 + 240 px wide; 15 px + the tag, and for a note of 4 lines also the note, tall) */
const FLIP_X = 260;
const FLIP_Y = 90;
const FLIP_Y_NOTE = 135;
/** a flight is animated this long (a bit more than the 350 ms of the css, so the style does not change under it) */
const FLY_MS = 450;
/** how often idle cursors are swept */
const SWEEP_MS = 1000;

/** the arrow: the classic pointer, tip at 1 / 1 */
const ARROW = 'M1 1 L1 16 L4.8 12.6 L7.6 19.4 L10.6 18.1 L7.8 11.4 L12.8 11.4 Z';

type Els = Map<string, HTMLDivElement>;
type Spots = Map<string, Point>;
/** per cursor: the target it was last flown to, and until when the flight animation is on */
interface Flights {
  target: Map<string, Target>;
  until: Map<string, number>;
}

/** a cursor that gets a spot for a target it was not flown to yet starts a flight; the same target is only followed */
function noteFlight(f: Flights, name: string, target: Target, now: number): void {
  if (f.target.get(name) === target) return;
  f.target.set(name, target);
  f.until.set(name, now + FLY_MS);
}

function makeEnv(): Env {
  const st = useEditor.getState();
  const project = st.project;
  return {
    dom: { query: (selector) => document.querySelector(selector) },
    win: { width: window.innerWidth, height: window.innerHeight },
    zoom: st.zoom,
    scrollLeft: view.scrollLeft,
    project: project ? { width: project.width, height: project.height } : null,
    clip: (id) => project?.clips.find((c) => c.id === id),
  };
}

/** puts a cursor at a point (only writes when it moved) and flips its tag away from the window edges */
function place(el: HTMLElement, p: Point, win: { width: number; height: number }, hasNote: boolean): void {
  const next = `translate3d(${Math.round(p.x)}px, ${Math.round(p.y)}px, 0)`;
  if (el.style.transform !== next) el.style.transform = next;
  el.toggleAttribute('data-flip-x', p.x > win.width - FLIP_X);
  el.toggleAttribute('data-flip-y', p.y > win.height - (hasNote ? FLIP_Y_NOTE : FLIP_Y));
}

/**
 * the cursors of mcp clients, drawn over the whole window. the layer takes no pointer events. while at least one cursor
 * exists a frame loop keeps every cursor on its target (the user may scroll, zoom or resize meanwhile); with none there
 * is no timer and no frame. where a cursor stands is kept out of react (a style write per frame, no render).
 */
export function McpCursors() {
  const cursors = useMcpCursors((s) => s.cursors);
  const active = cursors.length > 0;
  const els = useRef<Els>(new Map());
  const spots = useRef<Spots>(new Map());
  const flights = useRef<Flights>({ target: new Map(), until: new Map() });

  // a target is located the moment it is set, before the tool runs: a tool that removes its target (delete_clips) would
  // otherwise take it out of the dom before the next frame
  useEffect(
    () =>
      useMcpCursors.subscribe((after, before) => {
        const old = new Map(before.cursors.map((c) => [c.name, c.target]));
        let env: Env | null = null;
        for (const c of after.cursors) {
          if (old.get(c.name) === c.target) continue;
          env ??= makeEnv();
          const p = locateTarget(c.target, env);
          if (!p) continue;
          spots.current.set(c.name, p);
          noteFlight(flights.current, c.name, c.target, Date.now());
          const el = els.current.get(c.name);
          if (el) {
            // the flight attribute goes on in the same style change as the new position, so the move is animated
            el.setAttribute('data-flying', '');
            place(el, p, env.win, c.note !== null);
          }
        }
      }),
    [],
  );

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = Date.now();
      const env = makeEnv();
      const list = useMcpCursors.getState().cursors;
      for (const c of list) {
        // a target that is not found (yet) leaves the cursor where it was: a clip that was just added is there one frame later
        const p = locateTarget(c.target, env);
        if (p) {
          spots.current.set(c.name, p);
          noteFlight(flights.current, c.name, c.target, now);
        }
        const el = els.current.get(c.name);
        if (!el) continue;
        el.toggleAttribute('data-flying', now < (flights.current.until.get(c.name) ?? 0));
        place(el, spots.current.get(c.name) ?? topMiddle(env.win.width), env.win, c.note !== null);
        el.toggleAttribute('data-fading', isFading(c, now));
        // a call that is still running keeps its label, however long it takes
        el.toggleAttribute('data-quiet', c.phase !== 'working' && now - c.last > QUIET_MS);
      }
      for (const name of spots.current.keys()) {
        if (list.some((c) => c.name === name)) continue;
        spots.current.delete(name);
        flights.current.target.delete(name);
        flights.current.until.delete(name);
      }
    };
    raf = requestAnimationFrame(tick);
    const sweep = window.setInterval(() => useMcpCursors.getState().sweep(Date.now()), SWEEP_MS);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(sweep);
      spots.current.clear();
      flights.current.target.clear();
      flights.current.until.clear();
    };
  }, [active]);

  if (!active) return null;
  return (
    <div className="mcp-cursors" aria-hidden="true">
      {cursors.map((c) => (
        <CursorView key={c.name} cursor={c} els={els.current} spots={spots.current} />
      ))}
    </div>
  );
}

const CursorView = memo(function CursorView({ cursor: c, els, spots }: { cursor: McpCursor; els: Els; spots: Spots }) {
  const ref = useRef<HTMLDivElement>(null);
  const name = c.name;

  // a new cursor starts where it last stood, else at the top middle of the window, and flies from there on the next frame
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    els.set(name, el);
    const win = { width: window.innerWidth, height: window.innerHeight };
    place(el, topMiddle(win.width), win, false);
    // the style has to be computed once at the start, else the first move would not be a flight
    el.getBoundingClientRect();
    const first = spots.get(name);
    if (first) {
      requestAnimationFrame(() => {
        el.setAttribute('data-flying', '');
        place(el, first, win, false);
      });
    }
    return () => {
      if (els.get(name) === el) els.delete(name);
    };
  }, [name, els, spots]);

  return (
    <div ref={ref} className="mcp-cursor" data-slot={c.slot} data-phase={c.phase}>
      <svg className="mcp-arrow" width="16" height="22" viewBox="0 0 16 22">
        <path d={ARROW} />
      </svg>
      {c.pulses > 0 && <span key={c.pulses} className="mcp-pulse" />}
      <div className="mcp-body">
        <div className="mcp-tag">
          <span className="mcp-name">
            {c.name}
            {c.phase === 'failed' && <span className="mcp-fail">failed</span>}
          </span>
          {c.label && <span className="mcp-label">{c.label}</span>}
        </div>
        {c.note && <div className="mcp-note">{c.note}</div>}
      </div>
    </div>
  );
});
