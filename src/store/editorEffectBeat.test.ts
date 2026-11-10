import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, EffectClip, Project } from '../types';
import { createProject } from '../lib/factory';
import { useEditor } from './editorStore';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = (id: string): Clip => proj().clips.find((c) => c.id === id)!;
const fxOf = (id: string): EffectClip => clipOf(id) as EffectClip;

let trackId = '';

beforeEach(() => {
  useEditor.setState({ clipboard: [] });
  const p = createProject('test');
  ed().openProject(p);
  trackId = p.tracks[0]!.id;
});

function mk(start = 0, duration = 6): string {
  return ed().addEffect('flash', { trackId, start, duration })!;
}

describe('effect clip beat link in the store', () => {
  it('is stored cleaned: every clamped, pulse 0..1, lock a boolean, source a string or null', () => {
    const id = mk();
    ed().updateClip(id, { beat: { source: 'x', every: 1000, pulse: 7, lock: true } });
    expect(fxOf(id).beat).toEqual({ source: 'x', every: 64, pulse: 1, lock: true });
    ed().updateClip(id, { beat: { source: 5, every: 0.001, pulse: -3, lock: 'sure' } as never });
    expect(fxOf(id).beat).toEqual({ source: null, every: 1 / 16, pulse: 0, lock: false });
  });

  it('bad input removes the field', () => {
    const id = mk();
    ed().updateClip(id, { beat: { source: null, every: 1, pulse: 0.5, lock: false } });
    expect(fxOf(id).beat).toBeDefined();
    ed().updateClip(id, { beat: { every: NaN } as never });
    expect('beat' in fxOf(id)).toBe(false);
  });

  it('null (off) removes the field and a repeat of it is no change and no undo step', () => {
    const id = mk();
    ed().updateClip(id, { beat: { source: null, every: 1, pulse: 0.5, lock: false } });
    ed().updateClip(id, { beat: null });
    expect('beat' in fxOf(id)).toBe(false);
    const before = proj();
    ed().updateClip(id, { beat: null });
    expect(proj()).toBe(before);
  });

  it('the same link again is no change (a new object that says the same)', () => {
    const id = mk();
    ed().updateClip(id, { beat: { source: null, every: 2, pulse: 0.5, lock: true } });
    const before = proj();
    ed().updateClip(id, { beat: { source: null, every: 2, pulse: 0.5, lock: true } });
    expect(proj()).toBe(before);
    // a value that cleans to the stored one is no change either
    ed().updateClip(id, { beat: { source: '', every: 2, pulse: 0.5, lock: true } });
    expect(proj()).toBe(before);
  });

  it('one change is one undo step', () => {
    const id = mk();
    ed().updateClip(id, { beat: { source: null, every: 1, pulse: 0.5, lock: false } });
    ed().undo();
    expect('beat' in fxOf(id)).toBe(false);
    ed().redo();
    expect(fxOf(id).beat?.pulse).toBe(0.5);
  });

  it('only effect clips take it', () => {
    const text = ed().addText();
    ed().updateClip(text, { beat: { source: null, every: 1, pulse: 1, lock: false } } as never);
    expect('beat' in clipOf(text)).toBe(false);
  });

  it('survives a split (both halves), a duplicate and copy / paste', () => {
    const id = mk(0, 6);
    const link = { source: 'song', every: 4, pulse: 0.4, lock: true };
    ed().updateClip(id, { beat: link });
    ed().splitClips(2, [id]);
    const halves = proj().clips.filter((c) => c.type === 'effect') as EffectClip[];
    expect(halves).toHaveLength(2);
    for (const h of halves) expect(h.beat).toEqual(link);
    const [dup] = ed().duplicateClips([id]);
    expect(fxOf(dup!).beat).toEqual(link);
    ed().select([id]);
    ed().copySelection();
    ed().paste(10);
    const all = proj().clips.filter((c) => c.type === 'effect') as EffectClip[];
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (const e of all) expect(e.beat).toEqual(link);
  });

  it('is kept when the clip it follows is deleted', () => {
    const id = mk();
    ed().updateClip(id, { beat: { source: 'someclip', every: 1, pulse: 0.5, lock: false } });
    ed().deleteClips(['someclip']);
    expect(fxOf(id).beat?.source).toBe('someclip');
  });
});
