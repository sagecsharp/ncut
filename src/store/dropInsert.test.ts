import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, Project } from '../types';
import { createProject, createTextClip } from '../lib/factory';
import { planDropInsert } from '../features/timeline/dropInsert';
import { useEditor } from './editorStore';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const start = (id: string) => proj().clips.find((c) => c.id === id)!.start;

function open(): string {
  const p = createProject('t');
  ed().openProject(p);
  const track = proj().tracks.find((t) => t.kind === 'video')!.id;
  const clips: Clip[] = [
    { ...createTextClip(track, 0, { duration: 2 }), id: 'a' } as Clip,
    { ...createTextClip(track, 2, { duration: 2 }), id: 'b' } as Clip,
  ];
  useEditor.setState({ project: { ...proj(), clips }, past: [], future: [] });
  return track;
}

beforeEach(() => useEditor.setState({ project: null, selection: [], past: [], future: [] }));

describe('drop inbetween, store side', () => {
  it('moves the later clips and adds the new one in one undo step', () => {
    const track = open();
    const plan = planDropInsert(proj(), track, 2, 1.5)!;
    ed().pushHistory();
    expect(ed().moveClips(plan.moves, { skipHistory: true })).toBe(true);
    const id = ed().addText({ trackId: track, start: plan.start, duration: 1.5, skipHistory: true });
    expect(start('b')).toBe(3.5);
    expect(start(id)).toBe(2);
    ed().undo();
    expect(proj().clips.map((c) => c.id).sort()).toEqual(['a', 'b']);
    expect(start('b')).toBe(2);
  });
  it('a refused move leaves no empty undo step', () => {
    const track = open();
    ed().pushHistory();
    expect(ed().moveClips([{ id: 'b', trackId: track, start: -1 }], { skipHistory: true })).toBe(false);
    expect(ed().past.length).toBe(0);
  });
});
