import { memo } from 'react';
import { NumberField } from '../../components/ui/NumberField';
import {
  DEFAULT_TRANSITION_DURATION,
  MAX_TRANSITION_DURATION,
  MIN_TRANSITION_DURATION,
  TRANSITIONS,
  TRANSITION_CATEGORIES,
  getTransition,
} from '../../engine/transitions/registry';
import { previousClipOnTrack } from '../../lib/transitions';
import { useEditor } from '../../store/editorStore';
import type { Clip, Transition } from '../../types';
import { Row, Section } from './controls';
import { beginEdit, liveOpts } from './edit';

const actions = () => useEditor.getState();

interface Props {
  clip: Clip;
  transition: Transition | null | undefined;
}

export const TransitionSection = memo(function TransitionSection({ clip, transition }: Props) {
  const id = clip.id;
  // a string (or null), so this only re-renders when the neighbour changes
  const prevName = useEditor((s) => {
    if (!s.project) return null;
    const prev = previousClipOnTrack(s.project, clip);
    return prev ? prev.name || prev.type : null;
  });
  const known = transition ? getTransition(transition.id) : undefined;

  const pick = (value: string) => {
    if (value === '') actions().updateClip(id, { transition: null });
    else actions().updateClip(id, { transition: { id: value, duration: transition?.duration ?? DEFAULT_TRANSITION_DURATION } });
  };

  return (
    <Section id="transition" title="transition">
      <Row label="type" title="how this clip blends in from the one before it">
        <select className="select" title="transition" aria-label="transition" value={transition?.id ?? ''} onChange={(e) => pick(e.target.value)}>
          <option value="">none</option>
          {transition && !known ? <option value={transition.id}>{transition.id}</option> : null}
          {TRANSITION_CATEGORIES.map((cat) => {
            const list = TRANSITIONS.filter((t) => t.category === cat.id);
            if (list.length === 0) return null;
            return (
              <optgroup key={cat.id} label={cat.label}>
                {list.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
      </Row>
      {transition ? (
        <Row label="duration" title="how long the transition takes (seconds)">
          <NumberField
            className="props-grow"
            suffix="s"
            title="transition duration (seconds)"
            value={transition.duration}
            min={MIN_TRANSITION_DURATION}
            max={MAX_TRANSITION_DURATION}
            step={0.1}
            precision={2}
            onStart={beginEdit}
            onChange={(v) => actions().updateClip(id, { transition: { id: transition.id, duration: v } }, liveOpts())}
          />
        </Row>
      ) : null}
      <div className="props-hint">{prevName !== null ? `blends from "${prevName}" into this clip` : 'starts from empty'}</div>
    </Section>
  );
});
