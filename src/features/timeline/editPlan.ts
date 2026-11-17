/**
 * three point edit planner. pure: `import type` only from stores, no reasons.ts, shortcuts.ts or dom.
 * every rule of a three point edit is here: the targets, the marks, insert's sync, replace's frame match.
 */
import type { Clip, ClipParts, InOutRange, MediaAsset, Project, Track, TrackKind, VideoClip } from '../../types';
import { MAX_SPEED, MIN_CLIP_DURATION, MIN_SPEED, isTimedClip } from '../../types';
import type { Span } from '../../lib/inOut';
import { cleanRange, frameAt } from '../../lib/inOut';
import { DEFAULT_IMAGE_DURATION, createClipFromAsset } from '../../lib/factory';
import { marksOf } from '../../lib/marks';
import { ownSoundsOf, soundFromPicture } from '../../lib/soundPair';
import { formatSeconds } from '../../lib/time';
import { clipEnd } from '../../lib/timelineOps';
import type { ClipMove } from '../../store/editorStore';
import type { IdMaker } from './soundPlan';
import { EDIT_TEXT, editStopText } from './editText';
import { movingTracks, planSyncShift, syncShiftMoves } from './syncShift';

export type EditMode = 'insert' | 'overwrite' | 'replace' | 'fit' | 'append';
export type EditTarget = string | null | false; // null auto, false off, a string = that track
export interface EditTargets { picture: EditTarget; sound: EditTarget }
export const AUTO_TARGETS: EditTargets = { picture: null, sound: null };
export const NEW_VIDEO = 'new:video';
export const NEW_AUDIO = 'new:audio';
export interface EditInput {
  mode: EditMode;
  assetId: string;
  marks?: InOutRange | null;  // source in / out. undefined = marksOf(asset)
  range?: InOutRange | null;  // timeline in / out. undefined = p.range, cleared after use
  playhead: number;
  sourceTime?: number;        // replace: media s landing on the playhead (3.7)
  targets: EditTargets;
  apart: boolean;             // a video with sound arrives as a grouped pair
  selection: readonly string[];
  clipId?: string;            // replace: this clip
}
export type PlaceBy = 'range' | 'in' | 'out' | 'playhead' | 'end' | 'clip';
export interface EditPoints {
  start: number; length: number; from: number; speed: number; // timeline s, timeline s, media s, 1 unless fit
  by: PlaceBy; sourceBy: 'in' | 'out' | 'start'; ignored: 'source-out' | null;
}
export interface NewTrack { key: typeof NEW_VIDEO | typeof NEW_AUDIO; kind: TrackKind }
export interface InsertPrep {
  at: number; by: number;
  split: string[];                                               // cut at `at`
  trims: { id: string; edge: 'start' | 'end'; time: number }[];  // slivers on landing tracks
  deletes: string[];                                             // landing track clips that are slivers both sides
  atOf: Map<string, number>;                                     // track -> edge, a clip moving whole
  lockedSpan: string[];                                          // locked tracks with a clip across `at`
  kept: number; slivers: number;
}
export interface ReplacePlan { clipId: string; swap: boolean; trimStart: number; sounds: { id: string; trimStart: number }[]; soundsKept: number }
export interface EditPlan {
  mode: EditMode; points: EditPoints; parts: ClipParts; pair: boolean;
  clips: { clip: Clip; after?: string }[]; // insert order, a sound right after its picture; trackId may be a NEW key
  newTracks: NewTrack[]; targetIds: string[]; // targetIds: the landing tracks (real ids and NEW keys)
  prep: InsertPrep | null; clear: Span | null; replace: ReplacePlan | null;
  usedRange: boolean; playheadAfter: number | null;
}
export type EditStopWhy = 'media-gone' | 'picture-off' | 'sound-off' | 'targets-off' | 'target-locked' | 'needs-range'
  | 'too-short' | 'before-zero' | 'media-short' | 'media-short-back' | 'fit-fast' | 'fit-slow'
  | 'no-clip-under' | 'replace-kind' | 'replace-text' | 'replace-same' | 'media-before' | 'media-after';
