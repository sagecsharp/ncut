/**
 * the editor store. single source of truth for the open project, selection, history and view state.
 *
 * rules:
 * - the project is immutable. every action builds a new Project object.
 * - every mutating action records an undo step unless called with { skipHistory: true }.
 *   for drags: call pushHistory() once when the drag really starts, then pass skipHistory on each update.
 * - clips on one track never overlap. actions that would cause overlap are rejected or clamped.
 * - this module has no dom / indexeddb imports so it can run in unit tests.
 *
 * zustand v5 gotcha: a selector must return a stable reference. never do
 *   useEditor(s => s.project.clips.filter(...))   // new array every call -> infinite render loop
 * use the hooks at the bottom of this file, or useMemo over a stable slice, or useShallow.
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import type {
  AudioClip,
  CameraClip,
  Clip,
  ClipBend,
  ClipGrade,
  ClipParts,
  Easing,
  EffectClip,
  ImageClip,
  InOutRange,
  Keyframe,
  Keyframes,
  MediaAsset,
  Pivot,
  Project,
  ShapeClip,
  TextClip,
  Track,
  TrackKind,
  Transform,
  VideoClip,
} from '../types';
import { MAX_SCALE, MAX_SPEED, MIN_CLIP_DURATION, MIN_SCALE, MIN_SPEED, isCameraClip, isTimedClip, isVisualClip, stretchX, stretchY, stretchZ, trackKindForClip } from '../types';
import {
  DEFAULT_CAMERA_DURATION,
  DEFAULT_EFFECT_DURATION,
  DEFAULT_SHAPE_DURATION,
  DEFAULT_TEXT_DURATION,
  MAX_FPS,
  createCameraClip,
  createClipFromAsset,
  createEffectClip,
  createShapeClip,
  createTextClip,
  createTrack,
  clipTypeFor,
} from '../lib/factory';
import { cleanRange, sameRange } from '../lib/inOut';
import { normalizeGrade, sameGrade, withoutGradeKeys } from '../lib/gradeData';
import { patchOutput, patchTrack, planMixerReset } from '../lib/mix';
import { keepsSoundGroup, ownSoundsOf } from '../lib/soundPair';
import { getEffect } from '../engine/effects/registry';
import { hasKeyedPose, reparentTransform } from '../engine/parent';
import { normalizePivot, samePivot } from '../engine/pivot';
import { parseBend } from '../engine/scene3d/bend';
import {
  KEY_EPS,
  animProps,
  baseValue,
  canKey,
  isSeedable,
  evalKeys,
  isAnimated,
  keyIndexAt,
  shiftKeyframes,
  valueAt,
  withKeyAt,
  withBaseValue,
  withValueAt,
  withoutKeyAt,
  withoutKeys,
} from '../lib/anim';
import { uid } from '../lib/id';
import { relinkCopies, repointSplitHalves, unlinkRemoved, wouldCycle } from '../lib/links';
import { faceClipId, faceSourceIds, remapFaces } from '../engine/scene3d/faces';
import { skyUses } from '../engine/scene3d/sky';
import { BPM_MAX, BPM_MIN, type EffectBeat, parseBeatOffset, parseBpm, parseEffectBeat, sameEffectBeat } from '../lib/tempo';
import { clamp } from '../lib/time';
import {
  clipEnd,
  findFreeStart,
  findTrackWithRoom,
  getTrackClips,
  isRangeFree,
  maxClipDuration,
  normalizeTrackOrder,
  rangesOverlap,
} from '../lib/timelineOps';
import { selectableIds } from './selectableIds';

const HISTORY_LIMIT = 100;
export const MIN_ZOOM = 4;
export const MAX_ZOOM = 600;
export const DEFAULT_ZOOM = 80;

/** one clip's bend write (setBends). keys: undefined = keep the bend.angle keys, null = remove them, a list = these (clip-local seconds) */
export interface BendWrite {
  id: string;
  bend: ClipBend | null;
  keys?: readonly Keyframe[] | null;
}

export interface ActionOpts {
  /** do not record an undo step for this change */
  skipHistory?: boolean;
}

/** one edit of setClipValues. time is a timeline time, value in stored units */
export interface ClipValueEdit {
  id: string;
  prop: string;
  time: number;
  value: number;
}

type LockedKeys = 'id' | 'type' | 'trackId' | 'start' | 'duration' | 'trimStart' | 'speed';
/** any editable clip field. fields that do not exist on the target clip type are ignored. */
export type ClipPatch = Partial<Omit<VideoClip, LockedKeys>> &
  Partial<Omit<ImageClip, LockedKeys>> &
  Partial<Omit<AudioClip, LockedKeys>> &
  Partial<Omit<TextClip, LockedKeys>> &
  Partial<Omit<ShapeClip, LockedKeys>> &
  Partial<Omit<EffectClip, LockedKeys>> &
  Partial<Omit<CameraClip, LockedKeys>>;

/** fields that may be missing on a stored clip but can still be set through updateClip */
const SPATIAL_KEYS = [
  'threeD',
  'lookAt',
  'shape',
  'shapeDepth',
  'lit',
  'faces',
  'transition',
  'blend',
  'crop',
  'radius',
  'motionIn',
  'motionOut',
  'motionLoop',
  'parent',
  'motionBlur',
  'adjust',
  'chromaKey',
  'mask',
  'lookTarget',
  'bend',
  'pivot',
  'grade',
] as const;
const OPTIONAL_CLIP_KEYS: Record<string, readonly string[]> = {
  video: [...SPATIAL_KEYS, 'bpm', 'beatOffset', 'pan'],
  audio: ['bpm', 'beatOffset', 'pan'],
  image: SPATIAL_KEYS,
  text: [
    ...SPATIAL_KEYS,
    'letterSpacing',
    'lineHeight',
    'uppercase',
    'stroke',
    'shadow',
    'backgroundRadius',
    'backgroundPadding',
    'animIn',
    'animOut',
    'animLoop',
    'gradient',
    'curve',
    'wrapWidth',
    'highlight',
    'extrude',
    'counter',
    'underline',
    'strike',
    'hollow',
    'backgroundPerLine',
    'stroke2',
  ],
  shape: [...SPATIAL_KEYS, 'color2', 'gradientAngle', 'gradientRadial', 'filled', 'stroke', 'points', 'inner', 'drawStart', 'drawEnd'],
  camera: ['target', 'focusStrength', 'focusDistance', 'focusRange', 'focusOnTarget'],
  effect: ['timeOffset', 'target', 'fullDuration', 'beat', 'grade'],
};

export interface ClipMove {
  id: string;
  trackId: string;
  start: number;
}

/** one step of a trim plan, run by runTrimOps. a slip's trimStart is absolute, so a replan never adds up */
export type TrimOp =
  | { kind: 'trim'; id: string; edge: 'start' | 'end'; time: number }
  | { kind: 'move'; moves: ClipMove[] }
  | { kind: 'speed'; id: string; speed: number }
  | { kind: 'slip'; id: string; trimStart: number };

export type ProjectSettingsPatch = Partial<Pick<Project, 'name' | 'width' | 'height' | 'fps' | 'background' | 'fog' | 'light' | 'sky' | 'output'>>;
export type TrackPatch = Partial<Pick<Track, 'name' | 'muted' | 'hidden' | 'locked'>> & { volume?: number | null; pan?: number | null };

export interface EditorState {
  project: Project | null;
  /** selected clip ids */
  selection: string[];
  past: Project[];
  future: Project[];
  clipboard: Clip[];
  /** timeline scale in pixels per second */
  zoom: number;
  snapping: boolean;

  // lifecycle
  openProject(project: Project): void;
  closeProject(): void;

  // history
  /**
   * open an undo step (use before a drag with skipHistory updates). the step is only written when the first
   * skipHistory change after it lands: a gesture that changes nothing leaves undo and redo exactly as they were.
   */
  pushHistory(): void;
  /** undo / redo also bring back the selection the step was made with */
  undo(): void;
  redo(): void;
  /**
   * take back what was written since the last pushHistory() (a cancelled drag, a plan that failed half way).
   * nothing was written: nothing happens, earlier steps are never touched. the taken back step cannot be redone.
   */
  rollback(): void;

  // project
  updateProject(patch: ProjectSettingsPatch, opts?: ActionOpts): void;

  // assets (not undoable)
  addAsset(asset: MediaAsset): void;
  /** removes the asset and every clip that uses it. clears history. */
  removeAsset(assetId: string): void;
  renameAsset(assetId: string, name: string): void;
  /** set or clear (null) the marked part of a video or audio media. not an undo step. false when nothing changed */
  setMediaMarks(assetId: string, marks: InOutRange | null): boolean;

  // tracks
  /** video tracks are added on top by default, audio tracks at the bottom. returns the new track id. */
  addTrack(kind: TrackKind, opts?: ActionOpts & { index?: number }): string;
  /** removes the track and its clips */
  removeTrack(trackId: string, opts?: ActionOpts): void;
  updateTrack(trackId: string, patch: TrackPatch, opts?: ActionOpts): void;
  /** every fader to 0 db, every pan to the middle, the output too. mute and solo stay */
  resetMixer(opts?: ActionOpts): void;
  /** reorder a track. index is in project.tracks. tracks stay grouped video-first. */
  moveTrack(trackId: string, toIndex: number, opts?: ActionOpts): void;

