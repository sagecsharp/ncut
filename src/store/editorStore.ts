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
  Clip,
  ImageClip,
  MediaAsset,
  Project,
  TextClip,
  Track,
  TrackKind,
  Transform,
  VideoClip,
} from '../types';
import { MAX_SPEED, MIN_CLIP_DURATION, MIN_SPEED, isTimedClip, isVisualClip, trackKindForClip } from '../types';
import { DEFAULT_TEXT_DURATION, createClipFromAsset, createTextClip, createTrack } from '../lib/factory';
import { uid } from '../lib/id';
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
  Partial<Omit<TextClip, LockedKeys>>;

export interface ClipMove {
  id: string;
  trackId: string;
  start: number;
}

export type ProjectSettingsPatch = Partial<Pick<Project, 'name' | 'width' | 'height' | 'fps' | 'background'>>;
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
  /** patch editable fields (name, volume, transform, text props, fades...). */
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
        if (patch.fps !== undefined) next.fps = clamp(patch.fps, 1, 120);
        if (patch.name !== undefined) next.name = patch.name.trim() || 'untitled project';
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
      const next: Project = {
        ...project,
        assets: project.assets.filter((a) => a.id !== assetId),
        clips: project.clips.filter((c) => !('assetId' in c) || c.assetId !== assetId),
      };
      set({ project: next, past: [], future: [], selection: pruneSelection(next, get().selection) });
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
        return {
          ...p,
          tracks: p.tracks.filter((t) => t.id !== trackId),
          clips: p.clips.filter((c) => c.trackId !== trackId),
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

    updateClip(id, patch, opts) {
      mutate((p) => {
        const clip = p.clips.find((c) => c.id === id);
        if (!clip || isLocked(p, clip.trackId)) return null;
        const next: Record<string, unknown> = { ...clip };
        let changed = false;
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) continue;
          if (!(key in clip)) continue; // field does not exist on this clip type
          if (['id', 'type', 'trackId', 'start', 'duration', 'trimStart', 'speed'].includes(key)) continue;
          if (next[key] !== value) {
            next[key] = value;
            changed = true;
          }
        }
        if (!changed) return null;
        if (typeof next.volume === 'number') next.volume = clamp(next.volume as number, 0, 2);
        return replaceClip(p, clampFades(next as unknown as Clip));
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
          transform.opacity === cur.opacity
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
          const next = { ...clip, start: newStart, duration: end - newStart } as Clip;
          if (isTimedClip(next) && isTimedClip(clip)) {
            next.trimStart = Math.max(0, clip.trimStart + delta * clip.speed);
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
        for (const c of p.clips) {
          const inside = time > c.start + MIN_CLIP_DURATION && time < clipEnd(c) - MIN_CLIP_DURATION;
          if (!targets.has(c.id) || !inside || isLocked(p, c.trackId)) {
            clips.push(c);
            continue;
          }
          const left = clampFades({ ...c, duration: time - c.start, fadeOut: 0 } as Clip);
          const right = { ...c, id: uid('clp'), start: time, duration: clipEnd(c) - time, fadeIn: 0 } as Clip;
          if (isTimedClip(right) && isTimedClip(c)) right.trimStart = c.trimStart + (time - c.start) * c.speed;
          if (isVisualClip(right) && isVisualClip(c)) right.transform = { ...c.transform };
          created.push(right.id);
          clips.push(left, clampFades(right));
        }
        if (created.length === 0) return null;
        return { ...p, clips };
      }, opts);
      return created;
    },

    deleteClips(ids, opts) {
      mutate((p) => {
        const doomed = p.clips.filter((c) => ids.includes(c.id) && !isLocked(p, c.trackId));
        if (doomed.length === 0) return null;
        const doomedIds = new Set(doomed.map((c) => c.id));
        let clips = p.clips.filter((c) => !doomedIds.has(c.id));
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
          copy.start = findFreeStart(next, trackId, clipEnd(c), c.duration);
          created.push(copy.id);
          next = { ...next, clips: [...next.clips, copy] };
        }
        return created.length > 0 ? next : null;
      }, opts);
      if (created.length > 0) set({ selection: created });
      return created;
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
          next = { ...next, clips: [...next.clips, copy] };
        }
        return created.length > 0 ? next : null;
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
