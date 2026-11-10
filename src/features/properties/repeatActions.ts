import { isRangeFree } from '../../lib/timelineOps';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import { isVisualClip } from '../../types';
import { DEFAULT_REPEAT, applyRepeatEntry, repeatFitsOneTrack, repeatPlan } from './repeat';
import type { RepeatOptions } from './repeat';

/**
 * make copies of one visual clip, each a step further than the one before (see repeat.ts). the copies
 * lie BELOW the original in layer order, copy 1 right under it, so the original is the front-most and
 * the copies trail behind it. when the delay is as long as the clip the copies never overlap in time
 * and share one track (the original's own when it is free there, else a new one under it); otherwise
 * every copy gets a new track of its own. original and copies end up in one group and selected.
 * one undo step. returns the ids of the copies (empty when nothing happened).
 */
export function repeatClip(id: string, opts: Partial<RepeatOptions>): string[] {
  const st = useEditor.getState();
  const p = st.project;
  const ui = useUi.getState();
  if (!p) return [];
  const clip = p.clips.find((c) => c.id === id);
  if (!clip || !isVisualClip(clip)) return [];
  const home = p.tracks.findIndex((t) => t.id === clip.trackId);
  if (home < 0 || p.tracks[home]!.locked) {
    ui.toast('this clip is on a locked track: unlock it to make copies');
    return [];
  }
  // the stagger sits on the frame grid like every clip: whole frames, at least one when there is a delay
  const rawDelay = Number.isFinite(opts.delay) ? Math.max(0, opts.delay!) : 0;
  const fps = p.fps > 0 ? p.fps : 30;
  const delay = rawDelay > 0 ? Math.max(1, Math.round(rawDelay * fps)) / fps : 0;
  opts = { ...opts, delay };
  const plan = repeatPlan(clip, { ...DEFAULT_REPEAT, ...opts });
  if (plan.length === 0) {
    ui.toast('set copies to 2 or more');
    return [];
  }

  const shared = repeatFitsOneTrack(clip, opts.delay ?? 0);
  const copies = plan.map((entry) => applyRepeatEntry(clip, entry));

  st.pushHistory();
  const skip = { skipHistory: true };
  let ids: string[] = [];
  if (shared) {
    const homeFree = copies.every((c) => isRangeFree(p, clip.trackId, c.start, c.duration));
    const trackId = homeFree ? clip.trackId : st.addTrack('video', { index: home + 1, ...skip });
    for (const c of copies) c.trackId = trackId;
    ids = useEditor.getState().addClips(copies, { newTrack: false, ...skip });
  } else {
    // one new track per copy, copy 1 right under the original, copy 2 under that...
    copies.forEach((c, i) => {
      c.trackId = st.addTrack('video', { index: home + 1 + i, ...skip });
    });
    ids = useEditor.getState().addClips(copies, { newTrack: false, ...skip });
  }
  if (ids.length === 0) return [];
  const all = [id, ...ids];
  // a clip that already belongs to a group stays with it: the copies join (the group is made again with them)
  const mates = clip.group ? p.clips.filter((c) => c.group === clip.group && c.id !== id).map((c) => c.id) : [];
  useEditor.getState().groupClips([...all, ...mates], skip);
  useEditor.getState().select(all);
  ui.toast(ids.length === 1 ? '1 copy' : `${ids.length} copies`);
  return ids;
}