  // clips
  /**
   * put an asset on the timeline. returns the new clip id, or null when the asset is unknown.
   * - trackId + start: placed on that track at the nearest free spot to start
   *   (ignored if the track kind does not fit the asset or the track is locked)
   * - start only: first track of the right kind with room at start, else a new track
   * - neither: appended after the last clip of the first usable track
   */
  insertAsset(assetId: string, opts?: ActionOpts & { trackId?: string; start?: number; range?: InOutRange | null; parts?: ClipParts }): string | null;
  /** add a text clip. same placement rules as insertAsset. returns the new clip id. */
  addText(opts?: ActionOpts & { trackId?: string; start?: number; duration?: number; preset?: Partial<TextClip> }): string;
  /** add a shape clip. same placement rules as insertAsset. returns the new clip id. */
  addShape(opts?: ActionOpts & { trackId?: string; start?: number; duration?: number; preset?: Partial<ShapeClip> }): string;
  /** add a marker at a time (timeline seconds). a marker already within 1ms of it is returned instead. returns the marker id. */
  addMarker(time: number, name?: string, opts?: ActionOpts): string;
  updateMarker(id: string, patch: { time?: number; name?: string }, opts?: ActionOpts): void;
  removeMarker(id: string, opts?: ActionOpts): void;
  /** set or clear the timeline in / out (null clears). cleaned through lib/inOut. not an undo step. */
  setRange(range: InOutRange | null): void;
  /**
   * add an effect clip (an adjustment layer that changes everything below its track).
   * - trackId + start: placed on that video track at the nearest free spot to start
   * - otherwise: at start (default 0) on the TOP video track when it has room there, else on a new top track,
   *   so a new effect always covers the whole picture.
   * returns the new clip id, or null when the effect id is unknown.
   */
  addEffect(effect: string, opts?: ActionOpts & { trackId?: string; start?: number; duration?: number }): string | null;
  /**
   * add a camera clip (see CameraClip). same placement as addEffect: the top video track when it has
   * room, else a new top track. returns the new clip id.
   */
  addCamera(opts?: ActionOpts & { trackId?: string; start?: number; duration?: number }): string;
  /**
   * set an animatable property (see lib/anim.ts for the names: x y scale rotation opacity z rotX rotY
   * volume amount p.<key> pan tilt roll fov) the way an editor expects: when the property has
   * keyframes the value goes into a key at `time` (timeline seconds), otherwise into the static field.
   * values are clamped to the property's range.
   */
  setClipValue(id: string, prop: string, time: number, value: number, opts?: ActionOpts): void;
  /**
   * setClipValue for many clips in ONE store update (one undo step, one notify): the multi inspector's drags.
   * each time is clamped into its clip. per edit the same rules as setClipValue (clampProp, a key when the prop has
   * keys, the base value otherwise). locked, missing and unchanged edits are skipped. nothing changed: no step.
   */
  setClipValues(edits: readonly ClipValueEdit[], opts?: ActionOpts): void;
  /** add a key holding the current value at `time`, or remove the key that is already there */
  toggleKeyframe(id: string, prop: string, time: number, opts?: ActionOpts): void;
  /** add or update a key at `time`. value defaults to the current value there. */
  setKeyframe(id: string, prop: string, time: number, value?: number, ease?: Easing, opts?: ActionOpts): void;
  /** remove the key at `time` (within tolerance seconds). the last key leaves the value it had. */
  removeKeyframe(id: string, prop: string, time: number, tolerance?: number, opts?: ActionOpts): void;
  /** move the key(s) at fromTime to toTime. prop null = every property that has a key there. */
  moveKeyframe(id: string, prop: string | null, fromTime: number, toTime: number, tolerance?: number, opts?: ActionOpts): void;
  /**
   * replace the whole keyframes record of a clip in ONE step (reverse, fit, paste...). keys are clip-local
   * seconds (see Keyframe). refused on a locked track. properties the clip cannot animate are dropped, values
   * are clamped like setKeyframe does, keys are sorted by t (a second key at the same t replaces the first),
   * non-finite keys and properties without keys are dropped; no keys at all removes the field.
   * a property that had keys and has none afterwards keeps its static value as it was at `opts.time`
   * (timeline seconds, default the clip start).
   */
  setClipKeyframes(id: string, keyframes: Keyframes, opts?: ActionOpts & { time?: number }): void;
  /** remove every key of one property (or of all when prop is omitted). values freeze as they are at `time`. */
  clearKeyframes(id: string, time: number, prop?: string, opts?: ActionOpts): void;
  /** set one parameter of an effect clip (clamped to the param range). */
  setEffectParam(id: string, key: string, value: number, opts?: ActionOpts): void;
  /** patch editable fields (name, volume, transform, text props, effect amount, fades...). */
  updateClip(id: string, patch: ClipPatch, opts?: ActionOpts): void;
  /** set the bend (and the bend.angle keys) of several clips as one change. null takes the bend off. one undo step unless skipHistory */
  setBends(list: readonly BendWrite[], opts?: ActionOpts): void;
  /** shallow-merge into the clip transform (visual clips only) */
  updateTransform(id: string, patch: Partial<Transform>, opts?: ActionOpts): void;
  /**
   * move clips (same or other track). all-or-nothing: returns false and changes nothing when any
   * move is invalid (unknown/locked/wrong-kind track, negative start, or overlap after the move).
   */
  moveClips(moves: ClipMove[], opts?: ActionOpts): boolean;
  /**
   * drag one edge of a clip to a timeline time. clamped to: min duration, neighbours on the track,
   * time 0, and the source media bounds for video/audio.
   */
  trimClip(id: string, edge: 'start' | 'end', time: number, opts?: ActionOpts): void;
  /**
   * swap the media of a video / image / audio clip for another asset of the same kind, keeping the
   * clip's place, look and animation. a video / audio clip keeps its trim when the new media is long
   * enough, else the trim start moves back and then the clip gets shorter. returns false when the
   * clip or asset is missing, the kinds differ or the track is locked.
   */
  replaceClipAsset(id: string, assetId: string, opts?: ActionOpts): boolean;
  /** change playback rate of a video/audio clip. duration follows (clamped to the next clip). */
  setClipSpeed(id: string, speed: number, opts?: ActionOpts): void;
  /** slip a video / audio clip: its place and length stay, trimStart moves by sourceDelta media seconds (+ = later media). false = nothing changed */
  slipClip(id: string, sourceDelta: number, opts?: ActionOpts): boolean;
  /** with from, ops run on { ...project, clips: from }: assets, markers, tracks stay current. false only when refused */
  applyTrimPlan(ops: readonly TrimOp[], opts?: ActionOpts & { from?: readonly Clip[] }): boolean;
  /**
   * split at a timeline time. ids defaults to the selection, or every clip under the time when
   * nothing is selected. clips on locked tracks are skipped. returns ids of the new right-hand parts.
   */
  splitClips(time: number, ids?: string[], opts?: ActionOpts): string[];
  /** ripple: close the gap by shifting later clips on the same track left */
  deleteClips(ids: string[], opts?: ActionOpts & { ripple?: boolean }): void;
  /** copies land right after the originals when there is room. selects and returns the copies. */
  /**
   * copies of clips. by default the copies go after the originals in time. `sameTime`: every copy keeps its
   * start and goes to a track above its original that is free for that span (a new one when there is none),
   * so it lies exactly over the original (for "leave a copy behind" gestures). `copies` is filled with
   * original id -> copy id, for a caller that goes on working with the copies.
   */
  duplicateClips(ids: string[], opts?: ActionOpts & { sameTime?: boolean; copies?: Map<string, string> }): string[];
  /**
   * add ready-made clips in one undo step (captions, a frozen frame...). every clip gets a new id.
   * - newTrack (default true): they all go on ONE new track (video kinds: on top; audio: at the
   *   bottom), named trackName. clips are placed in time order; one that would overlap the clip
   *   before it starts where that one ends (and is dropped when nothing of it is left).
   * - newTrack false: each clip goes on its own trackId when that track exists, is unlocked, has the
   *   right kind and is free there, else on any track with room, else on a new track.
   * all clips must be of one track kind (all pictures or all audio), otherwise nothing happens.
   * selects and returns the new ids.
   */
  addClips(clips: Clip[], opts?: ActionOpts & { newTrack?: boolean; trackName?: string }): string[];
  /** ready-made clips exactly where they say (track, start, id), each right after the clip `after` names, else at the end.
   * all or nothing: false when a track is missing, locked or of the wrong kind, an id is taken, a start is below 0, a clip
   * is shorter than MIN_CLIP_DURATION or its span is not free (clips of the same call count). selection stays. */
  insertClips(entries: readonly { clip: Clip; after?: string }[], opts?: ActionOpts): boolean;
  /** put two or more clips into a new group (they leave their old groups). returns the group id, or null. */
  groupClips(ids: string[], opts?: ActionOpts): string | null;
  /** dissolve every group that one of these clips belongs to */
  ungroupClips(ids: string[], opts?: ActionOpts): void;
  /** set the group of these clips (null takes it off). locked tracks are skipped. false = nothing changed */
  setClipGroup(ids: readonly string[], group: string | null, opts?: ActionOpts): boolean;

  // clipboard
  copySelection(): void;
  cutSelection(): void;
  /** paste so the earliest clipboard clip starts at `time`. selects and returns the pasted ids. */
  paste(time: number): string[];

  // selection
  select(ids: string[], mode?: 'replace' | 'add' | 'toggle'): void;
  clearSelection(): void;
  selectAll(): void;

  // view
  setZoom(zoom: number): void;
  setSnapping(on: boolean): void;
}

/* ---------- pure helpers ---------- */

/**
 * the clips with the clip ids in their side fills (Spatial.faces) swapped or dropped through `map` (see remapFaces: undefined
 * keeps an id, null drops the entry). only the clips in `only` when given. clips that change are new objects, the rest stay.
 */
export function remapSides(clips: Clip[], map: (id: string) => string | null | undefined, only?: ReadonlySet<string>): Clip[] {
  return clips.map((c) => {
    if (!isVisualClip(c) || !c.faces || (only && !only.has(c.id))) return c;
    const faces = remapFaces(c.faces, map);
    if (faces === c.faces) return c;
    const { faces: _drop, ...rest } = c;
    void _drop;
    return (faces ? { ...rest, faces } : rest) as Clip;
  });
}

/** point the links (parent, camera target, group, the clips on the sides of a solid) of freshly copied clips at each other */
function relinkIn(project: Project, idMap: ReadonlyMap<string, string>, originals: readonly Clip[]): Project {
  const copyIds = new Set(idMap.values());
  // a copied solid shows the copy of its picture clip when that was copied along, else it keeps naming the original
  const copies = remapSides(
    relinkCopies(
      project.clips.filter((c) => copyIds.has(c.id)),
      idMap,
      originals,
    ),
    (id) => idMap.get(id),
  );
  const byId = new Map(copies.map((c) => [c.id, c]));
  return { ...project, clips: project.clips.map((c) => byId.get(c.id) ?? c) };
}

/** does a solid show one of these clips on a side? */
function showsAny(c: Clip, ids: ReadonlySet<string>): boolean {
  if (!isVisualClip(c) || !c.faces) return false;
  for (const f of Object.values(c.faces)) {
    const id = faceClipId(f);
    if (id !== null && ids.has(id)) return true;
  }
  return false;
}

/**
 * after a split: clips that are not part of the cut (neither a left nor a right half) but link to a cut
 * clip (parent, look target, camera target, effect target) and lie at or after the cut follow the right
 * half, so a plain split changes nothing in the picture. one that ends before the cut stays on the left
 * half. one that straddles the cut (it sits on a locked track and could not be cut) goes to the half that
 * covers more of it, ties stay left. rightOf: original (left half) id -> right half id.
 */
export function repointSplitDependents(clips: Clip[], rightOf: ReadonlyMap<string, string>, time: number): Clip[] {
  if (rightOf.size === 0) return clips;
  const rights = new Set(rightOf.values());
  const eps = 1e-6;
  return clips.map((c0) => {
    if (rightOf.has(c0.id) || rights.has(c0.id)) return c0;
    const end = clipEnd(c0);
    const after = c0.start >= time - eps || (c0.start < time && end > time && end - time > time - c0.start + eps);
    if (!after) return c0;
    const map = (id: string | null | undefined): string | undefined => (id ? rightOf.get(id) : undefined);
    let c = c0;
    if (isVisualClip(c)) {
      const parent = map(c.parent);
      const look = map(c.lookTarget);
      if (parent) c = { ...c, parent } as Clip;
      if (look) c = { ...c, lookTarget: look } as Clip;
      // a solid that shows a clip that was cut shows its right half from the cut on
      if (isVisualClip(c) && c.faces) c = remapSides([c], (id) => rightOf.get(id))[0]!;
    }
    if (isCameraClip(c)) {
      const t = map(c.target);
      if (t) c = { ...c, target: t } as Clip;
    }
    if (c.type === 'effect') {
      const t = map(c.target);
      if (t) c = { ...c, target: t } as Clip;
    }
    return c;
  });
}

function replaceClip(project: Project, clip: Clip): Project {
  return { ...project, clips: project.clips.map((c) => (c.id === clip.id ? clip : c)) };
}

function clampFades<T extends Clip>(clip: T): T {
  const fadeIn = clamp(clip.fadeIn || 0, 0, clip.duration);
  const fadeOut = clamp(clip.fadeOut || 0, 0, clip.duration);
  if (fadeIn === clip.fadeIn && fadeOut === clip.fadeOut) return clip;
  return { ...clip, fadeIn, fadeOut };
}

function isLocked(project: Project, trackId: string): boolean {
  return project.tracks.find((t) => t.id === trackId)?.locked ?? false;
}

/** the ids plus the effect clips that sit on one of them (EffectClip.target). effects on locked tracks stay out. */
function withTargetedEffects(p: Project, ids: ReadonlySet<string>): Set<string> {
  const out = new Set(ids);
  for (const c of p.clips) {
    if (c.type === 'effect' && c.target && ids.has(c.target) && !isLocked(p, c.trackId)) out.add(c.id);
  }
  return out;
}

function nextTrackName(project: Project, kind: TrackKind): string {
  const used = new Set(project.tracks.map((t) => t.name));
  let n = project.tracks.filter((t) => t.kind === kind).length + 1;
  while (used.has(`${kind} ${n}`)) n++;
  return `${kind} ${n}`;
}

