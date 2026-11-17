/** picture and sound actions: plan first, then the store. a plan that gives a string changes nothing */
import { useEditor } from '../../store/editorStore';
import type { ActionOpts, ClipPatch } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import { uid } from '../../lib/id';
import { mateOf } from '../../lib/soundPair';
import { clipEnd } from '../../lib/timelineOps';
import type { Project } from '../../types';
import { liveOpts } from '../properties/edit';
import { applyFollowerSpans, followBase } from './followApply';
import { planJoin, planPairSpeed, planSeparate, planSync, planSyncAll, sideIds, soundToggle, syncTarget } from './soundPlan';
import type { IdMaker, Skipped, SyncHow } from './soundPlan';
import { SOUND_TEXT } from './soundText';

export interface SeparateDone { pairs: { picture: string; sound: string; track: string }[]; skipped: Skipped[] }
export interface JoinDone { joined: string[]; removed: string[]; skipped: Skipped[] }
export interface SyncDone { synced: string[]; skipped: Skipped[] }

const toast = (text: string): void => useUi.getState().toast(text);
const ed = () => useEditor.getState();
const ids: IdMaker = { clip: () => uid('clp'), group: () => uid('grp') };

/** the clip a sync move would run into, named; the plain text when nothing is there */
function syncNoRoomText(before: Project | null, id: string, how: SyncHow): string {
  const c = before?.clips.find((x) => x.id === id);
  const m = before ? mateOf(before.clips, id) : null;
  if (!before || !c || (c.type !== 'video' && c.type !== 'audio') || !m) return SOUND_TEXT.syncNoRoom;
  const t = syncTarget(c, m, how);
  const o = before.clips.find((x) => x.id !== c.id && x.trackId === c.trackId && x.start < t.start + t.duration - 1e-9 && clipEnd(x) > t.start + 1e-9);
  return o ? `${SOUND_TEXT.syncNoRoom}: ${o.name} is in the way` : SOUND_TEXT.syncNoRoom;
}

/** a toast only when something was skipped: "2 separated, 1 skipped: <why of the first>" */
function reportSkips(verb: string, n: number, skipped: readonly Skipped[], before: Project | null, how?: SyncHow): void {
  const first = skipped[0];
  if (!first) return;
  const why = first.why === SOUND_TEXT.syncNoRoom && how ? syncNoRoomText(before, first.id, how) : first.why;
  toast(`${n} ${verb}, ${skipped.length} skipped: ${why}`);
}

/** a string = why nothing changed. skipHistory: inside a step the caller opened */
export function separateSound(sel: readonly string[], opts?: ActionOpts & { prefer?: string }): SeparateDone | string {
  const p = ed().project;
  const plan = p ? planSeparate(p, sel, ids, opts?.prefer) : SOUND_TEXT.soundVideoFirst;
  if (typeof plan === 'string') return plan;
  const inner = !!opts?.skipHistory;
  const step = { skipHistory: true };
  if (!inner) ed().pushHistory();
  const fail = (): string => {
    if (!inner) ed().rollback();
    return SOUND_TEXT.trackLocked;
  };
  const real = new Map<string, string>();
  for (const nt of plan.newTracks) {
    const id = ed().addTrack('audio', step);
    real.set(nt.key, id);
    const patch: { muted?: boolean; volume?: number; pan?: number } = {};
    if (nt.muted) patch.muted = true;
    if (nt.volume !== undefined && nt.volume !== 1) patch.volume = nt.volume;
    if (nt.pan !== undefined && nt.pan !== 0) patch.pan = nt.pan;
    if (Object.keys(patch).length > 0) ed().updateTrack(id, patch, step);
  }
  const sounds = plan.sounds.map((s) => ({ clip: real.has(s.clip.trackId) ? { ...s.clip, trackId: real.get(s.clip.trackId)! } : s.clip, after: s.after }));
  if (!ed().insertClips(sounds, step)) return fail();
  for (const id of plan.mute) ed().updateClip(id, { muted: true }, step);
  for (const g of plan.groups) if (!ed().setClipGroup([g.id], g.group, step)) return fail();
  for (const t of plan.tempo) ed().updateClip(t.id, t.patch, step);
  for (const b of plan.beats) ed().updateClip(b.id, { beat: b.beat } as ClipPatch, step);
  ed().select([...plan.pairs.map((x) => x.picture), ...sounds.map((s) => s.clip.id)], 'replace');
  const trackOf = new Map(sounds.map((s) => [s.clip.id, s.clip.trackId]));
  return { pairs: plan.pairs.map((x) => ({ picture: x.picture, sound: x.sound, track: trackOf.get(x.sound)! })), skipped: plan.skipped };
}