export interface EditStop { why: EditStopWhy; clipId?: string; trackId?: string; have?: number; need?: number; speed?: number; where?: 'in' | 'start' }
export interface EditResult {
  ok: boolean; reason?: string;
  failed: 'plan' | 'apply' | null; // plan: nothing written. apply: rolled back
  mode: EditMode; clips: string[];  // new clips (replace: the clip and its slipped sound clips)
  start: number; length: number; from: number; speed: number;
  split: number; moved: number; removed: number; trimmed: number; slivers: number; kept: number; soundsKept: number;
  lockedTracks: string[]; newTracks: string[]; // track ids
  rangeCleared: InOutRange | null;  // for the toast's undo
}

export function isEditStop(x: EditPlan | EditStop): x is EditStop {
  return 'why' in x;
}

/** the lowest unlocked video track (the last one) or the top unlocked audio track (the first one); a new track when all are locked */
export function autoTargetId(tracks: readonly Track[], kind: TrackKind): string {
  if (kind === 'video') {
    for (let i = tracks.length - 1; i >= 0; i--) if (tracks[i].kind === 'video' && !tracks[i].locked) return tracks[i].id;
    return NEW_VIDEO;
  }
  for (const t of tracks) if (t.kind === 'audio' && !t.locked) return t.id;
  return NEW_AUDIO;
}

/** false = off. a string naming a track of that kind (locked or not) = that id. else auto */
export function targetTrackId(tracks: readonly Track[], kind: TrackKind, target: EditTarget): string | null {
  if (target === false) return null;
  if (typeof target === 'string' && tracks.some((t) => t.id === target && t.kind === kind)) return target;
  return autoTargetId(tracks, kind);
}

let resolved: { tracks: readonly Track[]; picture: EditTarget; sound: EditTarget; out: { picture: string | null; sound: string | null } } | null = null;

/** both targets as track ids. one entry cache, so a caller that asks every frame gets the same object */
export function resolveTargets(tracks: readonly Track[], targets: EditTargets): { picture: string | null; sound: string | null } {
  if (resolved && resolved.tracks === tracks && resolved.picture === targets.picture && resolved.sound === targets.sound) return resolved.out;
  const out = { picture: targetTrackId(tracks, 'video', targets.picture), sound: targetTrackId(tracks, 'audio', targets.sound) };
  resolved = { tracks, picture: targets.picture, sound: targets.sound, out };
  return out;
}

/** which parts of the media land, given the resolved targets (null = off) */
export function partsFor(
  asset: Pick<MediaAsset, 'kind' | 'hasAudio'>,
  picture: string | null,
  sound: string | null,
  apart: boolean,
): { parts: ClipParts; pair: boolean; usesPicture: boolean; usesSound: boolean } | EditStopWhy {
  if (asset.kind === 'audio') {
    if (sound === null) return 'sound-off';
    return { parts: 'both', pair: false, usesPicture: false, usesSound: true };
  }
  if (asset.kind !== 'video' || !asset.hasAudio) {
    if (picture === null) return 'picture-off';
    return { parts: 'both', pair: false, usesPicture: true, usesSound: false };
  }
  if (picture === null && sound === null) return 'targets-off';
  if (sound === null) return { parts: 'picture', pair: false, usesPicture: true, usesSound: false };
  if (picture === null) return { parts: 'sound', pair: false, usesPicture: false, usesSound: true };
  return { parts: 'both', pair: apart, usesPicture: true, usesSound: apart };
}

/** does a clip of this media land on a track of this kind (the bar). the caller ands it with "this track is the lit target" */
export function landsOn(kind: TrackKind, asset: Pick<MediaAsset, 'kind' | 'hasAudio'>, pictureOn: boolean, apart: boolean): boolean {
  if (kind === 'video') return asset.kind !== 'audio';
  return asset.kind === 'audio' || (asset.kind === 'video' && asset.hasAudio && (!pictureOn || apart));
}

