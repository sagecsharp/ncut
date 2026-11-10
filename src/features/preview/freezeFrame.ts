/**
 * freeze frame: turn the picture of a video clip at the playhead into a still that sits in the
 * timeline at that spot.
 */
import { resolveClip } from '../../lib/anim';
import { deleteAsset, importFiles } from '../../media/importer';
import { getAssetUrl } from '../../media/registry';
import { seekFrame } from '../../media/seekFrame';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { withFollowerMoves } from '../timeline/followMoves';
import { freezeEffectCopies, freezeFileName, freezeHandover, freezeSourceTime, pickFreezeTarget, planFreeze, shiftMoves, stillClipFrom } from './freezePlan';

/** default length of the still, seconds */
export const FREEZE_DURATION = 2;

const GRAB_TIMEOUT_MS = 10_000;

function once(el: HTMLVideoElement, ok: string, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (err?: Error) => {
      window.clearTimeout(timer);
      el.removeEventListener(ok, onOk);
      el.removeEventListener('error', onErr);
      if (err) reject(err);
      else resolve();
    };
    const onOk = () => done();
    const onErr = () => done(new Error('video error'));
    const timer = window.setTimeout(() => done(new Error('timeout')), ms);
    el.addEventListener(ok, onOk);
    el.addEventListener('error', onErr);
  });
}

/**
 * the clip's own picture (not the composed canvas) at a source time, at the natural size of the video, as a png.
 * uses a private element so the preview's pooled elements are never moved.
 */
async function grabSourceFrame(url: string, sourceTime: number): Promise<Blob | null> {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  try {
    const loaded = once(v, 'loadeddata', GRAB_TIMEOUT_MS);
    v.src = url;
    await loaded;
    // wait for the picture of that moment, not only for 'seeked': drawn too early the still shows the frame before the seek
    if (Math.abs(v.currentTime - sourceTime) > 1e-3 && !(await seekFrame(v, sourceTime, GRAB_TIMEOUT_MS))) return null;
    const w = v.videoWidth;
    const h = v.videoHeight;
    if (w <= 0 || h <= 0) return null;
    if (typeof OffscreenCanvas !== 'undefined') {
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(v, 0, 0, w, h);
      return await c.convertToBlob({ type: 'image/png' });
    }
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, w, h);
    return await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
  } catch {
    return null;
  } finally {
    v.pause();
    v.removeAttribute('src');
    v.load();
  }
}

/**
 * freeze the selected video clip (or the top video clip under the playhead) at the playhead.
 * the clip is split there, the still is inserted and everything after it on that track moves right.
 * returns the id of the new image clip, or null when there is nothing to freeze.
 */
export async function freezeFrame(): Promise<string | null> {
  const first = useEditor.getState();
  const project = first.project;
  if (!project) return null;
  usePlayback.getState().pause();
  const time = usePlayback.getState().time;
  const target = pickFreezeTarget(project, first.selection, time);
  if (!target) return null;
  const track = project.tracks.find((t) => t.id === target.trackId);
  if (!track || track.locked) return null;
  const url = getAssetUrl(target.assetId);
  if (!url) return null;
  const asset = project.assets.find((a) => a.id === target.assetId);

  const blob = await grabSourceFrame(url, freezeSourceTime(target, time, project.fps, asset?.duration));
  if (!blob) return null;
  const file = new File([blob], freezeFileName(target.name, time, project.fps), { type: 'image/png' });
  let imported;
  try {
    imported = await importFiles([file]);
  } catch {
    return null;
  }
  const still = imported[0];
  if (!still || still.kind !== 'image') return null;

  // the project may have changed during the async work: plan again from the live state
  const live = useEditor.getState();
  const liveClip = live.project?.clips.find((c) => c.id === target.id);
  if (!live.project || !liveClip || liveClip.type !== 'video') {
    void deleteAsset(still.id);
    return null;
  }
  const before = live.project;
  const plan = planFreeze(liveClip, time, before.fps);
  const skip = { skipHistory: true };
  let newId: string | null = null;
  live.pushHistory();
  if (plan.split) useEditor.getState().splitClips(time, [liveClip.id], skip);
  const afterSplit = useEditor.getState().project!;
  // the clips that make room for the still take the effects put on them along
  const moves = withFollowerMoves(afterSplit.clips, afterSplit.tracks, shiftMoves(afterSplit.clips, liveClip.trackId, plan.shiftFrom, FREEZE_DURATION));
  const moved = moves.length === 0 || useEditor.getState().moveClips(moves, skip);
  if (moved) {
    const handover = freezeHandover(liveClip, plan);
    const clip = stillClipFrom(liveClip, resolveClip(liveClip, time).transform, still.id, plan.stillStart, FREEZE_DURATION, handover);
    const ids = useEditor.getState().addClips([clip], { ...skip, newTrack: false });
    newId = ids[0] ?? null;
    if (newId) {
      // the entrance / exit moved to the still: the video loses it in the same step
      if (handover.videoPatch) useEditor.getState().updateClip(liveClip.id, handover.videoPatch, skip);
      // the effects put on the video also act on the still (read from the clips before the split: the left half keeps the id)
      const fx = freezeEffectCopies(before.clips, liveClip.id, time, newId, plan.stillStart, FREEZE_DURATION);
      if (fx.length > 0) useEditor.getState().addClips(fx, { ...skip, newTrack: false });
    }
  }
  if (!newId) {
    // put everything back: the history step pushed above holds the project as it was
    if (useEditor.getState().project !== before) useEditor.getState().rollback();
    void deleteAsset(still.id);
    return null;
  }
  useEditor.getState().select([newId], 'replace');
  return newId;
}
