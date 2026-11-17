import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clip, ClipGrade, MediaAsset, Project, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createProject } from '../lib/factory';
import { useEditor } from './editorStore';
import { usePlayback } from './playback';
import { setSourceMaster, useSource } from './source';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = (id: string): Clip => proj().clips.find((c) => c.id === id)!;
const gradeOf = (id: string): ClipGrade | null | undefined => (clipOf(id) as VideoClip).grade;

const lut = (id: string): MediaAsset => ({ id, name: id + '.cube', kind: 'lut', mime: 'application/octet-stream', size: 100, duration: 0, width: 0, height: 0, hasAudio: false, createdAt: 0 });
const video: MediaAsset = { id: 'va', name: 'clip', kind: 'video', mime: 'video/mp4', size: 1, duration: 10, width: 1920, height: 1080, hasAudio: true, createdAt: 0 };

function mkVideo(id: string, trackId: string, start: number, over: Partial<VideoClip> = {}): VideoClip {
  return { id, type: 'video', trackId, start, duration: 2, name: id, fadeIn: 0, fadeOut: 0, assetId: 'va', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over };
}

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  const p = createProject('lut');
  const t = p.tracks[0]!.id;
  ed().openProject({
    ...p,
    assets: [{ ...video }, lut('l1'), lut('l2')],
    clips: [
      mkVideo('c1', t, 0, { grade: { liftR: 0.2, lut: { media: 'l1', mix: 0.5 } } }),
      mkVideo('c2', t, 2, { grade: { lut: { media: 'l1' } } }),
      mkVideo('c3', t, 4, { grade: { lut: { media: 'l2' } } }),
      mkVideo('c4', t, 6),
    ],
  });
});

afterEach(() => {
  setSourceMaster(null);
  vi.unstubAllGlobals();
});

describe('luts in the store', () => {
  it('removing a lut takes it off every grade and keeps undo', () => {
    ed().updateProject({ name: 'one' });
    ed().updateProject({ name: 'two' });
    const steps = ed().past.length;
    const c3 = clipOf('c3');
    const c4 = clipOf('c4');
    ed().removeAsset('l1');
    expect(proj().assets.map((a) => a.id)).toEqual(['va', 'l2']);
    // the wheels stay, the lut goes
    expect(gradeOf('c1')).toEqual({ liftR: 0.2 });
    // a grade that was only a lut is no grade
    expect('grade' in clipOf('c2')).toBe(false);
    // other luts and clips without a grade are the same objects
    expect(clipOf('c3')).toBe(c3);
    expect(clipOf('c4')).toBe(c4);
    expect(proj().clips).toHaveLength(4);
    // no clip had this media as its asset: history stays
    expect(ed().past.length).toBe(steps);
    expect(ed().future.length).toBe(0);
    ed().undo();
    expect(proj().name).toBe('one');
  });

  it('removing a media nothing grades with keeps the clips array', () => {
    const clips = proj().clips;
    ed().addAsset(lut('l3'));
    ed().removeAsset('l3');
    expect(proj().clips).toBe(clips);
  });

  it('insertAsset of a lut makes nothing', () => {
    const before = proj();
    expect(ed().insertAsset('l1')).toBeNull();
    expect(proj().clips).toBe(before.clips);
    expect(proj().clips).toHaveLength(4);
  });

  it('setMediaMarks refuses a lut', () => {
    const before = proj();
    expect(ed().setMediaMarks('l1', { in: 1, out: 2 })).toBe(false);
    expect(proj()).toBe(before);
    expect(proj().assets.find((a) => a.id === 'l1')!.marks).toBeUndefined();
    // a video still takes marks
    expect(ed().setMediaMarks('va', { in: 1, out: 2 })).toBe(true);
  });

  it('a lut only grade at mix 0 is kept', () => {
    ed().updateClip('c4', { grade: { lut: { media: 'l2', mix: 0 } } });
    expect(gradeOf('c4')).toEqual({ lut: { media: 'l2', mix: 0 } });
    expect(ed().past).toHaveLength(1);
    // and a lut without a media is no lut
    ed().updateClip('c4', { grade: { lut: {} as never } });
    expect('grade' in clipOf('c4')).toBe(false);
  });

  it('source open refuses a lut', () => {
    useSource.setState({ assetId: null, time: 0, playing: false, rate: 1, toOut: false, split: false });
    usePlayback.setState({ time: 0, playing: false });
    useSource.getState().open('l1', 1);
    expect(useSource.getState().assetId).toBeNull();
    useSource.getState().open('va', 1);
    expect(useSource.getState().assetId).toBe('va');
    useSource.getState().open('l1');
    expect(useSource.getState().assetId).toBe('va');
  });
});
