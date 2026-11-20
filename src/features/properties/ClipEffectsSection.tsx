import { memo, useMemo } from 'react';
import { Trash2 } from 'lucide-react';
import { EFFECT_CATEGORIES } from '../../engine/effects/types';
import { EFFECTS } from '../../engine/effects/registry';
import { useEditor } from '../../store/editorStore';
import type { VisualClip } from '../../types';
import { AnimField } from './AnimField';
import { effectsOnClip } from './clipEffects';
import { addEffectToClips } from './clipEffectActions';
import { Row, Section, useSelectOpen } from './controls';

const actions = () => useEditor.getState();

/** the "add effect" select: it always shows "choose...", so the list of effects is only rendered while it is open */
export function AddEffect({ clipIds, title = 'add an effect to this clip' }: { clipIds: readonly string[]; title?: string }) {
  const { open, handlers } = useSelectOpen();
  return (
    <select
      className="select"
      title={title}
      aria-label={title}
      value=""
      onChange={(ev) => {
        if (ev.target.value) addEffectToClips(clipIds, ev.target.value);
      }}
      {...handlers}
    >
      <option value="">choose...</option>
      {open
        ? EFFECT_CATEGORIES.map((cat) => {
            const items = EFFECTS.filter((x) => x.category === cat.id);
            if (items.length === 0) return null;
            return (
              <optgroup key={cat.id} label={cat.label}>
                {items.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </optgroup>
            );
          })
        : null}
    </select>
  );
}

/** the effect clips that are put on this clip, and a select to add one */
export const ClipEffectsSection = memo(function ClipEffectsSection({ clip }: { clip: VisualClip }) {
  const clips = useEditor((s) => s.project?.clips);
  const list = useMemo(() => (clips ? effectsOnClip(clips, clip.id) : []), [clips, clip.id]);
  return (
    <Section id="clip-effects" title="effects">
      {list.map((e) => (
        <div key={e.id} className="props-fx">
          <div className="props-fx-head">
            <button
              type="button"
              className="btn btn-sm props-link"
              title="select this effect clip"
              onClick={() => actions().select([e.id])}
            >
              {e.name || e.effect}
            </button>
            <button
              type="button"
              className="icon-btn"
              title="remove this effect"
              aria-label={`remove ${e.name || e.effect}`}
              onClick={() => actions().deleteClips([e.id])}
            >
              <Trash2 size={14} />
            </button>
          </div>
          <AnimField id={e.id} prop="amount" label="strength" title="how strong the effect is on this clip (%)" feel="effectAmount" fallback={1} />
        </div>
      ))}
      {list.length === 0 ? <div className="props-hint">no effects on this clip</div> : null}
      <Row label="add effect" title="put an effect on this clip only" wide>
        <AddEffect clipIds={[clip.id]} />
      </Row>
    </Section>
  );
});
