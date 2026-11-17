/** which toggles a track header shows. pure: no store, no dom */

export type HeadToggle = 'target' | 'mute' | 'solo' | 'hide' | 'lock' | 'sync';
export const HEAD_ORDER: readonly HeadToggle[] = ['target', 'mute', 'solo', 'hide', 'lock', 'sync'];
/** a compact header has room for this many toggles */
export const COMPACT_ROOM = 3;

export interface HeadState {
  video: boolean;
  /** the source view has media, so the target toggle shows */
  target: boolean;
  muted: boolean;
  solo: boolean;
  hidden: boolean;
  locked: boolean;
  /** sync lock is off */
  syncOff: boolean;
}

/** compact: the lit toggles first, then this order of the rest */
const COMPACT_RANK: readonly HeadToggle[] = ['target', 'lock', 'mute', 'hide', 'solo', 'sync'];

/** the toggles of a header, in HEAD_ORDER. a compact header keeps the first `room`: lit ones win, a lit toggle is never the target */
export function headToggles(s: HeadState, compact: boolean, room = COMPACT_ROOM): HeadToggle[] {
  const all = HEAD_ORDER.filter((t) => (t !== 'target' || s.target) && (t !== 'hide' || s.video));
  if (!compact) return all;
  const lit: Record<HeadToggle, boolean> = { target: false, mute: s.muted, solo: s.solo, hide: s.hidden, lock: s.locked, sync: s.syncOff };
  const ranked = [...all].sort((a, b) => Number(lit[b]) - Number(lit[a]) || COMPACT_RANK.indexOf(a) - COMPACT_RANK.indexOf(b));
  const keep = new Set(ranked.slice(0, Math.max(0, room)));
  return all.filter((t) => keep.has(t));
}
