import { describe, expect, it } from 'vitest';
import { createProject } from '../lib/factory';
import { seeThroughTwin } from '../features/export/delivery';
import { useEditor } from './editorStore';

const ed = () => useEditor.getState();

describe('a transparent canvas', () => {
  it('a new project is opaque unless asked', () => {
    expect('transparent' in createProject()).toBe(false);
    expect(createProject('t', undefined, 30, true).transparent).toBe(true);
  });

  it('turns on and off as one undo step each, and off is the missing field', () => {
    ed().openProject(createProject('t'));
    ed().updateProject({ transparent: true });
    expect(ed().project!.transparent).toBe(true);
    ed().updateProject({ transparent: false });
    expect('transparent' in ed().project!).toBe(false);
    // off again changes nothing: no undo step
    const steps = ed().past.length;
    ed().updateProject({ transparent: false });
    expect(ed().past.length).toBe(steps);
    ed().undo();
    expect(ed().project!.transparent).toBe(true);
  });

  it('the export starts on a container that keeps the see-through part', () => {
    expect(seeThroughTwin('mp4', true)).toBe('webm');
    expect(seeThroughTwin('jpg', true)).toBe('png');
    expect(seeThroughTwin('gif', true)).toBe('gif');
    expect(seeThroughTwin('mp4', false)).toBe('mp4');
  });
});
