import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioClip, Clip, MediaAsset, Track, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import { SOUND_TEXT } from '../timeline/soundText';
import { paletteActions } from './paletteActions';
import { reasonFor, reasonSnapshot } from './reasons';
import { toggleSoundNow } from '../timeline/soundActions';

const ed = () => useEditor.getState();

const track = (id: string, kind: 'video' | 'audio', over: Partial<Track> = {}): Track => ({ id, kind, name: id, muted: false, hidden: false, locked: false, ...over });
const asset = (id: string, kind: MediaAsset['kind'], hasAudio: boolean): MediaAsset => ({ id, name: id, kind, mime: '', size: 1, duration: 60, width: 100, height: 100, hasAudio, createdAt: 0 });
const video = (id: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId: 'v1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'av', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const audio = (id: string, start: number, duration: number, over: Partial<AudioClip> = {}): AudioClip => ({
  id, type: 'audio', trackId: 'a1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'av', trimStart: 0, speed: 1, volume: 1, muted: false, ...over,
});

const TRACKS = [track('v1', 'video'), track('a1', 'audio')];
interface Fixture { name: string; clips: Clip[]; tracks?: Track[]; selection: string[] }
const FIXTURES: Fixture[] = [
  { name: 'nothing selected', clips: [video('v', 0, 4)], selection: [] },
  { name: 'a plain video', clips: [video('v', 0, 4)], selection: ['v'] },
  { name: 'a silent video', clips: [video('v', 0, 4, { assetId: 'silent' })], selection: ['v'] },
  { name: 'a song', clips: [audio('s', 0, 4, { assetId: 'song' })], selection: ['s'] },
  { name: 'a pair in sync', clips: [video('v', 0, 4, { group: 'g', muted: true }), audio('s', 0, 4, { group: 'g' })], selection: ['v'] },
  { name: 'a pair, both selected', clips: [video('v', 0, 4, { group: 'g', muted: true }), audio('s', 0, 4, { group: 'g' })], selection: ['v', 's'] },
  { name: 'a pair out of sync', clips: [video('v', 0, 4, { group: 'g', muted: true }), audio('s', 0.5, 4, { group: 'g' })], selection: ['v'] },
  { name: 'a late sound', clips: [video('v', 0, 4, { group: 'g', muted: true }), audio('s', 0.5, 4, { group: 'g' })], selection: ['s'] },
  { name: 'a pair at two speeds', clips: [video('v', 0, 4, { group: 'g', muted: true }), audio('s', 0, 2, { group: 'g', speed: 2 })], selection: ['s'] },
  { name: 'a slip that runs out', clips: [video('v', 0, 4, { group: 'g', muted: true }), audio('s', 0.5, 4, { group: 'g' })], selection: ['v'] },
  { name: 'a locked pair', clips: [video('v', 0, 4, { group: 'g', muted: true }), audio('s', 0.5, 4, { group: 'g' })], tracks: [track('v1', 'video'), track('a1', 'audio', { locked: true })], selection: ['v', 's'] },
  { name: 'a locked video', clips: [video('v', 0, 4)], tracks: [track('v1', 'video', { locked: true }), track('a1', 'audio')], selection: ['v'] },
];

function open(f: Fixture): void {
  ed().openProject({
    ...createProject('reasons'),
    assets: [asset('av', 'video', true), asset('silent', 'video', false), asset('song', 'audio', true)],
    tracks: f.tracks ?? TRACKS,
    clips: f.clips,
  });
  useEditor.setState({ past: [], future: [], selection: f.selection });
}

const runAction = (id: string): void => {
  if (id === 'separate-sound') {
    toggleSoundNow(ed().selection);
    return;
  }
  paletteActions().find((a) => a.id === id)!.run();
};

const SOUND_IDS = ['separate-sound', 'join-sound', 'move-into-sync', 'slip-into-sync', 'select-sound', 'select-picture'];

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  useUi.setState({ toasts: [] });
});

describe('sound reasons', () => {
  for (const id of SOUND_IDS) {
    it(`a reason means no change: ${id}`, () => {
      let reasons = 0;
      let free = 0;
      for (const f of FIXTURES) {
        open(f);
        const before = ed().project;
        const selection = [...ed().selection];
        const reason = reasonFor(id, reasonSnapshot());
        if (!reason) {
          free++;
          continue;
        }
        reasons++;
        runAction(id);
        expect(ed().project, `${id} on ${f.name}`).toBe(before);
        expect(ed().selection, `${id} on ${f.name}`).toEqual(selection);
        expect(ed().past.length, `${id} on ${f.name}`).toBe(0);
        // the user is told why
        expect(useUi.getState().toasts.at(-1)?.message, `${id} on ${f.name}`).toBe(reason);
      }
      // the fixtures hold both answers for every id
      expect(reasons).toBeGreaterThan(0);
      expect(free).toBeGreaterThan(0);
    });
  }

  it('a reason is one of the sound texts', () => {
    open(FIXTURES[1]!);
    expect(reasonFor('join-sound', reasonSnapshot())).toBe(SOUND_TEXT.soundPairFirst);
    open(FIXTURES[2]!);
    expect(reasonFor('separate-sound', reasonSnapshot())).toBe(SOUND_TEXT.noSoundInVideo);
    open(FIXTURES[6]!);
    expect(reasonFor('separate-sound', reasonSnapshot())).toBe(SOUND_TEXT.soundOutOfSync);
    expect(reasonFor('move-into-sync', reasonSnapshot())).toBeNull();
  });
});
