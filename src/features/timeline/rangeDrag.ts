/**
 * the in / out mark being dragged on the ruler. a module value, not a store: a drag at pointer rate must not wake the
 * PreviewEngine or any store subscriber. the ruler, the lane lines and the corner subscribe to it directly.
 */
export interface RangeDrag {
  which: 'in' | 'out';
  /** timeline seconds, already snapped and clamped */
  time: number;
  /** the time sits on a snap point */
  snapped: boolean;
}

let current: RangeDrag | null = null;
const listeners = new Set<() => void>();

export const rangeDrag = {
  get(): RangeDrag | null {
    return current;
  },
  set(v: RangeDrag | null): void {
    if (v === current) return;
    current = v;
    for (const fn of listeners) fn();
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};
