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
  Easing,
  EffectClip,
  ImageClip,
  MediaAsset,
  Project,
  ShapeClip,
  TextClip,
  Track,
  TrackKind,
  Transform,
  VideoClip,
} from '../types';
import { MAX_SPEED, MIN_CLIP_DURATION, MIN_SPEED, isTimedClip, isVisualClip, trackKindForClip } from '../types';
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
} from '../lib/factory';
import { getEffect } from '../engine/effects/registry';
import {
  KEY_EPS,
  animProps,
  baseValue,
  isAnimated,
  keyIndexAt,
  shiftKeyframes,
  valueAt,
  withKeyAt,
  withValueAt,
  withoutKeyAt,
  withoutKeys,
} from '../lib/anim';
import { uid } from '../lib/id';
import { relinkCopies, unlinkRemoved, wouldCycle } from '../lib/links';
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

const HISTORY_LIMIT = 100;
export const MIN_ZOOM = 4;
export const MAX_ZOOM = 600;
export const DEFAULT_ZOOM = 80;

export interface ActionOpts {
  /** do not record an undo step for this change */
  skipHistory?: boolean;
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
] as const;
const OPTIONAL_CLIP_KEYS: Record<string, readonly string[]> = {
  video: SPATIAL_KEYS,
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
    'backgroundPerLine',
  ],
  shape: [...SPATIAL_KEYS, 'color2', 'gradientAngle', 'gradientRadial', 'filled', 'stroke', 'points', 'inner'],
  camera: ['target'],
  effect: ['timeOffset', 'target'],
};

export interface ClipMove {
  id: string;
  trackId: string;
  start: number;
}

export type ProjectSettingsPatch = Partial<Pick<Project, 'name' | 'width' | 'height' | 'fps' | 'background' | 'fog'>>;
export type TrackPatch = Partial<Pick<Track, 'name' | 'muted' | 'hidden' | 'locked'>>;

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
  /** record the current project as an undo step (use before a drag with skipHistory updates) */
  pushHistory(): void;
  undo(): void;
  redo(): void;

  // project
  updateProject(patch: ProjectSettingsPatch, opts?: ActionOpts): void;

  // assets (not undoable)
  addAsset(asset: MediaAsset): void;
  /** removes the asset and every clip that uses it. clears history. */
  removeAsset(assetId: string): void;
  renameAsset(assetId: string, name: string): void;

  // tracks
  /** video tracks are added on top by default, audio tracks at the bottom. returns the new track id. */
  addTrack(kind: TrackKind, opts?: ActionOpts & { index?: number }): string;
  /** removes the track and its clips */
  removeTrack(trackId: string, opts?: ActionOpts): void;
  updateTrack(trackId: string, patch: TrackPatch, opts?: ActionOpts): void;
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
  insertAsset(assetId: string, opts?: ActionOpts & { trackId?: string; start?: number }): string | null;
  /** add a text clip. same placement rules as insertAsset. returns the new clip id. */
  addText(opts?: ActionOpts & { trackId?: string; start?: number; duration?: number; preset?: Partial<TextClip> }): string;
  /** add a shape clip. same placement rules as insertAsset. returns the new clip id. */
  addShape(opts?: ActionOpts & { trackId?: string; start?: number; duration?: number; preset?: Partial<ShapeClip> }): string;
  /** add a marker at a time (timeline seconds). a marker already within 1ms of it is returned instead. returns the marker id. */
  addMarker(time: number, name?: string, opts?: ActionOpts): string;
  updateMarker(id: string, patch: { time?: number; name?: string }, opts?: ActionOpts): void;
  removeMarker(id: string, opts?: ActionOpts): void;
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
  /** add a key holding the current value at `time`, or remove the key that is already there */
  toggleKeyframe(id: string, prop: string, time: number, opts?: ActionOpts): void;
  /** add or update a key at `time`. value defaults to the current value there. */
  setKeyframe(id: string, prop: string, time: number, value?: number, ease?: Easing, opts?: ActionOpts): void;
  /** remove the key at `time` (within tolerance seconds). the last key leaves the value it had. */
  removeKeyframe(id: string, prop: string, time: number, tolerance?: number, opts?: ActionOpts): void;
  /** move the key(s) at fromTime to toTime. prop null = every property that has a key there. */
  moveKeyframe(id: string, prop: string | null, fromTime: number, toTime: number, tolerance?: number, opts?: ActionOpts): void;
  /** remove every key of one property (or of all when prop is omitted). values freeze as they are at `time`. */
  clearKeyframes(id: string, time: number, prop?: string, opts?: ActionOpts): void;
  /** set one parameter of an effect clip (clamped to the param range). */
  setEffectParam(id: string, key: string, value: number, opts?: ActionOpts): void;
  /** patch editable fields (name, volume, transform, text props, effect amount, fades...). */
  updateClip(id: string, patch: ClipPatch, opts?: ActionOpts): void;
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
  /**
   * split at a timeline time. ids defaults to the selection, or every clip under the time when
   * nothing is selected. clips on locked tracks are skipped. returns ids of the new right-hand parts.
   */
  splitClips(time: number, ids?: string[], opts?: ActionOpts): string[];
  /** ripple: close the gap by shifting later clips on the same track left */
  deleteClips(ids: string[], opts?: ActionOpts & { ripple?: boolean }): void;
  /** copies land right after the originals when there is room. selects and returns the copies. */
  duplicateClips(ids: string[], opts?: ActionOpts): string[];
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
  /** put two or more clips into a new group (they leave their old groups). returns the group id, or null. */
  groupClips(ids: string[], opts?: ActionOpts): string | null;
  /** dissolve every group that one of these clips belongs to */
  ungroupClips(ids: string[], opts?: ActionOpts): void;

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

