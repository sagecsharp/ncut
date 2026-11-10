import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { interaction, notifyView, view } from './view';

/**
 * keeps an element at the playhead x with a transform, driven by store subscriptions (no react
 * state, no re-render per frame).
 */
function usePlayheadTransform(ref: RefObject<HTMLElement | null>, offset: number, onTime?: (x: number, playing: boolean) => void) {
  const onTimeRef = useRef(onTime);
  onTimeRef.current = onTime;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let lastX = NaN;
    const place = (): number => {
      const exact = usePlayback.getState().time * useEditor.getState().zoom;
      const x = Math.round(exact);
      if (x !== lastX) {
        lastX = x;
        el.style.transform = `translate3d(${x + offset}px,0,0)`;
      }
      return exact;
    };
    place();
    const unsubTime = usePlayback.subscribe((s, p) => {
      if (s.time === p.time) return;
      const exact = place();
      onTimeRef.current?.(exact, s.playing);
    });
    const unsubZoom = useEditor.subscribe((s, p) => {
      if (s.zoom !== p.zoom) place();
    });
    return () => {
      unsubTime();
      unsubZoom();
    };
  }, [ref, offset]);
}

/** the 1px vertical line over the lanes */
export function PlayheadLine({ scrollerRef }: { scrollerRef: RefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLDivElement>(null);
  usePlayheadTransform(ref, 0, (x, playing) => {
    // keep the playhead in view, but never fight the user (wheel / scrollbar) or a drag
    if (interaction.gestureActive || performance.now() < interaction.userScrollUntil) return;
    const left = view.scrollLeft;
    if (x >= left && x <= left + view.width - 6) return;
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, playing ? x - 40 : x - view.width / 2);
    view.scrollLeft = el.scrollLeft;
    notifyView();
  });
  return <div ref={ref} className="timeline-playhead" />;
}

/** the flat handle (and the line piece) inside the ruler */
export function PlayheadHandle() {
  const ref = useRef<HTMLDivElement>(null);
  usePlayheadTransform(ref, -5);
  return (
    <div ref={ref} className="timeline-playhead-handle">
      <div className="timeline-playhead-cap" />
      <div className="timeline-playhead-stem" />
    </div>
  );
}
