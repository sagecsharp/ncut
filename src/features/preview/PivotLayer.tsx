/**
 * the pivot mark of the selected clip and its drag, for both overlays. the move pivot mode (pivotMode.ts) adds the nine
 * spot dots and an area that takes a press anywhere on the picture. nothing here renders per frame: positions are written
 * to refs from store subscriptions, like SelBox, and pointer moves are coalesced to one update per animation frame.
 */
import { useLayoutEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { PIVOT_SPOTS, normalizePivot, pivotOf } from '../../engine/pivot';
import { type CameraRig, projectPoint, screenRay } from '../../engine/scene3d/camera';
import { faceSourceSet } from '../../engine/scene3d/faces';
import type { Vec3 } from '../../engine/scene3d/math';
import { clipEnd } from '../../lib/timelineOps';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import type { Clip, Project, VisualClip } from '../../types';
import { isVisualClip } from '../../types';
import { beginEdit, endEdit } from '../properties/edit';
import { pivotModeBlocker, setPivot } from '../properties/pivotActions';
import { tip } from '../shell/tip';
import { beginPreviewGesture, endPreviewGesture } from './gesture';
import { type PivotSnap, clipSpots, fractionOnPlane, nearestSnap, pivotSnaps } from './pivotMath';
import { usePivotMode } from './pivotMode';

export interface PivotLayerProps {
  /** output: 2d clips are flat canvas px, 3d clips go through the project camera. scene: everything through the view camera */
  kind: 'output' | 'scene';
  /** css px per canvas px now */
  getF: () => number;
  /** the camera the overlay shows at a time (output: projectRig, scene: the scene view's viewRig) */
  getRig: (project: Project, time: number) => CameraRig;
  /** call `fn` whenever the overlay's view changes (size, view camera). returns the unsubscribe */
  register: (fn: () => void) => () => void;
}

/** the mark takes the pointer without the mode when the picture is at least this big on screen (its shorter side, css px) */
const LIVE_MIN_PX = 24;
const SNAP_RADIUS_PX = 8;
const DRAG_THRESHOLD_PX = 2;

interface Drag {
  pointerId: number;
  id: string;
  from: 'mark' | 'area';
  startX: number;
  startY: number;
  started: boolean;
  /** the layer's place on the page and css px per canvas px, measured at the press */
  left: number;
  top: number;
  f: number;
  /** a 2d clip in the output view: a straight ray, no camera */
  flat: boolean;
  rig: CameraRig;
  /** the 9 spots of the picture (it does not move while the pivot does) */
  spots: Vec3[];
  snaps: PivotSnap[];
}

interface Pending {
  x: number;
  y: number;
  alt: boolean;
}

const inRangeAt = (c: Clip, time: number) => time >= c.start - 1e-6 && time < clipEnd(c) - 1e-6;

/** a world point in css px of the overlay (ok false = behind the camera). a flat clip of the output view has no camera */
function screenOf(kind: 'output' | 'scene', rig: CameraRig, project: Project, f: number) {
  return (p: Vec3, of: VisualClip): { x: number; y: number; ok: boolean } => {
    if (kind === 'output' && !of.threeD) return { x: p[0] * f, y: p[1] * f, ok: true };
    const r = projectPoint(rig, p[0], p[1], p[2], project.width, project.height);
    return { x: r.x * f, y: r.y * f, ok: r.visible };
  };
}

/** the one selected picture clip the layer works on, or null */
function selectedClip(project: Project | null, selection: readonly string[]): VisualClip | null {
  if (!project || selection.length !== 1) return null;
  const clip = project.clips.find((c) => c.id === selection[0]);
  return clip && isVisualClip(clip) ? clip : null;
}

const typing = (t: EventTarget | null): boolean => {
  const el = t as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? '').toLowerCase();
  return tag === 'input' || tag === 'textarea';
};

