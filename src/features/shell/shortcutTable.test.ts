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
});
