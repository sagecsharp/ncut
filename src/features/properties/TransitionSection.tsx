import { memo } from 'react';
import { Equal } from 'lucide-react';
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
import { useUi } from '../../store/ui';
import { rememberTransition } from '../media/transitionApply';
import { planSameLength } from '../media/transitionBatch';
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
    else {
      actions().updateClip(id, { transition: { id: value, duration: transition?.duration ?? DEFAULT_TRANSITION_DURATION } });
      rememberTransition(value, transition?.duration);
    }
  };

  const sameLength = () => {
    const project = actions().project;
    if (!project || !transition) return;
    const patches = planSameLength(project, clip.trackId, id);
    if (patches.length === 0) {
      useUi.getState().toast('nothing to do: no other transition on this track needs changing');
      return;
    }
    actions().pushHistory();
    for (const p of patches) actions().updateClip(p.clipId, { transition: p.transition }, { skipHistory: true });
    const full = patches.filter((p) => p.transition && Math.abs(p.transition.duration - transition.duration) < 1e-6).length;
    const short = patches.length - full;
    const noun = (n: number) => `${n} transition${n === 1 ? '' : 's'}`;
    useUi
      .getState()
      .toast(
        short === 0
          ? `${noun(full)} set to ${transition.duration.toFixed(2)}s`
          : `${full} got ${transition.duration.toFixed(2)}s, ${short} kept shorter to fit their cut`,
      );
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
            onChange={(v) => {
              actions().updateClip(id, { transition: { id: transition.id, duration: v } }, liveOpts());
              rememberTransition(transition.id, v);
            }}
          />
        </Row>
      ) : null}
      {transition ? (
        <div className="props-buttons">
          <button
            type="button"
            className="btn btn-sm"
            title="copy this length to the other transitions of this track (each is kept inside what its cut allows)"
            onClick={sameLength}
          >
            <Equal size={14} />
            use this length on every cut of the track
          </button>
        </div>
      ) : null}
      <div className="props-hint">{prevName !== null ? `blends from "${prevName}" into this clip` : 'starts from empty'}</div>
    </Section>
  );
});
