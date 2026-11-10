import { reparentTransform } from '../../engine/parent';
import { glyphLayout, measureText } from '../../engine/text';
import type { TextGlyph } from '../../engine/text';
import { clamp } from '../../lib/time';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { isCameraClip, isVisualClip } from '../../types';
import type { TextClip } from '../../types';
import { hasAnimatedPose } from './parentOptions';
import { MAX_PIECES, keepsBackground, pieceClip, splitBlocker, splitPlan } from './textSplit';
import type { SplitMode, SplitPlan } from './textSplit';

export const SPLIT_MODES: SplitMode[] = ['letters', 'words', 'lines'];

/** the plan of every mode for a text clip (what the buttons show). null when the text cannot be laid out. */
export function splitPlans(clip: TextClip): Record<SplitMode, SplitPlan> | null {
  const box = measureText(clip);
  let glyphs: TextGlyph[];
  try {
    glyphs = glyphLayout(clip).glyphs;
  } catch {
    return null; // no 2d canvas to measure with
  }
  return { letters: splitPlan(box, glyphs, 'letters'), words: splitPlan(box, glyphs, 'words'), lines: splitPlan(box, glyphs, 'lines') };
}

/** why a mode does nothing for this plan, or null when it can run */
export function splitReason(plan: SplitPlan | undefined): string | null {
  if (!plan || plan.count < 2) return 'nothing to split';
  if (plan.count > MAX_PIECES) return `too many pieces (${plan.count}), try words or lines`;
  return null;
}

const plural = (n: number, mode: SplitMode) => `${n} ${n === 1 ? mode.slice(0, -1) : mode}`;

/**
 * split a text clip into one clip per letter / word / line, each where its piece was. one undo step.
 * the pieces replace the original, are grouped and selected. returns how many pieces were made (0 = nothing happened).
 */
export function splitText(id: string, mode: SplitMode): number {
  const st = useEditor.getState();
  const ui = useUi.getState();
  const p = st.project;
  const clip = p?.clips.find((c) => c.id === id);
  if (!p || !clip || clip.type !== 'text') return 0;
  if (p.tracks.find((t) => t.id === clip.trackId)?.locked) return 0;
  const blocked = splitBlocker(clip);
  if (blocked) {
    ui.toast(blocked);
    return 0;
  }
  const plans = splitPlans(clip);
  const plan = plans?.[mode];
  const reason = splitReason(plan);
  if (!plan || reason) {
    ui.toast(reason ?? 'nothing to split');
    return 0;
  }
  // offsets are worked out with the clip's scale / spin at the playhead (held inside the clip)
  const time = clamp(usePlayback.getState().time, clip.start, clip.start + clip.duration);
  const effects = p.clips.filter((c) => c.type === 'effect' && c.target === id).length;
  const pieces = plan.pieces.map((pc) => pieceClip(clip, pc, mode, time));

  // what hangs on the original: attached clips (they keep their place), look targets and camera targets
  const kids = p.clips.filter((c) => isVisualClip(c) && c.parent === id);
  const lookers = p.clips.filter((c) => isVisualClip(c) && c.lookTarget === id).map((c) => c.id);
  const cameras = p.clips.filter((c) => isCameraClip(c) && c.target === id).map((c) => c.id);

  st.pushHistory();
  const skip = { skipHistory: true };
  st.deleteClips([id], skip);
  // the original is gone, so its track is free again: the first piece takes it, the others find room on other tracks
  const made = st.addClips(pieces, { newTrack: false, skipHistory: true });
  if (made.length === 0) {
    st.undo();
    return 0;
  }
  const first = made[0]!;
  if (kids.length + lookers.length + cameras.length > 0) {
    // the pieces are in the project now: work the kids' places out from the old project plus the pieces (the original
    // still there), so each kid stays where it is on screen under the first piece
    const now = useEditor.getState().project;
    const added = made.map((mid) => now?.clips.find((c) => c.id === mid)).filter((c) => !!c);
    const synth = { ...p, clips: [...p.clips, ...added] };
    for (const kid of kids) {
      if (!isVisualClip(kid)) continue;
      const transform = hasAnimatedPose(kid) ? null : reparentTransform(synth, kid, first, clamp(time, kid.start, kid.start + kid.duration));
      st.updateClip(kid.id, { parent: first }, skip);
      if (transform) st.updateTransform(kid.id, transform, skip);
    }
    for (const lid of lookers) st.updateClip(lid, { lookTarget: first }, skip);
    for (const cid of cameras) st.updateClip(cid, { target: first }, skip);
  }
  st.groupClips(made, skip);
  st.select(made, 'replace');
  let msg = plural(made.length, mode);
  if (clip.background && !keepsBackground(mode)) msg += ', background removed';
  if (effects > 0) msg += `, ${effects === 1 ? 'its effect was' : `${effects} effects were`} removed`;
  ui.toast(msg);
  return made.length;
}