/** the lowest unlocked video track and the top unlocked audio track that hold a selected clip. neither: null */
export function selectedTargets(p: Pick<Project, 'clips' | 'tracks'>, selection: readonly string[]): Partial<EditTargets> | null {
  const held = new Set<string>();
  for (const c of p.clips) if (selection.includes(c.id)) held.add(c.trackId);
  let picture: string | null = null;
  let sound: string | null = null;
  for (const t of p.tracks) {
    if (t.locked || !held.has(t.id)) continue;
    if (t.kind === 'video') picture = t.id;
    else if (sound === null) sound = t.id;
  }
  if (picture === null && sound === null) return null;
  return { ...(picture !== null ? { picture } : {}), ...(sound !== null ? { sound } : {}) };
}

const EPS = 1e-6;

/** the clip under t: a clip that starts at t wins over the one that ends there, nothing under the end of the last */
const underAt = (c: Pick<Clip, 'start' | 'duration'>, t: number): boolean => c.start <= t + EPS && t < clipEnd(c) - EPS;

/**
 * where and how long a three point edit is. marks are the source in / out (a picture has none), range the timeline in / out.
 * a stop names why nothing can be placed. usedRange: the timeline marks decided the place or the length
 */
export function editPoints(
  mode: EditMode, asset: MediaAsset, marks: InOutRange | null, range: InOutRange | null, playhead: number, fps: number,
): (EditPoints & { usedRange: boolean }) | EditStop {
  const r = cleanRange(range);
  const picture = asset.kind === 'image';
  const m = picture ? null : cleanRange(marks);
  const dur = asset.duration;
  const s0 = m?.in ?? 0;
  const s1 = m?.out ?? dur;
  const srcLen = picture ? DEFAULT_IMAGE_DURATION : s1 - s0;
  const short = (len: number): boolean => len < MIN_CLIP_DURATION - EPS;
  if (!picture && dur < MIN_CLIP_DURATION - EPS) return { why: 'too-short' };
  const hasRange = r?.in !== undefined && r.out !== undefined;
  const sourceBy: EditPoints['sourceBy'] = m?.in !== undefined ? 'in' : 'start';
  if (mode === 'fit') {
    if (!hasRange) return { why: 'needs-range' };
    const len = r!.out! - r!.in!;
    if (short(len)) return { why: 'too-short' };
    if (picture) return { start: r!.in!, length: len, from: 0, speed: 1, by: 'range', sourceBy: 'start', ignored: null, usedRange: true };
    if (short(srcLen)) return { why: 'too-short' };
    const speed = srcLen / len;
    if (speed > MAX_SPEED + 1e-9) return { why: 'fit-fast', speed };
    if (speed < MIN_SPEED - 1e-9) return { why: 'fit-slow', speed };
    return { start: r!.in!, length: len, from: s0, speed: Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed)), by: 'range', sourceBy, ignored: null, usedRange: true };
  }
  if (mode !== 'append' && hasRange) {
    const len = r!.out! - r!.in!;
    if (short(len)) return { why: 'too-short' };
    const at = { start: r!.in!, length: len, speed: 1, by: 'range' as const, usedRange: true };
    if (picture) return { ...at, from: 0, sourceBy: 'start', ignored: null };
    if (m?.in !== undefined) {
      if (m.in + len > dur + EPS) return { why: 'media-short', have: dur - m.in, need: len, where: 'in' };
      return { ...at, from: m.in, sourceBy: 'in', ignored: m.out !== undefined ? 'source-out' : null };
    }
    if (m?.out !== undefined) {
      const back = m.out - len;
      if (back < -EPS) return { why: 'media-short-back', have: m.out, need: len };
      return { ...at, from: Math.max(0, back), sourceBy: 'out', ignored: null };
    }
    if (len > dur + EPS) return { why: 'media-short', have: dur, need: len, where: 'start' };
    return { ...at, from: 0, sourceBy: 'start', ignored: null };
  }
  // rule b: the length is the marked part
  if (short(srcLen)) return { why: 'too-short' };
  const from = picture ? 0 : s0;
  const same = { length: srcLen, from, speed: 1, sourceBy: picture ? ('start' as const) : sourceBy, ignored: null };
  if (mode === 'append') return { ...same, start: 0, by: 'end', usedRange: false };
  if (r?.in !== undefined) return { ...same, start: r.in, by: 'in', usedRange: true };
  if (r?.out !== undefined) {
    const start = r.out - srcLen;
    if (start < -EPS) return { why: 'before-zero' };
    return { ...same, start: Math.max(0, start), by: 'out', usedRange: true };
  }
  return { ...same, start: frameAt(playhead, fps), by: 'playhead', usedRange: false };
}

