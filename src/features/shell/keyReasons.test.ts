import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageClip, Keyframe, Project } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { EASINGS } from '../../lib/anim';
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import type { KeyRef } from '../../store/ui';
import { setKeyCopy } from '../properties/keyClipboard';
import { useKeyPanel } from '../timeline/keyPanelState';
import { paletteActions } from './paletteActions';
import { REASON_IDS, REASON_TEXT, reasonFor, reasonSnapshot } from './reasons';
import type { ReasonInput } from './reasons';

vi.mock('../../store/session', () => ({ closeProject: vi.fn(), exportProjectFile: vi.fn() }));

const k = (t: number): Keyframe => ({ t, v: 0, ease: 'linear' });
const image = (trackId: string, id: string, keyframes?: ImageClip['keyframes']): ImageClip => ({
  id, type: 'image', trackId, start: 0, duration: 4, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM }, ...(keyframes ? { keyframes } : {}),
});

/** a: keys, b: none */
function make(): Project {
  const p = createProject('keyreasons');
  const t = p.tracks[0]!.id;
  return { ...p, clips: [image(t, 'a', { x: [k(1), k(2)] }), image(t, 'b')] };
}
const input = (over: Partial<ReasonInput> = {}): ReasonInput => ({ project: make(), selection: ['a'], time: 1, canUndo: false, canRedo: false, clipboard: 0, zoom: 100, ...over });
const sel: KeyRef[] = [{ clipId: 'a', prop: 'x', t: 1 }];
const EASE_ROWS = ['keys-ease-bezier', ...EASINGS.map((e) => 'keys-ease-' + e.id)];
const KEY_ROWS = ['keys-delete', 'keys-copy', 'keys-nudge-left', 'keys-nudge-right', ...EASE_ROWS];

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  useUi.setState({ keySel: [], keyFocus: false });
  useKeyPanel.setState({ open: false });
  setKeyCopy(null);
});

describe('the keyframe panel reasons', () => {
  it('open the panel, select keyframes, copy first', () => {
    for (const id of KEY_ROWS) {
      expect(REASON_IDS.has(id)).toBe(true);
      expect(reasonFor(id, input({ keySel: sel, keyPanelOpen: false }))).toBe(REASON_TEXT.openKeyPanel);
      expect(reasonFor(id, input({ keySel: [], keyPanelOpen: true }))).toBe(REASON_TEXT.selectKeys);
      expect(reasonFor(id, input({ keyPanelOpen: true }))).toBe(REASON_TEXT.selectKeys);
      expect(reasonFor(id, input({ keySel: sel, keyPanelOpen: true }))).toBeNull();
    }
    // no project: no question
    expect(reasonFor('keys-delete', { ...input(), project: null })).toBeNull();
    // the snapshot reads the panel, the selection and the copy
    useEditor.setState({ project: make(), selection: ['a'] });
    expect(reasonSnapshot()).toMatchObject({ keySel: [], keyCopied: false, keyPanelOpen: false });
    useKeyPanel.setState({ open: true });
    useUi.setState({ keySel: sel });
    setKeyCopy({ items: [{ clipId: 'a', keys: { x: [k(0)] } }] });
    expect(reasonSnapshot()).toMatchObject({ keySel: sel, keyCopied: true, keyPanelOpen: true });
    expect(reasonFor('keys-copy', reasonSnapshot())).toBeNull();
    // paste: copy first, the panel can be closed
    expect(reasonFor('keys-paste', input({ keyCopied: false }))).toBe(REASON_TEXT.copyKeysFirst);
  });

  it('every keys-ease row has a reason', () => {
    const rows = paletteActions().filter((a) => a.id.startsWith('keys-ease-'));
    expect(rows.map((r) => r.id).sort()).toEqual([...EASE_ROWS].sort());
    for (const r of rows) {
      expect(REASON_IDS.has(r.id)).toBe(true);
      expect(reasonFor(r.id, input({ keySel: [], keyPanelOpen: false }))).toBe(REASON_TEXT.openKeyPanel);
      expect(reasonFor(r.id, input({ keySel: [], keyPanelOpen: true }))).toBe(REASON_TEXT.selectKeys);
      expect(reasonFor(r.id, input({ keySel: sel, keyPanelOpen: true }))).toBeNull();
    }
    for (const id of ['keys-delete', 'keys-copy', 'keys-paste', 'keys-select-all', 'keys-nudge-left', 'keys-nudge-right']) {
      expect(paletteActions().some((a) => a.id === id)).toBe(true);
    }
  });

  it('paste needs a copy and a clip', () => {
    expect(reasonFor('keys-paste', input({ keyCopied: false, selection: [] }))).toBe(REASON_TEXT.copyKeysFirst);
    expect(reasonFor('keys-paste', input({ keyCopied: true, selection: [] }))).toBe(REASON_TEXT.selectClip);
    expect(reasonFor('keys-paste', input({ keyCopied: true }))).toBeNull();
    // the panel does not have to be open
    expect(reasonFor('keys-paste', input({ keyCopied: true, keyPanelOpen: false }))).toBeNull();
  });

  it('select all needs keys', () => {
    expect(reasonFor('keys-select-all', input({ selection: [] }))).toBe(REASON_TEXT.selectClip);
    expect(reasonFor('keys-select-all', input({ selection: ['b'] }))).toBe(REASON_TEXT.noKeys);
    expect(reasonFor('keys-select-all', input({ selection: ['a'] }))).toBeNull();
    expect(reasonFor('keys-select-all', input({ selection: ['b', 'a'] }))).toBeNull();
    expect(reasonFor('keys-select-all', input({ selection: ['a'], keyPanelOpen: false }))).toBeNull();
  });
});
