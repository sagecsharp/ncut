import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Crossfade } from '../../types';
import { SHAPE_NAME } from '../../lib/audioCross';
import type { CrossfadeSpan } from '../../lib/audioCross';
import { sameCrossfade } from '../../lib/audioCross';
import { useEditor } from '../../store/editorStore';
import { useTimeDisplay } from '../../store/timeDisplay';
import { useUi } from '../../store/ui';
import { useCrossfadeMenu, pickCrossfade } from './crossfadeActions';
import { boxGeo, boxRows, shapePoints } from './crossfadeGeometry';
import { dragCrossfade } from './crossfadePlan';
import type { CrossStop } from './crossfadePlan';
import { CROSS_TEXT, crossLengthText, crossShortText } from './crossfadeText';
import { CrossfadeMenu } from './CrossfadeMenu';
import { interaction } from './view';

interface Props {
  span: CrossfadeSpan;
  zoom: number;
  laneH: number;
  locked: boolean;
  picked: boolean;
}

/** a press moves the middle only after this many px, so a click stays a click */
const BODY_SLOP = 3;
/** the ends and the middle catch the places that matter within this many px */
const SNAP_PX = 6;

interface Drag {
  pointerId: number;
  x0: number;
  grab: 'before' | 'after' | 'body';
  start: Crossfade;
  moved: boolean;
  wrote: boolean;
  /** escape ends it: the rest of the press does nothing */
  dead: boolean;
  stop: (() => void) | null;
}

/** what plays as a Crossfade: the start of a drag */
const playedOf = (s: CrossfadeSpan): Crossfade => (s.shape === 'power' ? { before: s.before, after: s.after } : { before: s.before, after: s.after, shape: s.shape });

/**
 * one crossfade in the lane. it lives next to the clips (not inside one) because it straddles the edit.
 * the ends change its length, the middle slides it across the edit. the box handles its own pointer events.
 */
