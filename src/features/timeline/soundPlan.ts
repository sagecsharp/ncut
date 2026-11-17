/**
 * picture and sound planners. pure: a plan is data, soundActions.ts runs it through the store.
 * no store, no dom: reasons.ts imports soundKeyReason.
 */
import type { AudioClip, Clip, EffectClip, Keyframes, Project, TimedClip, VideoClip } from '../../types';
import { MIN_CLIP_DURATION, isTimedClip } from '../../types';
import type { ClipMove, ClipPatch } from '../../store/editorStore';
import { SYNC_EPS, isPair, mateOf, pairIndex, sameTrackSound, soundFromPicture, soundKeys, soundsOf, syncLabel, syncOffset, syncPoint, withSoundKeys } from '../../lib/soundPair';
import { clipEnd, isRangeFree } from '../../lib/timelineOps';
import { sameCrossfade } from '../../lib/audioCross';
import { parseBpm } from '../../lib/tempo';
import { withFollowerMoves } from './followMoves';
import { SOUND_TEXT as T } from './soundText';

export interface IdMaker { clip(): string; group(): string }
export interface Skipped { id: string; why: string }
type Beat = NonNullable<EffectClip['beat']>;
export interface SeparatePlan {
  newTracks: { key: string; muted: boolean; volume?: number; pan?: number }[]; // a sound's trackId may be a key
  sounds: { clip: AudioClip; after: string }[];
  mute: string[];
  groups: { id: string; group: string }[]; // pictures without a group
  tempo: { id: string; patch: ClipPatch }[]; // sound fields the picture gives away (tempo, crossfade, fade shapes)
  beats: { id: string; beat: Beat }[]; // beat sources moved to the sound clip
  pairs: { picture: string; sound: string }[];
  skipped: Skipped[];
}

const speedOf = (c: Pick<TimedClip, 'speed'>): number => (c.speed > 0 ? c.speed : 1);

/** the effect clips of a project */
const effectsOf = (p: Project): EffectClip[] => p.clips.filter((c): c is EffectClip => c.type === 'effect');

/** effects that pulse on the clip, split by their track: locked ones keep the tempo where it is */
type BeatIndex = Map<string, { locked: EffectClip[]; open: EffectClip[] }>;

/** every beat source of the project in one pass over its effects */
function beatIndex(p: Project): BeatIndex {
  const lockedTracks = new Set(p.tracks.filter((t) => t.locked).map((t) => t.id));
  const out: BeatIndex = new Map();
  for (const e of effectsOf(p)) {
    const source = e.beat?.source;
    if (!source) continue;
    let slot = out.get(source);
    if (!slot) out.set(source, (slot = { locked: [], open: [] }));
    (lockedTracks.has(e.trackId) ? slot.locked : slot.open).push(e);
  }
  return out;
}

function beatEffects(p: Project, source: string, index?: BeatIndex): { locked: EffectClip[]; open: EffectClip[] } {
  return (index ?? beatIndex(p)).get(source) ?? { locked: [], open: [] };
}

