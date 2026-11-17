import { beforeEach, describe, expect, it } from 'vitest';
import type { MediaAsset, Project } from '../types';
import { createClipFromAsset, createProject } from '../lib/factory';
import { useEditor } from './editorStore';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const assetOf = (id: string) => proj().assets.find((a) => a.id === id)!;

const video: MediaAsset = { id: 'va', name: 'clip', kind: 'video', mime: 'video/mp4', size: 1, duration: 10, width: 1920, height: 1080, hasAudio: true, createdAt: 0 };
const silent: MediaAsset = { ...video, id: 'vs', name: 'silent', hasAudio: false };
const sound: MediaAsset = { id: 'au', name: 'sound', kind: 'audio', mime: 'audio/mpeg', size: 1, duration: 6, width: 0, height: 0, hasAudio: true, createdAt: 0 };
const image: MediaAsset = { id: 'img', name: 'img', kind: 'image', mime: 'image/png', size: 1, duration: 0, width: 100, height: 100, hasAudio: false, createdAt: 0 };

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  ed().openProject({ ...createProject('marks'), assets: [video, silent, sound, image] });
});

describe('media marks', () => {
  it('no history', () => {
    expect(ed().setMediaMarks('va', { in: 1, out: 4 })).toBe(true);
    expect(assetOf('va').marks).toEqual({ in: 1, out: 4 });
    expect(ed().past).toHaveLength(0);
    expect(ed().future).toHaveLength(0);
    // the other assets are the same objects
    expect(assetOf('au')).toBe(sound);
  });

  it('same marks, same object', () => {
    ed().setMediaMarks('va', { in: 1, out: 4 });
    const p = proj();
    expect(ed().setMediaMarks('va', { in: 1, out: 4 })).toBe(false);
    expect(proj()).toBe(p);
    // marks that clean to the same thing
    expect(ed().setMediaMarks('va', { in: 1, out: 4, extra: 1 } as never)).toBe(false);
    expect(proj()).toBe(p);
    // nothing to clear
    expect(ed().setMediaMarks('au', null)).toBe(false);
    expect(ed().setMediaMarks('gone', { in: 1 })).toBe(false);
  });

  it('null deletes the key', () => {
    const json = JSON.stringify(proj());
    ed().setMediaMarks('va', { in: 1 });
    expect('marks' in assetOf('va')).toBe(true);
    expect(ed().setMediaMarks('va', null)).toBe(true);
    expect('marks' in assetOf('va')).toBe(false);
    expect(JSON.stringify(proj())).toBe(json);
    // marks that clean to nothing clear them too
    ed().setMediaMarks('va', { in: 1 });
    expect(ed().setMediaMarks('va', { in: -1 })).toBe(true);
    expect('marks' in assetOf('va')).toBe(false);
  });

  it('pictures refused', () => {
    expect(ed().setMediaMarks('img', { in: 0, out: 1 })).toBe(false);
    expect('marks' in assetOf('img')).toBe(false);
    expect(ed().setMediaMarks('au', { in: 1, out: 2 })).toBe(true);
  });

  it('undo, redo and rollback keep marks', () => {
    ed().addMarker(1, 'm');
    ed().setMediaMarks('va', { in: 2, out: 5 });
    ed().undo();
    expect(proj().markers).toBeUndefined();
    expect(assetOf('va').marks).toEqual({ in: 2, out: 5 });
    ed().redo();
    expect(proj().markers).toHaveLength(1);
    expect(assetOf('va').marks).toEqual({ in: 2, out: 5 });
    ed().pushHistory();
    ed().updateProject({ name: 'x' }, { skipHistory: true });
    ed().setMediaMarks('va', { in: 3 });
    ed().rollback();
    expect(proj().name).toBe('marks');
    expect(assetOf('va').marks).toEqual({ in: 3 });
  });

  it('open gesture stays open', () => {
    ed().pushHistory();
    ed().setMediaMarks('va', { in: 1, out: 2 });
    expect(ed().past).toHaveLength(0);
    ed().updateProject({ name: 'dragged' }, { skipHistory: true });
    expect(ed().past).toHaveLength(1);
    ed().undo();
    expect(proj().name).toBe('marks');
    expect(ed().past).toHaveLength(0);
    expect(assetOf('va').marks).toEqual({ in: 1, out: 2 });
  });

  it('insert with range and parts is one step', () => {
    const id = ed().insertAsset('va', { range: { in: 2, out: 5 }, parts: 'picture' })!;
    expect(ed().past).toHaveLength(1);
    const c = proj().clips.find((x) => x.id === id)!;
    expect(c.type).toBe('video');
    if (c.type !== 'video') return;
    expect(c.trimStart).toBe(2);
    expect(c.duration).toBe(3);
    expect(c.muted).toBe(true);
    expect(ed().selection).toEqual([id]);
    // the sound alone is an audio clip on an audio track
    const s = ed().insertAsset('va', { range: { in: 1, out: 2 }, parts: 'sound' })!;
    const sc = proj().clips.find((x) => x.id === s)!;
    expect(sc.type).toBe('audio');
    expect(proj().tracks.find((t) => t.id === sc.trackId)!.kind).toBe('audio');
    expect(ed().past).toHaveLength(2);
    ed().undo();
    expect(proj().clips.some((x) => x.id === s)).toBe(false);
    expect(proj().clips.some((x) => x.id === id)).toBe(true);
  });

  it('missing part changes nothing', () => {
    const before = proj();
    expect(ed().insertAsset('vs', { parts: 'sound' })).toBeNull();
    expect(ed().insertAsset('img', { parts: 'sound' })).toBeNull();
    expect(ed().insertAsset('au', { parts: 'picture' })).toBeNull();
    expect(proj()).toBe(before);
    expect(ed().past).toHaveLength(0);
  });

  it('no take is today\'s clip', () => {
    const id = ed().insertAsset('va')!;
    const c = proj().clips.find((x) => x.id === id)!;
    const want = createClipFromAsset(video, c.trackId, c.start);
    expect(JSON.stringify({ ...c, id: '' })).toBe(JSON.stringify({ ...want, id: '' }));
    const sid = ed().insertAsset('au', { start: 0 })!;
    const sc = proj().clips.find((x) => x.id === sid)!;
    expect(JSON.stringify({ ...sc, id: '' })).toBe(JSON.stringify({ ...createClipFromAsset(sound, sc.trackId, sc.start), id: '' }));
    // an empty take is no take
    const eid = ed().insertAsset('va', { range: null, parts: 'both' })!;
    const ec = proj().clips.find((x) => x.id === eid)!;
    expect(JSON.stringify({ ...ec, id: '', trackId: '', start: 0 })).toBe(JSON.stringify({ ...c, id: '', trackId: '', start: 0 }));
  });
});
