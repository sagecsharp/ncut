import { describe, expect, it } from 'vitest';
import type { ClipType } from '../../types';
import { INSPECTOR_TABS, SECTION_ORDER, TAB_OF, arrowTab, onTab, resolveTab, sectionsOf, tabsFor } from './clipTabs';
import type { InspectorTab } from './clipTabs';

const TYPES: ClipType[] = ['video', 'image', 'text', 'shape', 'audio', 'effect', 'camera'];
const GROUPS = ['basic', 'look', 'animate', 'sound'] as const;

describe('inspector tabs', () => {
  it('every section id is in exactly one of the four groups', () => {
    for (const id of SECTION_ORDER) {
      const hits = GROUPS.filter((g) => TAB_OF[id] === g);
      expect(hits, id).toHaveLength(1);
    }
    expect(new Set(SECTION_ORDER).size).toBe(SECTION_ORDER.length);
    expect(Object.keys(TAB_OF).sort()).toEqual([...SECTION_ORDER].sort());
  });

  it('for every clip each section shows on exactly one group tab and on "all"', () => {
    for (const type of TYPES) {
      for (const audio of [true, false]) {
        for (const id of sectionsOf(type, audio)) {
          expect(GROUPS.filter((g) => onTab(g, id))).toHaveLength(1);
          expect(onTab('all', id)).toBe(true);
        }
      }
    }
  });

  it('"all" keeps the old order', () => {
    expect(sectionsOf('text', false)).toEqual([
      'clip', 'animation', 'beat-sync', 'text', 'text-style', 'text-anim', 'transform', 'threed', 'path', 'repeat',
      'attach', 'look', 'color', 'mask', 'clip-effects', 'motion', 'transition', 'fades',
    ]);
    expect(sectionsOf('video', true)).toEqual([
      'clip', 'animation', 'beat-sync', 'transform', 'threed', 'path', 'repeat', 'attach', 'look', 'color', 'mask',
      'clip-effects', 'motion', 'transition', 'audio', 'tempo', 'speed', 'fades',
    ]);
  });

  it('a video without sound has no sound tab', () => {
    expect(tabsFor(sectionsOf('video', true))).toEqual(['basic', 'look', 'animate', 'sound', 'all']);
    expect(tabsFor(sectionsOf('video', false))).toEqual(['basic', 'look', 'animate', 'all']);
    expect(sectionsOf('video', false)).not.toContain('audio');
    expect(sectionsOf('video', false)).not.toContain('tempo');
  });

  it('tabs of every clip type', () => {
    expect(tabsFor(sectionsOf('image', false))).toEqual(['basic', 'look', 'animate', 'all']);
    expect(tabsFor(sectionsOf('text', false))).toEqual(['basic', 'look', 'animate', 'all']);
    expect(tabsFor(sectionsOf('shape', false))).toEqual(['basic', 'look', 'animate', 'all']);
    expect(tabsFor(sectionsOf('audio', true))).toEqual(['basic', 'look', 'animate', 'sound', 'all']);
    expect(tabsFor(sectionsOf('effect', false))).toEqual(['basic', 'look', 'animate', 'all']);
    expect(tabsFor(sectionsOf('camera', false))).toEqual(['basic', 'look', 'animate', 'all']);
  });

  it('a clip that is not a picture has no look tab unless it is linked to something', () => {
    expect(tabsFor(sectionsOf('effect', false, false))).toEqual(['basic', 'animate', 'all']);
    expect(tabsFor(sectionsOf('camera', false, false))).toEqual(['basic', 'animate', 'all']);
    expect(tabsFor(sectionsOf('audio', true, false))).toEqual(['basic', 'animate', 'sound', 'all']);
    expect(tabsFor(sectionsOf('effect', false, true))).toEqual(['basic', 'look', 'animate', 'all']);
    // a picture can always be attached
    expect(sectionsOf('image', false, false)).toContain('attach');
  });

  it('puts the main sections where they belong', () => {
    expect(sectionsOf('effect', false).filter((s) => TAB_OF[s] === 'basic')).toEqual(['clip', 'effect', 'effect-beat', 'fades']);
    expect(sectionsOf('camera', false).filter((s) => TAB_OF[s] === 'basic')).toEqual(['clip', 'camera', 'focus', 'fades']);
    expect(sectionsOf('text', false).filter((s) => TAB_OF[s] === 'look')).toEqual([
      'text-style', 'threed', 'attach', 'look', 'color', 'mask', 'clip-effects',
    ]);
    expect(sectionsOf('video', true).filter((s) => TAB_OF[s] === 'sound')).toEqual(['audio', 'tempo']);
  });

  it('the tab list has unique ids and "all" last', () => {
    const ids = INSPECTOR_TABS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[ids.length - 1]).toBe('all');
  });

  it('a tab the clip does not have falls back to basic', () => {
    const tabs = tabsFor(sectionsOf('image', false));
    expect(resolveTab('sound', tabs)).toBe('basic');
    expect(resolveTab('look', tabs)).toBe('look');
    expect(resolveTab('all', tabs)).toBe('all');
  });

  it('arrow keys move between tabs and wrap', () => {
    const tabs: InspectorTab[] = ['basic', 'look', 'all'];
    expect(arrowTab(tabs, 'basic', 'ArrowRight')).toBe('look');
    expect(arrowTab(tabs, 'all', 'ArrowRight')).toBe('basic');
    expect(arrowTab(tabs, 'basic', 'ArrowLeft')).toBe('all');
    expect(arrowTab(tabs, 'look', 'Home')).toBe('basic');
    expect(arrowTab(tabs, 'look', 'End')).toBe('all');
    expect(arrowTab(tabs, 'look', 'ArrowUp')).toBeNull();
    expect(arrowTab(tabs, 'sound', 'ArrowRight')).toBeNull();
  });
});