export function planSeparate(p: Project, ids: readonly string[], make: IdMaker, prefer?: string): SeparatePlan | string {
  const idx = pairIndex(p.clips);
  const want = new Set(ids);
  const trackOf = new Map(p.tracks.map((t) => [t.id, t]));
  const videos = p.tracks.filter((t) => t.kind === 'video');
  const audios = p.tracks.filter((t) => t.kind === 'audio');
  const work: Clip[] = [...p.clips];
  const plan: SeparatePlan = { newTracks: [], sounds: [], mute: [], groups: [], tempo: [], beats: [], pairs: [], skipped: [] };
  const usedFor = new Map<string, string>();
  let seenVideo = false;
  let made = 0;
  for (const c of p.clips) {
    if (!want.has(c.id) || c.type !== 'video') continue;
    seenVideo = true;
    const track = trackOf.get(c.trackId);
    if (!track) {
      plan.skipped.push({ id: c.id, why: T.soundVideoFirst });
      continue;
    }
    if (track.locked) {
      plan.skipped.push({ id: c.id, why: T.trackLocked });
      continue;
    }
    if (!p.assets.find((a) => a.id === c.assetId)?.hasAudio) {
      plan.skipped.push({ id: c.id, why: T.noSoundInVideo });
      continue;
    }
    if ((idx.others.get(c.id)?.length ?? 0) > 0) {
      plan.skipped.push({ id: c.id, why: T.alreadyApart });
      continue;
    }
    const fits = (t: { id: string; kind: string; locked: boolean; muted: boolean; volume?: number; pan?: number } | undefined): boolean =>
      !!t && t.kind === 'audio' && !t.locked && sameTrackSound(t, track) && isRangeFree({ clips: work }, t.id, c.start, c.duration);
    const i = videos.findIndex((t) => t.id === track.id);
    const mirror = i >= 0 ? audios[videos.length - 1 - i] : undefined;
    const tries = [prefer ? trackOf.get(prefer) : undefined, trackOf.get(usedFor.get(c.trackId) ?? ''), mirror, ...audios];
    let trackId = tries.find(fits)?.id;
    if (trackId === undefined) {
      const kept = usedFor.get(c.trackId);
      // a track this plan made for this video track: free again?
      if (kept !== undefined && kept.startsWith('new:') && isRangeFree({ clips: work }, kept, c.start, c.duration)) trackId = kept;
      else {
        trackId = 'new:' + ++made;
        const nt: SeparatePlan['newTracks'][number] = { key: trackId, muted: track.muted };
        if (track.volume !== undefined) nt.volume = track.volume;
        if (track.pan !== undefined) nt.pan = track.pan;
        plan.newTracks.push(nt);
      }
    }
    usedFor.set(c.trackId, trackId);
    const group = c.group ?? make.group();
    const s = soundFromPicture(c, make.clip(), trackId, group);
    work.push(s);
    plan.sounds.push({ clip: s, after: c.id });
    if (!c.muted) plan.mute.push(c.id);
    if (!c.group) plan.groups.push({ id: c.id, group });
    plan.pairs.push({ picture: c.id, sound: s.id });
    const hasTempo = parseBpm(c.bpm) !== null || (c.beatOffset !== undefined && c.beatOffset !== null);
    if (hasTempo) {
      const fx = beatEffects(p, c.id);
      if (fx.locked.length === 0) {
        const patch: Record<string, unknown> = {};
        if (parseBpm(c.bpm) !== null) patch.bpm = null;
        if (c.beatOffset !== undefined && c.beatOffset !== null) patch.beatOffset = null;
        plan.tempo.push({ id: c.id, patch: patch as ClipPatch });
        for (const e of fx.open) plan.beats.push({ id: e.id, beat: { ...e.beat!, source: s.id } });
      }
    }
    const gives: Record<string, unknown> = {};
    if (c.crossfade) gives.crossfade = null;
    if (c.fadeInShape) gives.fadeInShape = null;
    if (c.fadeOutShape) gives.fadeOutShape = null;
    if (Object.keys(gives).length > 0) plan.tempo.push({ id: c.id, patch: gives as ClipPatch });
  }
  if (plan.sounds.length === 0) return seenVideo ? (plan.skipped[0]?.why ?? T.soundVideoFirst) : T.soundVideoFirst;
  return plan;
}

export interface JoinPlan {
  pictures: { id: string; patch: ClipPatch; keyframes?: Keyframes | null; ungroup: boolean }[];
  remove: string[];
  beats: { id: string; beat: Beat }[];
  joined: string[];
  skipped: Skipped[];
}

