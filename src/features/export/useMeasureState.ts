import { useEffect, useRef, useState } from 'react';
import type { Project } from '../../types';
import type { TimeRange } from './range';
import type { MixLoudness } from './loudnessTypes';
import { measuredFor, measuringFor, onMeasureChange } from './measureMix';

export interface MeasureState { result: MixLoudness | null; progress: number | null; stale: boolean }

const EMPTY: MeasureState = { result: null, progress: null, stale: false };
const SETTLE_MS = 300;

interface Args { project: Project | null; range: TimeRange | null; rate: number }

/**
 * what the measure of a project's sound knows: the exact result, or the last one marked stale, and how far a run is.
 * the signature is worked out 300 ms after the last change, never per frame of a drag.
 */
export function useMeasureState(project: Project | null, range: TimeRange | null, rate: number): MeasureState {
  const [args, setArgs] = useState<Args>({ project, range, rate });
  const first = useRef(true);
  const last = useRef<MixLoudness | null>(null);
  const [state, setState] = useState<MeasureState>(EMPTY);
  const start = range?.start;
  const end = range?.end;

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const id = setTimeout(() => setArgs({ project, range, rate }), SETTLE_MS);
    return () => clearTimeout(id);
    // the range object is new each render: its two times are what counts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, start, end, rate]);

  useEffect(() => {
    const { project: p, range: r, rate: sr } = args;
    if (!p || !r) {
      last.current = null;
      setState((prev) => (prev === EMPTY ? prev : EMPTY));
      return;
    }
    const sync = (): void => {
      const fresh = measuredFor(p, r, sr);
      if (fresh) last.current = fresh;
      const progress = measuringFor(p, r, sr);
      const result = fresh ?? last.current;
      const stale = !fresh && !!last.current;
      setState((prev) => (prev.result === result && prev.progress === progress && prev.stale === stale ? prev : { result, progress, stale }));
    };
    sync();
    return onMeasureChange(sync);
  }, [args]);

  return state;
}
