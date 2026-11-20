/** putting an effect on clips from the inspector or a drop: the store side of clipEffects.ts */
import { getEffect } from '../../engine/effects/registry';
import { useEditor } from '../../store/editorStore';
import type { Clip, VisualClip } from '../../types';
import { effectHomeTrack, newTargetedEffect } from './clipEffects';

const actions = () => useEditor.getState();

/** a clip an effect can be put on (EffectClip.target): a picture of its own */
export function takesEffect(c: Clip): c is VisualClip {
  return c.type === 'video' || c.type === 'image' || c.type === 'text' || c.type === 'shape';
}

/**
 * one undo step: a new effect clip on each of these clips (the ones that can take one), each on a track above its clip.
 * the selection stays on the clips. answers how many effect clips were made.
 */
export function addEffectToClips(clipIds: readonly string[], effectId: string): number {
  const st = actions();
  const def = getEffect(effectId);
  const first = st.project;
  if (!first || !def) return 0;
  const want = new Set(clipIds);
  const picked = first.clips.filter((c) => want.has(c.id) && takesEffect(c));
  if (picked.length === 0) return 0;
  const selection = st.selection;
  // one step for all of them: every add below joins it
  const many = picked.length > 1;
  if (many) st.pushHistory();
  let made = 0;
  for (const target of picked) {
    // the track is picked on the project as it is now: an effects track made for the clip before is reused
    const p = actions().project;
    const clip = p?.clips.find((c) => c.id === target.id);
    if (!p || !clip || !takesEffect(clip)) continue;
    const home = effectHomeTrack(p, clip);
    const fx = newTargetedEffect(def.id, def.name, clip, home ?? clip.trackId);
    const opts = many ? { skipHistory: true } : undefined;
    const ids = home ? st.addClips([fx], { ...opts, newTrack: false }) : st.addClips([fx], { ...opts, newTrack: true, trackName: 'effects' });
    made += ids.length;
  }
  // addClips selects what it made: the clips stay selected
  if (made > 0) st.select([...selection], 'replace');
  return made;
}