export function joinWhy(p: Project, v: VideoClip, s: AudioClip, index?: BeatIndex): string | null {
  const locked = new Set(p.tracks.filter((t) => t.locked).map((t) => t.id));
  if (locked.has(v.trackId) || locked.has(s.trackId)) return T.trackLocked;
  if (beatEffects(p, s.id, index).locked.length > 0) return T.soundBeatLocked;
  if (Math.abs(v.speed - s.speed) > 1e-9) return T.soundOtherSpeed;
  if (Math.abs(syncPoint(v) - syncPoint(s)) > SYNC_EPS) return T.soundOutOfSync;
  if (Math.abs(v.start - s.start) > 1e-6 || Math.abs(clipEnd(v) - clipEnd(s)) > 1e-6) return T.soundOtherLength;
  if (Math.abs(v.fadeIn - s.fadeIn) > 1e-6 || Math.abs(v.fadeOut - s.fadeOut) > 1e-6) return T.soundOtherFades;
  if ((pairIndex(p.clips).others.get(v.id)?.length ?? 0) > 1) return T.soundMany;
  if (!isPair(p.clips, v.id, s.id)) return T.soundShared;
  const vt = p.tracks.find((t) => t.id === v.trackId);
  const st = p.tracks.find((t) => t.id === s.trackId);
  if (!vt || !st || !sameTrackSound(vt, st)) return T.soundTrackDiffers;
  return null;
}

/** the pictures of the selection that have a mate, each once, in project order, with their sound clip */
function pictureSides(p: Project, ids: readonly string[]): { v: VideoClip; s: AudioClip }[] {
  const want = new Set(ids);
  const seen = new Set<string>();
  const out: { v: VideoClip; s: AudioClip }[] = [];
  for (const c of p.clips) {
    if (!want.has(c.id) || !isTimedClip(c)) continue;
    const v = c.type === 'video' ? c : mateOf(p.clips, c.id);
    if (!v || v.type !== 'video' || seen.has(v.id)) continue;
    const s = mateOf(p.clips, v.id);
    if (!s || s.type !== 'audio') continue;
    seen.add(v.id);
    out.push({ v, s });
  }
  return out;
}

export function planJoin(p: Project, ids: readonly string[]): JoinPlan | string {
  const plan: JoinPlan = { pictures: [], remove: [], beats: [], joined: [], skipped: [] };
  const index = beatIndex(p);
  for (const { v, s } of pictureSides(p, ids)) {
    const why = joinWhy(p, v, s, index);
    if (why) {
      plan.skipped.push({ id: v.id, why });
      continue;
    }
    const patch: Record<string, unknown> = {};
    const from = v as unknown as Record<string, unknown>;
    const to = s as unknown as Record<string, unknown>;
    if (v.muted !== s.muted) patch.muted = s.muted;
    if (v.volume !== s.volume) patch.volume = s.volume;
    for (const k of ['pan', 'bpm', 'beatOffset', 'fadeInShape', 'fadeOutShape'] as const) if ((from[k] ?? null) !== (to[k] ?? null)) patch[k] = to[k] ?? null;
    if (!sameCrossfade(v.crossfade, s.crossfade)) patch.crossfade = s.crossfade ?? null;
    const entry: JoinPlan['pictures'][number] = {
      id: v.id,
      patch: patch as ClipPatch,
      ungroup: !!v.group && p.clips.filter((o) => o.id !== s.id && o.group === v.group).length < 2,
    };
    if (JSON.stringify(soundKeys(v.keyframes) ?? null) !== JSON.stringify(soundKeys(s.keyframes) ?? null)) {
      entry.keyframes = withSoundKeys(v.keyframes, s.keyframes) ?? null;
      // the keys swap writes a base value of its own: the base values come from the sound clip
      patch.volume = s.volume;
      patch.pan = to.pan ?? null;
    }
    plan.pictures.push(entry);
    plan.remove.push(s.id);
    plan.joined.push(v.id);
    for (const e of beatEffects(p, s.id, index).open) plan.beats.push({ id: e.id, beat: { ...e.beat!, source: v.id } });
  }
  if (plan.joined.length === 0) return plan.skipped[0]?.why ?? T.soundPairFirst;
  return plan;
}

export type SyncHow = 'move' | 'slip' | 'speed';
export interface SyncPlan { speeds: { id: string; speed: number; first: boolean }[]; moves: ClipMove[]; slips: { id: string; delta: number }[]; synced: string[]; skipped: Skipped[] }

