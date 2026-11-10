import { memo, useMemo, useState } from 'react';
import { Eye, EyeOff, Fan, Layers, LayoutGrid, Orbit, Square, Tornado, Columns3 } from 'lucide-react';
import { useEditor } from '../../store/editorStore';
import { isVisualClip } from '../../types';
import { ARRANGE_DEFAULTS, ARRANGE_SLIDERS, arrangeTargets } from './arrange3d';
import type { ArrangeKey, ArrangeKind } from './arrange3d';
import { arrangeSelection, flattenSelection, setLookAll } from './arrangeActions';
import { Row, SliderRow, Switch } from './controls';
import { liveOpts } from './edit';

const KINDS: { kind: ArrangeKind; icon: typeof Orbit; title: string }[] = [
  { kind: 'ring', icon: Orbit, title: 'ring: stand in a circle around the vertical axis' },
  { kind: 'row', icon: Columns3, title: 'row: side by side with equal gaps' },
  { kind: 'stack', icon: Layers, title: 'stack: one behind the other, like a deck of cards' },
  { kind: 'fan', icon: Fan, title: 'fan: spread like a hand of cards' },
  { kind: 'grid', icon: LayoutGrid, title: 'grid: rows and columns' },
  { kind: 'spiral', icon: Tornado, title: 'spiral: a ring that climbs and moves away' },
];

/**
 * "arrange in 3d" for 2 or more visual clips: layout buttons + the slider of the last layout, face the
 * camera / stop facing, and back to 2d. clips attached to a parent or on a locked track are left out.
 */
export const ArrangeSection = memo(function ArrangeSection({ ids }: { ids: string[] }) {
  const clips = useEditor((s) => s.project?.clips);
  const tracks = useEditor((s) => s.project?.tracks);
  const [kind, setKind] = useState<ArrangeKind | null>(null);
  const [vals, setVals] = useState<Record<ArrangeKey, number>>({ ...ARRANGE_DEFAULTS });
  const [outward, setOutward] = useState(true);

  const { usable, visual, threeD } = useMemo(() => {
    if (!clips || !tracks) return { usable: 0, visual: 0, threeD: 0 };
    const t = arrangeTargets({ clips, tracks }, ids);
    return {
      usable: t.clips.length,
      visual: t.clips.length + t.skipped,
      threeD: clips.filter((c) => ids.includes(c.id) && isVisualClip(c) && c.threeD).length,
    };
  }, [clips, tracks, ids]);

  const off = usable < 2;
  const slider = kind ? ARRANGE_SLIDERS[kind] : null;
  const roundish = kind === 'ring' || kind === 'spiral';

  const choose = (k: ArrangeKind) => {
    setKind(k);
    arrangeSelection(ids, k, { ...vals, outward }, true);
  };
  const setVal = (v: number) => {
    if (!kind || !slider) return;
    const next = { ...vals, [slider.key]: v };
    setVals(next);
    liveOpts(); // pushes the one undo step of this drag
    arrangeSelection(ids, kind, { ...next, outward }, false);
  };
  const setFacing = (on: boolean) => {
    setOutward(on);
    if (kind) arrangeSelection(ids, kind, { ...vals, outward: on }, true);
  };

  return (
    <>
      <Row label="layout" title="arrange the selected clips in 3d space">
        <div className="props-seg">
          {KINDS.map(({ kind: k, icon: Icon, title }) => (
            <button
              key={k}
              type="button"
              className={`icon-btn${kind === k ? ' is-active' : ''}`}
              title={title}
              aria-label={title}
              aria-pressed={kind === k}
              disabled={off}
              onClick={() => choose(k)}
            >
              <Icon size={14} />
            </button>
          ))}
        </div>
      </Row>
      {slider && kind ? (
        <SliderRow
          label={slider.label}
          title={`${slider.label} of the ${kind}`}
          value={vals[slider.key]}
          min={slider.min}
          max={slider.max}
          step={slider.step}
          suffix={slider.suffix}
          disabled={off}
          onChange={setVal}
        />
      ) : null}
      {roundish ? (
        <Row label="outward" title="clips face away from the middle (on) or toward it (off)">
          <Switch checked={outward} title="clips face outward or inward" onChange={setFacing} />
        </Row>
      ) : null}
      <div className="props-buttons">
        <button type="button" className="btn btn-sm" title="3d clips always turn to face the camera" disabled={threeD === 0} onClick={() => setLookAll(ids, 'camera')}>
          <Eye size={14} />
          face the camera
        </button>
        <button type="button" className="btn btn-sm" title="3d clips stop turning toward the camera" disabled={threeD === 0} onClick={() => setLookAll(ids, 'none')}>
          <EyeOff size={14} />
          stop facing
        </button>
        <button type="button" className="btn btn-sm" title="back to flat 2d: z, tilt and turn go to 0" disabled={threeD === 0} onClick={() => flattenSelection(ids)}>
          <Square size={14} />
          back to 2d
        </button>
      </div>
      {usable < visual || off ? <div className="props-hint">clips attached to another clip and clips on locked tracks are left out</div> : null}
    </>
  );
});