export function joinSound(sel: readonly string[], opts?: ActionOpts): JoinDone | string {
  const p = ed().project;
  const plan = p ? planJoin(p, sel) : SOUND_TEXT.soundPairFirst;
  if (typeof plan === 'string' || !p) return typeof plan === 'string' ? plan : SOUND_TEXT.soundPairFirst;
  const inner = !!opts?.skipHistory;
  const step = { skipHistory: true };
  if (!inner) ed().pushHistory();
  for (const pic of plan.pictures) {
    // the keys first: the swap writes a base value of its own, the patch then sets the right one
    if (pic.keyframes !== undefined) {
      const start = p.clips.find((c) => c.id === pic.id)?.start ?? 0;
      ed().setClipKeyframes(pic.id, pic.keyframes ?? {}, { ...step, time: start });
    }
    if (Object.keys(pic.patch).length > 0) ed().updateClip(pic.id, pic.patch, step);
  }
  for (const b of plan.beats) ed().updateClip(b.id, { beat: b.beat } as ClipPatch, step);
  ed().deleteClips(plan.remove, step);
  const gone = new Set(plan.remove);
  if (ed().project!.clips.some((c) => gone.has(c.id))) {
    if (!inner) ed().rollback();
    return SOUND_TEXT.trackLocked;
  }
  for (const pic of plan.pictures) if (pic.ungroup) ed().setClipGroup([pic.id], null, step);
  ed().select(plan.joined, 'replace');
  return { joined: plan.joined, removed: plan.remove, skipped: plan.skipped };
}

export function syncSound(sel: readonly string[], how: SyncHow, opts?: ActionOpts): SyncDone | string {
  const p = ed().project;
  const plan = p ? planSync(p, sel, how) : SOUND_TEXT.soundPairFirst;
  if (typeof plan === 'string' || !p) return typeof plan === 'string' ? plan : SOUND_TEXT.soundPairFirst;
  const inner = !!opts?.skipHistory;
  const step = { skipHistory: true };
  if (!inner) ed().pushHistory();
  const synced = new Set(plan.synced);
  const skipped = [...plan.skipped];
  const speedOf = new Map(p.clips.map((c) => [c.id, (c as { speed?: number }).speed ?? 1]));
  // a clip that gets shorter changes speed before its move, a longer one after, so setClipSpeed never clamps
  for (const s of plan.speeds) if (s.first) ed().setClipSpeed(s.id, s.speed, step);
  if (plan.moves.length > 0 && !ed().moveClips(plan.moves, step)) {
    // no room after all: the clips that wanted to move stay, the others go on
    const asked = new Set(plan.moves.map((m) => m.id));
    for (const id of plan.synced) {
      if (!asked.has(id)) continue;
      synced.delete(id);
      skipped.push({ id, why: SOUND_TEXT.syncNoRoom });
      const back = plan.speeds.find((s) => s.id === id && s.first);
      if (back) ed().setClipSpeed(id, speedOf.get(id)!, step);
    }
    if (synced.size === 0) {
      if (!inner) ed().rollback();
      return syncNoRoomText(p, skipped[skipped.length - 1]!.id, how);
    }
  }
  // the clips that stay still change speed too, after the move
  for (const s of plan.speeds) if (!s.first && synced.has(s.id)) ed().setClipSpeed(s.id, s.speed, step);
  // effects that were put on a clip come along with its new length
  for (const s of plan.speeds) if (synced.has(s.id)) applyFollowerSpans(p, s.id, step);
  for (const s of plan.slips) ed().slipClip(s.id, s.delta, step);
  return { synced: plan.synced.filter((id) => synced.has(id)), skipped };
}

