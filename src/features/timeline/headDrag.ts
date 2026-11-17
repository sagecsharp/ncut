/** the two drags of a track header: move the track among its kind, size its height. dom only, no test */
import { TRACK_H_MAX, TRACK_H_MIN, trackHeightOf } from '../../lib/trackTools';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import { REASON_TEXT } from '../shell/reasons';
import { computeLayout } from './layout';
import { clearTrackDrop, setTrackDrop } from './trackDrop';
import type { ReorderTarget } from './trackOrder';
import { dropLabel, reorderTarget } from './trackOrder';
import { interaction } from './view';

/** a header press moves the track after this many px */
const MOVE_PX = 4;
/** the pointer this close to the edge of the scroller scrolls it */
const EDGE_PX = 24;
const SCROLL_PX = 8;

interface Hooks {
  /** the body class while the drag runs */
  cls: string;
  /** the pointer has moved enough to be a drag. false: not yet */
  real(dx: number, dy: number): boolean;
  /** the first real move. false: end the drag here, nothing written */
  begin(): boolean;
  /** once a frame while the drag runs. true: run another frame (the scroller is moving) */
  frame(x: number, y: number): boolean | void;
  /** the pointer is up */
  release(): void;
  /** esc or pointercancel after the drag began */
  abort(): void;
  /** the drag is over, whatever ended it */
  end(): void;
}

/** the drag that runs now. a new press ends it first */
let stop: (() => void) | null = null;
/** the drag is writing the project itself: that is not a change from outside */
let writing = false;

/** run a write of the drag, so the project subscriber knows it is its own */
const own = (fn: () => void): void => {
  writing = true;
  try {
    fn();
  } finally {
    writing = false;
  }
};

function drag(e: PointerEvent, h: Hooks): void {
  stop?.();
  const pointerId = e.pointerId;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let x = x0;
  let y = y0;
  let began = false;
  let raf = 0;

  const frame = (): void => {
    raf = 0;
    if (h.frame(x, y)) schedule();
  };
  const schedule = (): void => {
    if (!raf) raf = requestAnimationFrame(frame);
  };
  const clean = (): void => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('keydown', onKey, true);
    unsub();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (began) {
      interaction.gestureActive = false;
      document.body.classList.remove(h.cls);
    }
    clearTrackDrop();
    h.end();
    stop = null;
  };
  const onMove = (ev: PointerEvent): void => {
    if (ev.pointerId !== pointerId) return;
    x = ev.clientX;
    y = ev.clientY;
    if (!began) {
      if (!h.real(x - x0, y - y0)) return;
      if (!h.begin()) {
        clean();
        return;
      }
      began = true;
      interaction.gestureActive = true;
      document.body.classList.add(h.cls);
    }
    schedule();
  };
  const onUp = (ev: PointerEvent): void => {
    if (ev.pointerId !== pointerId) return;
    x = ev.clientX;
    y = ev.clientY;
    if (began) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      h.frame(x, y);
      h.release();
    }
    clean();
  };
  const onCancel = (ev: PointerEvent): void => {
    if (ev.pointerId !== pointerId) return;
    if (began) h.abort();
    clean();
  };
  // a lost window focus can lose the pointerup: that ends the drag with no write
  const onBlur = (): void => {
    if (began) h.abort();
    clean();
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    if (began) h.abort();
    clean();
  };
  // a change of the project that the drag did not make ends it with no write
  const unsub = useEditor.subscribe((s, prev) => {
    if (s.project !== prev.project && !writing) clean();
  });
  stop = clean;
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('blur', onBlur);
  window.addEventListener('keydown', onKey, true);
}

const wanted = (e: PointerEvent): boolean => (e.pointerType === 'mouse' || e.pointerType === 'pen') && e.button === 0;

/** a press on a track header: past 4 px the track moves among its kind. release is one moveTrack */
export function startTrackMove(e: PointerEvent, trackId: string, head: HTMLElement): void {
  if (!wanted(e)) return;
  const target = e.target;
  if (target instanceof Element && target.closest('button, input, .timeline-head-size')) return;
  const wrap = head.closest('.timeline-lanes-wrap');
  const scroller = head.closest('.timeline-scroller');
  if (!wrap) return;
  let last: ReorderTarget | null = null;
  drag(e, {
    cls: 'is-track-moving',
    real: (dx, dy) => Math.hypot(dx, dy) >= MOVE_PX,
    begin: () => {
      const t = useEditor.getState().project?.tracks.find((x) => x.id === trackId);
      if (!t) return false;
      if (t.locked) {
        useUi.getState().toast(REASON_TEXT.trackLocked);
        return false;
      }
      setTrackDrop({ dragging: trackId });
      return true;
    },
    frame: (_x, cy) => {
      const project = useEditor.getState().project;
      if (!project) return;
      let more = false;
      if (scroller) {
        const r = scroller.getBoundingClientRect();
        const dir = cy < r.top + EDGE_PX ? -1 : cy > r.bottom - EDGE_PX ? 1 : 0;
        if (dir !== 0) {
          const before = scroller.scrollTop;
          scroller.scrollTop += dir * SCROLL_PX;
          more = scroller.scrollTop !== before;
        }
      }
      const from = project.tracks.findIndex((x) => x.id === trackId);
      const t = from < 0 ? null : reorderTarget(project.tracks, computeLayout(project.tracks), from, cy - wrap.getBoundingClientRect().top);
      last = t;
      if (t) {
        const anchor = project.tracks.find((x) => x.id === t.anchorId);
        setTrackDrop({ over: t.anchorId, side: t.side, label: dropLabel(project.tracks[from]!.kind, t.side, anchor?.name ?? '') });
      } else {
        setTrackDrop({ over: null, side: null, label: '' });
      }
      return more;
    },
    release: () => {
      const t = last;
      clearTrackDrop();
      if (t) own(() => useEditor.getState().moveTrack(trackId, t.to));
    },
    abort: () => {},
    end: () => {},
  });
}

/** a press on the bottom edge of a track header: the track gets taller or shorter. shift: every track of its kind */
export function startTrackSize(e: PointerEvent, trackId: string, head: HTMLElement): void {
  if (!wanted(e)) return;
  const project = useEditor.getState().project;
  const me = project?.tracks.find((t) => t.id === trackId);
  if (!project || !me) return;
  const set = e.shiftKey ? project.tracks.filter((t) => t.kind === me.kind) : [me];
  const starts: Record<string, number | null> = {};
  for (const t of set) starts[t.id] = t.height ?? null;
  const startH = trackHeightOf(me);
  const y0 = e.clientY;
  let wrote = false;
  const edge = head.querySelector('.timeline-head-size');
  edge?.classList.add('is-active');
  drag(e, {
    cls: 'is-track-sizing',
    real: (_dx, dy) => dy !== 0,
    begin: () => true,
    frame: (_x, cy) => {
      const h = Math.min(TRACK_H_MAX, Math.max(TRACK_H_MIN, Math.round(startH + cy - y0)));
      const patch: Record<string, number | null> = {};
      for (const id of Object.keys(starts)) patch[id] = h;
      own(() => useEditor.getState().setTrackHeights(patch));
      wrote = true;
    },
    release: () => {},
    abort: () => {
      if (wrote) own(() => useEditor.getState().setTrackHeights(starts));
    },
    end: () => edge?.classList.remove('is-active'),
  });
}
