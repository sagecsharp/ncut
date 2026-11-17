import { describe, expect, it } from 'vitest';
import type { ClipType } from '../../types';
import { INSPECTOR_TABS, SECTION_ORDER, TAB_OF, arrowTab, onTab, resolveTab, revealTab, sectionsOf, tabsFor } from './clipTabs';
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
      'clip', 'animation', 'beat-sync', 'text', 'text-style', 'text-anim', 'transform', 'threed', 'bend', 'path', 'repeat',
      'attach', 'look', 'color', 'grade', 'mask', 'clip-effects', 'motion', 'transition', 'fades',
    ]);
    expect(sectionsOf('video', true)).toEqual([
      'clip', 'animation', 'beat-sync', 'transform', 'threed', 'bend', 'path', 'repeat', 'attach', 'look', 'color', 'grade', 'mask',
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
    expect(tabsFor(sectionsOf('audio', true))).toEqual(['basic', 'animate', 'sound', 'all']);
    expect(tabsFor(sectionsOf('effect', false))).toEqual(['basic', 'animate', 'all']);
    expect(tabsFor(sectionsOf('camera', false))).toEqual(['basic', 'animate', 'all']);
  });

  it('a clip that is not a picture has no look tab', () => {
    expect(tabsFor(sectionsOf('effect', false, false))).toEqual(['basic', 'animate', 'all']);
    expect(tabsFor(sectionsOf('camera', false, false))).toEqual(['basic', 'animate', 'all']);
    expect(tabsFor(sectionsOf('audio', true, false))).toEqual(['basic', 'animate', 'sound', 'all']);
    expect(tabsFor(sectionsOf('effect', false, true))).toEqual(['basic', 'animate', 'all']);
    expect(tabsFor(sectionsOf('camera', false, true))).toEqual(['basic', 'animate', 'all']);
    expect(tabsFor(sectionsOf('audio', true, true))).toEqual(['basic', 'animate', 'sound', 'all']);
    // a picture can always be attached
    expect(sectionsOf('image', false, false)).toContain('attach');
  });

  it('puts the main sections where they belong', () => {
    expect(sectionsOf('effect', false).filter((s) => TAB_OF[s] === 'basic')).toEqual(['clip', 'effect', 'effect-beat', 'attach', 'fades']);
    expect(sectionsOf('camera', false).filter((s) => TAB_OF[s] === 'basic')).toEqual(['clip', 'camera', 'focus', 'attach', 'fades']);
    expect(sectionsOf('text', false).filter((s) => TAB_OF[s] === 'look')).toEqual([
      'text-style', 'threed', 'bend', 'look', 'color', 'grade', 'mask', 'clip-effects',
    ]);
    expect(sectionsOf('video', true).filter((s) => TAB_OF[s] === 'sound')).toEqual(['audio', 'tempo']);
  });

  it('attach sits on basic right after transform', () => {
    for (const type of ['video', 'image', 'text', 'shape'] as const) {
      const basic = sectionsOf(type, false).filter((s) => TAB_OF[s] === 'basic');
      expect(basic[basic.indexOf('transform') + 1], type).toBe('attach');
    }
  });

  it('the tab titles name their sections', () => {
    const title = (id: InspectorTab) => INSPECTOR_TABS.find((t) => t.id === id)!.title;
    expect(title('basic')).toContain('attach');
    expect(title('look')).not.toContain('links');
    expect(title('look')).not.toContain('attach');
    expect(title('look')).toContain('bend');
    expect(title('look')).toContain('grade');
  });

  it('bend comes right after threed, on the look tab', () => {
    expect(SECTION_ORDER[SECTION_ORDER.indexOf('threed') + 1]).toBe('bend');
    expect(TAB_OF.bend).toBe('look');
  });

  it('bend is on the look tab of every picture clip', () => {
    for (const type of ['video', 'image', 'text', 'shape'] as const) {
      expect(sectionsOf(type, false), type).toContain('bend');
      expect(tabsFor(sectionsOf(type, false)), type).toContain('look');
    }
    for (const type of ['audio', 'effect', 'camera'] as const) expect(sectionsOf(type, true), type).not.toContain('bend');
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

  it('grade comes right after color, on the look tab', () => {
    expect(SECTION_ORDER[SECTION_ORDER.indexOf('color') + 1]).toBe('grade');
    expect(TAB_OF.grade).toBe('look');
  });

  it('grade is on every picture clip and on a grade effect only', () => {
    for (const type of ['video', 'image', 'text', 'shape'] as const) expect(sectionsOf(type, false), type).toContain('grade');
    for (const type of ['audio', 'effect', 'camera'] as const) expect(sectionsOf(type, true), type).not.toContain('grade');
    const grade = sectionsOf('effect', false, true, true);
    expect(grade).toContain('grade');
    expect(tabsFor(grade)).toEqual(['basic', 'look', 'animate', 'all']);
    expect(sectionsOf('effect', false, true, false)).not.toContain('grade');
  });

  it('revealTab moves to the tab of a known section only', () => {
    expect(revealTab('basic', 'grade')).toBe('look');
    expect(revealTab('look', 'grade')).toBeNull();
    expect(revealTab('all', 'grade')).toBeNull();
    expect(revealTab('basic', 'm-grade')).toBeNull();
    expect(revealTab('basic', 'sky')).toBeNull();
    expect(revealTab('basic', 'constructor')).toBeNull();
  });
});
