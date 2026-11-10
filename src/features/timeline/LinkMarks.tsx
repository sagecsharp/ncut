import { useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { useEditor } from '../../store/editorStore';
import { hoverLinkedIds, linkedIds } from './effectTarget';
import { subscribeClipMount } from './view';

/**
 * quiet marks between an effect clip and the clip it is put on: the selected effect's target gets a
 * dashed outline, a selected clip marks the effects on it, and hovering an effect marks its target.
 * done with classes straight on the clip elements (the clips are memoized and must not re-render for
 * this). renders nothing. a clip that is not linked costs nothing.
 */
export function LinkMarks({ scrollerRef }: { scrollerRef: RefObject<HTMLElement | null> }) {
  const clips = useEditor((s) => s.project?.clips);
  const selection = useEditor((s) => s.selection);
  const hover = useRef<string | null>(null);
  const marked = useRef<HTMLElement[]>([]);
  const apply = useRef<() => void>(() => undefined);

  apply.current = () => {
    const root = scrollerRef.current;
    for (const el of marked.current) el.classList.remove('is-linked', 'is-linked-hover');
    marked.current = [];
    if (!root || !clips) return;
    const picked = linkedIds(clips, selection);
    const hovered = hoverLinkedIds(clips, hover.current);
    if (picked.size === 0 && hovered.size === 0) return;
    for (const el of root.querySelectorAll<HTMLElement>('[data-clip-id]')) {
      const id = el.dataset.clipId!;
      if (picked.has(id)) el.classList.add('is-linked');
      if (hovered.has(id)) el.classList.add('is-linked-hover');
      else if (!picked.has(id)) continue;
      marked.current.push(el);
    }
  };

  // after every commit: React may have rewritten a clip's className, so the marks are put on again
  useLayoutEffect(() => {
    apply.current();
  });

  // a lane mounts clips when its window moves (scroll / zoom): put the marks on those too, once per tick
  useEffect(() => {
    let queued = false;
    const unsub = subscribeClipMount(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        apply.current();
      });
    });
    return unsub;
  }, []);

  useEffect(() => {
    const root = scrollerRef.current;
    if (!root) return;
    const onOver = (e: PointerEvent) => {
      const id = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-clip-id]')?.dataset.clipId ?? null;
      if (id === hover.current) return;
      hover.current = id;
      apply.current();
    };
    const onLeave = () => {
      if (hover.current === null) return;
      hover.current = null;
      apply.current();
    };
    root.addEventListener('pointerover', onOver, { passive: true });
    root.addEventListener('pointerleave', onLeave, { passive: true });
    return () => {
      root.removeEventListener('pointerover', onOver);
      root.removeEventListener('pointerleave', onLeave);
      for (const el of marked.current) el.classList.remove('is-linked', 'is-linked-hover');
      marked.current = [];
    };
  }, [scrollerRef]);

  return null;
}
