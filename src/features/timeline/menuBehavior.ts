import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/** the items of a menu: menuitem, menuitemcheckbox, menuitemradio */
const MENU_ITEMS = '[role^="menuitem"]';

/**
 * the item a key moves the focus to: arrows wrap and skip disabled items, home / end go to the first / last enabled.
 * -1: nothing to do
 */
export function menuStep(enabled: readonly boolean[], index: number, key: string): number {
  const n = enabled.length;
  if (!enabled.some(Boolean)) return -1;
  if (key === 'Home') return enabled.indexOf(true);
  if (key === 'End') return enabled.lastIndexOf(true);
  if (key === 'ArrowDown') {
    for (let k = 1; k <= n; k++) {
      const i = index < 0 ? k - 1 : (index + k) % n;
      if (enabled[i]) return i;
    }
  }
  if (key === 'ArrowUp') {
    for (let k = 1; k <= n; k++) {
      const i = index < 0 ? n - k : (((index - k) % n) + n) % n;
      if (enabled[i]) return i;
    }
  }
  return -1;
}

/**
 * shared behaviour of the small floating menus: keep inside the window, close on outside press,
 * escape, scroll, wheel, resize and blur, arrows / home / end move the focus, tab closes.
 * returns the clamped position.
 */
export function useFloatingMenu(
  ref: RefObject<HTMLElement | null>,
  x: number,
  y: number,
  onClose: () => void,
  opts?: { focusFirst?: boolean },
) {
  const [pos, setPos] = useState({ x, y });
  const opener = useRef<HTMLElement | null>(null);
  const focusFirst = !!opts?.focusFirst;

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
        return;
      }
      const menu = ref.current;
      if (!menu || !(document.activeElement instanceof Node) || !menu.contains(document.activeElement)) return;
      if (e.key === 'Tab') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        const items = Array.from(menu.querySelectorAll<HTMLButtonElement>(MENU_ITEMS));
        const i = menuStep(
          items.map((b) => !b.disabled),
          items.indexOf(document.activeElement as HTMLButtonElement),
          e.key,
        );
        if (i >= 0) items[i]!.focus();
      }
    };
    // a focused item that scrolls a long menu must not close it
    const onScroll = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('wheel', onClose, { capture: true, passive: true });
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('wheel', onClose, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [ref, onClose]);

  // a passive effect, so it runs after a closing palette has given its focus back
  useEffect(() => {
    if (!focusFirst) return;
    const menu = ref.current;
    if (!menu) return;
    const active = document.activeElement;
    // the first opener stays: the strict mode double run must not replace it with the menu item
    if (!opener.current && active instanceof HTMLElement && !menu.contains(active)) opener.current = active;
    const first = Array.from(menu.querySelectorAll<HTMLButtonElement>(MENU_ITEMS)).find((b) => !b.disabled);
    first?.focus();
    return () => {
      const back = opener.current;
      const now = document.activeElement;
      if (back && back.isConnected && (!now || now === document.body)) back.focus();
    };
  }, [ref, focusFirst]);

  return pos;
}
