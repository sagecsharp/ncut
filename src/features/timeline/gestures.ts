/**
 * pointer gestures of the timeline: move, trim, marquee, ruler scrub, empty-lane click, context menu.
 *
 * everything lives outside react. one controller instance handles event delegation for the whole
 * lanes area, keeps gesture state in plain objects, caches geometry once at gesture start and
 * applies at most one update per animation frame.
 */
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react';
import type { Clip, ClipType } from '../../types';
import { trackKindForClip } from '../../types';
import { snapToFrame } from '../../lib/time';
import { clipEnd, collectSnapPoints, findFreeStart, snapTime } from '../../lib/timelineOps';
import { useEditor } from '../../store/editorStore';
import type { ClipMove } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { HEADER_W, RULER_H, SNAP_PX, computeLayout, hitLane } from './layout';
import type { Layout } from './layout';
import type { Overlays } from './overlays';
import { interaction, notifyView, view } from './view';

export interface MenuRequest {
  x: number;
  y: number;
  clipId: string;
}

export interface GestureEnv {
  getScroller(): HTMLElement | null;
  overlays: Overlays;
  openMenu(req: MenuRequest): void;
}

interface Geo {
  left: number;
  top: number;
}

interface MoveItem {
  id: string;
  type: ClipType;
  trackId: string;
  trackIdx: number;
  start: number;
  end: number;
  duration: number;
}

interface Base {
  pointerId: number;
  cx: number;
  cy: number;
  startX: number;
  startY: number;
  startScroll: number;
  startScrollTop: number;
  geo: Geo;
  zoom: number;
  layout: Layout;
  captureEl: Element | null;
  started: boolean;
}

interface MoveGesture extends Base {
  kind: 'move';
  items: MoveItem[];
  leader: MoveItem;
  points: number[];
  deferSingle: string | null;
  lastKey: string;
  delta: number;
  zone: 'top' | 'bottom' | null;
}

interface TrimGesture extends Base {
  kind: 'trim';
  id: string;
  edge: 'start' | 'end';
  points: number[];
  /** edge time minus pointer time at press, so the edge does not jump to the pointer */
  offset: number;
}

interface SeekGesture extends Base {
  kind: 'seek';
}

interface MarqueeGesture extends Base {
  kind: 'marquee';
  /** lane x / lanes-area y where the gesture began */
  originX: number;
  originY: number;
  baseSelection: string[];
  lastKey: string;
}

type Gesture = MoveGesture | TrimGesture | SeekGesture | MarqueeGesture;

const DRAG_THRESHOLD = 3;
const EDGE = 36;
const EDGE_MAX_SPEED = 22;

type PointerLike = ReactPointerEvent<HTMLElement>;

