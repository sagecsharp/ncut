import { beforeEach, describe, expect, it } from 'vitest';
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import type { AudioClip, Clip, MediaAsset, Track } from '../../types';
import { call, clipOf, ed, oneStepOf, proj, refused } from './editKit';

const track = (id: string, kind: 'video' | 'audio', over: Partial<Track> = {}): Track => ({ id, kind, name: id, muted: false, hidden: false, locked: false, ...over });
const song: MediaAsset = { id: 'song', name: 'song', kind: 'audio', mime: '', size: 1, duration: 60, width: 0, height: 0, hasAudio: true, createdAt: 0 };
const audio = (id: string, start: number, duration: number, over: Partial<AudioClip> = {}): AudioClip => ({
  id, type: 'audio', trackId: 'a1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'song', trimStart: 10, speed: 1, volume: 1, muted: false, ...over,
});

/** three audio clips a, b, c on a1, touching at 4 and 8, each with media before and after */
function open(clips: Clip[] = [audio('a', 0, 4, { trimStart: 10 }), audio('b', 4, 4, { trimStart: 30 }), audio('c', 8, 4, { trimStart: 50 })], tracks: Track[] = [track('a1', 'audio')]): void {
  ed().openProject({ ...createProject('cross'), assets: [song], tracks, clips });
  useEditor.setState({ past: [], future: [], selection: [] });
  usePlayback.getState().seek(0);
}

const cfOf = (id: string) => (clipOf(id) as AudioClip).crossfade;

beforeEach(() => open());

describe('crossfade_edits', () => {
  it('ids at start: the crossfade of the edit before the clip, answered with what fits', async () => {
    const r = await oneStepOf(() => call('crossfade_edits', { ids: ['b'], at: 'start', length: 0.5 }));
    expect(r.data.removed).toEqual([]);
    expect(r.data.skipped).toEqual([]);
    expect(r.data.set).toHaveLength(1);
    expect(r.data.set[0]).toMatchObject({ clip: 'b', edit: 4, shape: 'power' });
    expect(r.data.set[0].before).toBeCloseTo(0.25, 1);
    expect(cfOf('b')).toBeDefined();
    expect(cfOf('c')).toBeUndefined();
  });

  it('ids at both (default) cross both edges of a clip, at end the edge after it', async () => {
    const r = await call('crossfade_edits', { ids: ['b'] });
    expect(r.data.set.map((x: { clip: string }) => x.clip)).toEqual(['b', 'c']);
    open();
    const e = await call('crossfade_edits', { ids: ['a'], at: 'end' });
    expect(e.data.set.map((x: { clip: string }) => x.clip)).toEqual(['b']);
  });

  it('place, before, after and shape reach the plan', async () => {
    const s = await call('crossfade_edits', { ids: ['b'], at: 'start', place: 'start', length: 0.25, shape: 'smooth' });
    expect(s.ok, s.text).toBe(true);
    expect(s.data.set[0].before).toBe(0);
    expect(cfOf('b')?.shape).toBe('smooth');
    open();
    const w = await call('crossfade_edits', { ids: ['b'], at: 'start', before: 0.1, after: 0.2 });
    expect(w.data.set[0].before).toBeCloseTo(0.1, 1);
    expect(w.data.set[0].after).toBeCloseTo(0.2, 1);
  });

  it('track: every edit there, a one take edit is skipped and said', async () => {
    open([audio('a', 0, 4, { trimStart: 10 }), audio('b', 4, 4, { trimStart: 14 }), audio('c', 8, 4, { trimStart: 50 })]);
    const r = await oneStepOf(() => call('crossfade_edits', { track: 'a1' }));
    expect(r.data.set.map((x: { clip: string }) => x.clip)).toEqual(['c']);
    expect(r.data.skipped).toHaveLength(1);
    expect(r.data.skipped[0].id).toBe('b');
  });

  it('remove takes the crossfades away, waiting ones too', async () => {
    await call('crossfade_edits', { track: 'a1' });
    expect(cfOf('b')).toBeDefined();
    const r = await oneStepOf(() => call('crossfade_edits', { track: 'a1', remove: true }));
    expect(r.data.removed.sort()).toEqual(['b', 'c']);
    expect(cfOf('b')).toBeUndefined();
    expect(cfOf('c')).toBeUndefined();
    // ids: remove at one edge
    await call('crossfade_edits', { ids: ['b'], at: 'start' });
    const one = await call('crossfade_edits', { ids: ['b'], at: 'start', remove: true });
    expect(one.data.removed).toEqual(['b']);
  });

  it('is one undo step, however many edits it crosses', async () => {
    const n = ed().past.length;
    const before = proj();
    await call('crossfade_edits', { track: 'a1' });
    expect(ed().past.length).toBe(n + 1);
    ed().undo();
    expect(proj()).toEqual(before);
  });

  it('refuses ids with a track, length with before or after, neither, junk ids', async () => {
    await refused('crossfade_edits', { ids: ['b'], track: 'a1' }, /ids or a track, not both/);
    await refused('crossfade_edits', {}, /give ids or a track/);
    await refused('crossfade_edits', { ids: ['b'], length: 0.5, before: 0.1 }, /length, or before and after/);
    await refused('crossfade_edits', { ids: ['ghost'] }, /no clip with the id ghost/);
    await refused('crossfade_edits', { track: 'ghost' }, /no track with the id ghost/);
    await refused('crossfade_edits', { ids: ['b'], before: 11 }, /at most 10/);
    await refused('crossfade_edits', { ids: ['b'], place: 'left' }, /one of: center, start, end/);
    await refused('crossfade_edits', { ids: ['b'], shape: 'wobble' }, /one of: power, linear, smooth/);
    await refused('crossfade_edits', { ids: [] }, /at least 1/);
  });

  it('a locked track says so and changes nothing', async () => {
    open(undefined, [track('a1', 'audio', { locked: true })]);
    await refused('crossfade_edits', { ids: ['b'], at: 'start' }, /locked/);
    await refused('crossfade_edits', { track: 'a1' }, /locked/);
  });

  it('nothing to cross says why and leaves no step', async () => {
    await refused('crossfade_edits', { ids: ['a'], at: 'start' }, /no edit between two clips with sound/);
  });
});