function withNewTrack(project: Project, kind: TrackKind, index?: number): { project: Project; track: Track } {
  const track = createTrack(kind, nextTrackName(project, kind));
  const tracks = [...project.tracks];
  const videoCount = tracks.filter((t) => t.kind === 'video').length;
  let at: number;
  if (kind === 'video') at = clamp(index ?? 0, 0, videoCount);
  else at = clamp(index ?? tracks.length, videoCount, tracks.length);
  tracks.splice(at, 0, track);
  return { project: { ...project, tracks: normalizeTrackOrder(tracks) }, track };
}

/** decide where a new clip of `kind` and `duration` goes. may add a track. */
function resolvePlacement(
  project: Project,
  kind: TrackKind,
  duration: number,
  trackId: string | undefined,
  start: number | undefined,
): { project: Project; trackId: string; start: number } {
  const wanted = trackId ? project.tracks.find((t) => t.id === trackId) : undefined;
  if (wanted && wanted.kind === kind && !wanted.locked) {
    const desired = start ?? lastEnd(project, wanted.id);
    return { project, trackId: wanted.id, start: findFreeStart(project, wanted.id, desired, duration) };
  }
  if (start === undefined) {
    const first = project.tracks.find((t) => t.kind === kind && !t.locked);
    if (first) return { project, trackId: first.id, start: lastEnd(project, first.id) };
    const made = withNewTrack(project, kind);
    return { project: made.project, trackId: made.track.id, start: 0 };
  }
  const s = Math.max(0, start);
  const room = findTrackWithRoom(project, kind, s, duration);
  if (room) return { project, trackId: room.id, start: s };
  const made = withNewTrack(project, kind);
  return { project: made.project, trackId: made.track.id, start: s };
}

function lastEnd(project: Project, trackId: string): number {
  let end = 0;
  for (const c of project.clips) if (c.trackId === trackId) end = Math.max(end, clipEnd(c));
  return end;
}

function hasOverlapOnTracks(project: Project, trackIds: Iterable<string>): boolean {
  for (const trackId of trackIds) {
    const clips = getTrackClips(project, trackId);
    for (let i = 1; i < clips.length; i++) {
      const a = clips[i - 1]!;
      const b = clips[i]!;
      if (rangesOverlap(a.start, clipEnd(a), b.start, clipEnd(b))) return true;
    }
  }
  return false;
}

/**
 * the trim cores: pure Project -> Project | null (null = no change or refused). the store actions and runTrimOps
 * (so every trim plan) go through them.
 */
export function moveClipsIn(p: Project, moves: readonly ClipMove[]): Project | null {
  if (moves.length === 0) return null;
  const byId = new Map(moves.map((m) => [m.id, m]));
  const touched = new Set<string>();
  let valid = true;
  let changed = false;
  const clips = p.clips.map((c) => {
    const m = byId.get(c.id);
    if (!m) return c;
    const target = p.tracks.find((t) => t.id === m.trackId);
    if (!target || target.locked || target.kind !== trackKindForClip(c.type) || isLocked(p, c.trackId)) {
      valid = false;
      return c;
    }
    if (!(m.start >= 0) || !Number.isFinite(m.start)) {
      valid = false;
      return c;
    }
    touched.add(m.trackId);
    if (m.trackId === c.trackId && m.start === c.start) return c;
    changed = true;
    return { ...c, trackId: m.trackId, start: m.start };
  });
  if (!valid || !changed) return null;
  const next = { ...p, clips };
  if (hasOverlapOnTracks(next, touched)) return null;
  return next;
}

export function trimClipIn(p: Project, id: string, edge: 'start' | 'end', time: number): Project | null {
  const clip = p.clips.find((c) => c.id === id);
  if (!clip || isLocked(p, clip.trackId)) return null;
  const siblings = getTrackClips(p, clip.trackId).filter((c) => c.id !== id);
  const end = clipEnd(clip);
  if (edge === 'start') {
    let lower = 0;
    for (const s of siblings) if (clipEnd(s) <= clip.start + 1e-6) lower = Math.max(lower, clipEnd(s));
    if (isTimedClip(clip)) lower = Math.max(lower, clip.start - clip.trimStart / clip.speed);
    const upper = end - MIN_CLIP_DURATION;
    const newStart = clamp(time, lower, Math.max(lower, upper));
    if (Math.abs(newStart - clip.start) < 1e-9) return null;
    const delta = newStart - clip.start;
    // keys stay where they are on the timeline when the head is trimmed
    const next = { ...clip, start: newStart, duration: end - newStart, keyframes: shiftKeyframes(clip.keyframes, -delta) } as Clip;
    if (isTimedClip(next) && isTimedClip(clip)) {
      next.trimStart = Math.max(0, clip.trimStart + delta * clip.speed);
    }
    // an effect runs on time - start + timeOffset: keep what it shows at every frame that is left
    if (next.type === 'effect' && clip.type === 'effect') {
      next.timeOffset = (clip.timeOffset ?? 0) + delta;
      next.fullDuration = clip.fullDuration ?? clip.duration;
    }
    // a running number carries on from where the cut is (see TextCounter.offset)
    if (next.type === 'text' && clip.type === 'text' && clip.counter) {
      next.counter = { ...clip.counter, offset: (clip.counter.offset ?? 0) + delta, fullDuration: clip.counter.fullDuration ?? clip.duration };
    }
    // lit words too (see TextHighlight.offset)
    if (next.type === 'text' && clip.type === 'text' && clip.highlight) {
      next.highlight = { ...clip.highlight, offset: (clip.highlight.offset ?? 0) + delta, fullDuration: clip.highlight.fullDuration ?? clip.duration };
    }
    return replaceClip(p, clampFades(next));
  }
  let upper = Infinity;
  for (const s of siblings) if (s.start >= end - 1e-6) upper = Math.min(upper, s.start);
  if (isTimedClip(clip)) {
    const asset = p.assets.find((a) => a.id === clip.assetId);
    upper = Math.min(upper, clip.start + maxClipDuration(clip, asset?.duration));
  }
  const lower = clip.start + MIN_CLIP_DURATION;
  const newEnd = clamp(time, lower, Math.max(lower, upper));
  if (Math.abs(newEnd - end) < 1e-9) return null;
  return replaceClip(p, clampFades({ ...clip, duration: newEnd - clip.start }));
}

export function setClipSpeedIn(p: Project, id: string, speed: number): Project | null {
  const clip = p.clips.find((c) => c.id === id);
  if (!clip || !isTimedClip(clip) || isLocked(p, clip.trackId)) return null;
  const s = clamp(speed, MIN_SPEED, MAX_SPEED);
  if (!Number.isFinite(s) || s === clip.speed) return null;
  const sourceSpan = clip.duration * clip.speed;
  let duration = sourceSpan / s;
  let nextStart = Infinity;
  for (const o of p.clips) {
    if (o.trackId === clip.trackId && o.id !== clip.id && o.start >= clip.start) {
      nextStart = Math.min(nextStart, o.start);
    }
  }
  duration = Math.max(MIN_CLIP_DURATION, Math.min(duration, nextStart - clip.start));
  return replaceClip(p, clampFades({ ...clip, speed: s, duration }));
}

export function slipClipIn(p: Project, id: string, sourceDelta: number): Project | null {
  const clip = p.clips.find((c) => c.id === id);
  if (!clip || !isTimedClip(clip) || isLocked(p, clip.trackId) || !Number.isFinite(sourceDelta)) return null;
  const asset = p.assets.find((a) => a.id === clip.assetId);
  const hi = asset && asset.duration > 0 ? Math.max(0, asset.duration - clip.duration * clip.speed) : Infinity;
  const trimStart = clamp(clip.trimStart + sourceDelta, 0, Math.max(hi, clip.trimStart));
  if (Math.abs(trimStart - clip.trimStart) < 1e-9) return null;
  return replaceClip(p, { ...clip, trimStart }); // start, length, keys, fades stay
}

/**
 * run the ops of a trim plan in order. null when an op is refused or does not land, p when nothing changed.
 * an op that is already done is skipped, so a plan can be run on a project it was partly applied to.
 */
export function runTrimOps(p: Project, ops: readonly TrimOp[]): Project | null {
  let cur = p;
  for (const op of ops) {
    if (op.kind === 'move') {
      const holds = op.moves.every((m) => {
        const c = cur.clips.find((x) => x.id === m.id);
        return !!c && c.trackId === m.trackId && c.start === m.start;
      });
      if (holds) continue;
      const next = moveClipsIn(cur, op.moves);
      if (!next) return null;
      cur = next;
      continue;
    }
    const c = cur.clips.find((x) => x.id === op.id);
    if (!c) return null;
    if (op.kind === 'trim') {
      const edgeAt = (x: Clip) => (op.edge === 'end' ? clipEnd(x) : x.start);
      if (Math.abs(edgeAt(c) - op.time) < 1e-9) continue;
      const next = trimClipIn(cur, op.id, op.edge, op.time);
      if (!next) return null;
      const after = next.clips.find((x) => x.id === op.id);
      if (!after || Math.abs(edgeAt(after) - op.time) > 1e-6) return null;
      cur = next;
      continue;
    }
    if (!isTimedClip(c)) return null;
    if (op.kind === 'speed') {
      const want = clamp(op.speed, MIN_SPEED, MAX_SPEED);
      if (want === c.speed) continue;
      const next = setClipSpeedIn(cur, op.id, op.speed);
      if (!next) return null;
      const after = next.clips.find((x) => x.id === op.id);
      if (!after || !isTimedClip(after) || after.speed !== want || Math.abs(after.duration - (c.duration * c.speed) / want) > 1e-6) return null;
      cur = next;
      continue;
    }
    if (Math.abs(op.trimStart - c.trimStart) < 1e-9) continue;
    const next = slipClipIn(cur, op.id, op.trimStart - c.trimStart);
    if (!next) return null;
    const after = next.clips.find((x) => x.id === op.id);
    if (!after || !isTimedClip(after) || Math.abs(after.trimStart - op.trimStart) > 1e-9) return null;
    cur = next;
  }
  return cur;
}

/** the crop edge across from each crop edge */
const CROP_ACROSS: Record<string, string> = { 'crop.left': 'crop.right', 'crop.right': 'crop.left', 'crop.top': 'crop.bottom', 'crop.bottom': 'crop.top' };
/** the most two opposite crop edges cut together (the renderer squeezes a bigger pair, the numbers would lie) */
const MAX_CROP_SUM = 0.99;

/** clamp a value to an animatable property's range. null when the clip has no such property. */
function clampProp(clip: Clip, prop: string, value: number): number | null {
  if (prop.startsWith('p.')) {
    if (clip.type !== 'effect') return null;
    const param = getEffect(clip.effect)?.params.find((q) => q.key === prop.slice(2));
    return param ? clamp(value, param.min, param.max) : null;
  }
  const info = animProps(clip).find((a) => a.prop === prop);
  if (!info) return null;
  let v = clamp(value, info.min ?? -Infinity, info.max ?? Infinity);
  const across = CROP_ACROSS[prop];
  if (across) {
    // two opposite edges never cut more than 99% together: what the other edge takes at its most is not free
    let taken = baseValue(clip, across) ?? 0;
    for (const k of clip.keyframes?.[across] ?? []) taken = Math.max(taken, k.v);
    v = Math.min(v, Math.max(0, MAX_CROP_SUM - taken));
  }
  return info.int ? Math.round(v) : v;
}

/** setClipValue for one clip: the new clip, or null for "nothing to do" (locked track, no such prop, same value) */
function valueEdit(p: Project, clip: Clip, prop: string, time: number, value: number): Clip | null {
  if (isLocked(p, clip.trackId) || !Number.isFinite(value)) return null;
  if (baseValue(clip, prop) === undefined && !prop.startsWith('p.') && !isSeedable(clip, prop)) return null;
  const v = clampProp(clip, prop, value);
  if (v === null) return null;
  if (valueAt(clip, prop, time) === v && (!isAnimated(clip, prop) || keyIndexAt(clip.keyframes![prop]!, time - clip.start) >= 0)) {
    return null;
  }
  return withValueAt(clip, prop, time, v);
}

