import { memo, useMemo } from 'react';
import { Trash2 } from 'lucide-react';
import { EFFECT_CATEGORIES } from '../../engine/effects/types';
import { EFFECTS, getEffect } from '../../engine/effects/registry';
import { useEditor } from '../../store/editorStore';
import type { VisualClip } from '../../types';
import { AnimField } from './AnimField';
import { effectHomeTrack, effectsOnClip, newTargetedEffect } from './clipEffects';
import { Row, Section, useSelectOpen } from './controls';

const actions = () => useEditor.getState();

/** one undo step: a new effect clip on this clip, on a track above it. the selection stays on the clip. */
function addEffectTo(clipId: string, effectId: string): void {
  const st = actions();
  const p = st.project;
  const clip = p?.clips.find((c) => c.id === clipId);
  const def = getEffect(effectId);
  if (!p || !clip || !def || (clip.type !== 'video' && clip.type !== 'image' && clip.type !== 'text' && clip.type !== 'shape')) return;
  const home = effectHomeTrack(p, clip);
  const made = newTargetedEffect(def.id, def.name, clip as VisualClip, home ?? clip.trackId);
  const ids = home ? st.addClips([made], { newTrack: false }) : st.addClips([made], { newTrack: true, trackName: 'effects' });
  if (ids.length > 0) st.select([clipId]);
}

/** the "add effect" select: it always shows "choose...", so the list of effects is only rendered while it is open */
function AddEffect({ clipId }: { clipId: string }) {
  const { open, handlers } = useSelectOpen();
  return (
    <select
      className="select"
      title="add an effect to this clip"
      aria-label="add an effect to this clip"
      value=""
      onChange={(ev) => {
        if (ev.target.value) addEffectTo(clipId, ev.target.value);
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
          <AnimField slider id={e.id} prop="amount" label="strength" title="how strong the effect is on this clip (%)" scale={100} min={0} max={100} step={1} precision={0} suffix="%" fallback={1} />
        </div>
      ))}
      {list.length === 0 ? <div className="props-hint">no effects on this clip</div> : null}
      <Row label="add effect" title="put an effect on this clip only" wide>
        <AddEffect clipId={clip.id} />
      </Row>
    </Section>
  );
});
