import { COLOR_EFFECTS } from './defs/color';
import { DISTORT_EFFECTS } from './defs/distort';
import { MOTION_EFFECTS } from './defs/motion';
import { STYLIZE_EFFECTS } from './defs/stylize';
import type { EffectCategory, EffectDef } from './types';

/** every effect, in the order the effects tab shows them */
export const EFFECTS: EffectDef[] = [...MOTION_EFFECTS, ...COLOR_EFFECTS, ...DISTORT_EFFECTS, ...STYLIZE_EFFECTS];

const byId = new Map(EFFECTS.map((e) => [e.id, e]));

export function getEffect(id: string): EffectDef | undefined {
  return byId.get(id);
}

export function effectsInCategory(category: EffectCategory): EffectDef[] {
  return EFFECTS.filter((e) => e.category === category);
}

/** value of a param for a clip's saved params (falls back to the default, clamped to the range) */
export function effectParamValue(def: EffectDef, params: Record<string, number>, key: string): number {
  const p = def.params.find((q) => q.key === key);
  if (!p) return 0;
  const v = params[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) return p.default;
  return Math.min(p.max, Math.max(p.min, v));
}
