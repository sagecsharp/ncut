import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioClip, MediaAsset, Project, VideoClip } from '../../types';
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { insertMedia } from './insertMedia';
import { useSoundApart } from './soundSetting';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const asset = (id: string, kind: MediaAsset['kind'], hasAudio: boolean, duration = 5): MediaAsset => ({ id, name: id, kind, mime: '', size: 1, duration, width: kind === 'audio' ? 0 : 100, height: kind === 'audio' ? 0 : 100, hasAudio, createdAt: 0 });

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  useSoundApart.setState({ apart: false });
  ed().openProject({ ...createProject('insert'), assets: [asset('av', 'video', true), asset('silent', 'video', false), asset('song', 'audio', true), asset('pic', 'image', false)] });
  useEditor.setState({ past: [], future: [] });
});

describe('insertMedia', () => {
  it('off: one clip', () => {
    const id = insertMedia('av', { start: 1 });
    expect(id).not.toBeNull();
    expect(proj().clips).toHaveLength(1);
    expect(proj().clips[0]).toMatchObject({ id, type: 'video', start: 1 });
    expect(ed().past.length).toBe(1);
    expect(ed().selection).toEqual([id]);
  });

  it('on: a pair in one step', () => {
    useSoundApart.setState({ apart: true });
    const id = insertMedia('av', { start: 1 })!;
    expect(proj().clips.map((c) => c.type)).toEqual(['video', 'audio']);
    const v = proj().clips[0] as VideoClip;
    const s = proj().clips[1] as AudioClip;
    expect(v.id).toBe(id);
    expect(v.muted).toBe(true);
    expect(v.group).toBe(s.group);
    expect(s).toMatchObject({ start: 1, duration: v.duration, assetId: 'av' });
    expect(ed().selection.sort()).toEqual([v.id, s.id].sort());
    expect(ed().past.length).toBe(1);
    ed().undo();
    expect(proj().clips).toHaveLength(0);
    ed().redo();
    expect(proj().clips).toHaveLength(2);
  });

  it('a silent video stays one clip', () => {
    useSoundApart.setState({ apart: true });
    expect(insertMedia('silent')).not.toBeNull();
    expect(proj().clips).toHaveLength(1);
    expect(ed().past.length).toBe(1);
  });

  it('other media and the parts of a source drag stay one clip', () => {
    useSoundApart.setState({ apart: true });
    insertMedia('song');
    insertMedia('pic');
    insertMedia('av', { parts: 'picture' });
    insertMedia('av', { parts: 'sound' });
    expect(proj().clips.map((c) => c.type)).toEqual(['audio', 'image', 'video', 'audio']);
    expect(proj().clips.every((c) => c.group === undefined)).toBe(true);
    // 'both' separates like no parts
    insertMedia('av', { parts: 'both', start: 20 });
    expect(proj().clips.filter((c) => c.group !== undefined)).toHaveLength(2);
  });

  it('a media that is not there gives null and no step', () => {
    useSoundApart.setState({ apart: true });
    expect(insertMedia('nope')).toBeNull();
    expect(ed().past.length).toBe(0);
  });

  it("no own step inside a caller's", () => {
    useSoundApart.setState({ apart: true });
    ed().pushHistory();
    const id = insertMedia('av', { skipHistory: true });
    expect(id).not.toBeNull();
    expect(proj().clips).toHaveLength(2);
    expect(ed().past.length).toBe(1);
    ed().undo();
    expect(proj().clips).toHaveLength(0);
    // a failing insert inside a step leaves the rollback to the caller
    ed().pushHistory();
    expect(insertMedia('nope', { skipHistory: true })).toBeNull();
    expect(proj().clips).toHaveLength(0);
    expect(ed().past.length).toBe(0);
  });

  it('a pair lands on an audio track with room, the picture on its own track', () => {
    useSoundApart.setState({ apart: true });
    insertMedia('av', { start: 0 });
    insertMedia('av', { start: 1 });
    // the second overlaps the first: more tracks, nothing overlaps
    const byTrack = new Map<string, [number, number][]>();
    for (const c of proj().clips) byTrack.set(c.trackId, [...(byTrack.get(c.trackId) ?? []), [c.start, c.start + c.duration]]);
    for (const spans of byTrack.values()) {
      const sorted = [...spans].sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < sorted.length; i++) expect(sorted[i]![0]).toBeGreaterThanOrEqual(sorted[i - 1]![1] - 1e-9);
    }
    expect(proj().clips).toHaveLength(4);
  });
});