export const CrossfadeBox = memo(function CrossfadeBox({ span, zoom, laneH, locked, picked }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [readout, setReadout] = useState<string | null>(null);
  const fps = useEditor((s) => s.project?.fps || 30);
  const names = useEditor((s) => {
    const a = s.project?.clips.find((c) => c.id === span.fromId);
    const b = s.project?.clips.find((c) => c.id === span.toId);
    return `${a ? a.name || a.type : ''}\u0000${b ? b.name || b.type : ''}`;
  });
  const mode = useTimeDisplay((s) => s.mode);
  const menuOpen = useCrossfadeMenu((s) => s.menu?.clipId === span.toId);
  const rows = boxRows(laneH);
  const geo = boxGeo(span, zoom, laneH);
  const points = useMemo(() => shapePoints(span.shape, geo.width, rows.h, span.end > span.start ? (span.edit - span.start) / (span.end - span.start) : 0.5), [span.shape, geo.width, rows.h, span.edit, span.start, span.end]);
  const [fromName = '', toName = ''] = names.split('\u0000');

  const text = (sec: number): string => crossLengthText(sec, fps, mode);
  let title: string;
  if (geo.notch) title = `crossfade: nothing fits. ${CROSS_TEXT.crossNoMedia}`;
  else {
    title = `crossfade: ${text(span.before)} before and ${text(span.after)} after the edit, ${SHAPE_NAME[span.shape]}. drag an end to change it, the middle to move it across the edit. right click: shape and place`;
    if (span.shortBefore || span.shortAfter) {
      const why = [span.shortBefore ? crossShortText('before', span.shortBefore, fromName, toName) : '', span.shortAfter ? crossShortText('after', span.shortAfter, fromName, toName) : ''].filter(Boolean).join(', ');
      title += ` only ${text(span.before + span.after)} of ${text(span.wantBefore + span.wantAfter)} fits: ${why}`;
    }
    if (!geo.grips) title += ' zoom in to drag it';
  }

  // nothing keeps a drag alive when the box goes away
  useEffect(
    () => () => {
      const d = drag.current;
      if (d) {
        d.stop?.();
        interaction.gestureActive = false;
        drag.current = null;
      }
    },
    [],
  );

  const stopText = (b: number, a: number, stop: CrossStop | null): string =>
    `${text(b)} before, ${text(a)} after${stop ? `: ${crossShortText(stop.side, stop.why, fromName, toName)}` : ''}`;

  const end = (cancel: boolean): void => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    d.stop?.();
    interaction.gestureActive = false;
    setReadout(null);
    const el = ref.current;
    if (el && el.hasPointerCapture(d.pointerId)) el.releasePointerCapture(d.pointerId);
    if (cancel && d.wrote) useEditor.getState().rollback();
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.stopPropagation();
    if (e.button !== 0 || locked || drag.current) return;
    pickCrossfade(span.toId);
    if (!geo.grips) return;
    const grip = (e.target as HTMLElement).closest<HTMLElement>('[data-crossfade-grip]')?.dataset.crossfadeGrip;
    const el = ref.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const d: Drag = { pointerId: e.pointerId, x0: e.clientX, grab: grip === 'before' || grip === 'after' ? grip : 'body', start: playedOf(span), moved: false, wrote: false, dead: false, stop: null };
    // escape takes the drag back
    const onKey = (k: KeyboardEvent): void => {
      if (k.key !== 'Escape') return;
      k.preventDefault();
      k.stopPropagation();
      d.dead = true;
      end(true);
    };
    document.addEventListener('keydown', onKey, true);
    d.stop = () => document.removeEventListener('keydown', onKey, true);
    drag.current = d;
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.dead || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.x0;
    if (!d.moved && Math.abs(dx) < BODY_SLOP) return;
    d.moved = true;
    interaction.gestureActive = true;
    const st = useEditor.getState();
    const p = st.project;
    if (!p) return;
    const r = dragCrossfade(p, span.toId, d.grab, d.start, dx / zoom, e.altKey, SNAP_PX / zoom);
    const clip = p.clips.find((c) => c.id === span.toId);
    const cur = clip && (clip.type === 'video' || clip.type === 'audio') ? clip.crossfade : null;
    // nothing is written until a frame really moves: a click with jitter keeps the stored value and its link
    const base = dragCrossfade(p, span.toId, d.grab, d.start, 0, e.altKey, 0).value;
    if (!sameCrossfade(cur, r.value) && (d.wrote || !sameCrossfade(base, r.value))) {
      if (!d.wrote) {
        st.pushHistory();
        d.wrote = true;
      }
      st.updateClip(span.toId, { crossfade: r.value }, { skipHistory: true });
    }
    setReadout(stopText(r.value.before, r.value.after, r.stop));
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    end(false);
  };

  const onLost = (): void => {
    // a release also ends the capture: by then the drag is done
    if (drag.current) end(true);
  };

  return (
    <div
      ref={ref}
      className={`timeline-crossfade${picked ? ' is-picked' : ''}${geo.notch ? ' is-notch' : ''}${locked ? ' is-locked' : ''}${geo.grips && !locked ? ' is-movable' : ''}`}
      data-crossfade={span.toId}
      aria-label="crossfade at the edit"
      title={title}
      style={{ transform: `translate3d(${geo.x}px,${rows.top}px,0)`, width: geo.width, height: rows.h }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => end(true)}
      onLostPointerCapture={onLost}
      onDoubleClick={(e) => {
        e.stopPropagation();
        useUi.getState().revealSection('crossfade');
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        pickCrossfade(span.toId);
        useCrossfadeMenu.getState().open({ clipId: span.toId, at: { x: e.clientX, y: e.clientY }, focusFirst: false });
      }}
    >
      {geo.ghosts.map((g, i) => (
        <div key={i} className="timeline-crossfade-ghost" style={{ left: g.x - geo.x, width: g.width }} />
      ))}
      {geo.notch ? null : (
        <svg className="timeline-crossfade-shape" width={geo.width} height={rows.h} viewBox={`0 0 ${geo.width} ${rows.h}`} aria-hidden="true">
          <polyline className="timeline-crossfade-out" points={points.out} fill="none" />
          <polyline className="timeline-crossfade-in" points={points.in} fill="none" />
        </svg>
      )}
      <div className="timeline-crossfade-edit" style={{ left: geo.editX - geo.x }} />
      {geo.grips ? (
        <>
          <div className="timeline-crossfade-grip is-before" data-crossfade-grip="before" />
          <div className="timeline-crossfade-grip is-after" data-crossfade-grip="after" />
        </>
      ) : null}
      {readout !== null ? <div className="timeline-crossfade-readout">{readout}</div> : null}
      {menuOpen ? <CrossfadeMenu clipId={span.toId} anchor={ref.current} /> : null}
    </div>
  );
});