type Planned = Pick<Project, 'clips' | 'tracks'>;

function replaceStop(why: EditStopWhy, extra: Partial<EditStop> = {}): EditStop {
  return { why, ...extra };
}

/** the clip a replace works on (3.7): the asked clip, a selected one under the playhead, else what the targets show */
function replaceClip(p: Project, input: EditInput, asset: MediaAsset): Clip | EditStop {
  const t = input.playhead;
  if (input.clipId !== undefined) return p.clips.find((c) => c.id === input.clipId) ?? replaceStop('no-clip-under');
  const rank = new Map<string, number>();
  p.tracks.forEach((tr, i) => rank.set(tr.id, i));
  const isMedia = (c: Clip): boolean => c.type === 'video' || c.type === 'audio' || c.type === 'image';
  const picked = p.clips
    .filter((c) => input.selection.includes(c.id) && isMedia(c) && underAt(c, t))
    .sort((a, b) => (rank.get(a.trackId) ?? 0) - (rank.get(b.trackId) ?? 0));
  if (picked[0]) return picked[0];
  const tg = resolveTargets(p.tracks, input.targets);
  const withSound = asset.kind === 'video' && asset.hasAudio;
  const look: (string | null)[] = asset.kind === 'audio' ? [tg.sound] : withSound ? [tg.picture, tg.sound] : [tg.picture];
  if (look.every((id) => id === null)) return replaceStop(asset.kind === 'audio' ? 'sound-off' : withSound ? 'targets-off' : 'picture-off');
  const real: string[] = [];
  for (const id of look) {
    if (id === null || !p.tracks.some((x) => x.id === id)) continue;
    real.push(id);
    const hit = p.clips.find((c) => c.trackId === id && underAt(c, t));
    if (hit) return hit;
  }
  return replaceStop('no-clip-under', real.length === 1 ? { trackId: real[0] } : {});
}

