import { describe, expect, it } from 'vitest';
import { SHORTCUTS, SHORTCUT_GROUPS, findShortcut } from './shortcuts';

function key(k: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { key: k, code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods } as KeyboardEvent;
}

describe('shortcut table', () => {
  it('has unique ids and only known groups', () => {
    expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(SHORTCUTS.length);
    for (const s of SHORTCUTS) expect(SHORTCUT_GROUPS).toContain(s.group);
  });
  it('lists a markers group', () => {
    expect(SHORTCUT_GROUPS).toContain('markers');
    expect(SHORTCUTS.filter((s) => s.group === 'markers').length).toBe(3);
  });
  it('m adds a marker, shift+m mutes', () => {
    expect(findShortcut(key('m'))?.id).toBe('marker-add');
    expect(findShortcut(key('M', { shiftKey: true }))?.id).toBe('mute');
  });
  it('alt+, and alt+. jump between markers without hitting the edge / keyframe keys', () => {
    expect(findShortcut(key(',', { code: 'Comma', altKey: true }))?.id).toBe('marker-prev');
    expect(findShortcut(key('.', { code: 'Period', altKey: true }))?.id).toBe('marker-next');
    expect(findShortcut(key(',', { code: 'Comma' }))?.id).toBe('edge-prev');
    expect(findShortcut(key('<', { code: 'Comma', shiftKey: true }))?.id).toBe('key-prev');
  });
  it('r adds a rectangle', () => {
    expect(findShortcut(key('r'))?.id).toBe('add-shape');
  });
  it('no two shortcuts answer the same letter or digit press', () => {
    const plain = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
    for (const k of plain) {
      for (const shiftKey of [false, true]) {
        const code = /[a-z]/.test(k) ? 'Key' + k.toUpperCase() : 'Digit' + k;
        const e = key(shiftKey ? k.toUpperCase() : k, { shiftKey, code });
        expect(SHORTCUTS.filter((s) => s.match(e)).length).toBeLessThanOrEqual(1);
      }
    }
  });
  it('group, ungroup, freeze and select-after have rows and mutate where they edit', () => {
    expect(findShortcut(key('g', { ctrlKey: true }))?.id).toBe('group');
    expect(findShortcut(key('G', { ctrlKey: true, shiftKey: true }))?.id).toBe('ungroup');
    expect(findShortcut(key('F', { shiftKey: true }))?.id).toBe('freeze-frame');
    expect(findShortcut(key('A', { ctrlKey: true, shiftKey: true }))?.id).toBe('select-after');
    expect(findShortcut(key('a', { ctrlKey: true }))?.id).toBe('select-all');
    for (const id of ['group', 'ungroup', 'freeze-frame']) expect(SHORTCUTS.find((s) => s.id === id)?.mutates).toBe(true);
    expect(SHORTCUTS.find((s) => s.id === 'select-after')?.mutates).toBeFalsy();
  });
  it('keeps the everyday shortcuts', () => {
    expect(findShortcut(key(' ', { code: 'Space' }))?.id).toBe('play-pause');
    expect(findShortcut(key('s'))?.id).toBe('split');
    expect(findShortcut(key('Delete'))?.id).toBe('delete');
    expect(findShortcut(key('z', { ctrlKey: true }))?.id).toBe('undo');
    expect(findShortcut(key('c', { ctrlKey: true }))?.id).toBe('copy');
    expect(findShortcut(key('x', { ctrlKey: true }))?.id).toBe('cut');
    expect(findShortcut(key('v', { ctrlKey: true }))?.id).toBe('paste');
    expect(findShortcut(key('d', { ctrlKey: true }))?.id).toBe('duplicate');
    expect(findShortcut(key('ArrowLeft'))?.id).toBe('frame-back');
    expect(findShortcut(key('e', { ctrlKey: true }))?.id).toBe('export');
  });
  it('lists the preview keys in their own group, and every shortcut has a description and keys', () => {
    expect(SHORTCUTS.filter((s) => s.group === 'preview').length).toBeGreaterThanOrEqual(3);
    for (const s of SHORTCUTS) {
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.keys.length).toBeGreaterThan(0);
    }
  });
  it('marks store-changing shortcuts so they wait for a drag to end', () => {
    for (const id of ['undo', 'redo', 'delete', 'split', 'paste', 'duplicate', 'cut', 'mute']) {
      expect(SHORTCUTS.find((s) => s.id === id)?.mutates).toBe(true);
    }
    expect(SHORTCUTS.find((s) => s.id === 'play-pause')?.mutates).toBeFalsy();
  });
  it('j steps back a second, k pauses, l plays', () => {
    expect(findShortcut(key('j'))?.id).toBe('back-second');
    expect(findShortcut(key('k'))?.id).toBe('pause');
    expect(findShortcut(key('l'))?.id).toBe('play');
    expect(findShortcut(key('j', { ctrlKey: true }))).toBeUndefined();
  });
  it('trim and ripple delete keep their keys, w e r only live in the scene view rows', () => {
    expect(findShortcut(key('[', { code: 'BracketLeft' }))?.id).toBe('trim-start');
    expect(findShortcut(key(']', { code: 'BracketRight' }))?.id).toBe('trim-end');
    expect(findShortcut(key('Delete', { shiftKey: true }))?.id).toBe('ripple-delete');
    expect(findShortcut(key('w'))).toBeUndefined();
    expect(SHORTCUTS.some((s) => s.id === 'scene-tools' && s.group === 'preview')).toBe(true);
    expect(SHORTCUTS.some((s) => s.id === 'swap-media')).toBe(true);
  });
});
