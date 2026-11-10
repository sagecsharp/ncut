/**
 * pointer gestures of the timeline: move, trim, marquee, ruler scrub, empty-lane click, context menu.
 *
 * everything lives outside react. one controller instance handles event delegation for the whole
 * lanes area, keeps gesture state in plain objects, caches geometry once at gesture start and
 * applies at most one update per animation frame.
 */
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react';
import type { Clip, ClipType, EffectClip } from '../../types';
import { trackKindForClip } from '../../types';
import { keyTimes } from '../../lib/anim';
import { formatTimecode, snapToFrame } from '../../lib/time';
import { previousClipOnTrack, transitionSpan } from '../../lib/transitions';
import { MAX_TRANSITION_DURATION, MIN_TRANSITION_DURATION } from '../../engine/transitions/registry';
import { clipEnd, findFreeStart } from '../../lib/timelineOps';
import { snapTimeFast as snapTime } from './snapSearch';
import { useEditor } from '../../store/editorStore';
import type { ClipMove } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { findFollowers, placeFollowers } from './effectFollow';
import type { ClipSpan } from './effectFollow';
import { planGroupTrim } from './groupTrim';
import { hitKey } from './keyGeometry';
import { groupIds, marqueeReplaceList, pressedSelection } from './selectionRules';
import { HEADER_W, RULER_H, SNAP_PX, computeLayout, hitGap, hitLane } from './layout';
import { gapForMove, singleTrack } from './moveGap';
import { hitMarker, markerTimes, timelineSnapPoints } from './markers';
import type { MarkerMenuRequest } from './MarkerUi';
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
  openMarkerMenu(req: MarkerMenuRequest): void;
  /** start renaming a marker with the input near client x / y */
  renameMarker(id: string, x: number, y: number): void;
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
  deferSingle: string[] | null;
  lastKey: string;
  delta: number;
  zone: 'top' | 'bottom' | null;
  /** index of the new track a border under the pointer opens, when the move may open one */
  gap: number | null;
  /** effect clips that follow the moving clips, and the clips as they were when the drag started */
  follow: EffectClip[];
  baseClips: Clip[];
}

interface TrimGesture extends Base {
  kind: 'trim';
  id: string;
  edge: 'start' | 'end';
  points: number[];
  /** edge time minus pointer time at press, so the edge does not jump to the pointer */
  offset: number;
  /** the edge of the grabbed clip at press: the drag moves every trimmed clip by (edge now - this) */
  startEdge: number;
  /** the selection at press: with several clips in it the drag trims all of them (see planGroupTrim) */
  selection: string[];
  /** the clips this drag trims (just the grabbed one, or every selected clip that can be) */
  ids: string[];
  /** true when the drag trims more than the grabbed clip */
  group: boolean;
  /** effect clips that follow the trimmed clips, and the clips as they were when the trim started */
  follow: EffectClip[];
  baseClips: Clip[];
}

interface SeekGesture extends Base {
  kind: 'seek';
  /** key times of the selected clips (timeline seconds), empty when snapping is off */
  points: number[];
}

/** a press on a keyframe diamond: click = jump to it, drag = retime that moment for every property */
interface KeyGesture extends Base {
  kind: 'key';
  id: string;
  /** timeline time of the moment being dragged (follows the key as it moves) */
  time: number;
  /** key time minus pointer time at press */
  offset: number;
  points: number[];
}

/** a drag on the inner edge of a transition marker */
interface TransitionGesture extends Base {
  kind: 'transition';
  id: string;
  /** span end minus pointer time at press */
  offset: number;
}

interface MarqueeGesture extends Base {
  kind: 'marquee';
  /** lane x / lanes-area y where the gesture began */
  originX: number;
  originY: number;
  baseSelection: string[];
  lastKey: string;
}

/** a press on a marker flag: click = jump to it, drag = move it */
interface MarkerGesture extends Base {
  kind: 'marker';
  id: string;
  time: number;
  /** marker time minus pointer time at press */
  offset: number;
  points: number[];
}