/** where the mover c ends up when it is lined up with its mate m: how far off it is, its new start and its new length */
export function syncTarget(c: TimedClip, m: TimedClip, how: SyncHow): { d: number; start: number; duration: number } {
  const d = how === 'speed' ? c.start - c.trimStart / speedOf(m) - syncPoint(m) : syncPoint(c) - syncPoint(m);
  return { d, start: c.start - d, duration: how === 'speed' ? (c.duration * speedOf(c)) / speedOf(m) : c.duration };
}

/** every mover of the selection, planned or skipped. planSync answers a string when nothing is planned */
export function planSyncAll(p: Project, ids: readonly string[], how: SyncHow): SyncPlan {
  const want = new Set(ids);
  const plan: SyncPlan = { speeds: [], moves: [], slips: [], synced: [], skipped: [] };
  const locked = new Set(p.tracks.filter((t) => t.locked).map((t) => t.id));
  const done = new Set<string>();
  // the clips as the plan leaves them: a planned mover sits on its target span
  const work: Clip[] = [...p.clips];
  for (const sel of p.clips) {
    if (!want.has(sel.id) || !isTimedClip(sel)) continue;
    const other = mateOf(p.clips, sel.id);
    if (!other) continue;
    // with both sides selected the sound clip moves
    const bothSides = want.has(other.id);
    const c = bothSides && sel.type === 'video' ? other : sel;
    const m = c === sel ? other : sel;
    if (done.has(c.id)) continue;
    done.add(c.id);
    if (locked.has(c.trackId)) {
      plan.skipped.push({ id: c.id, why: T.trackLocked });
      continue;
    }
    const sameSpeed = Math.abs(speedOf(c) - speedOf(m)) <= 1e-9;
    if (how !== 'speed' && !sameSpeed) {
      plan.skipped.push({ id: c.id, why: T.soundOtherSpeed });
      continue;
    }
    const t = syncTarget(c, m, how);
    if (Math.abs(t.d) <= SYNC_EPS && sameSpeed) {
      plan.skipped.push({ id: c.id, why: T.inSync });
      continue;
    }
    if (how === 'slip') {
      const delta = t.d * speedOf(c);
      const trim = c.trimStart + delta;
      const asset = p.assets.find((a) => a.id === c.assetId);
      if (trim < -1e-9 || (asset && asset.duration > 0 && trim + c.duration * speedOf(c) > asset.duration + 1e-6)) {
        plan.skipped.push({ id: c.id, why: T.slipTooShort });
        continue;
      }
      plan.slips.push({ id: c.id, delta });
    } else {
      if (t.start < -1e-9 || !isRangeFree({ clips: work }, c.trackId, t.start, t.duration, [c.id])) {
        plan.skipped.push({ id: c.id, why: T.syncNoRoom });
        continue;
      }
      const at = work.findIndex((x) => x.id === c.id);
      if (at >= 0) work[at] = { ...work[at]!, start: t.start, duration: t.duration };
      if (how === 'speed') plan.speeds.push({ id: c.id, speed: m.speed, first: m.speed > c.speed });
      if (Math.abs(t.start - c.start) > 1e-9) plan.moves.push({ id: c.id, trackId: c.trackId, start: t.start });
    }
    plan.synced.push(c.id);
  }
  if (plan.synced.length > 0) plan.moves = withFollowerMoves(p.clips, p.tracks, plan.moves);
  return plan;
}

export function planSync(p: Project, ids: readonly string[], how: SyncHow): SyncPlan | string {
  const plan = planSyncAll(p, ids, how);
  return plan.synced.length === 0 ? (plan.skipped[0]?.why ?? T.soundPairFirst) : plan;
}

