import { describe, expect, it } from 'vitest';
import { createProject, createTextClip } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useSource } from '../../store/source';
import { useUi } from '../../store/ui';
import { REASON_TEXT } from './reasons';
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
  it('trim and ripple delete keep their keys, w is ripple trim end outside the scene view', () => {
    expect(findShortcut(key('[', { code: 'BracketLeft' }))?.id).toBe('trim-start');
    expect(findShortcut(key(']', { code: 'BracketRight' }))?.id).toBe('trim-end');
    expect(findShortcut(key('Delete', { shiftKey: true }))?.id).toBe('ripple-delete');
    expect(findShortcut(key('w'))?.id).toBe('ripple-end');
    expect(findShortcut(key('q'))?.id).toBe('ripple-start');
    expect(findShortcut(key('y'))?.id).toBe('trim-mode');
    expect(findShortcut(key('y', { ctrlKey: true }))?.id).toBe('redo');
    expect(findShortcut(key('u'))?.id).toBe('edit-select');
    expect(SHORTCUTS.some((s) => s.id === 'scene-tools' && s.group === 'preview')).toBe(true);
    expect(SHORTCUTS.some((s) => s.id === 'swap-media')).toBe(true);
  });
  it('shift+z zooms to fit and ctrl+shift+z still redoes', () => {
    expect(findShortcut(key('Z', { shiftKey: true }))?.id).toBe('zoom-fit');
    expect(findShortcut(key('z', { ctrlKey: true, shiftKey: true }))?.id).toBe('redo');
    expect(findShortcut(key('z', { ctrlKey: true }))?.id).toBe('undo');
  });
  it('shift+f10 and the menu key open the clip menu, f10 alone overwrites', () => {
    expect(findShortcut(key('F10', { shiftKey: true }))?.id).toBe('clip-menu');
    expect(findShortcut(key('ContextMenu'))?.id).toBe('clip-menu');
    expect(findShortcut(key('F10'))?.id).toBe('overwrite-edit');
  });
  it('f9 inserts and f10 overwrites', () => {
    expect(findShortcut(key('F9'))?.id).toBe('insert-edit');
    expect(findShortcut(key('F10'))?.id).toBe('overwrite-edit');
    for (const id of ['insert-edit', 'overwrite-edit']) {
      const row = SHORTCUTS.find((s) => s.id === id)!;
      expect(row.mutates, id).toBe(true);
      expect(row.group, id).toBe('editing');
    }
    const ids = SHORTCUTS.map((s) => s.id);
    expect(ids.indexOf('insert-edit')).toBe(ids.indexOf('extract') + 1);
    expect(ids.indexOf('overwrite-edit')).toBe(ids.indexOf('insert-edit') + 1);
    expect(ids.indexOf('mouse-edit-target')).toBe(ids.indexOf('mouse-source-scrub') + 1);
  });
  it('every mouse and fields row is info, and every group has a row', () => {
    for (const s of SHORTCUTS.filter((r) => r.group === 'mouse' || r.group === 'fields')) {
      expect(s.info, s.id).toBe(true);
      expect(s.match(key('a'))).toBe(false);
    }
    for (const g of SHORTCUT_GROUPS) expect(SHORTCUTS.some((s) => s.group === g), g).toBe(true);
    expect(SHORTCUTS.filter((s) => s.group === 'mouse').length).toBe(40);
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
      expect(s.description, s.id).not.toMatch(/\broll(ing)?\b/);
      // a j cut and an l cut are what the word list calls a sound that starts before or ends after its picture
      if (s.id !== 'cut') expect(s.description.replace('j or l cut', ''), s.id).not.toMatch(/\bcut\b/);
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
  it('the fields group has the eighteen rows in order', () => {
    expect(SHORTCUTS.filter((s) => s.group === 'fields').map((s) => s.id)).toEqual([
      'field-drag', 'field-fine', 'field-snap', 'field-reset', 'field-cancel',
      'grade-wheel-drag', 'grade-wheel-fine', 'grade-wheel-hue', 'grade-wheel-reset', 'grade-wheel-keys',
      'grade-curve-add', 'grade-curve-remove', 'grade-curve-fine', 'grade-curve-keys',
      'field-arrows', 'field-enter', 'field-tabs', 'field-fader-keys',
    ]);
    expect(SHORTCUTS.some((s) => s.id === 'field-scrub')).toBe(false);
    for (const id of ['field-cancel', 'field-enter']) expect(SHORTCUTS.find((s) => s.id === id)!.keys.flat()).toContain('esc');
  });
  it('the new rows sit where the plan puts them', () => {
    const ids = SHORTCUTS.map((s) => s.id);
    const after = (id: string, prev: string) => expect(ids.indexOf(id), `${id} after ${prev}`).toBe(ids.indexOf(prev) + 1);
    after('play-in-out', 'play-pause');
    after('go-to-time', 'seek-end');
    after('edit-prev', 'edge-next');
    after('edit-next', 'edit-prev');
    after('lift', 'ripple-delete');
    after('extract', 'lift');
    after('separate-sound', 'ungroup');
    for (const [id, prev] of [['trim-mode', 'trim-end'], ['ripple-start', 'trim-mode'], ['ripple-end', 'ripple-start'], ['edit-select', 'ripple-end'], ['nudge-left', 'edit-select'], ['nudge-right', 'nudge-left'], ['nudge-left-big', 'nudge-right'], ['nudge-right-big', 'nudge-left-big']] as const) after(id, prev);
    after('toggle-source', 'zoom-fit');
    expect(ids.indexOf('match-frame')).toBe(ids.indexOf('toggle-source') + 1);
    expect(ids.indexOf('source-view-keys')).toBe(ids.indexOf('match-frame') + 1);
    expect(ids.indexOf('toggle-scopes')).toBe(ids.indexOf('source-view-keys') + 1);
    expect(ids.indexOf('toggle-scopes') + 1).toBe(ids.indexOf('preview-nudge'));
    after('preview-probe', 'preview-pivot-done');
    after('mouse-range', 'mouse-ruler');
    after('mouse-ripple', 'mouse-trim');
    after('mouse-media-open', 'mouse-media');
    after('open-mixer', 'field-fader-keys');
    expect(ids.indexOf('open-mixer') + 1).toBe(ids.indexOf('export'));
    expect(ids.slice(ids.indexOf('mouse-splitter') + 1, ids.indexOf('mouse-splitter') + 4)).toEqual(['mouse-fader', 'mouse-solo-only', 'mouse-meter-clear']);
  });
  it('source rows', () => {
    const row = (id: string) => SHORTCUTS.find((s) => s.id === id)!;
    expect(row('toggle-source').keys).toEqual([['shift', 'v']]);
    expect(row('match-frame').keys).toEqual([['f']]);
    expect(row('match-frame').mutates).toBe(true);
    expect(row('source-view-keys').info).toBe(true);
    expect(row('source-view-keys').keys.flat()).toEqual(['space', 'j', 'k', 'l', '←', '→', 'i', 'o', 'x']);
    expect(row('mouse-media').description).toContain('the marked part');
    const ids = SHORTCUTS.map((s) => s.id);
    const at = ids.indexOf('mouse-media');
    expect(ids.slice(at + 1, at + 5)).toEqual(['mouse-media-open', 'mouse-media-skim', 'mouse-source-drag', 'mouse-source-scrub']);
    expect(row('mouse-source-scrub').group).toBe('mouse');
  });
  it('shift+v and f match once', () => {
    const v = key('V', { shiftKey: true, code: 'KeyV' });
    expect(SHORTCUTS.filter((s) => s.match(v)).map((s) => s.id)).toEqual(['toggle-source']);
    expect(SHORTCUTS.filter((s) => s.match(key('f'))).map((s) => s.id)).toEqual(['match-frame']);
    expect(findShortcut(key('v'))?.id).toBe('toggle-scene');
    expect(findShortcut(key('F', { shiftKey: true }))?.id).toBe('freeze-frame');
  });
  it('routed rows', () => {
    const view = [
      'play-pause', 'shuttle-back', 'pause', 'shuttle-forward', 'frame-back', 'frame-forward', 'frames-back', 'frames-forward', 'seek-start', 'seek-end',
      'mark-in', 'mark-out', 'mark-clip', 'clear-in-out', 'go-in', 'go-out', 'play-in-out',
    ];
    for (const id of view) expect(SHORTCUTS.some((s) => s.id === id && !s.info), id).toBe(true);
    const p = createProject('keys');
    useEditor.getState().openProject({ ...p, clips: [{ ...createTextClip(p.tracks[0]!.id, 0), id: 'a', duration: 4 }] });
    usePlayback.setState({ time: 1 });
    useSource.getState().close();
    useUi.setState({ toasts: [], previewMode: 'source', programMode: 'output' });
    SHORTCUTS.find((s) => s.id === 'mark-in')!.run();
    expect(useUi.getState().toasts.map((t) => t.message)).toContain(REASON_TEXT.sourceEmpty);
    expect(useEditor.getState().project?.range).toBeUndefined();
    const quiet = ['frame-back', 'frame-forward', 'frames-back', 'frames-forward', 'seek-start', 'seek-end'];
    for (const id of view) {
      useUi.setState({ toasts: [], previewMode: 'source', programMode: 'output' });
      usePlayback.setState({ time: 1 });
      SHORTCUTS.find((s) => s.id === id)!.run();
      const toasts = useUi.getState().toasts.map((t) => t.message);
      if (quiet.includes(id)) expect(toasts, id).toEqual([]);
      else expect(toasts, id).toEqual([REASON_TEXT.sourceEmpty]);
      expect(usePlayback.getState().time, id).toBe(1);
      expect(useEditor.getState().project?.range, id).toBeUndefined();
    }
    useUi.setState({ toasts: [], previewMode: 'output', programMode: 'output' });
    SHORTCUTS.find((s) => s.id === 'mark-in')!.run();
    expect(useEditor.getState().project?.range?.in).toBeDefined();
  });
  it('in and out keys', () => {
    const rows = SHORTCUTS.filter((s) => s.group === 'inout');
    expect(rows.map((s) => s.id)).toEqual(['mark-in', 'mark-out', 'mark-clip', 'clear-in-out', 'go-in', 'go-out']);
    expect(rows.map((s) => s.keys)).toEqual([[['i']], [['o']], [['x']], [['shift', 'x']], [['shift', 'i']], [['shift', 'o']]]);
    for (const id of ['mark-in', 'mark-out', 'mark-clip', 'clear-in-out', 'lift', 'extract']) expect(SHORTCUTS.find((s) => s.id === id)?.mutates, id).toBe(true);
    for (const id of ['go-in', 'go-out', 'play-in-out']) expect(SHORTCUTS.find((s) => s.id === id)?.mutates, id).toBeFalsy();
    expect(findShortcut(key('K', { shiftKey: true }))?.id).toBe('key-add');
    expect(findShortcut(key('k'))?.id).toBe('pause');
    expect(findShortcut(key(' ', { code: 'Space', shiftKey: true }))?.id).toBe('play-in-out');
    expect(findShortcut(key(' ', { code: 'Space' }))?.id).toBe('play-pause');
    expect(groupLabel('inout')).toBe('in and out');
    expect(SHORTCUT_GROUPS.indexOf('inout')).toBe(SHORTCUT_GROUPS.indexOf('markers') + 1);
    expect(SHORTCUTS.filter((s) => s.group === 'markers').length).toBe(3);
  });
  it('lift and extract never answer a letter', () => {
    expect(findShortcut(key(';', { code: 'Semicolon' }))?.id).toBe('lift');
    expect(findShortcut(key("'", { code: 'Quote' }))?.id).toBe('extract');
    expect(findShortcut(key('m', { code: 'Semicolon' }))?.id).toBe('marker-add');
    expect(findShortcut(key('i', { code: 'Quote' }))?.id).not.toBe('extract');
    expect(findShortcut(key('q', { code: 'Semicolon' }))?.id).not.toBe('lift');
  });
  it('ctrl+l separates sound', () => {
    expect(findShortcut(key('l', { ctrlKey: true }))?.id).toBe('separate-sound');
    expect(findShortcut(key('l'))?.id).toBe('shuttle-forward');
    const row = SHORTCUTS.find((s) => s.id === 'separate-sound')!;
    expect(row.mutates).toBe(true);
    expect(row.also).toContain('j cut');
    expect(SHORTCUTS.find((s) => s.id === 'mouse-one')?.description).toContain('j or l cut');
  });
  it('shift+6 opens the mixer, shift+s stays free', () => {
    const six = key('^', { shiftKey: true, code: 'Digit6' });
    expect(findShortcut(six)?.id).toBe('open-mixer');
    expect(findShortcut(key('S', { shiftKey: true, code: 'KeyS' }))).toBeUndefined();
    expect(SHORTCUTS.find((s) => s.id === 'open-mixer')?.group).toBe('app');
  });
  it('shift+w toggles the scopes', () => {
    expect(findShortcut(key('W', { shiftKey: true, code: 'KeyW' }))?.id).toBe('toggle-scopes');
    expect(SHORTCUTS.find((s) => s.id === 'toggle-scopes')?.also).toContain('ire');
    expect(SHORTCUTS.find((s) => s.id === 'preview-probe')?.info).toBe(true);
  });
  it('g types a time, up / down step edits, alt+arrows nudge', () => {
    const stage = { closest: () => ({}) } as unknown as EventTarget;
    const lane = { closest: () => null } as unknown as EventTarget;
    expect(findShortcut(key('g'))?.id).toBe('go-to-time');
    expect(findShortcut(key('g', { ctrlKey: true }))?.id).toBe('group');
    expect(findShortcut(key('ArrowUp', { target: lane }))?.id).toBe('edit-prev');
    expect(findShortcut(key('ArrowDown', { target: lane }))?.id).toBe('edit-next');
    expect(findShortcut(key('ArrowUp', { target: stage }))).toBeUndefined();
    expect(findShortcut(key('ArrowDown', { target: stage }))).toBeUndefined();
    expect(findShortcut(key('ArrowLeft', { altKey: true }))?.id).toBe('nudge-left');
    expect(findShortcut(key('ArrowRight', { altKey: true }))?.id).toBe('nudge-right');
    expect(findShortcut(key('ArrowLeft', { altKey: true, shiftKey: true }))?.id).toBe('nudge-left-big');
    expect(findShortcut(key('ArrowRight', { altKey: true, shiftKey: true }))?.id).toBe('nudge-right-big');
    expect(findShortcut(key('ArrowLeft'))?.id).toBe('frame-back');
    expect(findShortcut(key('ArrowLeft', { shiftKey: true }))?.id).toBe('frames-back');
    for (const id of ['nudge-left', 'nudge-right', 'nudge-left-big', 'nudge-right-big']) {
      const row = SHORTCUTS.find((s) => s.id === id)!;
      expect(row.mutates, id).toBe(true);
      expect(row.repeat, id).toBe(true);
      expect(typeof row.runKey, id).toBe('function');
    }
    const go = SHORTCUTS.find((s) => s.id === 'go-to-time')!;
    expect(typeof go.runKey).toBe('function');
    expect(go.mutates).toBeFalsy();
  });
});