/** point the links (parent, camera target, group) of freshly copied clips at each other */
function relinkIn(project: Project, idMap: ReadonlyMap<string, string>, originals: readonly Clip[]): Project {
  const copyIds = new Set(idMap.values());
  const copies = relinkCopies(
    project.clips.filter((c) => copyIds.has(c.id)),
    idMap,
    originals,
  );
  const byId = new Map(copies.map((c) => [c.id, c]));
  return { ...project, clips: project.clips.map((c) => byId.get(c.id) ?? c) };
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

/** clamp a value to an animatable property's range. null when the clip has no such property. */
function clampProp(clip: Clip, prop: string, value: number): number | null {
  if (prop.startsWith('p.')) {
    if (clip.type !== 'effect') return null;
    const param = getEffect(clip.effect)?.params.find((q) => q.key === prop.slice(2));
    return param ? clamp(value, param.min, param.max) : null;
  }
  const info = animProps(clip).find((a) => a.prop === prop);
  if (!info) return null;
  return clamp(value, info.min ?? -Infinity, info.max ?? Infinity);
}

/** the value a property has when nothing is stored for it (effect params fall back to the effect default) */
function propDefault(clip: Clip, prop: string): number | undefined {
  if (clip.type === 'effect' && prop.startsWith('p.')) {
    return getEffect(clip.effect)?.params.find((q) => q.key === prop.slice(2))?.default;
  }
  return baseValue(clip, prop);
}

function pruneSelection(project: Project | null, selection: string[]): string[] {
  if (!project) return [];
  const ids = new Set(project.clips.map((c) => c.id));
  const next = selection.filter((id) => ids.has(id));
  return next.length === selection.length ? selection : next;
}

/* ---------- store ---------- */

export const useEditor = create<EditorState>()((set, get) => {
  /** apply a project transform with history bookkeeping. returns true when something changed. */
  function mutate(fn: (p: Project) => Project | null | undefined, opts?: ActionOpts): boolean {
    const { project, past } = get();
    if (!project) return false;
    const next = fn(project);
    if (!next || next === project) return false;
    if (opts?.skipHistory) {
      set({ project: next, selection: pruneSelection(next, get().selection) });
    } else {
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
      set({ project, selection: [], past: [], future: [], zoom: DEFAULT_ZOOM });
    },
    closeProject() {
      set({ project: null, selection: [], past: [], future: [] });
    },

    pushHistory() {
      const { project, past } = get();
      if (!project) return;
      if (past[past.length - 1] === project) return;
      set({ past: [...past, project].slice(-HISTORY_LIMIT), future: [] });
    },
    undo() {
      const { project } = get();
      if (!project) return;
      const past = [...get().past];
      // skip no-op steps (a drag that pushed history but changed nothing)
      let prev = past.pop();
      while (prev && prev === project) prev = past.pop();
      if (!prev) {
        set({ past });
        return;
      }
      // assets are not part of history: keep the current list
      const restored: Project = { ...prev, assets: project.assets };
      set({
        project: restored,
        past,
        future: [project, ...get().future].slice(0, HISTORY_LIMIT),
        selection: pruneSelection(restored, get().selection),
      });
    },
    redo() {
      const { project, future, past } = get();
      if (!project || future.length === 0) return;
      const [next, ...rest] = future;
      const restored: Project = { ...next!, assets: project.assets };
      set({
        project: restored,
        past: [...past, project].slice(-HISTORY_LIMIT),
        future: rest,
        selection: pruneSelection(restored, get().selection),
      });
    },

    updateProject(patch, opts) {
      mutate((p) => {
        const next = { ...p, ...patch };
        if (patch.width !== undefined) next.width = clamp(Math.round(patch.width), 16, 7680);
        if (patch.height !== undefined) next.height = clamp(Math.round(patch.height), 16, 7680);
        if (patch.fps !== undefined) next.fps = clamp(patch.fps, 1, MAX_FPS);
        if (patch.name !== undefined) next.name = patch.name.trim() || 'untitled project';
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
      set({ project: { ...project, assets: [...project.assets, asset] } });
    },
    removeAsset(assetId) {
      const { project } = get();
      if (!project) return;
      const uses = (c: Clip) => 'assetId' in c && c.assetId === assetId;
      const gone = new Set(project.clips.filter(uses).map((c) => c.id));
      const next: Project = {
        ...project,
        assets: project.assets.filter((a) => a.id !== assetId),
        clips: gone.size > 0 ? unlinkRemoved(project.clips.filter((c) => !gone.has(c.id)), gone) : project.clips,
      };
      // history holds whole projects: a step that still has a clip of this asset cannot be gone back to.
      // when no step has one (an unused asset), undo and redo stay as they are.
      const inHistory = [...get().past, ...get().future].some((p) => p.clips.some(uses));
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
        const gone = new Set(p.clips.filter((c) => c.trackId === trackId).map((c) => c.id));
        return {
          ...p,
          tracks: p.tracks.filter((t) => t.id !== trackId),
          clips: gone.size > 0 ? unlinkRemoved(p.clips.filter((c) => !gone.has(c.id)), gone) : p.clips,
        };
      }, opts);
    },
    updateTrack(trackId, patch, opts) {
      mutate((p) => {
        if (!p.tracks.some((t) => t.id === trackId)) return null;
        return { ...p, tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t)) };
      }, opts);
      if (patch.locked === true) {
        const p = get().project;
        const sel = get().selection;
        const kept = sel.filter((id) => p?.clips.find((c) => c.id === id)?.trackId !== trackId);
        if (kept.length !== sel.length) set({ selection: kept });
      }
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
        const draft = createClipFromAsset(asset, '', 0);
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
        const duration = Math.max(MIN_CLIP_DURATION, opts?.duration ?? DEFAULT_TEXT_DURATION);
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
        if (!clip || isLocked(p, clip.trackId) || !Number.isFinite(value)) return null;
        if (baseValue(clip, prop) === undefined && !prop.startsWith('p.')) return null;
        const v = clampProp(clip, prop, value);
        if (v === null) return null;
        if (valueAt(clip, prop, time) === v && (!isAnimated(clip, prop) || keyIndexAt(clip.keyframes![prop]!, time - clip.start) >= 0)) {
          return null;
        }
        return replaceClip(p, withValueAt(clip, prop, time, v));
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
        if (!clip || isLocked(p, clip.trackId)) return null;
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
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) continue;
          // field does not exist on this clip type
          if (!(key in clip) && !OPTIONAL_CLIP_KEYS[clip.type]?.includes(key)) continue;
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
    replaceClipAsset(id, assetId, opts) {
      return mutate((p) => {
        const clip = p.clips.find((c) => c.id === id);
        const asset = p.assets.find((a) => a.id === assetId);
        if (!clip || !asset || isLocked(p, clip.trackId)) return null;
        if (clip.type !== 'video' && clip.type !== 'image' && clip.type !== 'audio') return null;
        if (asset.kind !== clip.type || clip.assetId === assetId) return null;
        if (clip.type === 'image') return replaceClip(p, { ...clip, assetId, name: asset.name });
        const speed = clip.speed > 0 ? clip.speed : 1;
        const length = asset.duration > 0 ? asset.duration : clip.duration * speed;
        const want = clip.duration * speed;
        const trimStart = Math.max(0, Math.min(clip.trimStart, length - want));
        const duration = Math.max(MIN_CLIP_DURATION, Math.min(clip.duration, (length - trimStart) / speed));
        return replaceClip(p, clampFades({ ...clip, assetId, name: asset.name, trimStart, duration }));
      }, opts);
    },
    updateTransform(id, patch, opts) {
      mutate((p) => {
        const clip = p.clips.find((c) => c.id === id);
        if (!clip || !isVisualClip(clip) || isLocked(p, clip.trackId)) return null;
        const transform = { ...clip.transform, ...patch };
        transform.opacity = clamp(transform.opacity, 0, 1);
        transform.scale = clamp(transform.scale, 0.01, 100);
        const cur = clip.transform;
        if (
          transform.x === cur.x &&
          transform.y === cur.y &&
          transform.scale === cur.scale &&
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
      return mutate((p) => {
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
      }, opts);
    },

    trimClip(id, edge, time, opts) {
      mutate((p) => {
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
          if (next.type === 'effect' && clip.type === 'effect') next.timeOffset = (clip.timeOffset ?? 0) + delta;
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
      }, opts);
    },

    setClipSpeed(id, speed, opts) {
      mutate((p) => {
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
      }, opts);
    },

    splitClips(time, ids, opts) {
      const created: string[] = [];
      mutate((p) => {
        const sel = get().selection;
        const scope = ids ?? (sel.length > 0 ? sel : p.clips.map((c) => c.id));
        const targets = new Set(scope);
        const clips: Clip[] = [];
        // a group cut in two becomes two groups: the right halves get a group of their own
        const rightGroups = new Map<string, string>();
        for (const c of p.clips) {
          const inside = time > c.start + MIN_CLIP_DURATION && time < clipEnd(c) - MIN_CLIP_DURATION;
          if (!targets.has(c.id) || !inside || isLocked(p, c.trackId)) {
            clips.push(c);
            continue;
          }
          // what happens at the head (entrances, the transition in) stays with the left half,
          // what happens at the tail (exits) goes with the right half
          const leftDraft = { ...c, duration: time - c.start, fadeOut: 0 } as Record<string, unknown>;
          delete leftDraft.motionOut;
          delete leftDraft.animOut;
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
          if (right.type === 'effect' && c.type === 'effect') right.timeOffset = (c.timeOffset ?? 0) + (time - c.start);
          if (isVisualClip(right) && isVisualClip(c)) right.transform = { ...c.transform };
          if (c.group) {
            if (!rightGroups.has(c.group)) rightGroups.set(c.group, uid('grp'));
            right.group = rightGroups.get(c.group)!;
          }
          created.push(right.id);
          clips.push(left, clampFades(right));
        }
        if (created.length === 0) return null;
        if (rightGroups.size === 0) return { ...p, clips };
        // a group of one is no group
        const size = new Map<string, number>();
        for (const c of clips) if (c.group) size.set(c.group, (size.get(c.group) ?? 0) + 1);
        return {
          ...p,
          clips: clips.map((c) => {
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
        let clips = unlinkRemoved(
          p.clips.filter((c) => !doomedIds.has(c.id)),
          doomedIds,
        );
        if (opts?.ripple) {
          clips = clips.map((c) => {
            let shift = 0;
            for (const d of doomed) if (d.trackId === c.trackId && d.start < c.start) shift += d.duration;
            return shift > 0 ? { ...c, start: Math.max(0, c.start - shift) } : c;
          });
        }
        return { ...p, clips };
      }, opts);
    },

    duplicateClips(ids, opts) {
      const created: string[] = [];
      mutate((p) => {
        let next = p;
        const originals = p.clips.filter((c) => ids.includes(c.id)).sort((a, b) => a.start - b.start);
        const idMap = new Map<string, string>();
        // one shift for the whole selection, so copies keep their timing against each other: the smallest
        // shift (at least the length of the selection) where every copy fits on its track. a clip on a
        // locked track goes to another track and does not take part.
        const free = originals.filter((c) => !isLocked(p, c.trackId));
        let shift = 0;
        if (free.length > 1) {
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
        for (const c of originals) {
          const copy = structuredClone(c);
          copy.id = uid('clp');
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
        return relinkIn(next, idMap, originals);
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

    copySelection() {
      const { project, selection } = get();
      if (!project || selection.length === 0) return;
      set({ clipboard: structuredClone(project.clips.filter((c) => selection.includes(c.id))) });
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
      const valid = ids.filter((id) => {
        const c = project.clips.find((x) => x.id === id);
        return c && !isLocked(project, c.trackId);
      });
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
