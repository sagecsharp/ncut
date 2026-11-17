import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioClip, Clip, MediaAsset, Project, Track, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { CROSS_TEXT } from '../timeline/crossfadeText';
import { pickCrossfade } from '../timeline/crossfadeActions';
import { paletteActions } from './paletteActions';
import { REASON_IDS, REASON_TEXT, reasonFor, reasonSnapshot } from './reasons';
import { SHORTCUTS } from './shortcuts';

const ed = () => useEditor.getState();
const lastToast = (): string => useUi.getState().toasts.at(-1)?.message ?? '';
const track = (id: string, kind: 'video' | 'audio', over: Partial<Track> = {}): Track => ({ id, kind, name: id, muted: false, hidden: false, locked: false, ...over });
const asset = (id: string, kind: MediaAsset['kind'], hasAudio: boolean, duration = 60): MediaAsset => ({ id, name: id, kind, mime: '', size: 1, duration, width: 100, height: 100, hasAudio, createdAt: 0 });
const audio = (id: string, start: number, duration: number, over: Partial<AudioClip> = {}): AudioClip => ({
  id, type: 'audio', trackId: 'a1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'song', trimStart: 10, speed: 1, volume: 1, muted: false, ...over,
});
const video = (id: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId: 'v1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'av', trimStart: 10, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over,
});

const OPEN = [track('v1', 'video'), track('a1', 'audio')];
const LOCKED = [track('v1', 'video'), track('a1', 'audio', { locked: true })];
const TWO = (): Clip[] => [audio('a', 0, 4, { trimStart: 10 }), audio('b', 4, 4, { trimStart: 30 })];
const HAS = { before: 0.1, after: 0.1 };

interface Fixture { name: string; clips: Clip[]; tracks?: Track[]; selection: string[]; time?: number; pick?: string }
const FIXTURES: Fixture[] = [
  { name: 'nothing selected, the playhead on nothing', clips: TWO(), selection: [] },
  { name: 'nothing selected, the playhead on the edit', clips: TWO(), selection: [], time: 4 },
  { name: 'the clip after', clips: TWO(), selection: ['b'] },
  { name: 'the clip before', clips: TWO(), selection: ['a'] },
  { name: 'a lone clip', clips: [audio('a', 0, 4)], selection: ['a'] },
  { name: 'both have one', clips: [audio('a', 0, 4, { trimStart: 10 }), audio('b', 4, 4, { trimStart: 30, crossfade: HAS })], selection: ['a', 'b'] },
  { name: 'a locked track', clips: TWO(), tracks: LOCKED, selection: ['a'] },
  { name: 'no media past the edit', clips: [audio('a', 0, 4, { assetId: 'short', trimStart: 10 }), audio('b', 4, 4, { assetId: 'short', trimStart: 0 })], selection: ['a'] },
  { name: 'one take', clips: [audio('a', 0, 4, { trimStart: 10 }), audio('b', 4, 4, { trimStart: 14 })], selection: ['a'] },
  { name: 'a soundless video', clips: [video('s', 0, 4, { assetId: 'silent' }), video('t', 4, 4, { trimStart: 30 })], tracks: OPEN, selection: ['t'] },
  { name: 'a picked crossfade', clips: [audio('a', 0, 4, { trimStart: 10 }), audio('b', 4, 4, { trimStart: 30, crossfade: HAS })], selection: [], pick: 'b' },
  { name: 'a fade shape already set', clips: [audio('a', 0, 4, { fadeInShape: 'smooth', fadeOutShape: 'smooth' })], selection: ['a'] },
];

function open(f: Fixture): void {
  ed().openProject({
    ...createProject('reasons'),
    assets: [asset('song', 'audio', true), asset('av', 'video', true), asset('silent', 'video', false), asset('short', 'audio', true, 14)],
    tracks: f.tracks ?? OPEN,
    clips: f.clips,
  });
  useEditor.setState({ past: [], future: [], selection: f.selection });
  usePlayback.setState({ time: f.time ?? 0 });
  useUi.setState({ toasts: [], crossfadePick: null, trimEdge: null });
  if (f.pick) {
    // the pick counts for the selection it was made with
    ed().select([f.pick], 'replace');
    const locked = (f.tracks ?? OPEN).some((t) => t.locked);
    if (!locked) pickCrossfade(f.pick);
  }
}

const IDS = ['crossfade', 'crossfade-track', 'crossfade-track-off', 'fade-shape-power', 'fade-shape-linear', 'fade-shape-smooth'];
const row = (id: string) => SHORTCUTS.find((s) => s.id === id);
const run = (id: string): void => {
  const key = row(id);
  if (key) key.run();
  else paletteActions().find((a) => a.id === id)!.run();
};
const snap = (): string => JSON.stringify({ project: ed().project, selection: ed().selection, time: usePlayback.getState().time });

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  useUi.setState({ toasts: [], crossfadePick: null, trimEdge: null });
  usePlayback.setState({ time: 0 });
});

