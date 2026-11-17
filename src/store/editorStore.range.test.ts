import { beforeEach, describe, expect, it } from 'vitest';
import type { Project, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createProject } from '../lib/factory';
import { useEditor } from './editorStore';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;

function open(): string {
  const p = createProject('range');
  const v = p.tracks[0]!.id;
  const clip: VideoClip = { id: 'c1', type: 'video', trackId: v, start: 0, duration: 10, name: 'c', fadeIn: 0, fadeOut: 0, assetId: 'a', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM } };
  ed().openProject({ ...p, clips: [clip] });
  return v;
}

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  open();
});

describe('setRange', () => {
  it('setRange is not an undo step', () => {
    ed().setRange({ in: 1, out: 3 });
    expect(proj().range).toEqual({ in: 1, out: 3 });
    expect(ed().past).toHaveLength(0);
    expect(ed().future).toHaveLength(0);
    ed().setRange({ in: 2 });
    expect(proj().range).toEqual({ in: 2 });
    expect(ed().past).toHaveLength(0);
  });

  it('the same range keeps the same project', () => {
    ed().setRange({ in: 1, out: 3 });
    const p = proj();
    ed().setRange({ in: 1, out: 3 });
    expect(proj()).toBe(p);
    // a bad mark cleans to the same range
    ed().setRange({ in: 1, out: 3, bogus: 1 } as never);
    expect(proj()).toBe(p);
    // nothing to clear
    ed().setRange(null);
    const q = proj();
    ed().setRange(null);
    expect(proj()).toBe(q);
  });

  it('undo, redo and rollback keep the live range', () => {
    ed().addMarker(1, 'm');
    ed().setRange({ in: 1, out: 3 });
    ed().undo();
    expect(proj().markers).toBeUndefined();
    expect(proj().range).toEqual({ in: 1, out: 3 });
    ed().redo();
    expect(proj().markers).toHaveLength(1);
    expect(proj().range).toEqual({ in: 1, out: 3 });
    // a range set after the step was made also survives its undo and redo
    ed().setRange({ in: 4 });
    ed().undo();
    expect(proj().range).toEqual({ in: 4 });
    ed().setRange(null);
    ed().redo();
    expect('range' in proj()).toBe(false);
    // rollback
    ed().setRange({ out: 5 });
    ed().pushHistory();
    ed().updateProject({ name: 'x' }, { skipHistory: true });
    ed().setRange({ out: 6 });
    ed().rollback();
    expect(proj().name).toBe('range');
    expect(proj().range).toEqual({ out: 6 });
  });

  it('pushHistory, setRange, a skipHistory edit, undo is one step', () => {
    const json = JSON.stringify(proj());
    ed().pushHistory();
    ed().setRange({ in: 1, out: 3 });
    ed().updateProject({ name: 'moved' }, { skipHistory: true });
    expect(ed().past).toHaveLength(1);
    ed().undo();
    expect(proj().name).toBe('range');
    expect(ed().past).toHaveLength(0);
    ed().setRange(null);
    expect(JSON.stringify(proj())).toBe(json);
  });

  it('set then clear gives the json of before', () => {
    const json = JSON.stringify(proj());
    ed().setRange({ in: 1, out: 3 });
    expect(JSON.stringify(proj())).not.toBe(json);
    ed().setRange(null);
    expect(JSON.stringify(proj())).toBe(json);
    expect('range' in proj()).toBe(false);
    // a crossed range cleans to nothing
    ed().setRange({ in: 5, out: 2 });
    expect(proj().range).toEqual({ in: 5 });
    ed().setRange({ out: 0 });
    expect('range' in proj()).toBe(false);
    expect(JSON.stringify(proj())).toBe(json);
  });
});
