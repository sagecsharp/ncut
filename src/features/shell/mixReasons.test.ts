import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioClip, MediaAsset, Project, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject, createTrack } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { REASON_IDS, REASON_TEXT, reasonFor, reasonSnapshot } from './reasons';

const ed = () => useEditor.getState();
const T = REASON_TEXT;

const asset = (id: string, kind: 'video' | 'audio', hasAudio = true): MediaAsset => ({
  id, name: id, kind, mime: kind + '/x', size: 1, duration: 10, width: 100, height: 100, hasAudio, createdAt: 0,
});
const video = (trackId: string, id: string, assetId: string): VideoClip => ({
  id, type: 'video', trackId, start: 0, duration: 2, name: id, fadeIn: 0, fadeOut: 0, assetId, trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM },
});
const audio = (trackId: string, id: string): AudioClip => ({
  id, type: 'audio', trackId, start: 0, duration: 2, name: id, fadeIn: 0, fadeOut: 0, assetId: 'aud', trimStart: 0, speed: 1, volume: 1, muted: false,
});

let tracks: string[] = [];

beforeEach(() => {
  const p = createProject('mix reasons');
  const list = [createTrack('video', 'v1'), createTrack('video', 'v2'), createTrack('audio', 'a1')];
  tracks = list.map((t) => t.id);
  const clips = [video(tracks[0]!, 'vs', 'vid'), video(tracks[1]!, 'vn', 'mute'), audio(tracks[2]!, 'a')];
  ed().openProject({ ...p, tracks: list, assets: [asset('vid', 'video'), asset('mute', 'video', false), asset('aud', 'audio')], clips });
});

const ask = (id: string, over: { solo?: readonly string[]; selection?: string[] } = {}) =>
  reasonFor(id, { ...reasonSnapshot(), solo: over.solo ?? [], selection: over.selection ?? [] });
const proj = (): Project => ed().project!;

describe('the mixer reasons', () => {
  it('solo-selection', () => {
    expect(ask('solo-selection')).toBe(T.selectClip);
    expect(ask('solo-selection', { selection: ['vn'] })).toBe(T.soundFirst);
    expect(ask('solo-selection', { selection: ['vs'] })).toBeNull();
    expect(ask('solo-selection', { selection: ['a', 'vn'] })).toBeNull();
    expect(proj().clips.length).toBe(3);
  });

  it('solo-off', () => {
    expect(ask('solo-off')).toBe(T.noSolo);
    expect(ask('solo-off', { solo: [tracks[0]!] })).toBeNull();
    // ids of tracks that are gone count for nothing
    expect(ask('solo-off', { solo: ['trk_gone'] })).toBe(T.noSolo);
    expect(ask('solo-off', { solo: ['trk_gone', tracks[2]!] })).toBeNull();
  });

  it('mixer-reset', () => {
    expect(ask('mixer-reset')).toBe(T.mixFlat);
    ed().updateTrack(tracks[0]!, { volume: 0.5 });
    expect(ask('mixer-reset')).toBeNull();
    ed().resetMixer();
    expect(ask('mixer-reset')).toBe(T.mixFlat);
    ed().updateTrack(tracks[2]!, { pan: -0.3 });
    expect(ask('mixer-reset')).toBeNull();
    ed().resetMixer();
    expect(ask('mixer-reset')).toBe(T.mixFlat);
    ed().updateProject({ output: { volume: 0.7 } });
    expect(ask('mixer-reset')).toBeNull();
    ed().resetMixer();
    expect(ask('mixer-reset')).toBe(T.mixFlat);
  });

  it('the three ids are reason ids', () => {
    for (const id of ['solo-selection', 'solo-off', 'mixer-reset']) expect(REASON_IDS.has(id), id).toBe(true);
  });
});
