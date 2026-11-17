import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioClip, MediaAsset, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createProject, createTrack } from '../lib/factory';
import { useEditor } from './editorStore';
import { soloSelectedTracks, useSolo } from './solo';

const ed = () => useEditor.getState();
const solo = () => useSolo.getState();

const asset = (id: string, kind: 'image' | 'video' | 'audio'): MediaAsset => ({
  id, name: id, kind, mime: kind + '/x', size: 1, duration: 10, width: 100, height: 100, hasAudio: kind !== 'image', createdAt: 0,
});
const video = (trackId: string, id: string, assetId: string): VideoClip => ({
  id, type: 'video', trackId, start: 0, duration: 2, name: id, fadeIn: 0, fadeOut: 0, assetId, trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM },
});
const audio = (trackId: string, id: string): AudioClip => ({
  id, type: 'audio', trackId, start: 0, duration: 2, name: id, fadeIn: 0, fadeOut: 0, assetId: 'aud', trimStart: 0, speed: 1, volume: 1, muted: false,
});

/** tracks: video with sound, a video track with a silent clip, two audio tracks. clips: vs on the first, vn on the second, a on the third */
function open(): string[] {
  const p = createProject('solo');
  const tracks = [createTrack('video', 'v1'), createTrack('video', 'v2'), createTrack('audio', 'a1'), createTrack('audio', 'a2')];
  const t = tracks.map((x) => x.id);
  const clips = [video(t[0]!, 'vs', 'vid'), video(t[1]!, 'vn', 'mute'), audio(t[2]!, 'a')];
  ed().openProject({ ...p, tracks, assets: [asset('vid', 'video'), { ...asset('mute', 'video'), hasAudio: false }, asset('aud', 'audio')], clips });
  return t;
}

beforeEach(() => {
  useSolo.setState({ solo: [] });
  useEditor.setState({ project: null, selection: [] });
});

describe('solo', () => {
  it('toggleSolo adds and takes out', () => {
    solo().toggleSolo('a');
    solo().toggleSolo('b');
    expect(solo().solo).toEqual(['a', 'b']);
    solo().toggleSolo('a');
    expect(solo().solo).toEqual(['b']);
    solo().toggleSolo('b');
    expect(solo().solo).toEqual([]);
  });

  it('only: just this track, again none', () => {
    solo().toggleSolo('a');
    solo().toggleSolo('b', true);
    expect(solo().solo).toEqual(['b']);
    solo().toggleSolo('b', true);
    expect(solo().solo).toEqual([]);
    solo().toggleSolo('a');
    solo().toggleSolo('b');
    solo().toggleSolo('a', true);
    expect(solo().solo).toEqual(['a']);
  });

  it('no set when nothing changes', () => {
    solo().setSolo(['a', 'b']);
    const before = solo().solo;
    solo().setSolo(['b', 'a']);
    solo().setSolo(['a', 'b', 'a']);
    expect(solo().solo).toBe(before);
    solo().setSolo(['c', 'c']);
    expect(solo().solo).toEqual(['c']);
    solo().clearSolo();
    const empty = solo().solo;
    solo().clearSolo();
    expect(solo().solo).toBe(empty);
  });

  it('cleared when another project opens', () => {
    open();
    solo().setSolo(['a']);
    ed().openProject(createProject('other'));
    expect(solo().solo).toEqual([]);
  });

  it('kept on the same project', () => {
    const t = open();
    solo().setSolo([t[0]!]);
    ed().updateTrack(t[0]!, { muted: true });
    ed().addTrack('audio');
    expect(solo().solo).toEqual([t[0]]);
  });

  it('soloSelectedTracks', () => {
    const t = open();
    soloSelectedTracks();
    expect(solo().solo).toEqual([]);
    // a clip without sound: nothing happens
    useEditor.setState({ selection: ['vn'] });
    soloSelectedTracks();
    expect(solo().solo).toEqual([]);
    useEditor.setState({ selection: ['vs', 'a'] });
    soloSelectedTracks();
    expect(solo().solo).toEqual([t[0], t[2]]);
    // exactly those on solo: every track again
    soloSelectedTracks();
    expect(solo().solo).toEqual([]);
    solo().setSolo([t[3]!]);
    soloSelectedTracks();
    expect(solo().solo).toEqual([t[0], t[2]]);
  });
});
