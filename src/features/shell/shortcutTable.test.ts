import { describe, expect, it } from 'vitest';
import { GROUP_LABEL, SHORTCUTS, SHORTCUT_GROUPS, findShortcut, groupLabel } from './shortcuts';

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
  it('j shuttles back, k pauses, l shuttles forward', () => {
    expect(findShortcut(key('j'))?.id).toBe('shuttle-back');
    expect(findShortcut(key('k'))?.id).toBe('pause');
    expect(findShortcut(key('l'))?.id).toBe('shuttle-forward');
    expect(findShortcut(key('j', { ctrlKey: true }))).toBeUndefined();
    expect(SHORTCUTS.find((s) => s.id === 'shuttle-forward')?.description).toBe('play forward, again = faster');
    expect(SHORTCUTS.find((s) => s.id === 'shuttle-back')?.description).toBe('play backwards, again = faster');
  });
  it('ctrl+k (and cmd+k) opens the palette and nothing else answers it', () => {
    expect(findShortcut(key('k', { ctrlKey: true }))?.id).toBe('palette');
    expect(findShortcut(key('K', { metaKey: true }))?.id).toBe('palette');
    expect(SHORTCUTS.filter((s) => s.match(key('k', { ctrlKey: true }))).length).toBe(1);
  });
  it('no two runnable rows share a key combo in the same scope', () => {
    const seen = new Map<string, string>();
    for (const s of SHORTCUTS) {
      if (s.info) continue;
      for (const combo of s.keys) {
        const k = combo.join('+');
        expect(seen.get(k), k).toBeUndefined();
        seen.set(k, s.id);
      }
    }
  });
  it('trim and ripple delete keep their keys, w e r only live in the scene view rows', () => {
    expect(findShortcut(key('[', { code: 'BracketLeft' }))?.id).toBe('trim-start');
    expect(findShortcut(key(']', { code: 'BracketRight' }))?.id).toBe('trim-end');
    expect(findShortcut(key('Delete', { shiftKey: true }))?.id).toBe('ripple-delete');
    expect(findShortcut(key('w'))).toBeUndefined();
    expect(SHORTCUTS.some((s) => s.id === 'scene-tools' && s.group === 'preview')).toBe(true);
    expect(SHORTCUTS.some((s) => s.id === 'swap-media')).toBe(true);
  });
  it('shift+z zooms to fit and ctrl+shift+z still redoes', () => {
    expect(findShortcut(key('Z', { shiftKey: true }))?.id).toBe('zoom-fit');
    expect(findShortcut(key('z', { ctrlKey: true, shiftKey: true }))?.id).toBe('redo');
    expect(findShortcut(key('z', { ctrlKey: true }))?.id).toBe('undo');
  });
  it('shift+f10 and the menu key open the clip menu, f10 alone does nothing', () => {
    expect(findShortcut(key('F10', { shiftKey: true }))?.id).toBe('clip-menu');
    expect(findShortcut(key('ContextMenu'))?.id).toBe('clip-menu');
    expect(findShortcut(key('F10'))).toBeUndefined();
  });
  it('every mouse and fields row is info, and every group has a row', () => {
    for (const s of SHORTCUTS.filter((r) => r.group === 'mouse' || r.group === 'fields')) {
      expect(s.info, s.id).toBe(true);
      expect(s.match(key('a'))).toBe(false);
    }
    for (const g of SHORTCUT_GROUPS) expect(SHORTCUTS.some((s) => s.group === g), g).toBe(true);
    expect(SHORTCUTS.filter((s) => s.group === 'mouse').length).toBe(23);
  });
  it('the blender only scene rows say blender controls', () => {
    const blender = ['scene-grab', 'scene-clear', 'scene-copy', 'scene-delete', 'scene-select-all', 'scene-views', 'scene-frame-all'];
    for (const id of blender) expect(SHORTCUTS.find((s) => s.id === id)?.description.startsWith('scene view, blender controls:'), id).toBe(true);
    expect(SHORTCUTS.find((s) => s.id === 'scene-frame')?.description.startsWith('scene view:')).toBe(true);
    expect(SHORTCUTS.find((s) => s.id === 'scene-tools')?.description.startsWith('scene view, unity controls:')).toBe(true);
  });
  it('GROUP_LABEL has a lowercase label for every group', () => {
    for (const g of SHORTCUT_GROUPS) {
      expect(GROUP_LABEL[g].length).toBeGreaterThan(0);
      expect(GROUP_LABEL[g]).toBe(GROUP_LABEL[g].toLowerCase());
    }
    expect(groupLabel('animation')).toBe('keyframes and 3d');
    expect(groupLabel('preview')).toBe('preview and scene view');
    expect(groupLabel('something else')).toBe('something else');
  });
  it('no description says cut off, and only the cut row says cut', () => {
    for (const s of SHORTCUTS) {
      expect(s.description, s.id).not.toMatch(/cut off/);
      if (s.id !== 'cut') expect(s.description, s.id).not.toMatch(/\bcut\b/);
    }
    expect(SHORTCUTS.find((s) => s.id === 'trim-start')?.also).toContain('cut off the left side');
    expect(SHORTCUTS.find((s) => s.id === 'trim-end')?.also).toContain('cut off the right side');
  });
  it('mouse-pivot and preview-pivot-done are info rows in mouse and preview', () => {
    const pivot = SHORTCUTS.find((s) => s.id === 'mouse-pivot')!;
    expect(pivot.group).toBe('mouse');
    expect(pivot.info).toBe(true);
    expect(pivot.keys).toEqual([['drag'], ['alt', 'drag'], ['double click']]);
    const ids = SHORTCUTS.map((s) => s.id);
    expect(ids.indexOf('mouse-pivot')).toBe(ids.indexOf('mouse-canvas') + 1);
    const done = SHORTCUTS.find((s) => s.id === 'preview-pivot-done')!;
    expect(done.group).toBe('preview');
    expect(done.info).toBe(true);
    expect(done.keys).toEqual([['esc']]);
    expect(ids.indexOf('preview-pivot-done')).toBe(ids.indexOf('preview-no-snap') + 1);
    expect(SHORTCUTS.find((s) => s.id === 'mouse-canvas')?.description).toContain('rotate it by the round handle');
  });
  it('the fields group has the eight rows in order', () => {
    expect(SHORTCUTS.filter((s) => s.group === 'fields').map((s) => s.id)).toEqual([
      'field-drag', 'field-fine', 'field-snap', 'field-reset', 'field-cancel', 'field-arrows', 'field-enter', 'field-tabs',
    ]);
    expect(SHORTCUTS.some((s) => s.id === 'field-scrub')).toBe(false);
    for (const id of ['field-cancel', 'field-enter']) expect(SHORTCUTS.find((s) => s.id === id)!.keys.flat()).toContain('esc');
  });
});
