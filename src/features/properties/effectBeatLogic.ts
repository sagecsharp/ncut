/**
 * the choices of the "follow the tempo" section of an effect clip (EffectClip.beat). pure: no dom, no store.
 * what the link does when a frame is drawn is in engine/draw.ts (effectPassAt) and lib/tempo.ts.
 */
import type { EffectBeat } from '../../lib/tempo';
import type { EffectDef } from '../../engine/effects/types';

/** the "follow" select: off, the sound under the effect, or one clip by id */
export const FOLLOW_OFF = 'off';
export const FOLLOW_UNDER = 'under';

/** the lengths of a cycle, in beats */
export const EVERY_OPTIONS: [string, string][] = [
  ['0.25', '1/4 beat'],
  ['0.5', '1/2 beat'],
  ['1', '1 beat'],
  ['2', '2 beats'],
  ['4', '4 beats (a bar)'],
  ['8', '8 beats'],
  ['16', '16 beats'],
];

/** what a link starts as when it is turned on: a soft hit on every beat */
export const DEFAULT_BEAT: EffectBeat = { source: null, every: 1, pulse: 0.6, lock: false };

/** a value for the "every" select that is in the list (a stored 3 shows as itself) */
export function everyOptions(every: number): [string, string][] {
  const key = String(every);
  if (EVERY_OPTIONS.some(([v]) => v === key)) return EVERY_OPTIONS;
  const label = every === 1 ? '1 beat' : `${Math.round(every * 10000) / 10000} beats`;
  return [...EVERY_OPTIONS, [key, label]].sort((a, b) => Number(a[0]) - Number(b[0])) as [string, string][];
}

/** which entry of the follow select is on: a source that has no tempo (any more) counts as the sound under the effect */
export function followValue(beat: Pick<EffectBeat, 'source'> | null | undefined, sourceIds: readonly string[]): string {
  if (!beat) return FOLLOW_OFF;
  return beat.source && sourceIds.includes(beat.source) ? beat.source : FOLLOW_UNDER;
}

/** the link after a pick in the follow select. null = off (the field is removed). a turned on link keeps what was set before */
export function followPatch(current: EffectBeat | null | undefined, pick: string): EffectBeat | null {
  if (pick === FOLLOW_OFF) return null;
  const base = current ?? DEFAULT_BEAT;
  return { ...base, source: pick === FOLLOW_UNDER ? null : pick };
}

/** the link with one value changed (a link that is off is turned on first) */
export function changedBeat(current: EffectBeat | null | undefined, change: Partial<EffectBeat>): EffectBeat {
  return { ...(current ?? DEFAULT_BEAT), ...change };
}

/** the tooltip of the lock switch: names the param the tempo takes over */
export function lockTitle(def: EffectDef): string | null {
  if (!def.sync) return null;
  const p = def.params.find((x) => x.key === def.sync!.param);
  return p ? `the ${p.label} follows the tempo: one cycle of the effect for every cycle of the beat. its own value and keyframes are not used while this is on` : null;
}

/** the label of a param the lock has taken over */
export function lockedParam(def: EffectDef | undefined, beat: Pick<EffectBeat, 'lock'> | null | undefined, hasTempo: boolean): string | null {
  return def?.sync && beat?.lock && hasTempo ? def.sync.param : null;
}
