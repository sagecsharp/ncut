/**
 * effects that sit on ONE clip (EffectClip.target). pure: no dom, no canvas.
 * the frame renderer (engine/draw.ts) asks which effect clips point at a clip and are on screen at a time.
 */
import type { EffectClip, Project, Track } from '../types';
import { isVisualClip } from '../types';
import { clipEnd } from '../lib/timelineOps';
import { getEffect } from './effects/registry';
import type { EffectAlpha, EffectPass } from './effects/types';

/** target clip id -> the effect clips that point at it, in the order they run (see buildTargetIndex) */
export type TargetIndex = Map<string, EffectClip[]>;

/** true when the clip is an effect clip with a target (the normal adjustment layer walk skips these) */
export function isTargetedEffect(clip: { type: string; target?: string | null }): boolean {
  return clip.type === 'effect' && !!clip.target;
}

/**
 * every valid targeted effect grouped by the clip it points at. an effect counts when its target is a visual clip
 * (video, image, text, shape; not itself, not audio, not unknown) and it sits on a video track. each list is in
 * the order the effects run: the effect clips' tracks from bottom to top, then by start, then project order.
 * null when the project has no effect with a target at all.
 */
export function buildTargetIndex(project: Project): TargetIndex | null {
  let any = false;
  for (const c of project.clips) {
    if (isTargetedEffect(c)) {
      any = true;
      break;
    }
  }
  if (!any) return null;
  const visual = new Set<string>();
  for (const c of project.clips) if (isVisualClip(c)) visual.add(c.id);
  // a higher track index sits lower in the stack
  const rank = new Map<string, number>();
  project.tracks.forEach((t, i) => {
    if (t.kind === 'video') rank.set(t.id, i);
  });
  const index: TargetIndex = new Map();
  for (const c of project.clips) {
    if (c.type !== 'effect' || !c.target || !visual.has(c.target) || !rank.has(c.trackId)) continue;
    const list = index.get(c.target);
    if (list) list.push(c);
    else index.set(c.target, [c]);
  }
  if (index.size === 0) return null;
  for (const list of index.values()) {
    if (list.length > 1) list.sort((a, b) => rank.get(b.trackId)! - rank.get(a.trackId)! || a.start - b.start);
  }
  return index;
}

const cache = new WeakMap<object, { n: number; tracks: readonly Track[]; index: TargetIndex | null }>();

/**
 * buildTargetIndex, kept per clips array (the store replaces the array on every edit, so identity is the key; length
 * and the tracks array guard the rest). a frame of a project without targeted effects costs one scan of the clips
 * the first time and a map lookup after that.
 */
export function targetIndex(project: Project): TargetIndex | null {
  const hit = cache.get(project.clips);
  if (hit && hit.n === project.clips.length && hit.tracks === project.tracks) return hit.index;
  const index = buildTargetIndex(project);
  cache.set(project.clips, { n: project.clips.length, tracks: project.tracks, index });
  return index;
}

/**
 * the effect clips that change the clip `clipId` at a time: they point at it, the time is inside them
 * (start <= t < end) and their track is not hidden. in run order. null when none, so callers can take the plain path.
 */
export function effectsOnClip(index: TargetIndex | null, project: Project, clipId: string, time: number): EffectClip[] | null {
  if (!index) return null;
  const list = index.get(clipId);
  if (!list) return null;
  let out: EffectClip[] | null = null;
  for (const e of list) {
    if (time < e.start - 1e-6 || time >= clipEnd(e) - 1e-6) continue;
    const track = project.tracks.find((t) => t.id === e.trackId);
    if (!track || track.kind !== 'video' || track.hidden) continue;
    (out ??= []).push(e);
  }
  return out;
}

/** how far inside a clip's end its last frame sits (the frozen tail of a transition shows this frame) */
export const CLIP_EDGE = 1e-4;

/**
 * a time clamped into a clip's own range [start, end - CLIP_EDGE]. a clip drawn frozen (the sides of a transition
 * hold their edge frame outside their range) looks up and evaluates its effects at this time, so the frozen edge
 * keeps the effects it has on that edge frame instead of losing them until the frame time reaches the clip.
 */
export function clampIntoClip(clip: { start: number; duration: number }, time: number): number {
  const last = Math.max(clip.start, clip.start + clip.duration - CLIP_EDGE);
  return Math.min(last, Math.max(clip.start, time));
}

/** what an effect does to the outline of a clip (EffectDef.alpha, missing = keep) */
export function fxAlpha(def: { alpha?: Exclude<EffectAlpha, 'keep'> }): EffectAlpha {
  return def.alpha ?? 'keep';
}

/** true when the passes need the alpha run: one of them moves pixels or makes its own see-through areas */
export function needsAlphaRun(passes: readonly EffectPass[]): boolean {
  return passes.some((p) => !!p.def.alpha);
}

const ownCache = new WeakMap<object, { n: number; own: ReadonlyMap<string, EffectClip> | null }>();

/**
 * the effect clips with an own alpha (chroma key) and no target, by id. such a clip is no adjustment layer: per frame it
 * keys the video or picture right under it (frameFx in draw.ts). null when the project has none. kept per clips array
 * like targetIndex (identity, guarded by the length).
 */
export function ownLayers(project: Project): ReadonlyMap<string, EffectClip> | null {
  const hit = ownCache.get(project.clips);
  if (hit && hit.n === project.clips.length) return hit.own;
  let own: Map<string, EffectClip> | null = null;
  for (const c of project.clips) {
    if (c.type === 'effect' && !c.target && getEffect(c.effect)?.alpha === 'own') (own ??= new Map()).set(c.id, c);
  }
  ownCache.set(project.clips, { n: project.clips.length, own });
  return own;
}

/** an own layer on screen at a frame, with the index of its track (0 = top) */
export interface OwnLayer {
  clip: EffectClip;
  track: number;
}

/** something an own layer can key at a frame: a track index and the ids of the clips it would key there */
export interface BindTarget {
  track: number;
  keys: readonly string[];
}

/**
 * which clips the own layers key at a frame. each layer takes the nearest target below it (the smallest track index
 * greater than its own) that has keys, and binds to every key of it (a transition has two). layers are taken bottom
 * first (track index from high to low, stable), so the lists are in run order. clip id -> layers. empty map = none.
 */
export function bindOwnLayers(layers: readonly OwnLayer[], targets: readonly BindTarget[]): Map<string, EffectClip[]> {
  const out = new Map<string, EffectClip[]>();
  const sorted = [...layers].sort((a, b) => b.track - a.track);
  for (const layer of sorted) {
    let best: BindTarget | null = null;
    for (const t of targets) {
      if (t.track <= layer.track || t.keys.length === 0) continue;
      if (!best || t.track < best.track) best = t;
    }
    if (!best) continue;
    for (const key of best.keys) {
      const list = out.get(key);
      if (list) list.push(layer.clip);
      else out.set(key, [layer.clip]);
    }
  }
  return out;
}

/**
 * a TargetIndex with the bound own layers added after each clip's targeted effects. the base index is not changed
 * (it is the cached one): the lists of the bound clips are new arrays.
 */
export function withOwnLayers(base: TargetIndex | null, bound: ReadonlyMap<string, readonly EffectClip[]>): TargetIndex {
  const out: TargetIndex = new Map(base ?? []);
  for (const [id, layers] of bound) out.set(id, [...(base?.get(id) ?? []), ...layers]);
  return out;
}
