/**
 * the beat grid of effect clips (EffectClip.beat), kept per clips array like targetIndex in clipFx.ts. pure: no dom.
 * which clip an effect follows depends on every clip with a tempo, so a grid is looked up lazily per effect and
 * remembered until the clips (or the assets that say who has sound) are replaced.
 */
import { type BeatGrid, effectBeatGrid } from '../lib/tempo';
import type { EffectClip, MediaAsset, Project } from '../types';

interface Entry {
  assets: readonly MediaAsset[];
  /** effect id -> the grid, with what it was worked out from (a clip edited in place must not keep a stale grid) */
  grids: Map<string, { start: number; duration: number; source: string | null; grid: BeatGrid | null }>;
}

const cache = new WeakMap<object, Entry>();

/** true when the link can change the picture at all (a pulse or a lock) */
export function hasBeatLink(e: EffectClip): boolean {
  return !!e.beat && (e.beat.pulse > 0 || e.beat.lock);
}

/** the grid an effect clip follows, null without a link, without any tempo, or with a link that does nothing */
export function beatGridOf(project: Pick<Project, 'clips' | 'assets'>, e: EffectClip): BeatGrid | null {
  if (!hasBeatLink(e)) return null;
  let entry = cache.get(project.clips);
  if (!entry || entry.assets !== project.assets) {
    entry = { assets: project.assets, grids: new Map() };
    cache.set(project.clips, entry);
  }
  const source = e.beat?.source ?? null;
  const hit = entry.grids.get(e.id);
  if (hit && hit.start === e.start && hit.duration === e.duration && hit.source === source) return hit.grid;
  const grid = effectBeatGrid(project, e);
  entry.grids.set(e.id, { start: e.start, duration: e.duration, source, grid });
  return grid;
}
