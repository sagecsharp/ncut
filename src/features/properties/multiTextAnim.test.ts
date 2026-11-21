import { describe, expect, it } from 'vitest';
import { createProject, createTextClip } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import type { TextClip } from '../../types';
import { pickTextAnim, pickedFor, setTextAnimDuration, sharedTextAnim } from './multiTextAnim';

const ed = () => useEditor.getState();
const text = (id: string): TextClip => ed().project!.clips.find((c) => c.id === id) as TextClip;

describe('sharedTextAnim', () => {
  it('the same animation, none, or mixed', () => {
    const a = { animIn: { id: 'fade', duration: 0.5 } };
    const b = { animIn: { id: 'fade', duration: 1 } };
    const c = { animIn: { id: 'pop', duration: 0.5 } };
    expect(sharedTextAnim([a, b], 'animIn')).toEqual({ value: { id: 'fade', duration: 0.5 }, mixed: false });
    expect(sharedTextAnim([a, c], 'animIn').mixed).toBe(true);
    expect(sharedTextAnim([a, {}], 'animIn').mixed).toBe(true);
    expect(sharedTextAnim([{}, { animIn: null }], 'animIn')).toEqual({ value: null, mixed: false });
  });
  it('a pick keeps a clip its own duration', () => {
    expect(pickedFor({ id: 'fade', duration: 2 }, 'pop', 0.5)).toEqual({ id: 'pop', duration: 2 });
    expect(pickedFor(null, 'pop', 0.5)).toEqual({ id: 'pop', duration: 0.5 });
    expect(pickedFor({ id: 'fade', duration: 2 }, null, 0.5)).toBeNull();
  });
});

describe('pickTextAnim / setTextAnimDuration', () => {
  it('every selected text, one undo step each, other clips untouched', () => {
    const p = createProject('t');
    const tr = p.tracks[0]!.id;
    const a = { ...createTextClip(tr, 0), id: 'a', animIn: { id: 'fade', duration: 2 } } as TextClip;
    const b = { ...createTextClip(tr, 5), id: 'b' } as TextClip;
    const c = { ...createTextClip(tr, 10), id: 'c' } as TextClip;
    ed().openProject({ ...p, clips: [a, b, c] });
    const steps = ed().past.length;
    pickTextAnim(['a', 'b'], 'animIn', 'pop', 0.4);
    expect(text('a').animIn).toEqual({ id: 'pop', duration: 2 });
    expect(text('b').animIn).toEqual({ id: 'pop', duration: 0.4 });
    expect(text('c').animIn ?? null).toBeNull();
    expect(ed().past.length).toBe(steps + 1);
    setTextAnimDuration(['a', 'b'], 'animIn', 1.25, false);
    expect([text('a').animIn!.duration, text('b').animIn!.duration]).toEqual([1.25, 1.25]);
    expect(ed().past.length).toBe(steps + 2);
    ed().undo();
    ed().undo();
    expect(text('a').animIn).toEqual({ id: 'fade', duration: 2 });
    expect(text('b').animIn ?? null).toBeNull();
  });
});