/** a replace (3.7): the media of a clip changes and slips so the source playhead frame lands on the timeline playhead */
function planReplace(p: Project, input: EditInput, asset: MediaAsset, marks: InOutRange | null): EditPlan | EditStop {
  const found = replaceClip(p, input, asset);
  if ('why' in found) return found;
  const clip = found;
  if (clip.type !== 'video' && clip.type !== 'audio' && clip.type !== 'image') return replaceStop('replace-text', { clipId: clip.id });
  const fits = asset.kind === clip.type || (clip.type === 'audio' && asset.kind === 'video' && asset.hasAudio);
  if (!fits) return replaceStop('replace-kind', { clipId: clip.id });
  if (p.tracks.find((x) => x.id === clip.trackId)?.locked) return replaceStop('target-locked', { clipId: clip.id, trackId: clip.trackId });
  const swap = clip.assetId !== asset.id;
  const points = (from: number, speed: number): EditPoints => ({ start: clip.start, length: clip.duration, from, speed, by: 'clip', sourceBy: 'in', ignored: null });
  const plan = (from: number, speed: number, rep: ReplacePlan): EditPlan => ({
    mode: 'replace', points: points(from, speed), parts: 'both', pair: false, clips: [], newTracks: [], targetIds: [clip.trackId],
    prep: null, clear: null, replace: rep, usedRange: false, playheadAfter: null,
  });
  if (clip.type === 'image') {
    if (!swap) return replaceStop('replace-same', { clipId: clip.id });
    return plan(0, 1, { clipId: clip.id, swap, trimStart: 0, sounds: [], soundsKept: 0 });
  }
  const speed = clip.speed > 0 ? clip.speed : 1;
  const off = input.playhead - clip.start;
  const want = input.sourceTime ?? ((marks?.in ?? 0) + off * speed);
  const bound = (c: { id: string; duration: number; speed: number }, start: number): number | EditStop => {
    const sp = c.speed > 0 ? c.speed : 1;
    if (start < -EPS) return replaceStop('media-before', { clipId: c.id });
    if (start + c.duration * sp > asset.duration + EPS) return replaceStop('media-after', { clipId: c.id });
    return Math.min(Math.max(start, 0), Math.max(0, asset.duration - c.duration * sp));
  };
  const own = bound(clip, want - off * speed);
  if (typeof own !== 'number') return own;
  const d = own - clip.trimStart;
  const sounds: ReplacePlan['sounds'] = [];
  let soundsKept = 0;
  let still = !swap && Math.abs(own - clip.trimStart) < 1e-9;
  if (clip.type === 'video') {
    const open = new Set(p.tracks.filter((x) => !x.locked).map((x) => x.id));
    for (const s of ownSoundsOf(p.clips, clip)) {
      if (!open.has(s.trackId) || (swap && !asset.hasAudio)) {
        soundsKept++;
        continue;
      }
      const to = bound(s, s.trimStart + d);
      if (typeof to !== 'number') return to;
      if (Math.abs(to - s.trimStart) >= 1e-9) still = false;
      sounds.push({ id: s.id, trimStart: to });
    }
  }
  if (still) return replaceStop('replace-same', { clipId: clip.id });
  return plan(own, speed, { clipId: clip.id, swap, trimStart: own, sounds, soundsKept });
}

/** what an edit does, in order (3.5). a stop writes nothing */
export function planEdit(p: Project, input: EditInput, make: IdMaker): EditPlan | EditStop {
  const asset = p.assets.find((a) => a.id === input.assetId);
  if (!asset) return { why: 'media-gone' };
  const picture = asset.kind === 'image';
  const marks = picture ? null : input.marks === undefined ? marksOf(asset) : cleanRange(input.marks);
  const range = input.range === undefined ? cleanRange(p.range) : cleanRange(input.range);
  if (input.mode === 'replace') return planReplace(p, input, asset, marks);
  const tg = resolveTargets(p.tracks, input.targets);
  const pf = partsFor(asset, tg.picture, tg.sound, input.apart);
  if (typeof pf === 'string') return { why: pf };
  const pictureTrack = pf.usesPicture ? tg.picture : null;
  const soundTrack = pf.usesSound ? tg.sound : null;
  const landing = [pictureTrack, soundTrack].filter((id): id is string => id !== null);
  const newTracks: NewTrack[] = [];
  for (const id of landing) {
    if (id === NEW_VIDEO) newTracks.push({ key: NEW_VIDEO, kind: 'video' });
    else if (id === NEW_AUDIO) newTracks.push({ key: NEW_AUDIO, kind: 'audio' });
    else if (p.tracks.find((x) => x.id === id)?.locked) return { why: 'target-locked', trackId: id };
  }
  const real = landing.filter((id) => id !== NEW_VIDEO && id !== NEW_AUDIO);
  const pts = editPoints(input.mode, asset, marks, range, input.playhead, p.fps);
  if ('why' in pts) return pts;
  const { usedRange, ...points } = pts;
  if (input.mode === 'append') {
    const open = new Set(real);
    points.start = p.clips.reduce((m, c) => (open.has(c.trackId) ? Math.max(m, clipEnd(c)) : m), 0);
  }
  const { start, length, from, speed } = points;
  const one = (trackId: string, parts: ClipParts): Clip => {
    const base = createClipFromAsset(asset, trackId, start, { range: { in: from, out: from + length * speed }, parts });
    return isTimedClip(base) ? { ...base, id: make.clip(), duration: length, trimStart: from, speed } : { ...base, id: make.clip(), duration: length };
  };
  const clips: EditPlan['clips'] = [];
  if (pf.pair) {
    const v = one(pictureTrack!, 'both') as VideoClip;
    const g = make.group();
    const s = soundFromPicture(v, make.clip(), soundTrack!, g);
    const shown: VideoClip = { ...v, muted: true, group: g };
    clips.push({ clip: shown }, { clip: s, after: shown.id });
  } else {
    clips.push({ clip: one((pf.usesPicture ? pictureTrack : soundTrack)!, pf.parts) });
  }
  return {
    mode: input.mode, points, parts: pf.parts, pair: pf.pair, clips, newTracks, targetIds: landing,
    prep: input.mode === 'insert' ? insertPrep(p, start, length, real) : null,
    clear: input.mode === 'overwrite' || input.mode === 'fit' ? { start, end: start + length } : null,
    replace: null, usedRange, playheadAfter: start + length,
  };
}

