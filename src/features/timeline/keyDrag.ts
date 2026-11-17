/** the pure parts of dragging keyframes in the keyframe panel: where a key lands, what it snaps to, the pivot and factor of a stretch */
import type { KeyRef } from '../../store/ui';
import type { Clip, Project } from '../../types';
import { SNAP_PX } from './layout';
import { timelineSnapPoints } from './markers';
import { KEY_REF_EPS, laneId, selByLane } from './keySelection';
import { snapTimeFast } from './snapSearch';

/** snapping on: the nearest snap point within SNAP_PX / zoom, else a whole timeline frame. off: frames. never clamped */
export function keyDragTarget(t: number, points: readonly number[], zoom: number, fps: number, snapping: boolean): { time: number; hit: number | null } {
  if (snapping) {
    const s = snapTimeFast(t, points, SNAP_PX / zoom);
    if (s.hit !== null) return s;
  }
  return { time: Math.round(t * fps) / fps, hit: null };
}

/** is t in a sorted list of selected times, within KEY_REF_EPS */
export function selHas(list: Float64Array | undefined, t: number): boolean {
  if (!list) return false;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]! < t - KEY_REF_EPS) lo = mid + 1;
    else hi = mid;
  }
  return lo < list.length && Math.abs(list[lo]! - t) <= KEY_REF_EPS;
}

/** timelineSnapPoints(p, [], [playhead]) and the unselected inside keys of the shown clips (timeline seconds), ascending */
export function keySnapPoints(p: Project, shown: readonly Clip[], sel: readonly KeyRef[], playhead: number): number[] {
  const out = timelineSnapPoints(p, [], [playhead]);
  const lanes = selByLane(sel);
  for (const clip of shown) {
    if (!clip.keyframes) continue;
    for (const [prop, keys] of Object.entries(clip.keyframes)) {
      for (const k of keys) {
        if (k.t < -KEY_REF_EPS || k.t > clip.duration + KEY_REF_EPS) continue;
        if (!selHas(lanes.get(laneId(clip.id, prop)), k.t)) out.push(clip.start + k.t);
      }
    }
  }
  return out.sort((a, b) => a - b);
}

/** the time a stretch stays on: the playhead, unless the pressed key is within a frame of it, then the selected time farthest from the pressed one (within a frame too: the playhead) */
export function stretchPivot(pressed: number, playhead: number, selected: readonly number[], fps: number): number {
  const frame = 1 / fps - 1e-9;
  if (Math.abs(pressed - playhead) >= frame) return playhead;
  let best = playhead;
  let far = -1;
  for (const s of selected) {
    const d = Math.abs(s - pressed);
    if (d > far) {
      far = d;
      best = s;
    }
  }
  return far >= frame ? best : playhead;
}

/** the factor that puts the pressed key on `to` around the pivot. unclamped; 1 when the pressed key sits on the pivot */
export function stretchFactor(pressed: number, to: number, pivot: number): number {
  return Math.abs(pressed - pivot) < 1e-9 ? 1 : (to - pivot) / (pressed - pivot);
}
