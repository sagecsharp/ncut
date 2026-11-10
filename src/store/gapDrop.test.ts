import { beforeEach, describe, expect, it } from 'vitest';
import type { Project, Track } from '../types';
import { createProject, createTrack } from '../lib/factory';
import { gapAllows } from '../features/timeline/layout';
import { useEditor } from './editorStore';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const kinds = () => proj().tracks.map((t) => t.kind[0]).join('');

function open(): void {
  ed().openProject(createProject('t'));
  const tracks: Track[] = [createTrack('video', 'v1'), createTrack('video', 'v2'), createTrack('audio', 'a1'), createTrack('audio', 'a2')];
  useEditor.setState({ project: { ...proj(), tracks, clips: [] }, past: [], future: [] });
}

beforeEach(() => useEditor.setState({ project: null, selection: [], past: [], future: [] }));

describe('new track on a border between tracks', () => {
  it('video at every allowed index lands exactly there', () => {
    for (const index of [1, 2]) {
      open();
      expect(gapAllows(proj().tracks, index, 'video')).toBe(true);
      const before = proj().tracks.map((t) => t.id);
      const id = ed().addTrack('video', { index });
      const ids = proj().tracks.map((t) => t.id);
      expect(ids.indexOf(id)).toBe(index);
      expect(ids.filter((x) => x !== id)).toEqual(before);
      expect(kinds()).toBe('vvvaa');
    }
  });
  it('audio at every allowed index lands exactly there', () => {
    for (const index of [2, 3]) {
      open();
      expect(gapAllows(proj().tracks, index, 'audio')).toBe(true);
      const id = ed().addTrack('audio', { index });
      expect(proj().tracks.findIndex((t) => t.id === id)).toBe(index);
      expect(kinds()).toBe('vvaaa');
    }
  });
  it('a drop into a gap is one undo step', () => {
    open();
    const before = proj().tracks.map((t) => t.id);
    ed().pushHistory();
    const trackId = ed().addTrack('video', { skipHistory: true, index: 1 });
    const id = ed().addText({ trackId, start: 1, duration: 2, skipHistory: true });
    expect(proj().tracks[1]!.id).toBe(trackId);
    expect(proj().clips.find((c) => c.id === id)!.trackId).toBe(trackId);
    expect(kinds()).toBe('vvvaa');
    ed().undo();
    expect(proj().tracks.map((t) => t.id)).toEqual(before);
    expect(proj().clips).toEqual([]);
  });
});