/** the speed of selected pairs: both sides together, in one step (or inside the live edit that is going on) */
export function setPairSpeed(sel: readonly string[], speed: number, live: boolean): void {
  const cur = ed().project;
  if (!cur) return;
  const before = live ? followBase(cur) : cur;
  const plan = planPairSpeed(before ?? cur, sel, speed);
  if (typeof plan === 'string') return;
  let opts: ActionOpts;
  if (live) opts = liveOpts();
  else {
    ed().pushHistory();
    opts = { skipHistory: true };
  }
  const moves = [...plan.moves];
  for (let i = 0; i + 1 < plan.speeds.length; i += 2) {
    const picture = plan.speeds[i]!;
    const sound = plan.speeds[i + 1]!;
    ed().setClipSpeed(picture.id, picture.speed, opts);
    applyFollowerSpans(before, picture.id, opts);
    // a sound that gets longer moves before its speed change, so the speed never clamps against the next clip
    const now = ed().project?.clips.find((c) => c.id === sound.id) as { speed?: number } | undefined;
    const at = moves.findIndex((m) => m.id === sound.id);
    if (at >= 0 && now && sound.speed < (now.speed ?? 1)) {
      const [m] = moves.splice(at, 1);
      ed().moveClips([m!], opts);
    }
    ed().setClipSpeed(sound.id, sound.speed, opts);
  }
  // a sound that does not fit this tick goes back to where the gesture began, so the result does not depend on the path
  for (let i = 1; i < plan.speeds.length; i += 2) {
    const id = plan.speeds[i]!.id;
    if (moves.some((m) => m.id === id)) continue;
    const base = (before ?? cur).clips.find((c) => c.id === id);
    const now = ed().project?.clips.find((c) => c.id === id);
    if (base && now && Math.abs(now.start - base.start) > 1e-9) moves.push({ id, trackId: now.trackId, start: base.start });
  }
  // moveClips answers false for no moves: it is not a refusal, so it is not called then
  if (moves.length > 0) ed().moveClips(moves, opts);
}

export function separateSoundNow(sel: readonly string[]): void {
  const r = separateSound(sel);
  if (typeof r === 'string') toast(r);
  else reportSkips('separated', r.pairs.length, r.skipped, null);
}

export function joinSoundNow(sel: readonly string[]): void {
  const r = joinSound(sel);
  if (typeof r === 'string') toast(r);
  else reportSkips('joined', r.joined.length, r.skipped, null);
}

export function toggleSoundNow(sel: readonly string[]): void {
  const p = ed().project;
  const t = p ? soundToggle(p, sel) : { kind: 'none' as const, reason: SOUND_TEXT.soundVideoFirst };
  if (t.kind === 'none') {
    toast(t.reason);
    return;
  }
  if (t.kind === 'separate') {
    const r = separateSound(t.ids);
    if (typeof r === 'string') toast(r);
    else reportSkips('separated', r.pairs.length, r.skipped.filter((s) => s.why !== SOUND_TEXT.alreadyApart), null);
    return;
  }
  joinSoundNow(t.ids);
}

export function syncSoundNow(sel: readonly string[], how: SyncHow): void {
  const before = ed().project;
  const r = syncSound(sel, how);
  if (typeof r === 'string') {
    // no room: name the clip in the way
    const first = r === SOUND_TEXT.syncNoRoom && before ? planSyncAll(before, sel, how).skipped[0] : undefined;
    toast(first ? syncNoRoomText(before, first.id, how) : r);
  } else reportSkips('lined up', r.synced.length, r.skipped, before, how);
}

export function selectSideNow(sel: readonly string[], side: 'sound' | 'picture'): void {
  const p = ed().project;
  const found = p ? sideIds(p, sel, side) : [];
  if (found.length === 0) {
    toast(SOUND_TEXT.soundPairFirst);
    return;
  }
  ed().select(found, 'replace');
}