/** the value a property has when nothing is stored for it (effect params fall back to the effect default) */
function propDefault(clip: Clip, prop: string): number | undefined {
  if (clip.type === 'effect' && prop.startsWith('p.')) {
    return getEffect(clip.effect)?.params.find((q) => q.key === prop.slice(2))?.default;
  }
  return baseValue(clip, prop);
}

/** the selection without clips that are gone or sit on a locked track (same rule as select()) */
function pruneSelection(project: Project | null, selection: string[]): string[] {
  if (!project) return [];
  if (selection.length === 0) return selection;
  const locked = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id));
  const ids = new Set(project.clips.filter((c) => !locked.has(c.trackId)).map((c) => c.id));
  const next = selection.filter((id) => ids.has(id));
  return next.length === selection.length ? selection : next;
}

/**
 * the clips that are left when `gone` is removed. every surviving visual child of a removed clip keeps its
 * place on screen: it gets the world pose (reparentTransform for parent = null) computed while the parent still
 * exists, at the first moment the child is visible (clamped into the parent's range and the child's own).
 * a child with a keyed pose keeps its keys and is only detached. all other links to removed clips are cleared.
 * a child on a locked track is placed too: the lock guards against edits, and this is what keeps the picture
 * as it was (leaving it alone would make it jump).
 */
export function removeClipsKeepingPose(p: Project, gone: ReadonlySet<string>): Clip[] {
  const keep = p.clips.filter((c) => !gone.has(c.id));
  let byId: Map<string, Clip> | null = null;
  const placed = keep.map((c) => {
    if (!isVisualClip(c) || !c.parent || !gone.has(c.parent) || hasKeyedPose(c)) return c;
    byId ??= new Map(p.clips.map((x) => [x.id, x]));
    const parent = byId.get(c.parent);
    if (!parent) return c;
    const t = clamp(clamp(c.start, parent.start, clipEnd(parent)), c.start, clipEnd(c));
    const tr = reparentTransform(p, c, null, t);
    if (tr === c.transform) return c;
    return { ...c, transform: { ...tr, scale: clamp(tr.scale, MIN_SCALE, MAX_SCALE) } } as Clip;
  });
  // the sides that showed a removed clip go back to the solid's own picture (in the same step, so one undo restores both)
  return remapSides(unlinkRemoved(placed, gone), (id) => (gone.has(id) ? null : undefined));
}