export function planPairSpeed(base: Project, ids: readonly string[], speed: number): { speeds: { id: string; speed: number }[]; moves: ClipMove[]; pictures: string[] } | string {
  if (!(speed > 0) || !Number.isFinite(speed)) return T.soundPairFirst;
  const locked = new Set(base.tracks.filter((t) => t.locked).map((t) => t.id));
  const out = { speeds: [] as { id: string; speed: number }[], moves: [] as ClipMove[], pictures: [] as string[] };
  for (const { v, s } of pictureSides(base, ids)) {
    if (!isPair(base.clips, v.id, s.id) || locked.has(v.trackId) || locked.has(s.trackId)) continue;
    const s0 = speedOf(v);
    if (Math.abs(s0 - speedOf(s)) > 1e-9) continue;
    out.speeds.push({ id: v.id, speed }, { id: s.id, speed });
    out.pictures.push(v.id);
    const off = syncPoint(s) - syncPoint(v); // 0 in sync
    const start = v.start - v.trimStart / speed + off * (s0 / speed) + s.trimStart / speed;
    const duration = (s.duration * s0) / speed;
    // a move that does not fit is left out (the badge shows it)
    if (Math.abs(start - s.start) > 1e-9 && isRangeFree({ clips: base.clips }, s.trackId, start, duration, [s.id])) {
      out.moves.push({ id: s.id, trackId: s.trackId, start });
    }
  }
  if (out.pictures.length === 0) return T.soundPairFirst;
  return out;
}

export function freezeSound(p: Project, pictureId: string, from: number): { cut: string[]; tracks: string[] } {
  const pic = p.clips.find((c) => c.id === pictureId);
  const out = { cut: [] as string[], tracks: [] as string[] };
  if (!pic) return out;
  const locked = new Set(p.tracks.filter((t) => t.locked).map((t) => t.id));
  const sounds = soundsOf(p.clips, pic).filter((s) => !locked.has(s.trackId));
  const mine = new Set(sounds.map((s) => s.id));
  const left = new Set<string>();
  for (const s of sounds) {
    const crosses = s.start < from - 1e-9 && clipEnd(s) > from + 1e-9;
    if (crosses && !(from - s.start > MIN_CLIP_DURATION && clipEnd(s) - from > MIN_CLIP_DURATION)) left.add(s.trackId);
  }
  for (const s of sounds) {
    if (left.has(s.trackId)) continue;
    // another clip crossing the cut would be torn by the shift
    if (p.clips.some((o) => o.trackId === s.trackId && !mine.has(o.id) && o.start < from - 1e-9 && clipEnd(o) > from + 1e-9)) {
      left.add(s.trackId);
    }
  }
  for (const s of sounds) {
    if (left.has(s.trackId) || clipEnd(s) <= from + 1e-9) continue;
    if (s.start < from - 1e-9) out.cut.push(s.id);
    if (!out.tracks.includes(s.trackId)) out.tracks.push(s.trackId);
  }
  return out;
}

export type SoundToggle = { kind: 'separate'; ids: string[] } | { kind: 'join'; ids: string[] } | { kind: 'none'; reason: string };

/** throwaway ids: a plan made only to look at */
function throwaway(): IdMaker {
  let n = 0;
  return { clip: () => `tmp-clip-${++n}`, group: () => `tmp-grp-${++n}` };
}

export function soundToggle(p: Project, selection: readonly string[]): SoundToggle {
  const sep = planSeparate(p, selection, throwaway());
  if (typeof sep !== 'string') return { kind: 'separate', ids: [...selection] };
  const join = planJoin(p, selection);
  if (typeof join !== 'string') return { kind: 'join', ids: [...selection] };
  return { kind: 'none', reason: pictureSides(p, selection).length > 0 ? join : sep };
}

export function sideIds(p: Project, ids: readonly string[], side: 'sound' | 'picture'): string[] {
  const want = new Set(ids);
  const idx = pairIndex(p.clips);
  const found = new Set<string>();
  for (const c of p.clips) {
    if (!want.has(c.id) || !isTimedClip(c)) continue;
    if (c.type === 'video') {
      const sounds = idx.others.get(c.id) ?? [];
      if (sounds.length === 0) continue;
      if (side === 'picture') found.add(c.id);
      else for (const s of sounds) found.add(s);
    } else {
      const m = idx.mate.get(c.id);
      if (!m) continue;
      found.add(side === 'sound' ? c.id : m);
    }
  }
  return p.clips.filter((c) => found.has(c.id)).map((c) => c.id);
}