/**
 * insert (3.6): what happens to the clips across the edit point. moving = the tracks that move with it (movingTracks, one place).
 * a locked track is only named
 */
export function insertPrep(p: Planned, at: number, by: number, landing: readonly string[]): InsertPrep {
  const moving = movingTracks(p.tracks, new Set(landing));
  const lands = new Set(landing);
  const prep: InsertPrep = { at, by, split: [], trims: [], deletes: [], atOf: new Map(), lockedSpan: [], kept: 0, slivers: 0 };
  const sliver = (len: number): number => (len > EPS ? 1 : 0);
  for (const c of p.clips) {
    if (!(c.start < at - EPS && clipEnd(c) > at + EPS)) continue;
    const keepL = at - c.start;
    const keepR = clipEnd(c) - at;
    if (!moving.has(c.trackId)) {
      if (!prep.lockedSpan.includes(c.trackId)) prep.lockedSpan.push(c.trackId);
      continue;
    }
    const okL = at > c.start + MIN_CLIP_DURATION;
    const okR = at < clipEnd(c) - MIN_CLIP_DURATION;
    if (okL && okR) {
      prep.split.push(c.id);
    } else if (lands.has(c.trackId)) {
      if (okL) {
        prep.trims.push({ id: c.id, edge: 'end', time: at });
        prep.slivers += sliver(keepR);
      } else if (okR) {
        prep.trims.push({ id: c.id, edge: 'start', time: at });
        prep.slivers += sliver(keepL);
      } else {
        prep.deletes.push(c.id);
        prep.slivers += sliver(keepL) + sliver(keepR);
      }
    } else if (okL) {
      prep.kept++;
    } else {
      prep.atOf.set(c.trackId, c.start);
      prep.kept++;
    }
  }
  return prep;
}

/** the moves of an insert on the project after the splits: the sync shift (followers and locked tracks included) by `by` */
export function planInsertMoves(
  now: Planned, at: number, by: number, edited: ReadonlySet<string>, atOf: ReadonlyMap<string, number>,
): { moves: ClipMove[]; lockedBehind: string[] } {
  const s = planSyncShift(now, at, new Set(), edited, atOf);
  return { moves: syncShiftMoves(s, by), lockedBehind: s.lockedBehind };
}

export interface EditSummary { text: string; blocked: boolean; fit: string | null }

let summed: {
  assets: Project['assets']; tracks: Project['tracks']; range: Project['range']; fps: number;
  assetId: string; picture: EditTarget; sound: EditTarget; apart: boolean; out: EditSummary | null;
} | null = null;

