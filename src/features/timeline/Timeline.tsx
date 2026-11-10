import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import type { Track } from '../../types';
import { clamp } from '../../lib/time';
import { projectDuration } from '../../lib/timelineOps';
import { MAX_ZOOM, MIN_ZOOM, useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { isTypingTarget } from '../shell/useShortcuts';
import { ClipMenu } from './ClipMenu';
import { PlayheadLine } from './Playhead';
import { Ruler } from './Ruler';
import { TimelineToolbar } from './TimelineToolbar';
import { TrackHeader } from './TrackHeader';
import { TrackLane } from './TrackLane';
import { TrackMenu } from './TrackMenu';
import type { TrackMenuRequest } from './TrackMenu';
import { createDnd } from './dnd';
import { MarkerLines, MarkerMenu, MarkerRename } from './MarkerUi';
import type { MarkerMenuRequest } from './MarkerUi';
import { createGestures } from './gestures';
import type { MenuRequest } from './gestures';
import { HEADER_W, RULER_H, TAIL_MIN_PX, ZONE_H, laneHeight } from './layout';
import { Overlays } from './overlays';
import { FIT_PAD, rangeOf, zoomForRange } from './zoomMath';
import { markUserScroll, notifyView, resetView, view } from './view';
import './timeline.css';

const EMPTY_TRACKS: Track[] = [];

/** the multi-track timeline panel. */
export function Timeline() {
  const hasProject = useEditor((s) => s.project !== null);
  if (!hasProject) {
    return (
      <div className="panel timeline">
        <div className="empty">no project open</div>
      </div>
    );
  }
  return <TimelineInner />;
}

interface RowProps {
  track: Track;
  zoom: number;
}

function TrackRow({ track, zoom }: RowProps) {
  return (
    <div
      className={`timeline-row${track.locked ? ' is-locked' : ''}`}
      style={{ height: laneHeight(track.kind) }}
    >
      <TrackHeader track={track} />
      <TrackLane track={track} zoom={zoom} />
    </div>
  );
}

function wheelDelta(e: WheelEvent, el: HTMLElement, value: number): number {
  if (e.deltaMode === 1) return value * 16;
  if (e.deltaMode === 2) return value * el.clientHeight;
  return value;
}

function TimelineInner() {
  const tracks = useEditor((s) => s.project?.tracks ?? EMPTY_TRACKS);
  const zoom = useEditor((s) => s.zoom);
  const duration = useEditor((s) => (s.project ? projectDuration(s.project) : 0));
  const hasClips = useEditor((s) => (s.project?.clips.length ?? 0) > 0);
  const [viewW, setViewW] = useState(view.width);
  const [menu, setMenu] = useState<MenuRequest | null>(null);
  const [trackMenu, setTrackMenu] = useState<TrackMenuRequest | null>(null);
  const [markerMenu, setMarkerMenu] = useState<MarkerMenuRequest | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; x: number; y: number } | null>(null);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<{ time: number; x: number } | null>(null);
  const prevZoomRef = useRef(zoom);

  const overlays = useMemo(() => new Overlays(), []);
  const gestures = useMemo(
    () =>
      createGestures({
        getScroller: () => scrollerRef.current,
        overlays,
        openMenu: setMenu,
        openMarkerMenu: setMarkerMenu,
        renameMarker: (id, x, y) => setRenaming({ id, x, y }),
      }),
    [overlays],
  );
  const dnd = useMemo(() => createDnd({ getScroller: () => scrollerRef.current, overlays }), [overlays]);

  useEffect(
    () => () => {
      gestures.dispose();
      dnd.dispose();
    },
    [gestures, dnd],
  );

  const closeMenu = useCallback(() => setMenu(null), []);
  const closeTrackMenu = useCallback(() => setTrackMenu(null), []);
  const onLanesContextMenu = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      const el = e.target as HTMLElement;
      const onClip = el.closest('[data-clip-id], [data-transition-clip]');
      const trackId = el.closest<HTMLElement>('[data-track-id]')?.dataset.trackId;
      if (!onClip && trackId && !el.closest('input, button')) {
        e.preventDefault();
        setMenu(null);
        setMarkerMenu(null);
        setTrackMenu({ x: e.clientX, y: e.clientY, trackId });
        return;
      }
      gestures.onContextMenu(e);
    },
    [gestures],
  );
  const closeMarkerMenu = useCallback(() => setMarkerMenu(null), []);
  const closeRename = useCallback(() => setRenaming(null), []);
  const startRename = useCallback((id: string, x: number, y: number) => setRenaming({ id, x, y }), []);

  /* ---------- zoom ---------- */

  /** set the zoom. the optional anchor keeps `time` at viewport x `x` (applied in the layout effect). */
  const applyZoom = useCallback((next: number, time?: number, x?: number) => {
    const st = useEditor.getState();
    const z = clamp(next, MIN_ZOOM, MAX_ZOOM);
    if (z === st.zoom) return;
    anchorRef.current = time !== undefined && x !== undefined ? { time, x } : null;
    st.setZoom(z);
  }, []);

  /** toolbar zoom: keep the playhead where it is in the viewport (or the center when it is off screen) */
  const zoomKeepPlayhead = useCallback(
    (next: number) => {
      const t = usePlayback.getState().time;
      const px = t * useEditor.getState().zoom - view.scrollLeft;
      if (px >= 0 && px <= view.width) applyZoom(next, t, px);
      else applyZoom(next);
    },
    [applyZoom],
  );

  const fit = useCallback(() => {
    const project = useEditor.getState().project;
    const d = project ? projectDuration(project) : 0;
    applyZoom((view.width - 48) / Math.max(d, 1), 0, 0);
    const el = scrollerRef.current;
    if (el) el.scrollLeft = 0;
  }, [applyZoom]);

  /** zoom so the selected clips fill the view */
  const fitSelection = useCallback(() => {
    const st = useEditor.getState();
    const r = rangeOf(st.project?.clips.filter((c) => st.selection.includes(c.id)) ?? []);
    if (!r) return;
    const z = clamp(zoomForRange(r.start, r.end, view.width), MIN_ZOOM, MAX_ZOOM);
    if (z === st.zoom) {
      const el = scrollerRef.current;
      if (!el) return;
      el.scrollLeft = Math.max(0, r.start * z - FIT_PAD);
      view.scrollLeft = el.scrollLeft;
      notifyView();
      return;
    }
    applyZoom(z, r.start, FIT_PAD);
  }, [applyZoom]);

  // after the content width changed with the zoom, restore the anchor (default: viewport center)
  useLayoutEffect(() => {
    const prev = prevZoomRef.current;
    if (prev === zoom) return;
    prevZoomRef.current = zoom;
    const el = scrollerRef.current;
    if (!el) return;
    const anchor = anchorRef.current ?? { time: (view.scrollLeft + view.width / 2) / prev, x: view.width / 2 };
    anchorRef.current = null;
    el.scrollLeft = Math.max(0, anchor.time * zoom - anchor.x);
    view.scrollLeft = el.scrollLeft;
    notifyView();
  }, [zoom]);

  /* ---------- viewport size, wheel, shortcuts ---------- */

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    resetView();
    const measure = () => {
      view.width = Math.max(0, el.clientWidth - HEADER_W);
      view.height = el.clientHeight;
      setViewW(view.width);
      notifyView();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let pending: { factor: number; time: number; x: number } | null = null;
    let raf = 0;

    const flush = () => {
      raf = 0;
      const p = pending;
      pending = null;
      if (!p) return;
      applyZoom(useEditor.getState().zoom * p.factor, p.time, p.x);
    };

    const onWheel = (e: WheelEvent) => {
      markUserScroll();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const dy = wheelDelta(e, el, e.deltaY);
        const factor = Math.exp(-dy * (Math.abs(dy) < 30 ? 0.01 : 0.002));
        if (!pending) {
          // one measurement at the start of a wheel burst, not per event
          const r = el.getBoundingClientRect();
          const x = clamp(e.clientX - r.left - HEADER_W, 0, view.width);
          pending = { factor: 1, time: (view.scrollLeft + x) / useEditor.getState().zoom, x };
        }
        pending.factor *= factor;
        if (!raf) raf = requestAnimationFrame(flush);
      } else if (e.shiftKey) {
        e.preventDefault();
        el.scrollLeft += wheelDelta(e, el, e.deltaY || e.deltaX);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });

    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'z' || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      if (useUi.getState().dialog !== null || document.querySelector('.dialog-backdrop')) return;
      e.preventDefault();
      fit();
    };
    window.addEventListener('keydown', onKey);

    return () => {
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [applyZoom, fit]);

  const contentW = Math.max(viewW, Math.ceil(duration * zoom + Math.max(TAIL_MIN_PX, viewW * 0.25)));
  const rootVars = {
    '--tl-head-w': `${HEADER_W}px`,
    '--tl-ruler-h': `${RULER_H}px`,
    '--tl-zone-h': `${ZONE_H}px`,
  } as CSSProperties;
  const contentVars = { '--tl-w': `${contentW}px` } as CSSProperties;

  return (
    <div className="panel timeline" style={rootVars}>
      <TimelineToolbar onZoom={zoomKeepPlayhead} onFit={fit} onFitSelection={fitSelection} />
      <div className="timeline-body">
        <div
          ref={scrollerRef}
          className="timeline-scroller"
          onScroll={(e) => {
            const el = e.currentTarget;
            view.scrollLeft = el.scrollLeft;
            view.scrollTop = el.scrollTop;
            notifyView();
          }}
          onPointerDown={(e) => {
            // a press on the scroller itself is a scrollbar drag: do not auto-scroll under the user
            if (e.target === e.currentTarget) markUserScroll(4000);
          }}
        >
          <div
            className="timeline-content"
            style={contentVars}
            onDragEnter={dnd.onDragEnter}
            onDragOver={dnd.onDragOver}
            onDragLeave={dnd.onDragLeave}
            onDrop={dnd.onDrop}
          >
            <div className="timeline-ruler-row" onDoubleClick={gestures.onRulerDoubleClick} onContextMenu={gestures.onRulerContextMenu}>
              <div className="timeline-corner" />
              <Ruler onPointerDown={gestures.onRulerPointerDown} />
            </div>
            <div
              className="timeline-lanes-wrap"
              onPointerDown={gestures.onLanesPointerDown}
              onContextMenu={onLanesContextMenu}
            >
              <div className="timeline-zone">
                <div className="timeline-head timeline-head-fill" />
                <div ref={overlays.refZoneTop} className="timeline-lane-area timeline-zone-lane" title="drop here for a new video track" />
              </div>
              {tracks.map((t) => (
                <TrackRow key={t.id} track={t} zoom={zoom} />
              ))}
              <div className="timeline-zone">
                <div className="timeline-head timeline-head-fill" />
                <div
                  ref={overlays.refZoneBottom}
                  className="timeline-lane-area timeline-zone-lane"
                  title="drop here for a new audio track"
                />
              </div>
              <div className="timeline-filler">
                <div className="timeline-head timeline-head-fill" />
                <div className="timeline-lane-area timeline-filler-lane" />
              </div>
              <div className="timeline-overlay">
                <MarkerLines />
                <PlayheadLine scrollerRef={scrollerRef} />
                <div ref={overlays.refSnap} className="timeline-snap" hidden />
                <div ref={overlays.refGhost} className="timeline-ghost" hidden>
                  <span className="timeline-ghost-label" />
                </div>
                <div ref={overlays.refMarquee} className="timeline-marquee" hidden />
                <div ref={overlays.refReadout} className="timeline-readout" hidden />
              </div>
            </div>
          </div>
        </div>
        {!hasClips ? <div className="timeline-hint">drag media here to start</div> : null}
      </div>
      {markerMenu ? <MarkerMenu {...markerMenu} onClose={closeMarkerMenu} onRename={startRename} /> : null}
      {renaming ? <MarkerRename {...renaming} onDone={closeRename} /> : null}
      {trackMenu ? <TrackMenu {...trackMenu} onClose={closeTrackMenu} /> : null}
      {menu ? <ClipMenu x={menu.x} y={menu.y} clipId={menu.clipId} onClose={closeMenu} /> : null}
    </div>
  );
}
