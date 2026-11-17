/** the words of trim mode: why a trim stopped, the toasts. pure */
import { syncLockOf } from '../../lib/trackTools';
import { clipDisplayName } from './effectTarget';
import type { P, TrimStop, TrimStopWhy } from './trimModes';

export const TRIM_STOP_TEXT: Record<TrimStopWhy, string> = {
  'min-length': '{clip} cannot get shorter than 0.05 s',
  'media-start': '{clip} has no more media before its first frame',
  'media-end': '{clip} has no more media after its last frame',
  'overlap': '{clip} would run into {other}',
  'timeline-start': '{clip} would start before 0',
  'speed-fast': '{clip} would play faster than 4x',
  'speed-slow': '{clip} would play slower than 0.25x',
  'needs-media': 'slip and stretch need a video or audio clip',
  'no-edit': '{clip} does not touch another clip there: no edit to move',
  'locked': '{clip} is on a locked track',
};

export const TRIM_TEXT = {
  modeOn: 'trim mode on',
  modeOff: 'trim mode off',
  lockedStay: 'locked tracks did not move: {tracks}',
  outOfSync: 'out of sync now: {clips}',
  outOfSyncOff: 'out of sync now: {clips} (sync lock is off on {tracks})',
  dragStopped: 'the timeline changed, the drag stopped',
  selectedEdit: 'selected the end of {a} and the start of {b}',
  selectedEnd: 'selected the end of {a}',
  selectedStart: 'selected the start of {a}',
} as const;

/** the clip's name in quotes, cut to 24 characters. 'a clip' when it is gone or has no name */
export function clipLabel(p: P, id: string): string {
  const c = p.clips.find((x) => x.id === id);
  const name = c ? clipDisplayName(c).trim() : '';
  if (!name) return 'a clip';
  return name.length > 24 ? `"${name.slice(0, 23)}…"` : `"${name}"`;
}

export function trimStopText(stop: TrimStop, p: P): string {
  // one pass with a function replacer, so nothing in a name is read as a pattern or scanned again
  const v: Record<string, string> = { clip: clipLabel(p, stop.clipId), other: clipLabel(p, stop.otherId ?? '') };
  return TRIM_STOP_TEXT[stop.why].replace(/\{(clip|other)\}/g, (_, k: string) => v[k]!);
}

/** the names of those tracks, comma separated, in the given order. unknown ids are skipped */
export function lockedTracksText(p: P, trackIds: readonly string[]): string {
  const names: string[] = [];
  for (const id of trackIds) {
    const t = p.tracks.find((x) => x.id === id);
    if (t) names.push(t.name);
  }
  return names.join(', ');
}

/** the clips that went out of sync, by name. when some sit on sync lock off tracks, those tracks are named too */
export function outOfSyncText(p: P, clipIds: readonly string[]): string {
  const clips = clipIds.map((id) => clipLabel(p, id)).join(', ');
  const on = new Set<string>();
  for (const id of clipIds) {
    const c = p.clips.find((x) => x.id === id);
    if (c) on.add(c.trackId);
  }
  const off = p.tracks.filter((t) => on.has(t.id) && !t.locked && !syncLockOf(t)).map((t) => t.id);
  if (off.length === 0) return TRIM_TEXT.outOfSync.replace('{clips}', () => clips);
  return TRIM_TEXT.outOfSyncOff.replace(/{(clips|tracks)}/g, (_, k: string) => (k === 'clips' ? clips : lockedTracksText(p, off)));
}

/** the readout tail of a plan: sync lock off tracks that stay, clips that went out of sync */
export function syncSuffix(plan: { freeBehind?: readonly string[]; drift?: readonly string[] }): string {
  let text = '';
  if (plan.freeBehind && plan.freeBehind.length > 0) text += ', sync lock off tracks stay';
  const n = plan.drift?.length ?? 0;
  if (n > 0) text += `, ${n} clip${n > 1 ? 's' : ''} out of sync`;
  return text;
}