type Gesture = MoveGesture | TrimGesture | SeekGesture | MarqueeGesture | KeyGesture | TransitionGesture | MarkerGesture;

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
      case 'key':
        stepKey(cur);
        break;
      case 'transition':
        stepTransition(cur);
        break;
      case 'marker':
        stepMarker(cur);
        break;
    }
  }

  function finish(cur: Gesture): void {
    if (cur.kind === 'move') finishMove(cur);
    else if ((cur.kind === 'key' || cur.kind === 'marker') && !cur.started) usePlayback.getState().seek(cur.time);
  }

  /* ---------- seek (ruler scrub) ---------- */

  function seekAt(cur: SeekGesture): void {
    const project = store().project;
    if (!project) return;
    const t = Math.max(0, laneX(cur.geo, cur.cx)) / cur.zoom;
    if (cur.points.length > 0) {
      const r = snapTime(t, cur.points, SNAP_PX / cur.zoom);
      if (r.hit !== null) {
        env.overlays.setSnap(r.hit, cur.zoom);
        usePlayback.getState().seek(r.hit);
        return;
      }
    }
    env.overlays.setSnap(null, cur.zoom);
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
      m.baseClips = project.clips;
      m.follow = findFollowers(project.clips, project.tracks, m.items.map((o) => o.id), new Set(m.items.map((o) => o.id)));
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
    const ly = laneY(m.geo, m.cy);
    const movedY = m.cy - m.startY + (view.scrollTop - m.startScrollTop);
    // where the press was, in today's lane coordinates
    const pressGap = hitGap(m.layout, ly - movedY);
    const gap = gapForMove(project.tracks, m.baseClips, m.items, hitGap(m.layout, ly), movedY, pressGap);
    if (gap !== null) {
      // over a border the clips stay on their own track and follow the pointer in time
    } else if (hit.type === 'lane') {
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
    } else {
      const one = singleTrack(project.tracks, m.items);
      const kind = one?.kind;
      if (one && ((hit.where === 'top' && kind === 'video') || (hit.where === 'bottom' && kind === 'audio'))) zone = hit.where;
    }
    m.zone = zone;
    m.gap = gap;
    env.overlays.setHot(zone);
    env.overlays.setGap(gap === null ? null : m.layout.tops[gap]!);

    {
      const li = project.tracks.findIndex((t) => t.id === trackFor(m.leader));
      const laneTop = m.layout.tops[li < 0 ? m.leader.trackIdx : li] ?? 0;
      const at = Math.max(0, m.leader.start + delta);
      env.overlays.setReadout(Math.round(at * zoom), Math.max(0, laneTop - 15), formatTimecode(at, project.fps));
    }

    const moves: ClipMove[] = m.items.map((o) => ({
      id: o.id,
      trackId: trackFor(o),
      start: Math.max(0, o.start + delta),
    }));
    // effects that are put on the moving clips move with them when their own track has room
    let applied = false;
    if (m.follow.length > 0) applied = applyMoves(m, project.clips, [...moves, ...followMoves(m, moves)]);
    if (!applied) applied = applyMoves(m, project.clips, moves);
    if (!applied && m.items.length === 1) {
      const o = m.items[0]!;
      const trackId = trackFor(o);
      const free = findFreeStart(project, trackId, o.start + delta, o.duration, [o.id]);
      const single: ClipMove[] = [{ id: o.id, trackId, start: free }];
      if (
        (m.follow.length > 0 && applyMoves(m, project.clips, [...single, ...followMoves(m, single)])) ||
        applyMoves(m, project.clips, single)
      ) {
        env.overlays.setSnap(null, zoom);
        return;
      }
    }
    env.overlays.setSnap(applied ? snapHit : null, zoom);
  }

  /** where the effects that follow the moved clips go, planned from the clips as the drag found them */
  function followMoves(m: MoveGesture, moves: ClipMove[]): ClipMove[] {
    const changes = new Map<string, ClipSpan>();
    for (const mv of moves) {
      const o = m.items.find((x) => x.id === mv.id);
      if (o) changes.set(mv.id, { start: mv.start, duration: o.duration, trackId: mv.trackId });
    }
    return placeFollowers(m.baseClips, m.follow, changes).map((r) => ({
      id: r.id,
      trackId: m.baseClips.find((c) => c.id === r.id)!.trackId,
      start: r.start,
    }));
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
      if (m.deferSingle) st.select(m.deferSingle, 'replace');
      return;
    }
    const one = m.zone || m.gap !== null ? singleTrack(st.project?.tracks ?? [], m.items) : null;
    if (one) {
      // the clips go to a new track (above, below or between tracks), part of the same undo step
      const index = m.gap !== null ? m.gap : m.zone === 'top' ? 0 : undefined;
      const trackId = st.addTrack(one.kind, { skipHistory: true, index });
      if (trackId) {
        const lead: ClipMove[] = m.items.map((o) => ({ id: o.id, trackId, start: Math.max(0, o.start + m.delta) }));
        if (!(m.follow.length > 0 && st.moveClips([...lead, ...followMoves(m, lead)], { skipHistory: true }))) {
          st.moveClips(lead, { skipHistory: true });
        }
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
      const project = st.project;
      if (project) {
        t.baseClips = project.clips;
        t.follow = findFollowers(project.clips, project.tracks, t.ids);
      }
    }
    let time = Math.max(0, laneX(t.geo, t.cx) / t.zoom + t.offset);
    let hit: number | null = null;
    if (st.snapping) {
      const r = snapTime(time, t.points, SNAP_PX / t.zoom);
      time = r.time;
      hit = r.hit;
    }
    if (t.group) {
      // every selected clip gets its own start edge + the same delta, planned from the state at press (no drift)
      for (const step of planGroupTrim(t.baseClips, st.project?.tracks ?? [], t.selection, t.id, t.edge, time - t.startEdge)) {
        st.trimClip(step.id, t.edge, step.time, { skipHistory: true });
      }
    } else st.trimClip(t.id, t.edge, time, { skipHistory: true });
    if (t.follow.length > 0) followTrim(t);
    if (hit !== null) {
      const c = useEditor.getState().project?.clips.find((x) => x.id === t.id);
      const actual = c ? (t.edge === 'start' ? c.start : clipEnd(c)) : NaN;
      if (!(Math.abs(actual - hit) < 1e-6)) hit = null;
    }
    env.overlays.setSnap(hit, t.zoom);
  }

  /** effects that are put on the trimmed clips take their new start and end when their own track has room */
  function followTrim(t: TrimGesture): void {
    const st = store();
    const changes = new Map<string, ClipSpan>();
    for (const id of t.ids) {
      const trimmed = st.project?.clips.find((c) => c.id === id);
      if (trimmed) changes.set(id, { start: trimmed.start, duration: trimmed.duration });
    }
    if (changes.size === 0) return;
    for (const r of placeFollowers(t.baseClips, t.follow, changes)) {
      const now = store().project?.clips.find((c) => c.id === r.id);
      if (!now) continue;
      if (Math.abs(now.start - r.start) > 1e-6) st.trimClip(r.id, 'start', r.start, { skipHistory: true });
      const after = store().project?.clips.find((c) => c.id === r.id);
      if (after && Math.abs(clipEnd(after) - (r.start + r.duration)) > 1e-6) {
        st.trimClip(r.id, 'end', r.start + r.duration, { skipHistory: true });
      }
    }
  }

  /* ---------- keyframe diamonds ---------- */

  function stepKey(k: KeyGesture): void {
    const st = store();
    const project = st.project;
    if (!project) return;
    if (!k.started) {
      if (Math.abs(k.cx - k.startX) < DRAG_THRESHOLD) return;
      k.started = true;
      st.pushHistory();
    }
    const clip = project.clips.find((c) => c.id === k.id);
    if (!clip) return;
    const tol = 0.5 / project.fps;
    const lo = clip.start;
    const hi = clipEnd(clip);
    let time = Math.min(hi, Math.max(lo, laneX(k.geo, k.cx) / k.zoom + k.offset));
    let hit: number | null = null;
    if (st.snapping) {
      const r = snapTime(time, k.points, SNAP_PX / k.zoom);
      hit = r.hit;
      if (hit !== null) time = Math.min(hi, Math.max(lo, r.time));
    }
    if (hit === null) time = Math.min(hi, Math.max(lo, snapToFrame(time, project.fps)));
    if (Math.abs(time - k.time) < 1e-6) return;
    // landing on another moment of this clip would replace its keys: stay where we are instead
    for (const t of keyTimes(clip.keyframes, undefined, clip.duration)) {
      const at = clip.start + t;
      if (Math.abs(at - k.time) > tol && Math.abs(at - time) <= tol) {
        env.overlays.setSnap(null, k.zoom);
        return;
      }
    }
    st.moveKeyframe(k.id, null, k.time, time, undefined, { skipHistory: true });
    k.time = time;
    env.overlays.setSnap(hit, k.zoom);
  }

  /* ---------- markers ---------- */

  function stepMarker(k: MarkerGesture): void {
    const st = store();
    const project = st.project;
    if (!project) return;
    if (!k.started) {
      if (Math.abs(k.cx - k.startX) < DRAG_THRESHOLD) return;
      k.started = true;
      st.pushHistory();
    }
    let time = Math.max(0, laneX(k.geo, k.cx) / k.zoom + k.offset);
    let hit: number | null = null;
    if (st.snapping) {
      const r = snapTime(time, k.points, SNAP_PX / k.zoom);
      time = r.time;
      hit = r.hit;
    }
    if (hit === null) time = snapToFrame(time, project.fps);
    if (Math.abs(time - k.time) > 1e-6) {
      st.updateMarker(k.id, { time }, { skipHistory: true });
      k.time = time;
    }
    env.overlays.setSnap(hit, k.zoom);
  }

  /** ruler-local point of a pointer event: x in lane space, y from the top of the ruler */
  function rulerPoint(geo: Geo, e: { clientX: number; clientY: number }): { x: number; y: number } {
    return { x: laneX(geo, e.clientX), y: e.clientY - geo.top };
  }

  /* ---------- transition length ---------- */

  function stepTransition(t: TransitionGesture): void {
    const st = store();
    const project = st.project;
    if (!project) return;
    const clip = project.clips.find((c) => c.id === t.id);
    if (!clip || !('transition' in clip) || !clip.transition) return;
    if (!t.started) {
      if (Math.abs(t.cx - t.startX) < 2) return;
      t.started = true;
      st.pushHistory();
    }
    const prev = previousClipOnTrack(project, clip);
    const end = Math.max(0, laneX(t.geo, t.cx) / t.zoom + t.offset);
    // with a clip before it the band is centered on the cut, so the dragged edge is half the length
    let duration = prev ? (end - clip.start) * 2 : end - clip.start;
    const cap = prev ? Math.min(clip.duration, prev.duration) : clip.duration;
    duration = snapToFrame(Math.min(MAX_TRANSITION_DURATION, cap, Math.max(MIN_TRANSITION_DURATION, duration)), project.fps);
    if (Math.abs(duration - clip.transition.duration) < 1e-6) return;
    st.updateClip(t.id, { transition: { id: clip.transition.id, duration } }, { skipHistory: true });
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
    // one select call with the final list instead of replace(base) + add(hits): same selection, one store update
    st.select(marqueeReplaceList(project, mq.baseSelection, hits), 'replace');
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
    const handleEl = target.closest<HTMLElement>('[data-transition-handle]');
    // a press on a transition band acts on the clip that owns it
    const pressId =
      handleEl?.dataset.transitionHandle ?? clipEl?.dataset.clipId ?? target.closest<HTMLElement>('[data-transition-clip]')?.dataset.transitionClip;

    if (pressId !== undefined) {
      const id = pressId;
      const clip = project.clips.find((c) => c.id === id);
      const track = clip ? project.tracks.find((t) => t.id === clip.trackId) : undefined;
      if (!clip || !track || track.locked) return;
      e.preventDefault();
      if (handleEl) {
        if (!st.selection.includes(id)) st.select([id], 'replace');
        const span = transitionSpan(project, clip);
        if (!span) return;
        begin(
          {
            ...base(e, geo, layout, captureEl),
            kind: 'transition',
            id,
            offset: span.end - laneX(geo, e.clientX) / st.zoom,
          },
          'trim',
        );
        return;
      }
      if (clipEl && clip.keyframes && !mod) {
        const rect = clipEl.getBoundingClientRect();
        const key = hitKey(
          keyTimes(clip.keyframes, undefined, clip.duration),
          st.zoom,
          Math.max(2, clip.duration * st.zoom),
          rect.height - 2,
          e.clientX - rect.left - 1,
          e.clientY - rect.top - 1,
        );
        if (key !== null) {
          if (!st.selection.includes(id)) st.select([id], 'replace');
          const time = clip.start + key;
          const points = new Set<number>([usePlayback.getState().time]);
          for (const c of project.clips) {
            if (c.id === id) continue;
            for (const t of keyTimes(c.keyframes, undefined, c.duration)) points.add(c.start + t);
          }
          begin(
            {
              ...base(e, geo, layout, captureEl),
              kind: 'key',
              id,
              time,
              offset: time - laneX(geo, e.clientX) / st.zoom,
              points: [...points].sort((a, b) => a - b),
            },
            'trim',
          );
          return;
        }
      }
      const edgeAttr = target.closest<HTMLElement>('[data-trim]')?.dataset.trim;
      if (edgeAttr === 'start' || edgeAttr === 'end') {
        if (!st.selection.includes(id)) st.select([id], 'replace');
        // with several clips selected the drag trims all of them: they move with it, so they are no snap points
        const selection = store().selection;
        const planned = planGroupTrim(project.clips, project.tracks, selection, id, edgeAttr, 0).map((x) => x.id);
        const group = planned.length > 1 || (planned.length === 1 && planned[0] !== id);
        const ids = group ? planned : [id];
        begin(
          {
            ...base(e, geo, layout, captureEl),
            kind: 'trim',
            id,
            edge: edgeAttr,
            offset: (edgeAttr === 'start' ? clip.start : clipEnd(clip)) - laneX(geo, e.clientX) / st.zoom,
            startEdge: edgeAttr === 'start' ? clip.start : clipEnd(clip),
            selection,
            ids,
            group,
            points: timelineSnapPoints(project, [...ids, ...findFollowers(project.clips, project.tracks, ids).map((f) => f.id)], [usePlayback.getState().time]),
            follow: [],
            baseClips: project.clips,
          },
          'trim',
        );
        return;
      }
      // groups select together; alt picks the one clip; trimming (above) never expands
      let deferSingle: string[] | null = null;
      if (e.altKey) {
        st.select([id], 'replace');
      } else if (e.ctrlKey || e.metaKey) {
        st.select(pressedSelection(project, st.selection, id, 'toggle'), 'replace');
        if (!store().selection.includes(id)) return;
      } else if (e.shiftKey) {
        st.select(pressedSelection(project, st.selection, id, 'add'), 'replace');
      } else if (!st.selection.includes(id)) {
        st.select(groupIds(project, id), 'replace');
      } else if (st.selection.length > 1) {
        deferSingle = groupIds(project, id);
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
          points: timelineSnapPoints(
            project,
            [...items.map((o) => o.id), ...findFollowers(project.clips, project.tracks, items.map((o) => o.id)).map((f) => f.id)],
            [usePlayback.getState().time],
          ),
          deferSingle,
          lastKey: '',
          delta: 0,
          zone: null,
          gap: null,
          follow: [],
          baseClips: project.clips,
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
    const st = store();
    const rp = rulerPoint(geo, e);
    const marker = hitMarker(project.markers ?? [], st.zoom, rp.x, rp.y);
    if (marker) {
      begin(
        {
          ...base(e, geo, computeLayout(project.tracks), e.currentTarget),
          kind: 'marker',
          id: marker.id,
          time: marker.time,
          offset: marker.time - rp.x / st.zoom,
          points: timelineSnapPoints(project, [], [usePlayback.getState().time], marker.id),
        },
        'trim',
      );
      return;
    }
    const points: number[] = markerTimes(st.snapping ? project.markers : undefined);
    if (st.snapping && st.selection.length > 0) {
      const sel = new Set(st.selection);
      for (const c of project.clips) {
        if (sel.has(c.id)) for (const t of keyTimes(c.keyframes, undefined, c.duration)) points.push(c.start + t);
      }
    }
    const cur: SeekGesture = { ...base(e, geo, computeLayout(project.tracks), e.currentTarget), kind: 'seek', points };
    begin(cur, 'seek');
    seekAt(cur);
  }

  function onRulerDoubleClick(e: ReactMouseEvent<HTMLElement>): void {
    const project = store().project;
    const geo = measure();
    if (!project || !geo) return;
    const rp = rulerPoint(geo, e);
    const marker = hitMarker(project.markers ?? [], store().zoom, rp.x, rp.y);
    if (!marker) return;
    e.preventDefault();
    end();
    env.renameMarker(marker.id, e.clientX, e.clientY);
  }

  function onRulerContextMenu(e: ReactMouseEvent<HTMLElement>): void {
    const st = store();
    const project = st.project;
    const geo = measure();
    if (!project || !geo) return;
    e.preventDefault();
    end();
    const rp = rulerPoint(geo, e);
    const marker = hitMarker(project.markers ?? [], st.zoom, rp.x, rp.y);
    env.openMarkerMenu({
      x: e.clientX,
      y: e.clientY,
      markerId: marker?.id ?? null,
      time: Math.max(0, rp.x) / st.zoom,
    });
  }

  function onContextMenu(e: ReactMouseEvent<HTMLElement>): void {
    const el = e.target as HTMLElement;
    const id =
      el.closest<HTMLElement>('[data-clip-id]')?.dataset.clipId ?? el.closest<HTMLElement>('[data-transition-clip]')?.dataset.transitionClip;
    if (id === undefined) return;
    const st = store();
    const clip = st.project?.clips.find((c) => c.id === id);
    const track = clip ? st.project?.tracks.find((t) => t.id === clip.trackId) : undefined;
    if (!clip || !track || track.locked) return;
    e.preventDefault();
    end();
    if (!st.selection.includes(id)) st.select(st.project ? groupIds(st.project, id) : [id], 'replace');
    env.openMenu({ x: e.clientX, y: e.clientY, clipId: id });
  }

  return {
    onLanesPointerDown,
    onRulerPointerDown,
    onRulerDoubleClick,
    onRulerContextMenu,
    onContextMenu,
    dispose: end,
  };
}

export type Gestures = ReturnType<typeof createGestures>;
