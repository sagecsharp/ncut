import { memo, useState } from 'react';
import type { ReactNode } from 'react';
import { Copy } from 'lucide-react';
import { useClip } from '../../store/editorStore';
import { isVisualClip } from '../../types';
import { FeelField, Row, Section } from './controls';
import type { FeelKey } from './fieldFeel';
import { DEFAULT_REPEAT, MAX_REPEAT, repeatPresets } from './repeat';
import type { RepeatOptions } from './repeat';
import { repeatClip } from './repeatActions';
import './repeat.css';

/** the steps stay while the app is open, so the next clip starts with the same ones */
let remembered: RepeatOptions = { ...DEFAULT_REPEAT };

type Num = (key: keyof RepeatOptions, label: string, title: string, feel: FeelKey, pct?: boolean) => ReactNode;

/**
 * "repeat": one clip becomes a row of copies, each one step further than the one before. the fields
 * are remembered for the session. the copies are made on a click of "make copies" (one undo step).
 */
export const RepeatSection = memo(function RepeatSection({ id }: { id: string }) {
  const clip = useClip(id);
  const [vals, setVals] = useState<RepeatOptions>(remembered);
  if (!clip || !isVisualClip(clip)) return null;
  const is3d = !!clip.threeD;

  const set = (patch: Partial<RepeatOptions>) => {
    remembered = { ...remembered, ...patch };
    setVals(remembered);
  };
  const preset = (values: Partial<RepeatOptions>) => {
    remembered = { ...DEFAULT_REPEAT, ...values };
    setVals(remembered);
  };

  const field: Num = (key, label, title, feel, pct) => {
    const k = pct ? 100 : 1;
    return (
      <Row label={label} title={title}>
        <FeelField local feel={feel} title={title} value={vals[key] * k} onChange={(v) => set({ [key]: v / k })} />
      </Row>
    );
  };

  return (
    <Section id="repeat" title="repeat" defaultOpen={false}>
      <div className="repeat-chips">
        {repeatPresets.map((p) => {
          const off = p.needs3d && !is3d;
          return (
            <button
              key={p.id}
              type="button"
              className="btn btn-sm"
              title={off ? `${p.label}: only for a 3d clip` : p.title}
              aria-label={off ? `${p.label}: only for a 3d clip` : p.title}
              disabled={off}
              onClick={() => preset(p.values)}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      {field('count', 'copies', `how many clips in all, this one included (2 to ${MAX_REPEAT})`, 'repeatCount')}
      {field('dx', 'step x', 'how far each copy is further to the right (px, negative = left)', 'repeatDx')}
      {field('dy', 'step y', 'how far each copy is further down (px, negative = up)', 'repeatDy')}
      {is3d ? field('dz', 'step z', 'how far each copy is further away from the viewer (px, negative = closer)', 'repeatDz') : null}
      {is3d ? (
        <>
          {field('rotX', 'tilt', 'how much more each copy is tilted (degrees)', 'repeatTurn')}
          {field('rotY', 'turn', 'how much more each copy is turned sideways (degrees)', 'repeatTurn')}
          {field('rotZ', 'rotation', 'how much more each copy is rolled (degrees)', 'repeatTurn')}
        </>
      ) : (
        field('rotation', 'rotation', 'how much more each copy is turned (degrees)', 'repeatTurn')
      )}
      {field('scale', 'scale', 'size of each copy compared to the one before (100 = same, 90 = a bit smaller each time)', 'repeatScale', true)}
      {field('opacity', 'opacity', 'visibility of each copy compared to the one before (100 = same, 70 = fainter each time)', 'repeatOpacity', true)}
      {field('delay', 'delay', 'how much later each copy starts than the one before (seconds). gives an echo or a stagger.', 'repeatDelay')}
      <button
        type="button"
        className="btn btn-primary repeat-go"
        title="make the copies under this clip and group them with it. one undo step."
        onClick={() => repeatClip(id, vals)}
      >
        <Copy size={14} />
        <span>make copies</span>
      </button>
    </Section>
  );
});
