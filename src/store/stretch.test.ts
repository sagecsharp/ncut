import { beforeEach, describe, expect, it } from 'vitest';
import { createProject, createShapeClip } from '../lib/factory';
import type { Clip, ShapeClip } from '../types';
import { useEditor } from './editorStore';

const ed = () => useEditor.getState();
const clipOf = (id: string) => ed().project!.clips.find((c) => c.id === id) as ShapeClip;

let id = '';
beforeEach(() => {
  ed().openProject(createProject());
  const track = ed().project!.tracks[0]!.id;
  const c = createShapeClip(track, 0, { duration: 5 });
  id = c.id;
  ed().openProject({ ...ed().project!, clips: [c as Clip] });
});

describe('stretch in the store', () => {
  it('updateTransform clamps the stretch like scale', () => {
    ed().updateTransform(id, { scaleX: 0, scaleY: 1000, scaleZ: 2 });
    expect(clipOf(id).transform).toMatchObject({ scaleX: 0.01, scaleY: 100, scaleZ: 2 });
  });
  it('a stretch that stays missing stays missing', () => {
    ed().updateTransform(id, { x: 5 });
    expect(clipOf(id).transform.scaleX).toBeUndefined();
  });
  it('setting a missing stretch to 1 is a no-op, a change is not', () => {
    const before = ed().project;
    ed().updateTransform(id, { scaleX: 1 });
    expect(ed().project).toBe(before);
    ed().updateTransform(id, { scaleX: 1.5 });
    expect(clipOf(id).transform.scaleX).toBe(1.5);
    const n = ed().past.length;
    ed().updateTransform(id, { scaleX: 1.5 });
    expect(ed().past).toHaveLength(n);
  });
  it('setClipValue and setKeyframe clamp to the range', () => {
    ed().setClipValue(id, 'scaleY', 0, 500);
    expect(clipOf(id).transform.scaleY).toBe(100);
    ed().setKeyframe(id, 'scaleZ', 1, -3);
    expect(clipOf(id).keyframes!.scaleZ![0]!.v).toBe(0.01);
  });
});
