/** what the two frame view shows right now: a tiny external store. null when idle */
import { isTimedClip } from '../../types';
import type { Clip } from '../../types';
import { formatTimecode } from '../../lib/time';
import { clipDisplayName } from './effectTarget';
import { touchingAfter, touchingBefore } from './trimModes';
import type { Edge, P, TrimMode } from './trimModes';

export interface TrimViewReq { mode: TrimMode; clipId: string; edge?: Edge; otherId?: string }

let req: TrimViewReq | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function same(a: TrimViewReq | null, b: TrimViewReq | null): boolean {
  if (a === null || b === null) return a === b;
  return a.mode === b.mode && a.clipId === b.clipId && a.edge === b.edge && a.otherId === b.otherId;
}

/** an equal request keeps the stored object and tells nobody. with holdMs the request hides itself after that long */
export function setTrimView(next: TrimViewReq | null, holdMs?: number): void {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  if (!same(req, next)) {
    req = next;
    for (const l of [...listeners]) l();
  }
  if (next && holdMs !== undefined && holdMs > 0) timer = setTimeout(() => setTrimView(null), holdMs);
}

export function getTrimView(): TrimViewReq | null {
  return req;
}

export function subscribeTrimView(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** one half of the two frame view. time is media seconds (0 for stills and names) */
export interface TrimSide { show: 'video' | 'image' | 'name' | 'gap'; assetId?: string; time: number; label: string }

const GAP: TrimSide = { show: 'gap', time: 0, label: 'gap' };

function sideOf(c: Clip, which: 'first' | 'last', fps: number): TrimSide {
  const timed = isTimedClip(c);
  const time = !timed ? 0 : which === 'first' ? c.trimStart : c.trimStart + Math.max(0, c.duration - 1 / fps) * c.speed;
  const name = clipDisplayName(c);
  const text = `${which} frame of ${name}`;
  if (c.type === 'video') return { show: 'video', assetId: c.assetId, time, label: `${text}, ${formatTimecode(time, fps)}` };
  if (c.type === 'image') return { show: 'image', assetId: c.assetId, time: 0, label: text };
  if (c.type === 'audio') return { show: 'name', time, label: `${text}, ${formatTimecode(time, fps)}` };
  return { show: 'name', time: 0, label: text };
}

const side = (c: Clip | null, which: 'first' | 'last', fps: number): TrimSide => (c ? sideOf(c, which, fps) : GAP);

/** what the two halves show for a request, from the project as it is now. null for a stretch or a clip that is gone */
export function trimSides(p: P, req: TrimViewReq, fps: number): [TrimSide, TrimSide] | null {
  if (req.mode === 'stretch') return null;
  const c = p.clips.find((x) => x.id === req.clipId);
  if (!c) return null;
  switch (req.mode) {
    case 'slip':
      return [sideOf(c, 'first', fps), sideOf(c, 'last', fps)];
    case 'slide':
      return [side(touchingBefore(p, c), 'last', fps), side(touchingAfter(p, c), 'first', fps)];
    case 'move-edit': {
      const other = req.otherId !== undefined ? p.clips.find((x) => x.id === req.otherId) ?? null : null;
      if (req.edge === 'start') return [side(other ?? touchingBefore(p, c), 'last', fps), sideOf(c, 'first', fps)];
      return [sideOf(c, 'last', fps), side(other ?? touchingAfter(p, c), 'first', fps)];
    }
    default:
      // ripple: the edge that moved shows the clip, the other half what is across it
      if (req.edge === 'start') return [side(touchingBefore(p, c), 'last', fps), sideOf(c, 'first', fps)];
      return [sideOf(c, 'last', fps), side(touchingAfter(p, c), 'first', fps)];
  }
}
