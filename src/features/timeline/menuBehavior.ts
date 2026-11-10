import { useEffect, useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';

/**
 * shared behaviour of the small floating menus: keep inside the window, close on outside press,
 * escape, scroll, wheel, resize and blur. returns the clamped position.
 */
export function useFloatingMenu(ref: RefObject<HTMLElement | null>, x: number, y: number, onClose: () => void) {
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
  }, [ref, x, y]);

  useEffect(() => {
    const onDown = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('wheel', onClose, { capture: true, passive: true });
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('wheel', onClose, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [ref, onClose]);

  return pos;
}
