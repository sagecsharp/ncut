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
});
