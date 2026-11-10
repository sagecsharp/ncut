import { describe, expect, it } from 'vitest';
import type { EffectDef } from '../../engine/effects/types';
import { EFFECTS } from '../../engine/effects/registry';
import { EFFECT_CATEGORIES } from '../../engine/effects/types';
import { effectMatchesQuery, groupEffects } from './effectGroups';

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

describe('overlay group', () => {
  it('is the last group of the registry', () => {
    const g = groupEffects(EFFECT_CATEGORIES, EFFECTS);
    expect(g[g.length - 1]!.id).toBe('overlay');
    expect(g[g.length - 1]!.label).toBe('overlay');
    expect(g[g.length - 1]!.items.length).toBeGreaterThan(5);
  });
  it('the search finds overlays by name and by category', () => {
    const byName = groupEffects(EFFECT_CATEGORIES, EFFECTS, (e) => effectMatchesQuery(e, 'snow'));
    expect(byName.flatMap((x) => x.items.map((e) => e.id))).toContain('snow');
    const byCategory = groupEffects(EFFECT_CATEGORIES, EFFECTS, (e) => effectMatchesQuery(e, ' Overlay '));
    // other effects may mention the word in their description, but the whole category is always there
    const overlay = byCategory.find((x) => x.id === 'overlay')!;
    expect(overlay.items).toHaveLength(EFFECTS.filter((e) => e.category === 'overlay').length);
  });
});

describe('effectMatchesQuery', () => {
  const e = { id: 'x', name: 'tilt shift', category: 'blur', description: 'keeps a band sharp', params: [] } as unknown as EffectDef;
  it('matches name, description and category, ignoring case and padding', () => {
    expect(effectMatchesQuery(e, '')).toBe(true);
    expect(effectMatchesQuery(e, '   ')).toBe(true);
    expect(effectMatchesQuery(e, 'TILT')).toBe(true);
    expect(effectMatchesQuery(e, 'band')).toBe(true);
    expect(effectMatchesQuery(e, 'blur')).toBe(true);
    expect(effectMatchesQuery(e, 'zzz')).toBe(false);
  });
});