export interface SoundMenu { canSeparate: boolean; join: 'yes' | string | null; offset: string | null; sound: boolean; picture: boolean }
export function soundMenu(p: Project, ids: readonly string[], clicked: string): SoundMenu {
  const sel = ids.includes(clicked) ? ids : [clicked];
  const sep = planSeparate(p, sel, throwaway());
  let join: SoundMenu['join'] = null;
  if (pictureSides(p, sel).length > 0) {
    const jp = planJoin(p, sel);
    join = typeof jp === 'string' ? jp : 'yes';
  }
  return {
    canSeparate: typeof sep !== 'string',
    join,
    offset: syncLabel(p.clips, clicked, p.fps),
    sound: sideIds(p, [clicked], 'sound').length > 0,
    picture: sideIds(p, [clicked], 'picture').length > 0,
  };
}

export interface PairSummary { pairs: number; separable: number; outOfSync: number; speed: number; joinWhy: string | null }
export function pairSummary(p: Project | null, ids: readonly string[]): PairSummary {
  const out: PairSummary = { pairs: 0, separable: 0, outOfSync: 0, speed: 1, joinWhy: null };
  if (!p) return out;
  const sides = pictureSides(p, ids);
  out.pairs = sides.length;
  for (const { v } of sides) {
    const d = syncOffset(p.clips, v.id);
    if (d !== null && (Number.isNaN(d) || Math.abs(d) > SYNC_EPS)) out.outOfSync++;
  }
  if (sides.length > 0) out.speed = speedOf(sides[0]!.v);
  // what planSeparate would take: a video with sound on an unlocked track that is not apart yet (a track can always be made)
  const want = new Set(ids);
  const idx = pairIndex(p.clips);
  const trackOf = new Map(p.tracks.map((t) => [t.id, t]));
  const hasAudio = new Set(p.assets.filter((a) => a.hasAudio).map((a) => a.id));
  for (const c of p.clips) {
    if (!want.has(c.id) || c.type !== 'video') continue;
    const t = trackOf.get(c.trackId);
    if (t && !t.locked && hasAudio.has(c.assetId) && (idx.others.get(c.id)?.length ?? 0) === 0) out.separable++;
  }
  // a join reason only when no pair can join: the first pair's reason (planJoin's answer, without building its plan)
  if (sides.length > 0) {
    const index = beatIndex(p);
    let why: string | null = null;
    for (const { v, s } of sides) {
      const w = joinWhy(p, v, s, index);
      if (w === null) { why = null; break; }
      why ??= w;
    }
    out.joinWhy = why;
  }
  return out;
}

export function soundRole(p: Project, id: string): 'apart' | 'sound' | 'separable' | 'none' {
  const idx = pairIndex(p.clips);
  const c = idx.byId.get(id);
  if (!c) return 'none';
  if (c.type === 'video') {
    if ((idx.others.get(id)?.length ?? 0) > 0) return 'apart';
    return p.assets.find((a) => a.id === c.assetId)?.hasAudio ? 'separable' : 'none';
  }
  return idx.mate.has(id) ? 'sound' : 'none';
}

export function soundKeyReason(id: string, p: Project, selection: readonly string[]): string | null {
  switch (id) {
    case 'separate-sound': {
      const t = soundToggle(p, selection);
      return t.kind === 'none' ? t.reason : null;
    }
    case 'join-sound': {
      const j = planJoin(p, selection);
      return typeof j === 'string' ? j : null;
    }
    case 'move-into-sync':
    case 'slip-into-sync': {
      const s = planSync(p, selection, id === 'move-into-sync' ? 'move' : 'slip');
      return typeof s === 'string' ? s : null;
    }
    case 'select-sound':
      return sideIds(p, selection, 'sound').length === 0 ? T.soundPairFirst : null;
    case 'select-picture':
      return sideIds(p, selection, 'picture').length === 0 ? T.soundPairFirst : null;
    default:
      return null;
  }
}
