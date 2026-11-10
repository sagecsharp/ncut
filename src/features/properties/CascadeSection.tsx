import { memo, useState } from 'react';
import { ArrowLeftToLine, ArrowRightToLine, ListEnd, Rows3 } from 'lucide-react';
import { NumberField } from '../../components/ui/NumberField';
import { CASCADE_ORDERS, FLY_KINDS } from './cascade';
import type { CascadeOrder, FlyKind, StaggerMode } from './cascade';
import { flySelection, staggerSelection } from './cascadeActions';
import { Row, SelectRow, SliderRow } from './controls';
import './cascade.css';

interface Remembered {
  order: CascadeOrder;
  step: number;
  mode: StaggerMode;
  kind: FlyKind;
  strength: number;
  length: number;
}

/** the values stay while the app is open, like the repeat section */
let remembered: Remembered = { order: 'layer', step: 2, mode: 'move', kind: 'scatter', strength: 60, length: 0.5 };

/**
 * "cascade": for a selection of many small clips (what splitting a text into letters or repeating a clip
 * leaves behind). stagger = they start one after the other, fly = each one flies in or out. one undo
 * step per click. the fields are remembered for the session.
 */
export const CascadeSection = memo(function CascadeSection({ hasVisual }: { hasVisual: boolean }) {
  const [vals, setVals] = useState<Remembered>(remembered);
  const set = (patch: Partial<Remembered>) => {
    remembered = { ...remembered, ...patch };
    setVals(remembered);
  };
  const keepEnd = vals.mode === 'trim';

  return (
    <>
      <SelectRow
        label="order"
        title="the order the clips come in"
        value={vals.order}
        options={CASCADE_ORDERS.map((o) => [o.id, o.label])}
        onChange={(v) => set({ order: v as CascadeOrder })}
      />
      <Row label="step" title="frames between two clips (0 to 120). 0 = all start together.">
        <NumberField
          className="props-num cascade-num"
          title="frames between the start of one clip and the next (0 to 120)"
          value={vals.step}
          min={0}
          max={120}
          step={1}
          precision={0}
          suffix="fr"
          onChange={(v) => set({ step: Math.round(v) })}
        />
      </Row>
      <Row label="clips" title={keepEnd ? 'keep end: a clip starts later and gets shorter, it ends where it did' : 'keep length: a clip moves later and keeps its length'}>
        <button
          type="button"
          className="btn btn-sm"
          aria-pressed={keepEnd}
          title={keepEnd ? 'keep end: a clip starts later and gets shorter, it ends where it did. click for keep length.' : 'keep length: a clip moves later and keeps its length. click for keep end.'}
          onClick={() => set({ mode: keepEnd ? 'move' : 'trim' })}
        >
          {keepEnd ? <ArrowRightToLine size={14} /> : <ArrowLeftToLine size={14} />}
          {keepEnd ? 'keep end' : 'keep length'}
        </button>
      </Row>
      <div className="cascade-pair">
        <button
          type="button"
          className="btn btn-sm"
          title="the clips start one after the other, one step apart. one undo step."
          onClick={() => staggerSelection(vals.order, vals.step, vals.mode)}
        >
          <ListEnd size={14} />
          <span>stagger</span>
        </button>
        <button
          type="button"
          className="btn btn-sm"
          title="all clips start together, at the earliest start"
          onClick={() => staggerSelection(vals.order, 0, vals.mode)}
        >
          <Rows3 size={14} />
          <span>line up</span>
        </button>
      </div>
      {hasVisual ? (
        <>
          <SelectRow
            label="fly"
            title="how each clip flies in or out"
            value={vals.kind}
            options={FLY_KINDS.map((k) => [k.id, k.label])}
            onChange={(v) => set({ kind: v as FlyKind })}
          />
          <SliderRow label="strength" title="how far each clip flies (%)" value={vals.strength} min={0} max={100} suffix="%" onChange={(v) => set({ strength: v })} />
          <Row label="length" title="how long the fly lasts (seconds, never longer than the clip)">
            <NumberField
              className="props-num cascade-num"
              title="how long the fly lasts (seconds)"
              value={vals.length}
              min={0.05}
              max={10}
              step={0.1}
              precision={2}
              suffix="s"
              onChange={(v) => set({ length: v })}
            />
          </Row>
          <div className="cascade-pair">
            <button
              type="button"
              className="btn btn-sm"
              title="every selected clip flies in at its start. one undo step."
              onClick={() => flySelection(vals.kind, 'in', vals.strength / 100, vals.length)}
            >
              <span>fly in</span>
            </button>
            <button
              type="button"
              className="btn btn-sm"
              title="every selected clip flies out at its end. one undo step."
              onClick={() => flySelection(vals.kind, 'out', vals.strength / 100, vals.length)}
            >
              <span>fly out</span>
            </button>
          </div>
        </>
      ) : null}
    </>
  );
});