/** the keyframes without the bend.angle row (undefined when nothing is left) */
function withoutBendKeys(kf: Keyframes | undefined): Keyframes | undefined {
  if (!kf) return undefined;
  const { 'bend.angle': _drop, ...rest } = kf;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** bend.angle keys for setBends: finite t and v only, the angle clamped, sorted by t */
function cleanBendKeys(keys: readonly Keyframe[]): Keyframe[] {
  const out: Keyframe[] = [];
  for (const k of keys) {
    if (!k || !Number.isFinite(k.t) || !Number.isFinite(k.v)) continue;
    out.push({ t: k.t, v: clamp(k.v, -360, 360), ease: k.ease ?? 'ease' });
  }
  return out.sort((a, b) => a.t - b.t);
}

function sameClipBend(a: ClipBend | null | undefined, b: ClipBend | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.angle === b.angle && a.along === b.along && a.center === b.center && a.span === b.span;
}

function sameKeyframes(a: Keyframes | undefined, b: Keyframes | undefined): boolean {
  const x = a ?? {};
  const y = b ?? {};
  const kx = Object.keys(x);
  if (kx.length !== Object.keys(y).length) return false;
  for (const prop of kx) {
    const p = x[prop]!;
    const q = y[prop];
    if (!q || p.length !== q.length) return false;
    for (let i = 0; i < p.length; i++) if (p[i]!.t !== q[i]!.t || p[i]!.v !== q[i]!.v || p[i]!.ease !== q[i]!.ease) return false;
  }
  return true;
}

/** a keyframes record cleaned for a clip (see EditorState.setClipKeyframes). undefined = no keys left. */
export function cleanKeyframes(clip: Clip, input: Keyframes): Keyframes | undefined {
  const out: Keyframes = {};
  for (const [prop, keys] of Object.entries(input)) {
    if (!Array.isArray(keys)) continue;
    const list: Keyframe[] = [];
    let ok = true;
    for (const k of keys) {
      if (!k || !Number.isFinite(k.t) || !Number.isFinite(k.v)) continue;
      const v = clampProp(clip, prop, k.v);
      if (v === null) {
        ok = false;
        break;
      }
      list.push({ t: k.t, v, ease: k.ease ?? 'ease' });
    }
    if (!ok || list.length === 0) continue;
    list.sort((a, b) => a.t - b.t);
    // a key at the same time as the one before replaces it
    const dedup: Keyframe[] = [];
    for (const k of list) {
      if (dedup.length > 0 && k.t - dedup[dedup.length - 1]!.t < KEY_EPS) dedup[dedup.length - 1] = k;
      else dedup.push(k);
    }
    out[prop] = dedup;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/* ---------- store ---------- */

/** what history does not hold: the media list and the timeline in / out stay as they are now */
function keepLive(snap: Project, now: Project): Project {
  const out: Project = { ...snap, assets: now.assets };
  if (now.range) out.range = now.range;
  else delete out.range;
  return out;
}

export const useEditor = create<EditorState>()((set, get) => {
  /** the project pushHistory() was called on, until the first change of that gesture lands (or something else changes the project) */
  let pending: Project | null = null;
  /** the selection each history step was made with (undo / redo bring it back) */
  const selectionAt = new WeakMap<Project, string[]>();

  /** apply a project transform with history bookkeeping. returns true when something changed. */
  function mutate(fn: (p: Project) => Project | null | undefined, opts?: ActionOpts): boolean {
    const { project, past } = get();
    if (!project) return false;
    const next = fn(project);
    if (!next || next === project) return false;
    const opened = pending === project;
    pending = null;
    if (opts?.skipHistory && !opened) {
      set({ project: next, selection: pruneSelection(next, get().selection) });
    } else {
      selectionAt.set(project, get().selection);
      set({
        project: next,
        past: [...past, project].slice(-HISTORY_LIMIT),
        future: [],
        selection: pruneSelection(next, get().selection),
      });
    }
    return true;
  }

  return {
    project: null,
    selection: [],
    past: [],
    future: [],
    clipboard: [],
    zoom: DEFAULT_ZOOM,
    snapping: true,

    openProject(project) {
      pending = null;
      set({ project, selection: [], past: [], future: [], zoom: DEFAULT_ZOOM });
    },
    closeProject() {
      pending = null;
      set({ project: null, selection: [], past: [], future: [] });
    },

    pushHistory() {
      const { project } = get();
      if (!project) return;
      pending = project;
    },
    rollback() {
      const { project } = get();
      if (!project) return;
      // still open: the gesture wrote nothing, so there is nothing to take back
      if (pending !== null) {
        pending = null;
        return;
      }
      const past = [...get().past];
      const prev = past.pop();
      if (!prev) return;
      const restored: Project = prev === project ? project : keepLive(prev, project);
      set({ project: restored, past, selection: pruneSelection(restored, selectionAt.get(prev) ?? get().selection) });
    },
    undo() {
      const { project } = get();
      if (!project) return;
      pending = null;
      const past = [...get().past];
      // skip no-op steps (a drag that pushed history but changed nothing)
      let prev = past.pop();
      while (prev && prev === project) prev = past.pop();
      if (!prev) {
        set({ past });
        return;
      }
      // assets are not part of history: keep the current list (and the timeline in / out)
      const restored: Project = keepLive(prev, project);
      selectionAt.set(project, get().selection);
      set({
        project: restored,
        past,
        future: [project, ...get().future].slice(0, HISTORY_LIMIT),
        selection: pruneSelection(restored, selectionAt.get(prev) ?? get().selection),
      });
    },
    redo() {
      const { project, future, past } = get();
      if (!project || future.length === 0) return;
      pending = null;
      const [next, ...rest] = future;
      const restored: Project = keepLive(next!, project);
      selectionAt.set(project, get().selection);
      set({
        project: restored,
        past: [...past, project].slice(-HISTORY_LIMIT),
        future: rest,
        selection: pruneSelection(restored, selectionAt.get(next!) ?? get().selection),
      });
    },

    updateProject(patch, opts) {
      mutate((p) => {
        const next = { ...p, ...patch };
        if (patch.width !== undefined) next.width = clamp(Math.round(patch.width), 16, 7680);
        if (patch.height !== undefined) next.height = clamp(Math.round(patch.height), 16, 7680);
        if (patch.fps !== undefined) next.fps = clamp(patch.fps, 1, MAX_FPS);
        if (patch.name !== undefined) next.name = patch.name.trim() || 'untitled project';
        if (patch.output !== undefined) next.output = patchOutput(p.output, patch.output);
        const before = p as unknown as Record<string, unknown>;
        const after = next as unknown as Record<string, unknown>;
        // a missing optional field and null mean the same thing
        if (Object.keys(patch).every((k) => before[k] === after[k] || (before[k] == null && after[k] == null))) return null;
        return next;
      }, opts);
    },

    addAsset(asset) {
      const { project } = get();
      if (!project || project.assets.some((a) => a.id === asset.id)) return;
      const next = { ...project, assets: [...project.assets, asset] };
      // an import in the middle of a gesture must not close its undo step
      if (pending === project) pending = next;
      set({ project: next });
    },
    removeAsset(assetId) {
      const { project } = get();
      if (!project) return;
      const uses = (c: Clip) => 'assetId' in c && c.assetId === assetId;
      const gone = withTargetedEffects(project, new Set(project.clips.filter(uses).map((c) => c.id)));
      const next: Project = {
        ...project,
        assets: project.assets.filter((a) => a.id !== assetId),
        clips: gone.size > 0 ? removeClipsKeepingPose(project, gone) : project.clips,
      };
      // the sky goes with one of its pictures. undo keeps the current media list, so a sky that comes back with an undo
      // has its picture missing and is simply not drawn (sky.ts skyUsable): no need to clear the history for it
      if (skyUses(project.sky, assetId)) next.sky = null;
      // history holds whole projects: a step that still has a clip of this asset cannot be gone back to.
      // when no step has one (an unused asset), undo and redo stay as they are.
      const inHistory = [...get().past, ...get().future].some((p) => p.clips.some(uses));
      pending = null;
      if (gone.size > 0 || inHistory) set({ project: next, past: [], future: [], selection: pruneSelection(next, get().selection) });
      else set({ project: next });
    },
    renameAsset(assetId, name) {
      const { project } = get();
      if (!project) return;
      const clean = name.trim();
      if (!clean) return;
      set({
        project: { ...project, assets: project.assets.map((a) => (a.id === assetId ? { ...a, name: clean } : a)) },
      });
    },
    setMediaMarks(assetId, marks) {
      const { project } = get();
      if (!project) return false;
      const a = project.assets.find((x) => x.id === assetId);
      if (!a || a.kind === 'image') return false;
      const clean = cleanRange(marks);
      if (sameRange(cleanRange(a.marks), clean)) return false;
      const { marks: _old, ...rest } = a;
      void _old;
      const nextAsset: MediaAsset = clean ? { ...rest, marks: clean } : rest;
      const next = { ...project, assets: project.assets.map((x) => (x.id === assetId ? nextAsset : x)) };
      if (pending === project) pending = next; // a gesture's undo step stays open
      set({ project: next });
      return true;
    },

    addTrack(kind, opts) {
      let id = '';
      mutate((p) => {
        const made = withNewTrack(p, kind, opts?.index);
        id = made.track.id;
        return made.project;
      }, opts);
      return id;
    },
    removeTrack(trackId, opts) {
      mutate((p) => {
        if (!p.tracks.some((t) => t.id === trackId)) return null;
        const gone = withTargetedEffects(p, new Set(p.clips.filter((c) => c.trackId === trackId).map((c) => c.id)));
        return {
          ...p,
          tracks: p.tracks.filter((t) => t.id !== trackId),
          clips: gone.size > 0 ? removeClipsKeepingPose(p, gone) : p.clips,
        };
      }, opts);
    },
    updateTrack(trackId, patch, opts) {
      mutate((p) => {
        const t = p.tracks.find((x) => x.id === trackId);
        if (!t) return null;
        const n = patchTrack(t, patch);
        if (!n) return null;
        return { ...p, tracks: p.tracks.map((x) => (x === t ? n : x)) };
      }, opts);
      if (patch.locked === true) {
        const p = get().project;
        const sel = get().selection;
        const kept = sel.filter((id) => p?.clips.find((c) => c.id === id)?.trackId !== trackId);
        if (kept.length !== sel.length) set({ selection: kept });
      }
    },
    resetMixer(opts) {
      mutate((p) => planMixerReset(p), opts);
    },
    moveTrack(trackId, toIndex, opts) {
      mutate((p) => {
        const from = p.tracks.findIndex((t) => t.id === trackId);
        if (from < 0) return null;
        const track = p.tracks[from]!;
        const videoCount = p.tracks.filter((t) => t.kind === 'video').length;
        const lo = track.kind === 'video' ? 0 : videoCount;
        const hi = track.kind === 'video' ? videoCount - 1 : p.tracks.length - 1;
        const to = clamp(toIndex, lo, hi);
        if (to === from) return null;
        const tracks = [...p.tracks];
        tracks.splice(from, 1);
        tracks.splice(to, 0, track);
        return { ...p, tracks };
      }, opts);
    },

    insertAsset(assetId, opts) {
      let id: string | null = null;
      mutate((p) => {
        const asset = p.assets.find((a) => a.id === assetId);
        if (!asset) return null;
        if (clipTypeFor(asset, opts?.parts) === null) return null;
        const draft = createClipFromAsset(asset, '', 0, { range: opts?.range, parts: opts?.parts });
        const kind = trackKindForClip(draft.type);
        const placed = resolvePlacement(p, kind, draft.duration, opts?.trackId, opts?.start);
        const clip = { ...draft, trackId: placed.trackId, start: placed.start };
        id = clip.id;
        return { ...placed.project, clips: [...placed.project.clips, clip] };
      }, opts);
      if (id) set({ selection: [id] });
      return id;
    },
    addText(opts) {
      let id = '';
      mutate((p) => {
        const duration = Math.max(MIN_CLIP_DURATION, opts?.duration ?? opts?.preset?.duration ?? DEFAULT_TEXT_DURATION);
        const placed = resolvePlacement(p, 'video', duration, opts?.trackId, opts?.start);
        const draft = createTextClip(placed.trackId, placed.start, { ...opts?.preset, duration });
        // never let a preset override identity/placement
        draft.trackId = placed.trackId;
        draft.start = placed.start;
        draft.type = 'text';
        const clip = clampFades(draft);
        id = clip.id;
        return { ...placed.project, clips: [...placed.project.clips, clip] };
      }, opts);
      if (id) set({ selection: [id] });
      return id;
    },

    addShape(opts) {
      let id = '';
      mutate((p) => {
        const duration = Math.max(MIN_CLIP_DURATION, opts?.duration ?? opts?.preset?.duration ?? DEFAULT_SHAPE_DURATION);
        const placed = resolvePlacement(p, 'video', duration, opts?.trackId, opts?.start);
        const draft = createShapeClip(placed.trackId, placed.start, { ...opts?.preset, duration });
        // never let a preset override identity/placement
        draft.trackId = placed.trackId;
        draft.start = placed.start;
        draft.type = 'shape';
        const clip = clampFades(draft);
        id = clip.id;
        return { ...placed.project, clips: [...placed.project.clips, clip] };
      }, opts);
      if (id) set({ selection: [id] });
      return id;
    },

    addMarker(time, name, opts) {
      const t = Math.max(0, time);
      const existing = get().project?.markers?.find((m) => Math.abs(m.time - t) <= 1e-3);
      if (existing) return existing.id;
      const id = uid('mrk');
      mutate((p) => {
        const markers = [...(p.markers ?? []), { id, time: t, name: name ?? '' }].sort((a, b) => a.time - b.time);
        return { ...p, markers };
      }, opts);
      return id;
    },
    updateMarker(id, patch, opts) {
      mutate((p) => {
        const old = p.markers?.find((m) => m.id === id);
        if (!old) return null;
        const next = {
          ...old,
          time: typeof patch.time === 'number' && Number.isFinite(patch.time) ? Math.max(0, patch.time) : old.time,
          name: typeof patch.name === 'string' ? patch.name : old.name,
        };
        if (next.time === old.time && next.name === old.name) return null;
        const markers = (p.markers ?? []).map((m) => (m.id === id ? next : m)).sort((a, b) => a.time - b.time);
        return { ...p, markers };
      }, opts);
    },
    removeMarker(id, opts) {
      mutate((p) => {
        if (!p.markers?.some((m) => m.id === id)) return null;
        return { ...p, markers: p.markers.filter((m) => m.id !== id) };
      }, opts);
    },
    setRange(range) {
      const { project } = get();
      if (!project) return;
      const clean = cleanRange(range);
      if (sameRange(cleanRange(project.range), clean)) return;
      const next: Project = { ...project };
      if (clean) next.range = clean;
      else delete next.range;
      // not an undo step. an open gesture keeps its step whole (like addAsset), and a history entry that is this
      // very project stays "nothing changed" for undo
      if (pending === project) pending = next;
      const sel = selectionAt.get(project);
      if (sel) selectionAt.set(next, sel);
      const past = get().past;
      set(past.includes(project) ? { project: next, past: past.map((p) => (p === project ? next : p)) } : { project: next });
    },

    addEffect(effect, opts) {
      const def = getEffect(effect);
      if (!def) return null;
      let id: string | null = null;
      mutate((p) => {
        const duration = Math.max(MIN_CLIP_DURATION, opts?.duration ?? DEFAULT_EFFECT_DURATION);
        let placed: { project: Project; trackId: string; start: number };
        const wanted = opts?.trackId ? p.tracks.find((t) => t.id === opts.trackId) : undefined;
        if (wanted && wanted.kind === 'video' && !wanted.locked) {
          placed = resolvePlacement(p, 'video', duration, wanted.id, opts?.start);
        } else {
          const s = Math.max(0, opts?.start ?? 0);
          const top = p.tracks[0];
          if (top && top.kind === 'video' && !top.locked && isRangeFree(p, top.id, s, duration)) {
            placed = { project: p, trackId: top.id, start: s };
          } else {
            const made = withNewTrack(p, 'video', 0);
            placed = { project: made.project, trackId: made.track.id, start: s };
          }
        }
        const clip = createEffectClip(def.id, def.name, placed.trackId, placed.start, { duration });
        id = clip.id;
        return { ...placed.project, clips: [...placed.project.clips, clip] };
      }, opts);
      if (id) set({ selection: [id] });
      return id;
    },
    addCamera(opts) {
      let id = '';
      mutate((p) => {
        const duration = Math.max(MIN_CLIP_DURATION, opts?.duration ?? DEFAULT_CAMERA_DURATION);
        let placed: { project: Project; trackId: string; start: number };
        const wanted = opts?.trackId ? p.tracks.find((t) => t.id === opts.trackId) : undefined;
        if (wanted && wanted.kind === 'video' && !wanted.locked) {
          placed = resolvePlacement(p, 'video', duration, wanted.id, opts?.start);
        } else {
          const s = Math.max(0, opts?.start ?? 0);
          const top = p.tracks[0];
          if (top && top.kind === 'video' && !top.locked && isRangeFree(p, top.id, s, duration)) {
            placed = { project: p, trackId: top.id, start: s };
          } else {
            const made = withNewTrack(p, 'video', 0);
            placed = { project: made.project, trackId: made.track.id, start: s };
          }
        }
        const clip = createCameraClip(placed.trackId, placed.start, { duration });
        id = clip.id;
        return { ...placed.project, clips: [...placed.project.clips, clip] };
      }, opts);
      if (id) set({ selection: [id] });
      return id;
    },
    setClipValue(id, prop, time, value, opts) {
      mutate((p) => {
        const clip = p.clips.find((c) => c.id === id);
        if (!clip) return null;
        const next = valueEdit(p, clip, prop, time, value);
        return next ? replaceClip(p, next) : null;
      }, opts);
    },
    setClipValues(edits, opts) {
      mutate((p) => {
        const index = new Map<string, number>();
        p.clips.forEach((c, i) => {
          if (!index.has(c.id)) index.set(c.id, i);
        });
        let clips: Clip[] | null = null;
        for (const e of edits) {
          const i = index.get(e.id);
          if (i === undefined) continue;
          const clip = (clips ?? p.clips)[i]!;
          const t = clamp(e.time, clip.start, clip.start + clip.duration);
          const next = valueEdit(p, clip, e.prop, t, e.value);
          if (!next) continue;
          if (!clips) clips = p.clips.slice();
          clips[i] = next;
        }
        return clips ? { ...p, clips } : null;
      }, opts);
    },
    toggleKeyframe(id, prop, time, opts) {
      mutate((p) => {
        const clip = p.clips.find((c) => c.id === id);
        if (!clip || isLocked(p, clip.trackId)) return null;
        const keys = clip.keyframes?.[prop];
        const tol = 0.5 / p.fps;
        if (keys && keyIndexAt(keys, time - clip.start, tol) >= 0) return replaceClip(p, withoutKeyAt(clip, prop, time, tol));
        const v = valueAt(clip, prop, time) ?? propDefault(clip, prop);
        if (v === undefined) return null;
        return replaceClip(p, withKeyAt(clip, prop, time, v));
      }, opts);
    },
    setKeyframe(id, prop, time, value, ease, opts) {
      mutate((p) => {
        const clip = p.clips.find((c) => c.id === id);
        if (!clip || isLocked(p, clip.trackId) || !canKey(clip, prop)) return null;
        let v = value ?? valueAt(clip, prop, time) ?? propDefault(clip, prop);
        if (v === undefined || !Number.isFinite(v)) return null;
        const c = clampProp(clip, prop, v);
        if (c === null) return null;
        v = c;
        return replaceClip(p, withKeyAt(clip, prop, time, v, ease));
      }, opts);
    },
    removeKeyframe(id, prop, time, tolerance, opts) {
      mutate((p) => {
        const clip = p.clips.find((c) => c.id === id);
        if (!clip || isLocked(p, clip.trackId)) return null;
        const next = withoutKeyAt(clip, prop, time, tolerance ?? 0.5 / p.fps);
        return next === clip ? null : replaceClip(p, next);
      }, opts);
    },
    moveKeyframe(id, prop, fromTime, toTime, tolerance, opts) {
      mutate((p) => {
        const clip = p.clips.find((c) => c.id === id);
        if (!clip || !clip.keyframes || isLocked(p, clip.trackId)) return null;
        const tol = tolerance ?? 0.5 / p.fps;
        const from = fromTime - clip.start;
        const to = clamp(toTime - clip.start, 0, clip.duration);
        if (Math.abs(to - from) < KEY_EPS) return null;
        let changed = false;
        const kf = { ...clip.keyframes };
        for (const [name, keys] of Object.entries(kf)) {
          if (prop !== null && name !== prop) continue;
          const at = keyIndexAt(keys, from, tol);
          if (at < 0) continue;
          const moved = { ...keys[at]!, t: to };
          // a key already sitting at the target is replaced
          const rest = keys.filter((k, i) => i !== at && Math.abs(k.t - to) > KEY_EPS);
          kf[name] = [...rest, moved].sort((a, b) => a.t - b.t);
          changed = true;
        }
        return changed ? replaceClip(p, { ...clip, keyframes: kf }) : null;
      }, opts);
    },
    setClipKeyframes(id, keyframes, opts) {
      mutate((p) => {
        const clip = p.clips.find((c) => c.id === id);
        if (!clip || isLocked(p, clip.trackId)) return null;
        const kf = cleanKeyframes(clip, keyframes);
        const freeze = opts?.time ?? clip.start;
        let next: Clip = clip;
        // a property that lost all its keys keeps the value it had at `freeze`
        for (const [prop, keys] of Object.entries(clip.keyframes ?? {})) {
          if (keys.length > 0 && !kf?.[prop]) next = withBaseValue(next, prop, evalKeys(keys, freeze - clip.start));
        }
        if (next === clip && sameKeyframes(clip.keyframes, kf)) return null;
        return replaceClip(p, { ...next, keyframes: kf });
      }, opts);
    },
    clearKeyframes(id, time, prop, opts) {
      mutate((p) => {
        const clip = p.clips.find((c) => c.id === id);
        if (!clip || !clip.keyframes || isLocked(p, clip.trackId)) return null;
        const next = withoutKeys(clip, time, prop);
        if (next === clip) return null;
        return replaceClip(p, next);
      }, opts);
    },
    setEffectParam(id, key, value, opts) {
      mutate((p) => {
        const clip = p.clips.find((c) => c.id === id);
        if (!clip || clip.type !== 'effect' || isLocked(p, clip.trackId)) return null;
        const param = getEffect(clip.effect)?.params.find((q) => q.key === key);
        if (!param || !Number.isFinite(value)) return null;
        const v = clamp(value, param.min, param.max);
        if ((clip.params[key] ?? param.default) === v) return null;
        return replaceClip(p, { ...clip, params: { ...clip.params, [key]: v } });
      }, opts);
    },

    updateClip(id, patch, opts) {
      mutate((p) => {
        const clip = p.clips.find((c) => c.id === id);
        if (!clip || isLocked(p, clip.trackId)) return null;
        const next: Record<string, unknown> = { ...clip };
        let changed = false;
        for (const [key, raw] of Object.entries(patch)) {
          if (raw === undefined) continue;
          // field does not exist on this clip type
          if (!(key in clip) && !OPTIONAL_CLIP_KEYS[clip.type]?.includes(key)) continue;
          let value: unknown = raw;
          // a tempo is a number in range or nothing at all. cleaned before the compare: a value that cleans to
          // what is stored is no change
          if (key === 'bpm' && value != null) value = typeof value === 'number' && Number.isFinite(value) ? parseBpm(clamp(value, BPM_MIN, BPM_MAX)) : null;
          if (key === 'beatOffset' && value != null) value = parseBeatOffset(value);
          // an effect's tempo link is cleaned to its shape (bad input = no link) and compared by what it says, not by identity
          if (key === 'beat') {
            value = parseEffectBeat(value);
            if (sameEffectBeat(next[key] as EffectBeat | null | undefined, value as EffectBeat | null)) continue;
            // no link = no field (the saved project stays as it was before the feature)
            if (value === null) {
              delete next[key];
              changed = true;
              continue;
            }
          }
          // a pivot is cleaned to { x, y } in range or nothing at all, and compared by value. the middle = no field
          // (a saved project stays as it was before the feature)
          if (key === 'pivot') {
            value = normalizePivot(value);
            if (samePivot(next.pivot as Pivot | null | undefined, value as Pivot | null)) continue;
            if (value === null) {
              delete next.pivot;
              changed = true;
              continue;
            }
          }
          // a bend is cleaned like setBends does. null takes the field and its keys off. an equal bend is no change
          if (key === 'bend') {
            const clean = value === null ? null : parseBend(value);
            if (clean === null) {
              if ('bend' in next) {
                delete next.bend;
                changed = true;
              }
              if ((clip.keyframes?.['bend.angle']?.length ?? 0) > 0) {
                const kf = withoutBendKeys(clip.keyframes);
                if (kf) next.keyframes = kf;
                else delete next.keyframes;
                changed = true;
              }
              continue;
            }
            if (sameClipBend(next.bend as ClipBend | null | undefined, clean)) continue;
            value = clean;
          }
          // a grade is cleaned and compared by value. null takes it and its keys off. one that cleans to nothing is no field
          if (key === 'grade') {
            if (value === null) {
              if ('grade' in next) {
                delete next.grade;
                changed = true;
              }
              const kf = withoutGradeKeys(next.keyframes as Keyframes | undefined);
              if (kf !== next.keyframes) {
                if (kf) next.keyframes = kf;
                else delete next.keyframes;
                changed = true;
              }
              continue;
            }
            const clean = normalizeGrade(value) ?? {};
            if (sameGrade(next.grade as ClipGrade | undefined, clean)) continue;
            if (Object.keys(clean).length === 0) {
              delete next.grade;
              changed = true;
              continue;
            }
            value = clean;
          }
          // the sides of a solid: no fill left = no field (the saved project stays as it was before the feature)
          if (key === 'faces' && (value === null || typeof value !== 'object' || Object.keys(value as object).length === 0)) {
            if (key in next) {
              delete next[key];
              changed = true;
            }
            continue;
          }
          // a sound's pan is -1..1 and the middle = no field (a saved project stays as it was). a camera's pan is degrees, untouched
          if (key === 'pan' && (clip.type === 'video' || clip.type === 'audio')) {
            const v = value === null ? 0 : typeof value === 'number' && Number.isFinite(value) ? clamp(value, -1, 1) : NaN;
            if (Number.isNaN(v)) continue;
            if (Math.abs(v) < 1e-4) {
              if ('pan' in next) {
                delete next.pan;
                changed = true;
              }
              continue;
            }
            value = v;
          }
          if (key === 'keyframes') continue; // use the keyframe actions
          if (['id', 'type', 'trackId', 'start', 'duration', 'trimStart', 'speed'].includes(key)) continue;
          // attaching a clip to itself or to one of its own children would make a loop
          if (key === 'parent' && typeof value === 'string' && wouldCycle(p, clip.id, value)) continue;
          // an optional field that is missing and one set to null mean the same thing
          if (next[key] !== value && !(next[key] == null && value == null)) {
            next[key] = value;
            changed = true;
          }
        }
        if (!changed) return null;
        if (typeof next.volume === 'number') next.volume = clamp(next.volume as number, 0, 2);
        if (clip.type === 'effect' && typeof next.amount === 'number') next.amount = clamp(next.amount as number, 0, 1);
        return replaceClip(p, clampFades(next as unknown as Clip));
      }, opts);
    },
    setBends(list, opts) {
      mutate((p) => {
        const byId = new Map(list.map((w) => [w.id, w]));
        let any = false;
        const clips = p.clips.map((c) => {
          const w = byId.get(c.id);
          if (!w || !isVisualClip(c) || isLocked(p, c.trackId)) return c;
          const bend = w.bend === null ? null : parseBend(w.bend);
          let keys: Keyframe[] | undefined | null = undefined;
          if (w.keys === null) keys = null;
          else if (w.keys) keys = cleanBendKeys(w.keys);
          const sameB = bend === null ? !c.bend : sameClipBend(c.bend, bend);
          let kf = c.keyframes;
          if (keys === null) kf = withoutBendKeys(c.keyframes);
          else if (keys && keys.length > 0) kf = { ...(c.keyframes ?? {}), 'bend.angle': keys };
          else if (keys) kf = withoutBendKeys(c.keyframes);
          const sameK = sameKeyframes(c.keyframes, kf);
          if (sameB && sameK) return c;
          any = true;
          const next: Record<string, unknown> = { ...c };
          if (bend === null) delete next.bend;
          else next.bend = bend;
          if (kf) next.keyframes = kf;
          else delete next.keyframes;
          return next as unknown as Clip;
        });
        return any ? { ...p, clips } : null;
      }, opts);
    },
    replaceClipAsset(id, assetId, opts) {
      return mutate((p) => {
        const clip = p.clips.find((c) => c.id === id);
        const asset = p.assets.find((a) => a.id === assetId);
        if (!clip || !asset || isLocked(p, clip.trackId)) return null;
        if (clip.type !== 'video' && clip.type !== 'image' && clip.type !== 'audio') return null;
        // an audio clip takes any media with sound. a picture whose sound is apart swaps its sound clips too when the new video has sound
        const fits = asset.kind === clip.type || (clip.type === 'audio' && asset.kind === 'video' && asset.hasAudio);
        if (!fits || clip.assetId === assetId) return null;
        const swap = (c: VideoClip | ImageClip | AudioClip): Clip => {
          // a name the user gave the clip stays: the new asset's name only replaces the old asset's name or none
          const oldAsset = p.assets.find((a) => a.id === c.assetId);
          const name = !c.name || c.name === oldAsset?.name ? asset.name : c.name;
          if (c.type === 'image') return { ...c, assetId, name };
          const speed = c.speed > 0 ? c.speed : 1;
          const length = asset.duration > 0 ? asset.duration : c.duration * speed;
          const want = c.duration * speed;
          const trimStart = Math.max(0, Math.min(c.trimStart, length - want));
          const duration = Math.max(MIN_CLIP_DURATION, Math.min(c.duration, (length - trimStart) / speed));
          // another sound has another tempo
          const swapped = { ...c, assetId, name, trimStart, duration };
          delete swapped.bpm;
          delete swapped.beatOffset;
          return clampFades(swapped);
        };
        let next = replaceClip(p, swap(clip));
        if (clip.type === 'video' && asset.hasAudio) {
          for (const s of ownSoundsOf(p.clips, clip)) {
            if (isLocked(p, s.trackId) || s.assetId === assetId) continue;
            next = replaceClip(next, swap(s));
          }
        }
        return next;
      }, opts);
    },
    updateTransform(id, patch, opts) {
      mutate((p) => {
        const clip = p.clips.find((c) => c.id === id);
        if (!clip || !isVisualClip(clip) || isLocked(p, clip.trackId)) return null;
        const transform = { ...clip.transform, ...patch };
        transform.opacity = clamp(transform.opacity, 0, 1);
        transform.scale = clamp(transform.scale, MIN_SCALE, MAX_SCALE);
        // a stretch is only clamped when it is set (a missing one stays missing, it reads as 1)
        if (transform.scaleX !== undefined) transform.scaleX = clamp(transform.scaleX, MIN_SCALE, MAX_SCALE);
        if (transform.scaleY !== undefined) transform.scaleY = clamp(transform.scaleY, MIN_SCALE, MAX_SCALE);
        if (transform.scaleZ !== undefined) transform.scaleZ = clamp(transform.scaleZ, MIN_SCALE, MAX_SCALE);
        const cur = clip.transform;
        if (
          transform.x === cur.x &&
          transform.y === cur.y &&
          transform.scale === cur.scale &&
          stretchX(transform) === stretchX(cur) &&
          stretchY(transform) === stretchY(cur) &&
          stretchZ(transform) === stretchZ(cur) &&
          transform.rotation === cur.rotation &&
          transform.opacity === cur.opacity &&
          (transform.z ?? 0) === (cur.z ?? 0) &&
          (transform.rotX ?? 0) === (cur.rotX ?? 0) &&
          (transform.rotY ?? 0) === (cur.rotY ?? 0)
        ) {
          return null;
        }
        return replaceClip(p, { ...clip, transform });
      }, opts);
    },

    moveClips(moves, opts) {
      return mutate((p) => moveClipsIn(p, moves), opts);
    },

    trimClip(id, edge, time, opts) {
      mutate((p) => trimClipIn(p, id, edge, time), opts);
    },

    setClipSpeed(id, speed, opts) {
      mutate((p) => setClipSpeedIn(p, id, speed), opts);
    },
    slipClip(id, sourceDelta, opts) {
      return mutate((p) => slipClipIn(p, id, sourceDelta), opts);
    },
    /** with from, ops run on { ...project, clips: from }: assets, markers, tracks stay current. false only when refused */
    applyTrimPlan(ops, opts) {
      let refused = false;
      const from = opts?.from;
      mutate((p) => {
        const base = from && from !== p.clips ? { ...p, clips: from as Clip[] } : p;
        const next = runTrimOps(base, ops);
        if (!next) {
          refused = true;
          return null;
        }
        return next === p ? null : next; // no ops with from: the from clips come back
      }, opts);
      return !refused && get().project !== null;
    },

    splitClips(time, ids, opts) {
      const created: string[] = [];
      mutate((p) => {
        const sel = get().selection;
        const scope = ids ?? (sel.length > 0 ? sel : p.clips.map((c) => c.id));
        const targets = new Set(scope);
        const asked = new Set(scope);
        const cuttable = (c: Clip): boolean => time > c.start + MIN_CLIP_DURATION && time < clipEnd(c) - MIN_CLIP_DURATION && !isLocked(p, c.trackId);
        // a clip that lives on a side of a solid is cut only when every solid that shows it is cut with it (below: what
        // hangs on a cut clip is cut too). a side names one clip: a half its solid cannot follow (the solid is locked, or
        // does not reach over the cut) would be left without a solid and start to paint on its own.
        const onSides = faceSourceIds(p);
        const cuts = (c: Clip): boolean => {
          if (!cuttable(c)) return false;
          const solids = onSides.get(c.id);
          return !solids || solids.every((id) => p.clips.some((s) => s.id === id && cuttable(s)));
        };
        // what hangs on a clip that is cut is cut with it, so its right half can follow the right half of that
        // clip: an effect put on it, a clip attached to it or looking at it, a camera aiming at it (and what
        // hangs on those). left uncut they would stay with the left half and freeze at the cut.
        const extra = new Set<string>();
        for (const c of p.clips) if (targets.has(c.id) && cuts(c)) extra.add(c.id);
        for (let grew = extra.size > 0; grew; ) {
          grew = false;
          for (const c of p.clips) {
            if (extra.has(c.id) || !cuts(c)) continue;
            const hangsOn =
              c.type === 'effect' || c.type === 'camera'
                ? !!c.target && extra.has(c.target)
                : isVisualClip(c) && ((!!c.parent && extra.has(c.parent)) || (!!c.lookTarget && extra.has(c.lookTarget)) || showsAny(c, extra));
            if (!hangsOn) continue;
            targets.add(c.id);
            extra.add(c.id);
            grew = true;
          }
        }
        const clips: Clip[] = [];
        // original id -> right half id, to point the links of the right halves at each other
        const rightOf = new Map<string, string>();
        const extraCreated: string[] = [];
        // a group cut in two becomes two groups: the right halves get a group of their own
        const rightGroups = new Map<string, string>();
        for (const c of p.clips) {
          if (!targets.has(c.id) || !cuts(c)) {
            clips.push(c);
            continue;
          }
          // what happens at the head (entrances, the transition in) stays with the left half,
          // what happens at the tail (exits) goes with the right half
          const leftDraft = { ...c, duration: time - c.start, fadeOut: 0 } as Record<string, unknown>;
          delete leftDraft.motionOut;
          delete leftDraft.animOut;
          // an effect cut in two keeps the length its look was spread over (see EffectClip.fullDuration)
          if (c.type === 'effect') leftDraft.fullDuration = c.fullDuration ?? c.duration;
          // same for a running number: both halves count over the old length
          if (c.type === 'text' && c.counter) leftDraft.counter = { ...c.counter, fullDuration: c.counter.fullDuration ?? c.duration };
          // and for lit words: the run goes on over the cut
          if (c.type === 'text' && c.highlight) leftDraft.highlight = { ...c.highlight, fullDuration: c.highlight.fullDuration ?? c.duration };
          const left = clampFades(leftDraft as unknown as Clip);
          const rightDraft = { ...c } as Record<string, unknown>;
          delete rightDraft.transition;
          delete rightDraft.motionIn;
          delete rightDraft.animIn;
          const right = {
            ...(rightDraft as unknown as Clip),
            id: uid('clp'),
            start: time,
            duration: clipEnd(c) - time,
            fadeIn: 0,
            // both halves keep every key so the motion continues unbroken across the cut
            keyframes: shiftKeyframes(c.keyframes, -(time - c.start)),
          } as Clip;
          if (isTimedClip(right) && isTimedClip(c)) right.trimStart = c.trimStart + (time - c.start) * c.speed;
          if (right.type === 'effect' && c.type === 'effect') {
            right.timeOffset = (c.timeOffset ?? 0) + (time - c.start);
            right.fullDuration = c.fullDuration ?? c.duration;
          }
          if (right.type === 'text' && c.type === 'text' && c.counter) {
            right.counter = { ...c.counter, offset: (c.counter.offset ?? 0) + (time - c.start), fullDuration: c.counter.fullDuration ?? c.duration };
          }
          if (right.type === 'text' && c.type === 'text' && c.highlight) {
            right.highlight = { ...c.highlight, offset: (c.highlight.offset ?? 0) + (time - c.start), fullDuration: c.highlight.fullDuration ?? c.duration };
          }
          if (isVisualClip(right) && isVisualClip(c)) right.transform = { ...c.transform };
          if (c.group) {
            // one side of a separated sound cut alone: its right half stays with the side that plays on over the cut
            if (keepsSoundGroup(p.clips, c, time, (o) => targets.has(o.id) && cuts(o))) right.group = c.group;
            else {
              if (!rightGroups.has(c.group)) rightGroups.set(c.group, uid('grp'));
              right.group = rightGroups.get(c.group)!;
            }
          }
          rightOf.set(c.id, right.id);
          if (asked.has(c.id)) created.push(right.id);
          else extraCreated.push(right.id);
          clips.push(left, clampFades(right));
        }
        created.push(...extraCreated);
        if (created.length === 0) return null;
        // the right half of a solid shows the right half of a picture clip that was cut with it
        const linked = repointSplitDependents(remapSides(repointSplitHalves(clips, rightOf), (id) => rightOf.get(id), new Set(rightOf.values())), rightOf, time);
        if (rightGroups.size === 0) return { ...p, clips: linked };
        // a group of one is no group
        const size = new Map<string, number>();
        for (const c of linked) if (c.group) size.set(c.group, (size.get(c.group) ?? 0) + 1);
        return {
          ...p,
          clips: linked.map((c) => {
            if (!c.group || (size.get(c.group) ?? 0) > 1) return c;
            const alone = { ...c };
            delete alone.group;
            return alone;
          }),
        };
      }, opts);
      return created;
    },

    deleteClips(ids, opts) {
      mutate((p) => {
        const doomed = p.clips.filter((c) => ids.includes(c.id) && !isLocked(p, c.trackId));
        if (doomed.length === 0) return null;
        const doomedIds = new Set(doomed.map((c) => c.id));
        // only the clips that were asked for close a gap: an effect that goes with its clip never does
        const asked = doomed.slice();
        // effects that sit on a deleted clip go with it (they would stay behind as clips that do nothing).
        // one on a locked track stays, pointing at nothing.
        for (const c of p.clips) {
          if (c.type === 'effect' && c.target && doomedIds.has(c.target) && !doomedIds.has(c.id) && !isLocked(p, c.trackId)) {
            doomed.push(c);
            doomedIds.add(c.id);
          }
        }
        let clips = removeClipsKeepingPose(p, doomedIds);
        if (opts?.ripple) {
          const shiftOf = (c: Clip): number => {
            let shift = 0;
            for (const d of asked) if (d.trackId === c.trackId && d.start < c.start) shift += d.duration;
            return shift;
          };
          const before = clips;
          const byId = new Map(before.map((c) => [c.id, c]));
          const followed = new Set<string>();
          clips = before.map((c) => {
            let shift = shiftOf(c);
            // an effect that sits on a clip moves with it
            if (shift === 0 && c.type === 'effect' && c.target && !isLocked(p, c.trackId)) {
              const t = byId.get(c.target);
              if (t) shift = shiftOf(t);
              if (shift > 0) followed.add(c.id);
            }
            return shift > 0 ? { ...c, start: Math.max(0, c.start - shift) } : c;
          });
          // ... unless its own track has no room there: then it stays where it was
          if (followed.size > 0) {
            clips = clips.map((c, i) => {
              if (!followed.has(c.id)) return c;
              const hit = clips.some((o) => o !== c && o.trackId === c.trackId && o.start < clipEnd(c) - 1e-9 && c.start < clipEnd(o) - 1e-9);
              return hit ? before[i]! : c;
            });
          }
        }
        // a transition plays from the clip right before it: when that clip is gone and nothing touches the
        // start any more (a ripple may bring another one up), the transition would fade in from nothing
        const after = clips;
        const touched = (s: Clip) => after.some((o) => o !== s && o.trackId === s.trackId && Math.abs(clipEnd(o) - s.start) < 1e-6);
        const was = new Map(p.clips.map((c) => [c.id, c]));
        clips = clips.map((c) => {
          if (!('transition' in c) || !c.transition) return c;
          const old = was.get(c.id)!;
          if (!doomed.some((d) => d.trackId === old.trackId && Math.abs(clipEnd(d) - old.start) < 1e-6)) return c;
          if (touched(c)) return c;
          const { transition: _drop, ...rest } = c;
          void _drop;
          return rest as Clip;
        });
        return { ...p, clips };
      }, opts);
    },

    duplicateClips(ids, opts) {
      const created: string[] = [];
      mutate((p) => {
        let next = p;
        const trackIndex = (id: string) => p.tracks.findIndex((t) => t.id === id);
        // sameTime: from the bottom layer up, so every copy can be put above the copies of the layers below it
        const order = (a: Clip, b: Clip) => (opts?.sameTime ? trackIndex(b.trackId) - trackIndex(a.trackId) : 0) || a.start - b.start;
        const originals = p.clips.filter((c) => ids.includes(c.id)).sort(order);
        // the effects put on a duplicated clip come along (like copy / paste), without being asked for
        const askedIds = new Set(originals.map((c) => c.id));
        const extras = p.clips.filter((c): c is EffectClip => c.type === 'effect' && !!c.target && askedIds.has(c.target) && !askedIds.has(c.id) && !isLocked(p, c.trackId));
        const silent = new Set(extras.map((c) => c.id));
        const idMap = new Map<string, string>();
        // sameTime: the highest track taken by copies of lower layers, and the layer being worked on
        let ceiling: string | null = null;
        let groupTop: string | null = null;
        let groupHome: string | null = null;
        // one shift for the whole selection, so copies keep their timing against each other: the smallest
        // shift (at least the length of the selection) where every copy fits on its track. a clip on a
        // locked track goes to another track and does not take part.
        const free = originals.filter((c) => !isLocked(p, c.trackId));
        let shift = 0;
        if (free.length > 1 && !opts?.sameTime) {
          const first = Math.min(...free.map((c) => c.start));
          shift = Math.max(...free.map((c) => clipEnd(c))) - first;
          for (let round = 0; round < 24; round++) {
            let need = shift;
            for (const c of free) need = Math.max(need, findFreeStart(p, c.trackId, c.start + shift, c.duration) - c.start);
            if (need <= shift + 1e-9) break;
            shift = need;
          }
          // no shared spot found (very crowded tracks): place each copy on its own, as for one clip
          if (free.some((c) => !isRangeFree(p, c.trackId, c.start + shift, c.duration))) shift = 0;
        }
        for (const c of opts?.sameTime ? [...originals, ...extras].sort(order) : originals) {
          const copy = structuredClone(c);
          copy.id = uid('clp');
          if (opts?.sameTime) {
            const at = (id: string | null) => (id === null ? -1 : next.tracks.findIndex((t) => t.id === id));
            if (groupHome !== c.trackId) {
              // a new layer: what the layers below took is the ceiling now
              if (groupTop !== null && (ceiling === null || at(groupTop) < at(ceiling))) ceiling = groupTop;
              groupTop = null;
              groupHome = c.trackId;
            }
            const home = at(c.trackId);
            const kind = next.tracks[home]?.kind ?? trackKindForClip(c.type);
            const limit = ceiling !== null && at(ceiling) >= 0 ? Math.min(home, at(ceiling)) : home;
            let above: Track | undefined;
            for (let i = limit - 1; i >= 0; i--) {
              const t = next.tracks[i]!;
              if (t.kind === kind && !t.locked && isRangeFree(next, t.id, c.start, c.duration)) {
                above = t;
                break;
              }
            }
            if (!above) {
              const made = withNewTrack(next, kind, Math.max(0, limit));
              next = made.project;
              above = made.track;
            }
            if (groupTop === null || at(above.id) < at(groupTop)) groupTop = above.id;
            copy.trackId = above.id;
            copy.start = c.start;
            if (!silent.has(c.id)) created.push(copy.id);
            idMap.set(c.id, copy.id);
            next = { ...next, clips: [...next.clips, copy] };
            continue;
          }
          let trackId = c.trackId;
          if (isLocked(next, trackId)) {
            const kind = trackKindForClip(c.type);
            const room = findTrackWithRoom(next, kind, clipEnd(c), c.duration);
            if (room) trackId = room.id;
            else {
              const made = withNewTrack(next, kind);
              next = made.project;
              trackId = made.track.id;
            }
          }
          copy.trackId = trackId;
          copy.start =
            shift > 0 && trackId === c.trackId
              ? findFreeStart(next, trackId, c.start + shift, c.duration)
              : findFreeStart(next, trackId, clipEnd(c), c.duration);
          created.push(copy.id);
          idMap.set(c.id, copy.id);
          next = { ...next, clips: [...next.clips, copy] };
        }
        if (created.length === 0) return null;
        // not at the same time: an effect copy keeps its place against the copy of its clip
        if (!opts?.sameTime) {
          for (const e of extras) {
            const from = originals.find((o) => o.id === e.target);
            const to = next.clips.find((x) => x.id === idMap.get(e.target!));
            if (!from || !to) continue;
            const copy = structuredClone(e);
            copy.id = uid('clp');
            const at = Math.max(0, to.start + (e.start - from.start));
            let trackId = e.trackId;
            if (!isRangeFree(next, trackId, at, e.duration)) {
              const room = findTrackWithRoom(next, 'video', at, e.duration);
              if (room) trackId = room.id;
              else {
                const made = withNewTrack(next, 'video', 0);
                next = made.project;
                trackId = made.track.id;
              }
            }
            copy.trackId = trackId;
            copy.start = at;
            idMap.set(e.id, copy.id);
            next = { ...next, clips: [...next.clips, copy] };
          }
        }
        if (opts?.copies) for (const [from, to] of idMap) opts.copies.set(from, to);
        return relinkIn(next, idMap, [...originals, ...extras.filter((e) => idMap.has(e.id))]);
      }, opts);
      if (created.length > 0) set({ selection: created });
      return created;
    },

    addClips(input, opts) {
      const created: string[] = [];
      if (input.length === 0) return created;
      const kind = trackKindForClip(input[0]!.type);
      if (input.some((c) => trackKindForClip(c.type) !== kind)) return created;
      mutate((p) => {
        let next = p;
        const sorted = [...input].sort((a, b) => a.start - b.start);
        const idMap = new Map<string, string>();
        const copies: Clip[] = [];
        if (opts?.newTrack ?? true) {
          const made = withNewTrack(next, kind);
          next = made.project;
          if (opts?.trackName) {
            const name = opts.trackName;
            next = { ...next, tracks: next.tracks.map((t) => (t.id === made.track.id ? { ...t, name } : t)) };
          }
          let end = 0;
          for (const c of sorted) {
            const start = Math.max(0, c.start, end);
            const duration = c.start + c.duration - start;
            if (!(duration >= MIN_CLIP_DURATION)) continue;
            const copy = structuredClone(c);
            copy.id = uid('clp');
            copy.trackId = made.track.id;
            copy.start = start;
            copy.duration = duration;
            end = start + duration;
            idMap.set(c.id, copy.id);
            copies.push(clampFades(copy));
          }
          if (copies.length === 0) return null;
          next = { ...next, clips: [...next.clips, ...copies] };
        } else {
          for (const c of sorted) {
            const copy = structuredClone(c);
            copy.id = uid('clp');
            const start = Math.max(0, c.start);
            const home = next.tracks.find((t) => t.id === c.trackId);
            let trackId: string;
            if (home && home.kind === kind && !home.locked && isRangeFree(next, home.id, start, c.duration)) {
              trackId = home.id;
            } else {
              const room = findTrackWithRoom(next, kind, start, c.duration);
              if (room) trackId = room.id;
              else {
                const made = withNewTrack(next, kind);
                next = made.project;
                trackId = made.track.id;
              }
            }
            copy.trackId = trackId;
            copy.start = start;
            idMap.set(c.id, copy.id);
            const placed = clampFades(copy);
            copies.push(placed);
            next = { ...next, clips: [...next.clips, placed] };
          }
        }
        for (const c of copies) created.push(c.id);
        return relinkIn(next, idMap, sorted);
      }, opts);
      if (created.length > 0) set({ selection: created });
      return created;
    },

    insertClips(entries, opts) {
      return mutate((p) => {
        if (entries.length === 0) return null;
        const clips = [...p.clips];
        const taken = new Set(clips.map((c) => c.id));
        for (const { clip, after } of entries) {
          const track = p.tracks.find((t) => t.id === clip.trackId);
          if (!track || track.locked || track.kind !== trackKindForClip(clip.type)) return null;
          if (taken.has(clip.id) || !(clip.start >= 0) || !(clip.duration >= MIN_CLIP_DURATION - 1e-9)) return null;
          if (!isRangeFree({ clips }, clip.trackId, clip.start, clip.duration)) return null;
          taken.add(clip.id);
          const at = after ? clips.findIndex((c) => c.id === after) : -1;
          if (at >= 0) clips.splice(at + 1, 0, clip);
          else clips.push(clip);
        }
        return { ...p, clips };
      }, opts);
    },

    groupClips(ids, opts) {
      let group: string | null = null;
      mutate((p) => {
        const members = p.clips.filter((c) => ids.includes(c.id) && !isLocked(p, c.trackId));
        if (members.length < 2) return null;
        const first = members[0]!.group;
        // already exactly one group: nothing to do
        if (first && members.every((c) => c.group === first) && p.clips.filter((c) => c.group === first).length === members.length) {
          return null;
        }
        const id = uid('grp');
        group = id;
        const memberIds = new Set(members.map((c) => c.id));
        return { ...p, clips: p.clips.map((c) => (memberIds.has(c.id) ? { ...c, group: id } : c)) };
      }, opts);
      return group;
    },
    ungroupClips(ids, opts) {
      mutate((p) => {
        const groups = new Set<string>();
        for (const c of p.clips) if (ids.includes(c.id) && c.group) groups.add(c.group);
        if (groups.size === 0) return null;
        return {
          ...p,
          clips: p.clips.map((c) => {
            if (!c.group || !groups.has(c.group)) return c;
            const { group: _drop, ...rest } = c;
            void _drop;
            return rest as Clip;
          }),
        };
      }, opts);
    },
    setClipGroup(ids, group, opts) {
      return mutate((p) => {
        const want = new Set(ids);
        let changed = false;
        const clips = p.clips.map((c) => {
          if (!want.has(c.id) || isLocked(p, c.trackId) || (c.group ?? null) === group) return c;
          changed = true;
          const next = { ...c };
          if (group === null) delete next.group;
          else next.group = group;
          return next;
        });
        return changed ? { ...p, clips } : null;
      }, opts);
    },

    copySelection() {
      const { project, selection } = get();
      if (!project || selection.length === 0) return;
      // the effects put on a copied clip come along (a cut would otherwise lose them: deleting a clip deletes them)
      const ids = new Set(selection);
      for (const c of project.clips) if (c.type === 'effect' && c.target && ids.has(c.target)) ids.add(c.id);
      set({ clipboard: structuredClone(project.clips.filter((c) => ids.has(c.id))) });
    },
    cutSelection() {
      const { selection } = get();
      if (selection.length === 0) return;
      get().copySelection();
      get().deleteClips(selection);
    },
    paste(time) {
      const created: string[] = [];
      const { clipboard } = get();
      if (clipboard.length === 0) return created;
      mutate((p) => {
        let next = p;
        const origin = Math.min(...clipboard.map((c) => c.start));
        const sorted = [...clipboard].sort((a, b) => a.start - b.start);
        const idMap = new Map<string, string>();
        for (const c of sorted) {
          // skip clips whose asset was removed since the copy
          if ('assetId' in c && !next.assets.some((a) => a.id === c.assetId)) continue;
          const copy = structuredClone(c);
          copy.id = uid('clp');
          const start = Math.max(0, time + (c.start - origin));
          const kind = trackKindForClip(c.type);
          const home = next.tracks.find((t) => t.id === c.trackId);
          let trackId: string;
          if (home && home.kind === kind && !home.locked && isRangeFree(next, home.id, start, c.duration)) {
            trackId = home.id;
          } else {
            const room = findTrackWithRoom(next, kind, start, c.duration);
            if (room) trackId = room.id;
            else {
              const made = withNewTrack(next, kind);
              next = made.project;
              trackId = made.track.id;
            }
          }
          copy.trackId = trackId;
          copy.start = start;
          created.push(copy.id);
          idMap.set(c.id, copy.id);
          next = { ...next, clips: [...next.clips, copy] };
        }
        if (created.length === 0) return null;
        return relinkIn(next, idMap, sorted);
      });
      if (created.length > 0) set({ selection: created });
      return created;
    },

    select(ids, mode = 'replace') {
      const { project, selection } = get();
      if (!project) return;
      const valid = selectableIds(project, ids);
      if (mode === 'replace') {
        set({ selection: valid });
      } else if (mode === 'add') {
        set({ selection: [...new Set([...selection, ...valid])] });
      } else {
        const cur = new Set(selection);
        for (const id of valid) {
          if (cur.has(id)) cur.delete(id);
          else cur.add(id);
        }
        set({ selection: [...cur] });
      }
    },
    clearSelection() {
      if (get().selection.length > 0) set({ selection: [] });
    },
    selectAll() {
      const { project } = get();
      if (!project) return;
      set({ selection: project.clips.filter((c) => !isLocked(project, c.trackId)).map((c) => c.id) });
    },

    setZoom(zoom) {
      set({ zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM) });
    },
    setSnapping(on) {
      set({ snapping: on });
    },
  };
});

/* ---------- hooks with stable results ---------- */

/** the open project. throws when used outside the editor (no project open). */
export function useProject(): Project {
  const project = useEditor((s) => s.project);
  if (!project) throw new Error('useProject: no project is open');
  return project;
}

export function useSelectedClips(): Clip[] {
  const clips = useEditor((s) => s.project?.clips);
  const selection = useEditor((s) => s.selection);
  return useMemo(() => (clips ?? []).filter((c) => selection.includes(c.id)), [clips, selection]);
}

export function useClip(id: string | undefined): Clip | undefined {
  return useEditor((s) => (id ? s.project?.clips.find((c) => c.id === id) : undefined));
}

export function useAsset(id: string | undefined): MediaAsset | undefined {
  return useEditor((s) => (id ? s.project?.assets.find((a) => a.id === id) : undefined));
}

export function useCanUndo(): boolean {
  return useEditor((s) => s.past.length > 0);
}
export function useCanRedo(): boolean {
  return useEditor((s) => s.future.length > 0);
}
