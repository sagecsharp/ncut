import { memo, useMemo } from 'react';
import { RotateCcw, Shuffle } from 'lucide-react';
import { EFFECT_CATEGORIES } from '../../engine/effects/types';
import { EFFECTS, effectParamValue, getEffect } from '../../engine/effects/registry';
import { useEditor } from '../../store/editorStore';
import { isVisualClip } from '../../types';
import { ParentSelect } from './AttachSection';
import { AnimField } from './AnimField';
import { overlapsInTime } from './clipEffects';
import { effectTargetOptions } from './parentOptions';
import { Row, Section } from './controls';

const actions = () => useEditor.getState();

/** decimals needed to show a step (0.05 -> 2) */
function stepPrecision(step: number): number {
  if (!(step > 0) || step >= 1) return 0;
  return Math.min(4, Math.ceil(-Math.log10(step) - 1e-9));
}

interface EffectSectionProps {
  id: string;
  name: string;
  effect: string;
  params: Record<string, number>;
  /** the one clip this effect is put on (missing / null = everything below) */
  target?: string | null;
}

/** "applies to": everything below the effect's track, or one visual clip. a clip that is gone can be cleared. */
function AppliesTo({ id, target }: { id: string; target: string | null }) {
  const clips = useEditor((s) => s.project?.clips);
  const options = useMemo(() => (clips ? effectTargetOptions({ clips }, id) : []), [clips, id]);
  const self = clips?.find((c) => c.id === id);
  const picked = target ? clips?.find((c) => c.id === target) : undefined;
  const found = !!picked && isVisualClip(picked);
  const label = options.find((o) => o.id === target)?.label ?? '';
  const set = (next: string | null) => actions().updateClip(id, { target: next });
  return (
    <>
      <ParentSelect
        label="applies to"
        title="put this effect on one clip, or on everything below it"
        noneLabel="everything below"
        value={target ?? ''}
        options={options}
        onPick={set}
      />
      {target && found ? (
        <>
          <button
            type="button"
            className="btn btn-sm props-link"
            title="select this clip"
            onClick={() => actions().select([target])}
          >
            {label || picked.name || picked.type}
          </button>
          {self && !overlapsInTime(self, picked) ? (
            <div className="props-hint">this effect and its clip are never on screen together</div>
          ) : null}
        </>
      ) : null}
      {target && !found ? (
        <div className="props-buttons">
          <span className="props-hint">missing clip, the effect does nothing</span>
          <button type="button" className="btn btn-sm" title="go back to everything below" onClick={() => set(null)}>
            clear
          </button>
        </div>
      ) : null}
    </>
  );
}

/** back to defaults in one undo step: animated params lose their keys, then the static values reset */
function resetEffect(id: string): void {
  const st = actions();
  const clip = st.project?.clips.find((c) => c.id === id);
  if (!clip) return;
  st.pushHistory();
  for (const prop of Object.keys(clip.keyframes ?? {})) {
    if (prop === 'amount' || prop.startsWith('p.')) st.clearKeyframes(id, clip.start, prop, { skipHistory: true });
  }
  st.updateClip(id, { params: {}, amount: 1 }, { skipHistory: true });
}

export const EffectSection = memo(function EffectSection({ id, name, effect, params, target }: EffectSectionProps) {
  const def = getEffect(effect);

  if (!def) {
    return (
      <Section id="effect" title="effect">
        <div className="props-hint" title="this project uses an effect this version does not have">
          unknown effect
        </div>
      </Section>
    );
  }

  const switchTo = (nextId: string) => {
    const next = getEffect(nextId);
    if (!next || next.id === effect) return;
    actions().updateClip(id, name === def.name ? { effect: next.id, name: next.name } : { effect: next.id });
  };

  return (
    <Section id="effect" title="effect">
      <Row label="type" title="which effect this clip applies">
        <select className="select" title="effect" value={effect} onChange={(e) => switchTo(e.target.value)}>
          {EFFECT_CATEGORIES.map((cat) => {
            const list = EFFECTS.filter((x) => x.category === cat.id);
            if (list.length === 0) return null;
            return (
              <optgroup key={cat.id} label={cat.label}>
                {list.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
      </Row>
      <div className="props-hint">{def.description}</div>
      <AppliesTo id={id} target={target ?? null} />
      <AnimField
        slider
        id={id}
        prop="amount"
        label="amount"
        title="overall strength of the effect (%)"
        scale={100}
        min={0}
        max={100}
        step={1}
        precision={0}
        suffix="%"
        fallback={1}
      />
      {def.params.map((p) =>
        p.options ? (
          <Row key={p.key} label={p.label} title={p.label}>
            <select
              className="select"
              title={p.label}
              aria-label={p.label}
              value={String(Math.round(effectParamValue(def, params, p.key)))}
              onChange={(e) => actions().setEffectParam(id, p.key, Number(e.target.value))}
            >
              {p.options.map((o, i) => (
                <option key={o} value={i}>
                  {o}
                </option>
              ))}
            </select>
          </Row>
        ) : (
          <AnimField
            key={p.key}
            slider
            id={id}
            prop={`p.${p.key}`}
            label={p.label}
            title={p.label}
            min={p.min}
            max={p.max}
            step={p.step}
            precision={stepPrecision(p.step)}
            suffix={p.unit}
            fallback={p.default}
          />
        ),
      )}
      <div className="props-buttons">
        <button
          type="button"
          className="btn btn-sm"
          title="back to the default settings and full strength"
          onClick={() => resetEffect(id)}
        >
          <RotateCcw size={14} />
          reset
        </button>
        <button
          type="button"
          className="btn btn-sm"
          title="pick a new random pattern (changes the shake path, noise and other random parts)"
          onClick={() => actions().updateClip(id, { seed: Math.floor(Math.random() * 1000) })}
        >
          <Shuffle size={14} />
          reseed
        </button>
      </div>
    </Section>
  );
});