describe('crossfade reasons', () => {
  it('six crossfade reasons', () => {
    for (const id of IDS) expect(REASON_IDS, id).toContain(id);
    const why = (id: string, f: Fixture): string | null => {
      open(f);
      return reasonFor(id, reasonSnapshot());
    };
    const at = (name: string): Fixture => FIXTURES.find((f) => f.name === name)!;
    // the key
    expect(why('crossfade', at('nothing selected, the playhead on nothing'))).toBe(CROSS_TEXT.crossNoEditHere);
    expect(why('crossfade', at('nothing selected, the playhead on the edit'))).toBeNull();
    expect(why('crossfade', at('the clip after'))).toBeNull();
    expect(why('crossfade', at('a lone clip'))).toBe(CROSS_TEXT.crossNoEdit);
    expect(why('crossfade', at('both have one'))).toBeNull();
    expect(why('crossfade', at('a locked track'))).toBe(REASON_TEXT.trackLocked);
    expect(why('crossfade', at('no media past the edit'))).toBe(CROSS_TEXT.crossNoMedia);
    expect(why('crossfade', at('a soundless video'))).toBe(CROSS_TEXT.crossNoEdit);
    expect(why('crossfade', at('a picked crossfade'))).toBeNull();
    // the track
    expect(why('crossfade-track', at('nothing selected, the playhead on nothing'))).toBe(REASON_TEXT.selectClip);
    expect(why('crossfade-track', at('a lone clip'))).toBe(CROSS_TEXT.crossNoEditTrack);
    expect(why('crossfade-track', at('the clip after'))).toBeNull();
    expect(why('crossfade-track', at('both have one'))).toBe(CROSS_TEXT.crossAllHave);
    expect(why('crossfade-track', at('one take'))).toBe(CROSS_TEXT.crossOneTake);
    expect(why('crossfade-track', at('a locked track'))).toBe(REASON_TEXT.trackLocked);
    expect(why('crossfade-track', at('a soundless video'))).toBe(CROSS_TEXT.crossNoEditTrack);
    expect(why('crossfade-track-off', at('the clip after'))).toBe(CROSS_TEXT.crossNoneTrack);
    expect(why('crossfade-track-off', at('both have one'))).toBeNull();
    expect(why('crossfade-track-off', at('nothing selected, the playhead on nothing'))).toBe(REASON_TEXT.selectClip);
    // the fade shapes
    expect(why('fade-shape-power', at('nothing selected, the playhead on nothing'))).toBe(REASON_TEXT.soundFirst);
    expect(why('fade-shape-power', at('the clip after'))).toBeNull();
    expect(why('fade-shape-smooth', at('a fade shape already set'))).not.toBeNull();
    expect(why('fade-shape-linear', at('a fade shape already set'))).toBeNull();
    expect(why('fade-shape-linear', at('a locked track'))).toBe(REASON_TEXT.trackLocked);
    // no project: nothing to say
    useEditor.setState({ project: null });
    for (const id of IDS) expect(reasonFor(id, reasonSnapshot()), id).toBeNull();
  });

  it('a reason means the row changes nothing', () => {
    let reasons = 0;
    let free = 0;
    for (const id of IDS) {
      for (const f of FIXTURES) {
        open(f);
        const why = reasonFor(id, reasonSnapshot());
        if (!why) {
          free++;
          continue;
        }
        const before = snap();
        const past = ed().past.length;
        run(id);
        expect(snap(), `${id} in ${f.name}: ${why}`).toBe(before);
        expect(ed().past.length, `${id} in ${f.name}`).toBe(past);
        // and it says why
        expect(lastToast(), `${id} in ${f.name}`).toBe(why);
        reasons++;
      }
    }
    expect(reasons).toBeGreaterThan(20);
    expect(free).toBeGreaterThan(10);
  });

  it('the key adds, then removes', () => {
    open(FIXTURES.find((f) => f.name === 'the clip after')!);
    const crossfaded = (id: string): boolean => !!(ed().project!.clips.find((c) => c.id === id) as AudioClip).crossfade;
    expect(reasonFor('crossfade', reasonSnapshot())).toBeNull();
    run('crossfade');
    expect(crossfaded('b')).toBe(true);
    expect(ed().past.length).toBe(1);
    // the same state with a crossfade: the key is still free, and it removes
    expect(reasonFor('crossfade', reasonSnapshot())).toBeNull();
    run('crossfade');
    expect(crossfaded('b')).toBe(false);
    expect(ed().past.length).toBe(2);
    // both the keys are this one row
    expect(row('crossfade')!.keys).toEqual([['shift', 't'], ['ctrl', 'shift', 'd']]);
  });

  it('palette whys', () => {
    // the row of the palette is the same planner as the reason: when there is one, the row toasts it
    for (const id of ['crossfade-track', 'crossfade-track-off', 'fade-shape-power', 'fade-shape-linear', 'fade-shape-smooth']) {
      expect(paletteActions().find((a) => a.id === id), id).toBeDefined();
      for (const f of FIXTURES) {
        open(f);
        const why = reasonFor(id, reasonSnapshot());
        paletteActions().find((a) => a.id === id)!.run();
        if (why) expect(lastToast(), `${id} in ${f.name}`).toBe(why);
        else expect(ed().past.length, `${id} in ${f.name}`).toBeGreaterThan(0);
      }
    }
  });

  it('ASK equals REASON_TEXT', () => {
    // crossfadePlan.ts cannot import REASON_TEXT (reasons.ts imports it): its private words are the same
    const src = readFileSync('src/features/timeline/crossfadePlan.ts', 'utf8');
    const m = /const ASK = \{ selectClip: '([^']*)', soundFirst: '([^']*)', trackLocked: '([^']*)' \}/.exec(src);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(REASON_TEXT.selectClip);
    expect(m![2]).toBe(REASON_TEXT.soundFirst);
    expect(m![3]).toBe(REASON_TEXT.trackLocked);
    // the crossfade texts are spread into REASON_TEXT once
    for (const [k, v] of Object.entries(CROSS_TEXT)) expect(REASON_TEXT[k as keyof typeof REASON_TEXT], k).toBe(v);
  });
});
