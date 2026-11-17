/**
 * separate sound: a picture (video clip) and its sound clips (audio clips of the same file in the same group). nothing
 * of it is stored: a pair is found from the group, the file and the clip types. pure.
 * "sync point" = where the start of the file would sit on the timeline. the same sync point = in sync.
 */
import type { AudioClip, Clip, Keyframes, MediaAsset, TimedClip, VideoClip } from '../types';
import { isTimedClip } from '../types';
import { animProps } from './anim';
import { clipEnd } from './timelineOps';

/** sync points closer than this are the same */
export const SYNC_EPS = 1e-6;
/** the fields of a video clip that only change its sound */
export const SOUND_FIELDS = ['volume', 'muted', 'pan', 'bpm', 'beatOffset'] as const;

/** the keyframe properties that only change sound: volume and pan */
export function soundProps(): string[] {
  return animProps({ type: 'audio' } as Clip).map((p) => p.prop);
}

/** an audio clip whose media is a video file: the sound of a picture */
export function isSoundClip(c: Clip, assets: readonly Pick<MediaAsset, 'id' | 'kind'>[]): c is AudioClip {
  return c.type === 'audio' && assets.find((a) => a.id === c.assetId)?.kind === 'video';
}

const speedOf = (c: Pick<TimedClip, 'speed'>): number => (c.speed > 0 ? c.speed : 1);

/** the timeline time the start of the file sits at: start - trimStart / speed (a speed of 0 or less reads as 1) */
export function syncPoint(c: Pick<TimedClip, 'start' | 'trimStart' | 'speed'>): number {
  return c.start - c.trimStart / speedOf(c);
}

export interface PairIndex {
  /** clip id -> the id of the clip it is paired with. only clips that have others */
  mate: Map<string, string>;
  /** clip id -> the ids of the clips of its group with the other type and the same file, in project order */
  others: Map<string, string[]>;
  /** every video and audio clip */
  byId: Map<string, TimedClip>;
}

const cache = new WeakMap<readonly Clip[], PairIndex>();

/** the pairs of a clip list. cached per array, so the same list is indexed once */
export function pairIndex(clips: readonly Clip[]): PairIndex {
  const hit = cache.get(clips);
  if (hit) return hit;
  const byId = new Map<string, TimedClip>();
  const groups = new Map<string, TimedClip[]>();
  for (const c of clips) {
    if (!isTimedClip(c)) continue;
    byId.set(c.id, c);
    if (!c.group) continue;
    const list = groups.get(c.group);
    if (list) list.push(c);
    else groups.set(c.group, [c]);
  }
  const mate = new Map<string, string>();
  const others = new Map<string, string[]>();
  for (const list of groups.values()) {
    // bucket by file once, so a clip only looks at the other kind of its own file
    const pictures = new Map<string, TimedClip[]>();
    const sounds = new Map<string, TimedClip[]>();
    for (const c of list) {
      const side = c.type === 'video' ? pictures : c.type === 'audio' ? sounds : null;
      if (!side || c.assetId === undefined) continue;
      const bucket = side.get(c.assetId);
      if (bucket) bucket.push(c);
      else side.set(c.assetId, [c]);
    }
    for (const c of list) {
      const rest = (c.type === 'video' ? sounds : c.type === 'audio' ? pictures : null)?.get(c.assetId as string) ?? [];
      if (rest.length === 0) continue;
      others.set(c.id, rest.map((o) => o.id));
      let best: TimedClip | null = null;
      let bestOverlap = 0;
      let bestGap = 0;
      for (const o of rest) {
        const overlap = Math.max(0, Math.min(clipEnd(c), clipEnd(o)) - Math.max(c.start, o.start));
        const gap = Math.abs(syncPoint(c) - syncPoint(o));
        if (best === null || overlap > bestOverlap + 1e-9 || (Math.abs(overlap - bestOverlap) <= 1e-9 && gap < bestGap)) {
          best = o;
          bestOverlap = overlap;
          bestGap = gap;
        }
      }
      if (best) mate.set(c.id, best.id);
    }
  }
  const index: PairIndex = { mate, others, byId };
  cache.set(clips, index);
  return index;
}

/** the clip paired with this one: a picture's best sound clip, a sound clip's picture. null for a lone clip */
export function mateOf(clips: readonly Clip[], id: string): TimedClip | null {
  const ix = pairIndex(clips);
  const m = ix.mate.get(id);
  return m ? (ix.byId.get(m) ?? null) : null;
}

/** the sound clips of a picture, in project order. empty for any other clip */
export function soundsOf(clips: readonly Clip[], picture: Clip): AudioClip[] {
  if (picture.type !== 'video') return [];
  const ix = pairIndex(clips);
  const out: AudioClip[] = [];
  for (const id of ix.others.get(picture.id) ?? []) {
    const c = ix.byId.get(id);
    if (c && c.type === 'audio') out.push(c);
  }
  return out;
}

/** the sound clips whose best picture is this one: after a j or l cut a group holds several shots, each with its own sound */
export function ownSoundsOf(clips: readonly Clip[], picture: Clip): AudioClip[] {
  const ix = pairIndex(clips);
  return soundsOf(clips, picture).filter((s) => ix.mate.get(s.id) === picture.id);
}

/** a picture whose sound is apart: a video clip with sound clips of its file in its group */
export function hasSoundApart(clips: readonly Clip[], id: string): boolean {
  const ix = pairIndex(clips);
  return ix.byId.get(id)?.type === 'video' && (ix.others.get(id)?.length ?? 0) > 0;
}

