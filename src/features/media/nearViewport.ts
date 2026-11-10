/** how far outside the list a card still counts as near (px): its still is ready before it scrolls into view */
export const NEAR_MARGIN_PX = 150;

/**
 * tell `onChange` when `el` gets near the visible part of its scroll area (true) or leaves it (false). the area is
 * the closest .media-scroll (so the margin really is around the list), the viewport when there is none. without
 * IntersectionObserver the element counts as near at once. returns the stop function.
 */
export function observeNear(el: Element | null, onChange: (near: boolean) => void): () => void {
  if (!el) {
    onChange(true);
    return () => {};
  }
  if (typeof IntersectionObserver === 'undefined') {
    onChange(true);
    return () => {};
  }
  const io = new IntersectionObserver(
    (entries) => {
      // entries come in order: the last one is the current state
      const last = entries[entries.length - 1];
      if (last) onChange(last.isIntersecting);
    },
    { root: el.closest('.media-scroll'), rootMargin: `${NEAR_MARGIN_PX}px` },
  );
  io.observe(el);
  return () => io.disconnect();
}