export function PivotLayer(props: PivotLayerProps) {
  const latest = useRef(props);
  latest.current = props;
  const layerRef = useRef<HTMLDivElement>(null);
  const polyRef = useRef<SVGPolygonElement>(null);
  const markRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const spotRefs = useRef<Array<HTMLDivElement | null>>([]);
  const dragRef = useRef<Drag | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const rafRef = useRef(0);

  useLayoutEffect(() => {
    const mark = markRef.current;
    const poly = polyRef.current;
    const label = labelRef.current;
    if (!mark || !poly || !label) return;
    let shown = false;
    let lastClip: Clip | undefined;
    let dynamic = false;
    let lm = '';
    let lp = '';

    const spotEls = (): HTMLDivElement[] => spotRefs.current.filter((n): n is HTMLDivElement => !!n);
    const hide = () => {
      if (!shown) return;
      shown = false;
      mark.style.display = 'none';
      poly.style.display = 'none';
      for (const el of spotEls()) el.style.display = 'none';
    };

    const update = () => {
      const st = useEditor.getState();
      const project = st.project;
      const mode = usePivotMode.getState().on;
      // the mode needs one usable clip: it ends when the clip is gone, locked or no longer alone
      if (mode && pivotModeBlocker(project, st.selection)) {
        usePivotMode.getState().set(false);
        return;
      }
      const f = latest.current.getF();
      const clip = selectedClip(project, st.selection);
      lastClip = clip ?? undefined;
      dynamic = false;
      if (!project || !clip || f <= 0) return hide();
      const pv = pivotOf(clip);
      const isSet = pv.x !== 0 || pv.y !== 0;
      // a clip without a pivot costs nothing per frame: the editor and mode subscriptions bring the mark back
      if (!isSet && !mode) {
        lastClip = undefined;
        return hide();
      }
      const track = project.tracks.find((t) => t.id === clip.trackId);
      const time = usePlayback.getState().time;
      if (!track || track.hidden || !inRangeAt(clip, time) || faceSourceSet(project).has(clip.id)) {
        // the mode needs a clip that can show its pivot
        if (mode) usePivotMode.getState().set(false);
        return hide();
      }
      dynamic = !!clip.keyframes || !!clip.threeD || !!clip.parent || project.clips.some((c) => c.type === 'camera');
      const rig = latest.current.getRig(project, time);
      const toScreen = screenOf(latest.current.kind, rig, project, f);
      const { spots, pivot } = clipSpots(project, clip, time, rig.eye);
      const at = toScreen(pivot, clip);
      if (!at.ok) return hide();
      shown = true;

      const ms = `translate3d(${at.x}px, ${at.y}px, 0)`;
      if (ms !== lm) mark.style.transform = lm = ms;
      mark.style.display = 'block';
      mark.dataset.set = isSet ? '1' : '0';
      const p0 = toScreen(spots[0]!, clip);
      const p2 = toScreen(spots[2]!, clip);
      const p6 = toScreen(spots[6]!, clip);
      const p8 = toScreen(spots[8]!, clip);
      const sized = p0.ok && p2.ok && p6.ok ? Math.min(Math.hypot(p2.x - p0.x, p2.y - p0.y), Math.hypot(p6.x - p0.x, p6.y - p0.y)) : 0;
      mark.classList.toggle('is-live', !track.locked && (mode || (latest.current.kind === 'output' && sized >= LIVE_MIN_PX)));

      if (!mode) {
        poly.style.display = 'none';
        for (const el of spotEls()) el.style.display = 'none';
        return;
      }
      if (p0.ok && p2.ok && p6.ok && p8.ok) {
        const pts = `${p0.x},${p0.y} ${p2.x},${p2.y} ${p8.x},${p8.y} ${p6.x},${p6.y}`;
        if (pts !== lp) {
          lp = pts;
          poly.setAttribute('points', pts);
        }
        poly.style.display = '';
      } else poly.style.display = 'none';
      spotRefs.current.forEach((el, i) => {
        if (!el) return;
        const s = toScreen(spots[i]!, clip);
        el.style.display = s.ok ? 'block' : 'none';
        if (s.ok) el.style.transform = `translate3d(${s.x}px, ${s.y}px, 0)`;
      });
    };

    // esc ends the mode, and nothing else (it must not also clear the selection)
    const onKey = (e: KeyboardEvent) => {
      // esc in a field drag only takes the drag back
      if (e.key !== 'Escape' || dragRef.current || typing(e.target) || document.documentElement.classList.contains('is-scrubbing')) return;
      // an open menu or dialog takes this esc
      if (document.querySelector('[role="menu"], .dialog-backdrop')) return;
      e.preventDefault();
      e.stopPropagation();
      usePivotMode.getState().set(false);
    };
    let keyOn = false;
    const syncKey = () => {
      const on = usePivotMode.getState().on;
      if (on === keyOn) return;
      keyOn = on;
      if (on) window.addEventListener('keydown', onKey, true);
      else window.removeEventListener('keydown', onKey, true);
    };

    const unRegister = latest.current.register(update);
    const unEditor = useEditor.subscribe((s, p) => {
      // another selection ends the mode
      if (s.selection !== p.selection && usePivotMode.getState().on) usePivotMode.getState().set(false);
      // the scene overlay redraws on these itself and calls update through register
      if (latest.current.kind === 'output' && (s.project !== p.project || s.selection !== p.selection)) update();
    });
    const unTime = usePlayback.subscribe((s, p) => {
      if (latest.current.kind !== 'output' || s.time === p.time || !lastClip) return;
      if (dynamic || inRangeAt(lastClip, s.time) !== shown) update();
    });
    const unMode = usePivotMode.subscribe(() => {
      syncKey();
      update();
    });
    syncKey();
    update();
    return () => {
      unRegister();
      unEditor();
      unTime();
      unMode();
      if (keyOn) window.removeEventListener('keydown', onKey, true);
      cancelAnimationFrame(rafRef.current);
      if (dragRef.current) {
        dragRef.current = null;
        endPreviewGesture();
        endEdit();
      }
      usePivotMode.getState().set(false);
    };
  }, []);

  const showLabel = (text: string | null, x = 0, y = 0) => {
    const el = labelRef.current;
    if (!el) return;
    if (text === null) {
      el.style.display = 'none';
      return;
    }
    if (el.textContent !== text) el.textContent = text;
    el.style.transform = `translate3d(${x + 12}px, ${y + 12}px, 0)`;
    el.style.display = 'block';
  };

  /** put the pivot under the pointer: snapped to a spot or another clip unless alt is held */
  const apply = (snap: Pending) => {
    const d = dragRef.current;
    const project = useEditor.getState().project;
    if (!d || !project) return;
    if (!d.started) {
      if (d.from === 'mark' && Math.hypot(snap.x - d.startX, snap.y - d.startY) < DRAG_THRESHOLD_PX) return;
      d.started = true;
    }
    const cx = snap.x - d.left;
    const cy = snap.y - d.top;
    const hit = snap.alt ? null : nearestSnap(d.snaps, cx, cy, SNAP_RADIUS_PX);
    showLabel(hit ? hit.label : null, hit?.x, hit?.y);
    let frac: [number, number] | null = null;
    if (hit?.spot) frac = hit.spot;
    else {
      // another snap point stands in for the pointer
      const px = (hit ? hit.x : cx) / d.f;
      const py = (hit ? hit.y : cy) / d.f;
      if (d.flat) frac = fractionOnPlane(d.spots, [px, py, -1], [0, 0, 1]);
      else {
        const ray = screenRay(d.rig, px, py, project.width, project.height);
        frac = fractionOnPlane(d.spots, ray.origin, ray.dir);
      }
    }
    if (!frac) return;
    setPivot(d.id, normalizePivot({ x: frac[0], y: frac[1] }), { live: true });
  };

  const flush = () => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    const snap = pendingRef.current;
    pendingRef.current = null;
    if (snap) apply(snap);
  };

  const start = (e: ReactPointerEvent<Element>, from: 'mark' | 'area') => {
    if (e.button !== 0 || dragRef.current) return;
    e.stopPropagation();
    e.preventDefault();
    // preventDefault suppresses the focus change: put focus on the stage so the keys keep working
    layerRef.current?.closest<HTMLElement>('.preview-stage')?.focus({ preventScroll: true });
    const st = useEditor.getState();
    const project = st.project;
    const layer = layerRef.current;
    const clip = selectedClip(project, st.selection);
    if (!project || !layer || !clip) return;
    if (project.tracks.find((t) => t.id === clip.trackId)?.locked) return;
    const rect = layer.getBoundingClientRect();
    if (rect.width <= 0) return;
    const { kind, getRig } = latest.current;
    // playback would plan every live step at a different time: the pivot would land off the pointer
    if (usePlayback.getState().playing) usePlayback.getState().pause();
    const f = rect.width / project.width;
    const time = usePlayback.getState().time;
    const rig = getRig(project, time);
    dragRef.current = {
      pointerId: e.pointerId,
      id: clip.id,
      from,
      startX: e.clientX,
      startY: e.clientY,
      started: false,
      left: rect.left,
      top: rect.top,
      f,
      flat: kind === 'output' && !clip.threeD,
      rig,
      spots: clipSpots(project, clip, time, rig.eye).spots,
      snaps: pivotSnaps(project, clip, time, rig.eye, screenOf(kind, rig, project, f)),
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    beginEdit();
    beginPreviewGesture();
    if (from === 'area') apply({ x: e.clientX, y: e.clientY, alt: e.altKey });
  };

  const move = (e: ReactPointerEvent<Element>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    e.stopPropagation();
    pendingRef.current = { x: e.clientX, y: e.clientY, alt: e.altKey };
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const snap = pendingRef.current;
        pendingRef.current = null;
        if (snap) apply(snap);
      });
    }
  };

  const end = (e: ReactPointerEvent<Element>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    e.stopPropagation();
    if (e.type === 'pointerup') pendingRef.current = { x: e.clientX, y: e.clientY, alt: e.altKey };
    flush();
    dragRef.current = null;
    endPreviewGesture();
    endEdit();
    showLabel(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const reset = (e: { stopPropagation(): void }) => {
    e.stopPropagation();
    const clip = selectedClip(useEditor.getState().project, useEditor.getState().selection);
    if (clip) setPivot(clip.id, null);
  };

  return (
    <div ref={layerRef} className="pivot-layer">
      <svg className="pivot-area-svg" aria-hidden="true">
        <polygon
          ref={polyRef}
          className="pivot-area"
          style={{ display: 'none' }}
          {...tip('move pivot', { does: 'press where the pivot goes, or drag it', keys: 'preview-pivot-done' })}
          onDoubleClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => start(e, 'area')}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onLostPointerCapture={end}
        />
      </svg>
      {PIVOT_SPOTS.map((sp, i) => (
        <div
          key={sp.id}
          ref={(n) => {
            spotRefs.current[i] = n;
          }}
          className="pivot-spot"
        />
      ))}
      <div
        ref={markRef}
        className="pivot-mark"
        data-set="0"
        aria-label="pivot"
        {...tip('pivot', { does: 'the point it rotates and scales around. drag it, the clip stays where it is', keys: 'mouse-pivot' })}
        onPointerDown={(e) => start(e, 'mark')}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onDoubleClick={reset}
      />
      <div ref={labelRef} className="pivot-label" />
    </div>
  );
}
