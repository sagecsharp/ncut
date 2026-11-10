import { describe, expect, it } from 'vitest';
import type { EffectDef } from '../../engine/effects/types';
import { EFFECTS } from '../../engine/effects/registry';
import { EFFECT_CATEGORIES } from '../../engine/effects/types';
import { groupEffects } from './effectGroups';

const fake = (id: string, category: string) =>
  ({ id, name: id, category, description: id, params: [] }) as unknown as EffectDef;

describe('groupEffects', () => {
  it('follows the category order and drops empty groups', () => {
    const g = groupEffects(
      [
        { id: 'a', label: 'a' },
        { id: 'b', label: 'b' },
        { id: 'c', label: 'c' },
      ],
      [fake('x', 'c'), fake('y', 'a')],
    );
    expect(g.map((x) => x.id)).toEqual(['a', 'c']);
  });
  it('shows a category that has effects but no label entry', () => {
    const g = groupEffects([{ id: 'a', label: 'a' }], [fake('x', 'a'), fake('y', 'newcat')]);
    expect(g.map((x) => x.id)).toEqual(['a', 'newcat']);
    expect(g[1]!.label).toBe('newcat');
  });
  it('applies the search filter', () => {
    const g = groupEffects([{ id: 'a', label: 'a' }], [fake('x', 'a'), fake('y', 'a')], (e) => e.id === 'y');
    expect(g[0]!.items.map((e) => e.id)).toEqual(['y']);
  });
  it('lists every registry effect exactly once', () => {
    const g = groupEffects(EFFECT_CATEGORIES, EFFECTS);
    expect(g.reduce((n, x) => n + x.items.length, 0)).toBe(EFFECTS.length);
  });
});