function summarize(p: Project, asset: MediaAsset, targets: EditTargets, apart: boolean): EditSummary {
  const stop = (s: EditStop): EditSummary => ({ text: editStopText(s, p), blocked: true, fit: null });
  const tg = resolveTargets(p.tracks, targets);
  const pf = partsFor(asset, tg.picture, tg.sound, apart);
  if (typeof pf === 'string') return stop({ why: pf });
  const landing = [pf.usesPicture ? tg.picture : null, pf.usesSound ? tg.sound : null].filter((id): id is string => id !== null);
  const names: string[] = [];
  for (const id of landing) {
    if (id === NEW_VIDEO || id === NEW_AUDIO) {
      names.push(EDIT_TEXT.onNew.replace('{kind}', id === NEW_VIDEO ? 'video' : 'audio'));
      continue;
    }
    const t = p.tracks.find((x) => x.id === id);
    if (t?.locked) return stop({ why: 'target-locked', trackId: id });
    names.push(t?.name ?? id);
  }
  const marks = marksOf(asset);
  const pts = editPoints('insert', asset, marks, cleanRange(p.range), 0, p.fps);
  if ('why' in pts) return stop(pts);
  const where = pts.by === 'range' ? EDIT_TEXT.atRange : pts.by === 'in' ? EDIT_TEXT.atIn : pts.by === 'out' ? EDIT_TEXT.atOut : EDIT_TEXT.atPlayhead;
  let text = `${formatSeconds(pts.length)} ${where} on ${names.join(' and ')}`;
  if (pts.ignored) text += `. ${EDIT_TEXT.fourth}`;
  if (pts.by === 'range' && pts.sourceBy === 'out') text += `. ${EDIT_TEXT.backtimed}`;
  const r = cleanRange(p.range);
  let fit: string | null = null;
  if (r?.in !== undefined && r.out !== undefined && asset.kind !== 'image') {
    const len = r.out - r.in;
    const srcLen = (marks?.out ?? asset.duration) - (marks?.in ?? 0);
    if (len > EPS && srcLen > EPS) fit = EDIT_TEXT.fitDoes.replace('{len}', formatSeconds(len)).replace('{speed}', String(Math.round((srcLen / len) * 100) / 100));
  }
  return { text, blocked: false, fit };
}

/** the readout under the source view. no playhead in it, so a drag or playback never recomputes it. null without media */
export function editSummary(p: Project | null, assetId: string | null, targets: EditTargets, apart: boolean): EditSummary | null {
  if (!p || !assetId) return null;
  const asset = p.assets.find((a) => a.id === assetId);
  if (!asset) return null;
  const c = summed;
  if (c && c.assets === p.assets && c.tracks === p.tracks && c.range === p.range && c.fps === p.fps && c.assetId === assetId && c.picture === targets.picture && c.sound === targets.sound && c.apart === apart) return c.out;
  const out = summarize(p, asset, targets, apart);
  summed = { assets: p.assets, tracks: p.tracks, range: p.range, fps: p.fps, assetId, picture: targets.picture, sound: targets.sound, apart, out };
  return out;
}

/** why this edit would do nothing now: a plan with separate sound off. null when it can work */
export function editReason(
  mode: EditMode,
  p: Project,
  ctx: { assetId: string | null; sourceTime: number; playhead: number; selection: readonly string[]; targets: EditTargets },
): string | null {
  if (ctx.assetId === null) return null;
  let n = 0;
  const make: IdMaker = { clip: () => `reason-clip-${n++}`, group: () => `reason-group-${n++}` };
  const plan = planEdit(p, {
    mode, assetId: ctx.assetId, playhead: ctx.playhead, sourceTime: ctx.sourceTime, targets: ctx.targets, apart: false, selection: ctx.selection,
  }, make);
  return isEditStop(plan) ? editStopText(plan, p) : null;
}
