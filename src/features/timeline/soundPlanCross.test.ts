import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioClip, Clip, MediaAsset, Project, Track, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { soundIndex } from '../../lib/audioCross';
import type { ClipSound } from '../../lib/audioCross';
import { mateOf } from '../../lib/soundPair';
import { useEditor } from '../../store/editorStore';
import { joinSound, separateSound } from './soundActions';

vi.mock('../../media/registry', async (orig) => ({ ...(await orig<typeof import('../../media/registry')>()), getAssetBlob: () => new Blob(['x']) }));

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = <C extends Clip>(id: string): C => proj().clips.find((c) => c.id === id) as C;

const track = (id: string, kind: 'video' | 'audio'): Track => ({ id, kind, name: id, muted: false, hidden: false, locked: false });
const asset = (id: string, kind: MediaAsset['kind'], hasAudio: boolean, duration = 60): MediaAsset => ({ id, name: id, kind, mime: '', size: 1, duration, width: 100, height: 100, hasAudio, createdAt: 0 });
const video = (id: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId: 'v1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'av', trimStart: 5, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const X = { before: 0.25, after: 0.25, shape: 'smooth' as const };

function open(): void {
  const clips: Clip[] = [
    video('a', 0, 4, { fadeOut: 1, fadeOutShape: 'power' }),
    video('b', 4, 4, { crossfade: X, fadeIn: 1, fadeInShape: 'smooth' }),
  ];
  ed().openProject({ ...createProject('sep'), assets: [asset('av', 'video', true)], tracks: [track('v1', 'video'), track('a1', 'audio')], clips });
  useEditor.setState({ past: [], future: [], selection: [] });
}

/** what a sound clip plays, without the ids of the span */
const shape = (s: ClipSound | undefined): unknown =>
  s && {
    head: s.head, tail: s.tail, inShape: s.inShape, outShape: s.outShape,
    xin: s.xin && { start: s.xin.start, end: s.xin.end, edit: s.xin.edit, shape: s.xin.shape },
    xout: s.xout && { start: s.xout.start, end: s.xout.end, edit: s.xout.edit, shape: s.xout.shape },
  };

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
});

describe('separate and join carry the sound fields', () => {
  it('separate moves the crossfade and fade shapes to the sound clip', () => {
    open();
    expect(typeof separateSound(['a', 'b'])).toBe('object');
    const p = proj();
    const sa = mateOf(p.clips, 'a') as AudioClip;
    const sb = mateOf(p.clips, 'b') as AudioClip;
    expect(sa.type).toBe('audio');
    expect(sb.type).toBe('audio');
    // the sound clips have them
    expect(sb.crossfade).toEqual(X);
    expect(sb.fadeInShape).toBe('smooth');
    expect(sa.fadeOutShape).toBe('power');
    // the pictures gave them away
    for (const id of ['a', 'b']) {
      expect('crossfade' in clipOf(id)).toBe(false);
      expect('fadeInShape' in clipOf(id)).toBe(false);
      expect('fadeOutShape' in clipOf(id)).toBe(false);
    }
    // the pictures keep their fades (the picture fades straight)
    expect(clipOf<VideoClip>('a').fadeOut).toBe(1);
    expect(clipOf<VideoClip>('b').fadeIn).toBe(1);
  });

  it('separate keeps what plays', () => {
    open();
    const before = soundIndex(proj());
    expect([...before.keys()].sort()).toEqual(['a', 'b']);
    separateSound(['a', 'b']);
    const p = proj();
    const after = soundIndex(p);
    // the picture has no entry now: its sound is apart
    expect(after.has('a')).toBe(false);
    expect(after.has('b')).toBe(false);
    const sa = mateOf(p.clips, 'a')!;
    const sb = mateOf(p.clips, 'b')!;
    expect(after.size).toBe(2);
    expect(shape(after.get(sa.id))).toEqual(shape(before.get('a')));
    expect(shape(after.get(sb.id))).toEqual(shape(before.get('b')));
    expect(after.get(sb.id)!.head).toBe(0.25);
    expect(after.get(sa.id)!.tail).toBe(0.25);
  });

  it('join brings them back to the picture', () => {
    open();
    const originalA = clipOf<VideoClip>('a');
    const originalB = clipOf<VideoClip>('b');
    const before = soundIndex(proj());
    separateSound(['a', 'b']);
    expect(typeof joinSound(['a', 'b'])).toBe('object');
    const p = proj();
    expect(p.clips.map((c) => c.id)).toEqual(['a', 'b']);
    expect(clipOf<VideoClip>('b').crossfade).toEqual(originalB.crossfade);
    expect(clipOf<VideoClip>('b').fadeInShape).toBe('smooth');
    expect(clipOf<VideoClip>('a').fadeOutShape).toBe('power');
    expect('crossfade' in clipOf('a')).toBe(false);
    expect(clipOf<VideoClip>('a').fadeOut).toBe(originalA.fadeOut);
    const after = soundIndex(p);
    expect(shape(after.get('a'))).toEqual(shape(before.get('a')));
    expect(shape(after.get('b'))).toEqual(shape(before.get('b')));
  });
});