export function createGestures(env: GestureEnv) {
  let g: Gesture | null = null;
  let rafId = 0;

  const store = () => useEditor.getState();

  function measure(): Geo | null {
    const el = env.getScroller();
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top };
  }

  const laneX = (geo: Geo, cx: number) => cx - geo.left - HEADER_W + view.scrollLeft;
  /** y inside the lanes area (below the ruler), including the top zone */
  const laneY = (geo: Geo, cy: number) => cy - geo.top - RULER_H + view.scrollTop;

  function base(e: PointerLike, geo: Geo, layout: Layout, captureEl: Element): Base {
    return {
      pointerId: e.pointerId,
      cx: e.clientX,
      cy: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      startScroll: view.scrollLeft,
      startScrollTop: view.scrollTop,
      geo,
      zoom: store().zoom,
      layout,
      captureEl,
      started: false,
    };
  }

  /* ---------- lifecycle ---------- */

  function begin(next: Gesture, mode: string): void {
    end();
    g = next;
    try {
      next.captureEl?.setPointerCapture(next.pointerId);
    } catch {
      // pointer may already be gone
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    interaction.gestureActive = true;
    const scroller = env.getScroller();
    if (scroller) {
      scroller.dataset.gesture = mode;
      // pin the scrollable width so a gesture that shortens the project cannot clamp scrollLeft mid-drag
      const content = scroller.firstElementChild as HTMLElement | null;
      if (content) content.style.minWidth = `${content.offsetWidth}px`;
    }
  }

  function end(): void {
    const cur = g;
    g = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (cur?.captureEl) {
      try {
        if (cur.captureEl.hasPointerCapture(cur.pointerId)) cur.captureEl.releasePointerCapture(cur.pointerId);
      } catch {
        // ignore
      }
    }
    interaction.gestureActive = false;
    env.overlays.clear();
    const scroller = env.getScroller();
    if (scroller) {
      delete scroller.dataset.gesture;
      const content = scroller.firstElementChild as HTMLElement | null;
      if (content) content.style.minWidth = '';
    }
  }

  function onMove(e: PointerEvent): void {
    if (!g || e.pointerId !== g.pointerId) return;
    g.cx = e.clientX;
    g.cy = e.clientY;
    schedule();
  }

  function onUp(e: PointerEvent): void {
    if (!g || e.pointerId !== g.pointerId) return;
    g.cx = e.clientX;
    g.cy = e.clientY;
    // apply the final pointer position synchronously so the drop lands where the pointer is
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    const cur = g;
    step(cur);
    finish(cur);
    end();
  }

  function onCancel(e: PointerEvent): void {
    if (!g || e.pointerId !== g.pointerId) return;
    end();
  }

  function schedule(): void {
    if (!rafId) rafId = requestAnimationFrame(tick);
  }

  function edgeSpeed(cur: Gesture): number {
    const xv = cur.cx - cur.geo.left - HEADER_W;
    if (xv < EDGE) return -Math.ceil((Math.min(EDGE, EDGE - xv) / EDGE) * EDGE_MAX_SPEED);
    if (xv > view.width - EDGE) return Math.ceil((Math.min(EDGE, xv - (view.width - EDGE)) / EDGE) * EDGE_MAX_SPEED);
    return 0;
  }

  function tick(): void {
    rafId = 0;
    const cur = g;
    if (!cur) return;
    let again = false;
    if (cur.started || cur.kind === 'seek') {
      const el = env.getScroller();
      const speed = el ? edgeSpeed(cur) : 0;
      if (el && speed !== 0) {
        const before = el.scrollLeft;
        el.scrollLeft = before + speed;
        const after = el.scrollLeft;
        if (after !== before) {
          view.scrollLeft = after;
          notifyView();
          again = true;
        }
      }
    }
    step(cur);
    if (again) schedule();
  }

  function step(cur: Gesture): void {
    switch (cur.kind) {
      case 'move':
        stepMove(cur);
        break;
      case 'trim':
        stepTrim(cur);
        break;
      case 'seek':
        stepSeek(cur);
        break;
      case 'marquee':
        stepMarquee(cur);
        break;
    }
  }

  function finish(cur: Gesture): void {
    if (cur.kind === 'move') finishMove(cur);
  }

  /* ---------- seek (ruler scrub) ---------- */

  function seekAt(cur: Gesture): void {
    const project = store().project;
    if (!project) return;
    const t = Math.max(0, laneX(cur.geo, cur.cx)) / cur.zoom;
    usePlayback.getState().seek(snapToFrame(t, project.fps));
  }

  function stepSeek(cur: SeekGesture): void {
    cur.started = true;
    seekAt(cur);
  }

  /* ---------- move ---------- */

  function stepMove(m: MoveGesture): void {
    const st = store();
    const project = st.project;
    if (!project) return;
    if (!m.started) {
      if (Math.hypot(m.cx - m.startX, m.cy - m.startY) < DRAG_THRESHOLD) return;
      m.started = true;
      st.pushHistory();
    }
    const zoom = m.zoom;
    let minStart = Infinity;
    for (const o of m.items) minStart = Math.min(minStart, o.start);

    let delta = (m.cx - m.startX + (view.scrollLeft - m.startScroll)) / zoom;
    if (minStart + delta < 0) delta = -minStart;

    // snap leading / trailing edges of every moving clip
    let snapHit: number | null = null;
    if (st.snapping) {
      const thr = SNAP_PX / zoom;
      let bestDist = Infinity;
      let bestAdj = 0;
      for (const o of m.items) {
        for (const edge of [o.start + delta, o.end + delta]) {
          const r = snapTime(edge, m.points, thr);
          if (r.hit === null) continue;
          const d = Math.abs(r.hit - edge);
          if (d < bestDist) {
            bestDist = d;
            bestAdj = r.hit - edge;
            snapHit = r.hit;
          }
        }
      }
      if (snapHit !== null) {
        delta += bestAdj;
        if (minStart + delta < 0) {
          delta = -minStart;
          snapHit = null;
        }
      }
    }
    m.delta = delta;

    // which track each clip goes to
    const hit = hitLane(m.layout, laneY(m.geo, m.cy));
    const tracks = project.tracks;
    let trackFor = (o: MoveItem): string => o.trackId;
    let zone: 'top' | 'bottom' | null = null;
    if (hit.type === 'lane') {
      const di = hit.index - m.leader.trackIdx;
      if (di !== 0) {
        let valid = true;
        for (const o of m.items) {
          const tr = tracks[o.trackIdx + di];
          if (!tr || tr.locked || tr.kind !== trackKindForClip(o.type)) {
            valid = false;
            break;
          }
        }
        if (valid) trackFor = (o) => tracks[o.trackIdx + di]!.id;
      }
    } else if (m.items.length === 1) {
      const kind = trackKindForClip(m.leader.type);
      if ((hit.where === 'top' && kind === 'video') || (hit.where === 'bottom' && kind === 'audio')) zone = hit.where;
    }
    m.zone = zone;
    env.overlays.setHot(zone);

    const moves: ClipMove[] = m.items.map((o) => ({
      id: o.id,
      trackId: trackFor(o),
      start: Math.max(0, o.start + delta),
    }));
    const applied = applyMoves(m, project.clips, moves);
    if (!applied && m.items.length === 1) {
      const o = m.items[0]!;
      const trackId = trackFor(o);
      const free = findFreeStart(project, trackId, o.start + delta, o.duration, [o.id]);
      if (applyMoves(m, project.clips, [{ id: o.id, trackId, start: free }])) {
        env.overlays.setSnap(null, zoom);
        return;
      }
    }
    env.overlays.setSnap(applied ? snapHit : null, zoom);
  }

  /** returns true when the project now reflects `moves` (applied now or already there) */
  function applyMoves(m: MoveGesture, clips: Clip[], moves: ClipMove[]): boolean {
    const key = moves.map((mv) => `${mv.id}:${mv.trackId}:${mv.start}`).join('|');
    if (key === m.lastKey) return true;
    const want = new Map(moves.map((mv) => [mv.id, mv]));
    let same = true;
    for (const c of clips) {
      const mv = want.get(c.id);
      if (mv && (mv.trackId !== c.trackId || mv.start !== c.start)) {
        same = false;
        break;
      }
    }
    if (same) {
      m.lastKey = key;
      return true;
    }
    const ok = store().moveClips(moves, { skipHistory: true });
    if (ok) m.lastKey = key;
    return ok;
  }

  function finishMove(m: MoveGesture): void {
    const st = store();
    if (!m.started) {
      if (m.deferSingle) st.select([m.deferSingle], 'replace');
      return;
    }
    if (m.zone && m.items.length === 1) {
      const o = m.leader;
      const kind = trackKindForClip(o.type);
      const trackId = st.addTrack(kind, { skipHistory: true, index: m.zone === 'top' ? 0 : undefined });
      if (trackId) {
        st.moveClips([{ id: o.id, trackId, start: Math.max(0, o.start + m.delta) }], { skipHistory: true });
      }
    }
  }

  /* ---------- trim ---------- */

  function stepTrim(t: TrimGesture): void {
    const st = store();
    if (!t.started) {
      if (Math.abs(t.cx - t.startX) < 2) return;
      t.started = true;
      st.pushHistory();
    }
    let time = Math.max(0, laneX(t.geo, t.cx) / t.zoom + t.offset);
    let hit: number | null = null;
    if (st.snapping) {
      const r = snapTime(time, t.points, SNAP_PX / t.zoom);
      time = r.time;
      hit = r.hit;
    }
    st.trimClip(t.id, t.edge, time, { skipHistory: true });
    if (hit !== null) {
      const c = useEditor.getState().project?.clips.find((x) => x.id === t.id);
      const actual = c ? (t.edge === 'start' ? c.start : clipEnd(c)) : NaN;
      if (!(Math.abs(actual - hit) < 1e-6)) hit = null;
    }
    env.overlays.setSnap(hit, t.zoom);
  }

  /* ---------- marquee ---------- */

  function stepMarquee(mq: MarqueeGesture): void {
    if (!mq.started) {
      if (Math.hypot(mq.cx - mq.startX, mq.cy - mq.startY) < DRAG_THRESHOLD) return;
      mq.started = true;
    }
    const st = store();
    const project = st.project;
    if (!project) return;
    const x = laneX(mq.geo, mq.cx);
    const y = laneY(mq.geo, mq.cy);
    const x0 = Math.max(0, Math.min(x, mq.originX));
    const x1 = Math.max(x, mq.originX);
    const y0 = Math.max(0, Math.min(y, mq.originY));
    const y1 = Math.min(mq.layout.total, Math.max(y, mq.originY));
    env.overlays.setMarquee({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });

    const trackIdx = new Map(project.tracks.map((t, i) => [t.id, i]));
    const hits: string[] = [];
    for (const c of project.clips) {
      const i = trackIdx.get(c.trackId);
      if (i === undefined) continue;
      const top = mq.layout.tops[i]!;
      const bottom = top + mq.layout.heights[i]!;
      if (bottom < y0 || top > y1) continue;
      if (clipEnd(c) * mq.zoom < x0 || c.start * mq.zoom > x1) continue;
      hits.push(c.id);
    }
    const key = hits.join(',');
    if (key === mq.lastKey) return;
    mq.lastKey = key;
    st.select(mq.baseSelection, 'replace');
    if (hits.length > 0) st.select(hits, 'add');
  }

  /* ---------- entry points ---------- */

  function onLanesPointerDown(e: PointerLike): void {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('.timeline-head')) return;
    const st = store();
    const project = st.project;
    if (!project) return;
    const geo = measure();
    if (!geo) return;
    // preventDefault below stops the browser from moving focus: drop it from any text field ourselves
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) active.blur();
    const layout = computeLayout(project.tracks);
    const captureEl = e.currentTarget;
    const mod = e.shiftKey || e.ctrlKey || e.metaKey;
    const clipEl = target.closest<HTMLElement>('[data-clip-id]');

    if (clipEl) {
      const id = clipEl.dataset.clipId ?? '';
      const clip = project.clips.find((c) => c.id === id);
      const track = clip ? project.tracks.find((t) => t.id === clip.trackId) : undefined;
      if (!clip || !track || track.locked) return;
      e.preventDefault();
      const edgeAttr = target.closest<HTMLElement>('[data-trim]')?.dataset.trim;
      if (edgeAttr === 'start' || edgeAttr === 'end') {
        if (!st.selection.includes(id)) st.select([id], 'replace');
        begin(
          {
            ...base(e, geo, layout, captureEl),
            kind: 'trim',
            id,
            edge: edgeAttr,
            offset: (edgeAttr === 'start' ? clip.start : clipEnd(clip)) - laneX(geo, e.clientX) / st.zoom,
            points: collectSnapPoints(project, [id], [usePlayback.getState().time]),
          },
          'trim',
        );
        return;
      }
      let deferSingle: string | null = null;
      if (mod) {
        st.select([id], 'toggle');
        if (!store().selection.includes(id)) return;
      } else if (!st.selection.includes(id)) {
        st.select([id], 'replace');
      } else if (st.selection.length > 1) {
        deferSingle = id;
      }
      const sel = new Set(store().selection);
      const trackIdx = new Map(project.tracks.map((t, i) => [t.id, i]));
      const lockedTracks = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id));
      const items: MoveItem[] = [];
      for (const c of project.clips) {
        if (!sel.has(c.id) || lockedTracks.has(c.trackId)) continue;
        items.push({
          id: c.id,
          type: c.type,
          trackId: c.trackId,
          trackIdx: trackIdx.get(c.trackId) ?? 0,
          start: c.start,
          end: clipEnd(c),
          duration: c.duration,
        });
      }
      const leader = items.find((o) => o.id === id);
      if (!leader) return;
      begin(
        {
          ...base(e, geo, layout, captureEl),
          kind: 'move',
          items,
          leader,
          points: collectSnapPoints(project, items.map((o) => o.id), [usePlayback.getState().time]),
          deferSingle,
          lastKey: '',
          delta: 0,
          zone: null,
        },
        'move',
      );
      return;
    }

    // empty lane space: clear selection, seek, and maybe start a marquee
    e.preventDefault();
    const x = laneX(geo, e.clientX);
    const y = laneY(geo, e.clientY);
    if (!mod) st.clearSelection();
    usePlayback.getState().seek(snapToFrame(Math.max(0, x) / st.zoom, project.fps));
    begin(
      {
        ...base(e, geo, layout, captureEl),
        kind: 'marquee',
        originX: Math.max(0, x),
        originY: y,
        baseSelection: mod ? [...st.selection] : [],
        lastKey: '',
      },
      'marquee',
    );
  }

  function onRulerPointerDown(e: PointerLike): void {
    if (e.button !== 0) return;
    const project = store().project;
    if (!project) return;
    const geo = measure();
    if (!geo) return;
    e.preventDefault();
    const cur: SeekGesture = { ...base(e, geo, computeLayout(project.tracks), e.currentTarget), kind: 'seek' };
    begin(cur, 'seek');
    seekAt(cur);
  }

  function onContextMenu(e: ReactMouseEvent<HTMLElement>): void {
    const clipEl = (e.target as HTMLElement).closest<HTMLElement>('[data-clip-id]');
    if (!clipEl) return;
    const st = store();
    const id = clipEl.dataset.clipId ?? '';
    const clip = st.project?.clips.find((c) => c.id === id);
    const track = clip ? st.project?.tracks.find((t) => t.id === clip.trackId) : undefined;
    if (!clip || !track || track.locked) return;
    e.preventDefault();
    end();
    if (!st.selection.includes(id)) st.select([id], 'replace');
    env.openMenu({ x: e.clientX, y: e.clientY, clipId: id });
  }

  return {
    onLanesPointerDown,
    onRulerPointerDown,
    onContextMenu,
    dispose: end,
  };
}

export type Gestures = ReturnType<typeof createGestures>;
