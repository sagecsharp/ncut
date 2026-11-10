/** groups effects for the effects tab. categories come from the registry exports, never from a hardcoded list. */
import type { EffectDef } from '../../engine/effects/types';

export interface EffectGroup {
  id: string;
  label: string;
  items: EffectDef[];
}

/**
 * one group per known category (in the registry's order), then one per category that only shows up on
 * an effect (so a category added to an effect without a label entry still appears). empty groups are dropped.
 */
export function groupEffects(
  categories: readonly { id: string; label: string }[],
  effects: readonly EffectDef[],
  match: (e: EffectDef) => boolean = () => true,
): EffectGroup[] {
  const order: { id: string; label: string }[] = [...categories];
  const known = new Set(order.map((c) => c.id));
  for (const e of effects) {
    if (!known.has(e.category)) {
      known.add(e.category);
      order.push({ id: e.category, label: e.category });
    }
  }
  return order
    .map((c) => ({ id: c.id, label: c.label, items: effects.filter((e) => e.category === c.id && match(e)) }))
    .filter((g) => g.items.length > 0);
}
