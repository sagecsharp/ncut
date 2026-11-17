import { describe, expect, it } from 'vitest';
import { GROUP_LABEL, SHORTCUTS, SHORTCUT_GROUPS } from './shortcuts';
import { sceneMouseLine, shortcutGroups } from './shortcutsView';

describe('shortcuts view', () => {
  it('sceneMouseLine names the scheme', () => {
    expect(sceneMouseLine('unity')).toContain('unity controls');
    expect(sceneMouseLine('unity')).toContain('w e r');
    expect(sceneMouseLine('blender')).toContain('blender controls');
    expect(sceneMouseLine('blender')).toContain('g r s');
  });

  it('no query keeps the group order, mouse and fields come before app, labels come from GROUP_LABEL', () => {
    const groups = shortcutGroups('', SHORTCUTS, 'blender');
    expect(groups.map((g) => g.group)).toEqual([...SHORTCUT_GROUPS]);
    const ids = groups.map((g) => g.group);
    expect(ids.indexOf('mouse')).toBeLessThan(ids.indexOf('app'));
    expect(ids.indexOf('fields')).toBeLessThan(ids.indexOf('app'));
    for (const g of groups) expect(g.label).toBe(GROUP_LABEL[g.group]);
  });

  it('zoom keeps only rows that mention zoom', () => {
    const groups = shortcutGroups('zoom', SHORTCUTS, 'blender');
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      for (const r of g.rows) {
        const hay = [r.description, ...(r.also ?? []), GROUP_LABEL[r.group]].join(' ').toLowerCase();
        expect(hay.includes('zoom') || r.keys.some((k) => k.join('+').includes('zoom'))).toBe(true);
      }
    }
  });

  it('ctrl b finds split by its caps, cut off finds trim start by its alias', () => {
    const split = shortcutGroups('ctrl b', SHORTCUTS, 'blender').flatMap((g) => g.rows);
    expect(split.some((r) => r.id === 'split')).toBe(true);
    const trim = shortcutGroups('cut off', SHORTCUTS, 'blender').flatMap((g) => g.rows);
    expect(trim.some((r) => r.id === 'trim-start')).toBe(true);
  });

  it('a query that matches nothing gives no groups', () => {
    expect(shortcutGroups('qqqzzzxx', SHORTCUTS, 'blender')).toEqual([]);
  });

  it('the scene mouse line is the last row of preview', () => {
    const preview = shortcutGroups('', SHORTCUTS, 'unity').find((g) => g.group === 'preview')!;
    const last = preview.rows[preview.rows.length - 1]!;
    expect(last.id).toBe('scene-mouse');
    expect(last.description).toBe(sceneMouseLine('unity'));
  });

  it('the fields group now has eight rows', () => {
    const fields = shortcutGroups('', SHORTCUTS, 'blender').find((g) => g.group === 'fields')!;
    expect(fields.rows).toHaveLength(8);
  });

  it('the mouse group has mouse-pivot', () => {
    const mouse = shortcutGroups('', SHORTCUTS, 'blender').find((g) => g.group === 'mouse')!;
    expect(mouse.rows.some((r) => r.id === 'mouse-pivot')).toBe(true);
  });
});