/** a and b are each other's mate */
export function isPair(clips: readonly Clip[], a: string, b: string): boolean {
  const ix = pairIndex(clips);
  return ix.mate.get(a) === b && ix.mate.get(b) === a;
}

/** how far this clip's sync point lies after its mate's (seconds, + = this clip later). NaN when the speeds differ, null without a mate */
export function syncOffset(clips: readonly Clip[], id: string): number | null {
  const ix = pairIndex(clips);
  const c = ix.byId.get(id);
  const m = mateOf(clips, id);
  if (!c || !m) return null;
  if (Math.abs(speedOf(c) - speedOf(m)) > 1e-9) return NaN;
  return syncPoint(c) - syncPoint(m);
}

/** '+3f', '-0.4f', '+12.5s': the offset as a badge shows it. frames (tenths under one frame) up to 999 frames, then seconds */
export function formatSyncOffset(d: number, fps: number): string {
  const sign = d > 0 ? '+' : '-';
  const frames = Math.abs(d) * Math.max(1, fps);
  if (frames < 0.95) return `${sign}${Math.max(0.1, Math.round(frames * 10) / 10).toFixed(1)}f`;
  if (frames < 999.5) return `${sign}${Math.round(frames)}f`;
  return `${sign}${Math.abs(d).toFixed(1)}s`;
}

/** what the sync badge says: null in sync or without a mate, 'speed' for other speeds, else the offset */
export function syncLabel(clips: readonly Clip[], id: string, fps: number): string | null {
  const d = syncOffset(clips, id);
  if (d === null) return null;
  if (Number.isNaN(d)) return 'speed';
  if (Math.abs(d) <= SYNC_EPS) return null;
  return formatSyncOffset(d, fps);
}

/** the clips a mute changes: a picture with its sound apart stands for its sound clips, any other timed clip for itself. each once, project order */
export function muteTargets(clips: readonly Clip[], ids: Iterable<string>): TimedClip[] {
  const ix = pairIndex(clips);
  const want = new Set<string>();
  for (const id of ids) {
    const c = ix.byId.get(id);
    if (!c) continue;
    const apart = c.type === 'video' ? ix.others.get(id) : undefined;
    if (apart && apart.length > 0) {
      // the sound clips paired with this picture, or all of them when the sound is shared with another shot
      const mine = apart.filter((o) => ix.mate.get(o) === id);
      for (const o of mine.length > 0 ? mine : apart) want.add(o);
    } else want.add(id);
  }
  const out: TimedClip[] = [];
  for (const c of clips) if (isTimedClip(c) && want.has(c.id)) out.push(c);
  return out;
}

type TrackSound = { muted: boolean; volume?: number; pan?: number };
/** the same mute, level and pan */
export function sameTrackSound(a: TrackSound, b: TrackSound): boolean {
  return a.muted === b.muted && (a.volume ?? 1) === (b.volume ?? 1) && (a.pan ?? 0) === (b.pan ?? 0);
}

/** the sound clip of a picture: the file, the span, the fades and every sound field of it, none of the picture's look */
export function soundFromPicture(v: VideoClip, id: string, trackId: string, group: string | undefined): AudioClip {
  const out: AudioClip = {
    id,
    type: 'audio',
    trackId,
    start: v.start,
    duration: v.duration,
    name: v.name,
    fadeIn: v.fadeIn,
    fadeOut: v.fadeOut,
    assetId: v.assetId,
    trimStart: v.trimStart,
    speed: v.speed,
    volume: v.volume,
    muted: v.muted,
  };
  const from = v as unknown as Record<string, unknown>;
  const to = out as unknown as Record<string, unknown>;
  for (const k of SOUND_FIELDS) if (from[k] !== undefined) to[k] = from[k];
  const kf = soundKeys(v.keyframes);
  if (kf) out.keyframes = kf;
  if (group !== undefined) out.group = group;
  return out;
}

/** a copy of the keys of the sound properties (volume, pan). undefined when there are none */
export function soundKeys(kf: Keyframes | undefined): Keyframes | undefined {
  if (!kf) return undefined;
  const out: Keyframes = {};
  for (const p of soundProps()) {
    const keys = kf[p];
    if (keys && keys.length > 0) out[p] = structuredClone(keys);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** the picture's keys with its sound properties replaced by the sound clip's. undefined when nothing is left */
export function withSoundKeys(picture: Keyframes | undefined, sound: Keyframes | undefined): Keyframes | undefined {
  const own = new Set(soundProps());
  const out: Keyframes = {};
  if (picture) for (const k of Object.keys(picture)) if (!own.has(k)) out[k] = picture[k]!;
  if (sound) for (const p of own) if (sound[p] && sound[p]!.length > 0) out[p] = structuredClone(sound[p]!);
  return Object.keys(out).length > 0 ? out : undefined;
}

/** a cut at `time` leaves c in its group when a clip of the other type and the same file plays on over it and is not cut itself, so a j or l cut stays one pair */
export function keepsSoundGroup(clips: readonly Clip[], c: Clip, time: number, isCut: (o: Clip) => boolean): boolean {
  if (!c.group || !isTimedClip(c)) return false;
  const end = clipEnd(c);
  return clips.some((o) => o.id !== c.id && o.group === c.group && isTimedClip(o) && o.type !== c.type
    && o.assetId === c.assetId && o.start < end - 1e-9 && clipEnd(o) > time + 1e-9 && !isCut(o));
}
