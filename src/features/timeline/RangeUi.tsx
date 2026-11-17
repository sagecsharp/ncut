import { useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import { lastFrameIn } from '../../lib/inOut';
import { formatTimecode } from '../../lib/time';
import { useEditor } from '../../store/editorStore';
import { tip } from '../shell/tip';
import { clearInOut } from './rangeActions';
import { rangeDrag } from './rangeDrag';
import { liveRange } from './rangeRuler';
import './range.css';

/** the corner of the ruler row: the range as numbers, following a bracket drag, and a button that clears it */
export function RangeCorner() {
  const stored = useEditor((s) => s.project?.range);
  const fps = useEditor((s) => s.project?.fps ?? 30);
  const drag = useSyncExternalStore(rangeDrag.subscribe, rangeDrag.get);
  const r = liveRange(stored, drag);
  if (!r) return null;
  let text: string;
  if (r.in !== undefined && r.out !== undefined) text = `in to out ${formatTimecode(r.out - r.in, fps)}`;
  else if (r.in !== undefined) text = `in ${formatTimecode(r.in, fps)}`;
  else text = `out ${formatTimecode(lastFrameIn(r, fps) ?? 0, fps)}`;
  return (
    <div className="timeline-range-corner">
      <span className="timeline-range-corner-text">{text}</span>
      <button
        type="button"
        className="timeline-range-corner-clear"
        aria-label="clear in and out"
        {...tip('clear in and out', { does: 'take the in and out points away', keys: 'clear-in-out' })}
        onClick={() => clearInOut()}
      >
        <X size={12} />
      </button>
    </div>
  );
}

/** a hairline per set mark down through the lanes, and a shade between two marks. positioned with transforms */
export function RangeLines() {
  const stored = useEditor((s) => s.project?.range);
  const zoom = useEditor((s) => s.zoom);
  const drag = useSyncExternalStore(rangeDrag.subscribe, rangeDrag.get);
  const r = liveRange(stored, drag);
  if (!r) return null;
  const x = (t: number) => Math.round(t * zoom);
  const snapped = (which: 'in' | 'out') => (drag?.snapped && drag.which === which ? ' is-snapped' : '');
  return (
    <>
      {r.in !== undefined && r.out !== undefined && (
        <div className="timeline-range-shade" style={{ transform: `translate3d(${x(r.in)}px,0,0)`, width: `${x(r.out) - x(r.in)}px` }} />
      )}
      {r.in !== undefined && <div className={`timeline-range-line${snapped('in')}`} style={{ transform: `translate3d(${x(r.in)}px,0,0)` }} />}
      {r.out !== undefined && <div className={`timeline-range-line${snapped('out')}`} style={{ transform: `translate3d(${x(r.out)}px,0,0)` }} />}
    </>
  );
}
