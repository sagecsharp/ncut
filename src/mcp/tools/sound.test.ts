import { beforeEach, describe, expect, it } from 'vitest';
import type { MediaAsset } from '../../types';
import { addVideoClip, call, clipOf, ed, fresh, oneStepOf, proj, refused } from './editKit';

let video = '';
let audio = '';
beforeEach(() => {
  ({ video, audio } = fresh());
});

/** a video clip with sound, 0 to 5 s of a 20 s file, and the clip of its sound after separate_sound */
async function pair(start = 0): Promise<{ pic: string; sound: string }> {
  const pic = addVideoClip(video, start);
  await call('trim_clip', { id: pic, edge: 'end', time: start + 5 });
  const r = await call('separate_sound', { ids: [pic] });
  expect(r.ok, r.text).toBe(true);
  return { pic, sound: r.data.pairs[0].sound as string };
}

describe('separate_sound', () => {
  it('separate_sound is one step and answers the pairs', async () => {
    const pic = addVideoClip(video, 0);
    await call('trim_clip', { id: pic, edge: 'end', time: 5 });
    const r = await oneStepOf(() => call('separate_sound', { ids: [pic] }));
    expect(r.data.pairs).toHaveLength(1);
    expect(r.data.skipped).toEqual([]);
    const { picture, sound, track } = r.data.pairs[0];
    expect(picture).toBe(pic);
    const s = clipOf(sound);
    expect(s.type).toBe('audio');
    expect(s.trackId).toBe(track);
    expect((s as any).assetId).toBe('vid1');
    expect(s.start).toBe(0);
    expect(s.duration).toBe(5);
    expect((clipOf(pic) as any).muted).toBe(true);
    expect(s.group).toBeTruthy();
    expect(s.group).toBe(clipOf(pic).group);
  });

  it('track takes an audio track, a video track is refused', async () => {
    const pic = addVideoClip(video, 0);
    await call('trim_clip', { id: pic, edge: 'end', time: 5 });
    await refused('separate_sound', { ids: [pic], track: video }, /is a video track: the sound needs an audio track/);
    await refused('separate_sound', { ids: [pic], track: 'ghost' }, /no track with the id ghost/);
    await refused('separate_sound', { ids: ['ghost'] }, /no clip with the id ghost/);
    const other = ed().addTrack('audio');
    const r = await oneStepOf(() => call('separate_sound', { ids: [pic], track: other }));
    expect(r.data.pairs[0].track).toBe(other);
    expect(clipOf(r.data.pairs[0].sound).trackId).toBe(other);
    void audio;
  });

  it('a locked track is refused and another track is said', async () => {
    const pic = addVideoClip(video, 0);
    await call('trim_clip', { id: pic, edge: 'end', time: 5 });
    const a = ed().addTrack('audio');
    await call('update_track', { id: a, volumeDb: -6 });
    const r = await call('separate_sound', { ids: [pic], track: a });
    expect(r.ok, r.text).toBe(true);
    expect(r.data.pairs[0].track).not.toBe(a);
    expect(r.data.note).toMatch(/went to another track than/);
    await call('join_sound', { ids: [pic] });
    const b = ed().addTrack('audio');
    await call('update_track', { id: b, locked: true });
    await refused('separate_sound', { ids: [pic], track: b }, /is locked\. unlock it with update_track first/);
  });

  it('skipped clips say why', async () => {
    const pic = addVideoClip(video, 0);
    await call('trim_clip', { id: pic, edge: 'end', time: 4 });
    const quiet: MediaAsset = { id: 'quiet', name: 'quiet', kind: 'video', mime: 'video/mp4', size: 1, duration: 20, width: 1920, height: 1080, hasAudio: false, createdAt: 0 };
    ed().addAsset(quiet);
    const mute = addVideoClip(video, 4, 'quiet');
    const r = await call('separate_sound', { ids: [pic, mute] });
    expect(r.ok, r.text).toBe(true);
    expect(r.data.pairs).toHaveLength(1);
    expect(r.data.skipped).toEqual([{ id: mute, why: 'the selected video has no sound' }]);
    // nothing to separate at all is an error with no step
    await refused('separate_sound', { ids: [mute] }, /no sound|video clip with sound/);
    const t = await call('add_text', { text: 'hi', start: 10, duration: 2 });
    await refused('separate_sound', { ids: [t.data.id] }, /select a video clip with sound first/);
  });
});

describe('join_sound and sync_sound', () => {
  it('join_sound gives the picture back in one step', async () => {
    const { pic, sound } = await pair();
    const before = JSON.stringify(proj().clips.filter((c) => c.id === pic));
    expect(before).toContain('"muted":true');
    const r = await oneStepOf(() => call('join_sound', { ids: [sound] }));
    expect(r.data).toEqual({ joined: [pic], removed: [sound], skipped: [] });
    expect(proj().clips.some((c) => c.id === sound)).toBe(false);
    expect((clipOf(pic) as any).muted).toBeFalsy();
    expect(clipOf(pic).group).toBeUndefined();
    // the picture id works as well
    const again = await call('separate_sound', { ids: [pic] });
    const back = await call('join_sound', { ids: [pic] });
    expect(back.ok, back.text).toBe(true);
    expect(back.data.removed).toEqual([again.data.pairs[0].sound]);
  });

  it('a refused join leaves no step', async () => {
    const { pic, sound } = await pair();
    // out of sync
    ed().moveClips([{ id: sound, trackId: clipOf(sound).trackId, start: 0.5 }]);
    await refused('join_sound', { ids: [sound] }, /out of sync/);
    // a clip that was never separated
    const lone = addVideoClip(video, 10);
    await refused('join_sound', { ids: [lone] }, /select a picture or a sound that was separated first/);
    await refused('join_sound', { ids: ['ghost'] }, /no clip with the id ghost/);
    void pic;
  });

  it('sync_sound move, slip and speed', async () => {
    const { pic, sound } = await pair();
    const track = clipOf(sound).trackId;
    ed().moveClips([{ id: sound, trackId: track, start: 0.5 }]);
    const r = await oneStepOf(() => call('sync_sound', { ids: [sound] }));
    expect(r.data.synced).toEqual([sound]);
    expect(clipOf(sound).start).toBeCloseTo(0, 6);
    expect(clipOf(pic).start).toBe(0);
    // slip: the media moves, the clip stays
    ed().moveClips([{ id: sound, trackId: track, start: 0.5 }]);
    const s = await oneStepOf(() => call('sync_sound', { ids: [sound], how: 'slip' }));
    expect(s.data.synced).toEqual([sound]);
    expect(clipOf(sound).start).toBeCloseTo(0.5, 6);
    expect((clipOf(sound) as any).trimStart).toBeCloseTo(0.5, 6);
    // speed: a pair at two speeds plays at one again
    ed().setClipSpeed(sound, 2);
    const p = await oneStepOf(() => call('sync_sound', { ids: [pic], how: 'speed' }));
    expect(p.data.synced.length).toBeGreaterThan(0);
    expect((clipOf(sound) as any).speed).toBe((clipOf(pic) as any).speed);
    await refused('sync_sound', { ids: [pic], how: 'sideways' }, /how must be one of/);
    await refused('sync_sound', { ids: [addVideoClip(video, 10)] }, /select a picture or a sound that was separated first/);
  });
});

describe('update_clip on a picture apart', () => {
  it('volume and pan of a picture apart are set on the sound clip', async () => {
    const { pic, sound } = await pair();
    await refused('update_clip', { id: pic, patch: { volume: 0.2 } }, new RegExp(`the sound of ${pic} is the clip ${sound}: set volume there`));
    await refused('update_clip', { id: pic, patch: { pan: 0.7 } }, /set pan there/);
    await refused('set_keyframe', { id: pic, prop: 'pan', time: 1, value: -1 }, /set pan there/);
    await refused('set_keyframes', { id: pic, keyframes: { volume: [{ t: 0, v: 0.5 }, { t: 1, v: 1 }] } }, /set volume there/);
    // the same value, or other fields, are fine
    const same = await call('update_clip', { id: pic, patch: { volume: 1, name: 'picture' } });
    expect(same.ok, same.text).toBe(true);
    const mine = await call('update_clip', { id: sound, patch: { volume: 0.2, pan: 0.7 } });
    expect(mine.ok, mine.text).toBe(true);
  });

  it('update_clip refuses muted false, bpm and beatOffset on a picture apart', async () => {
    const { pic, sound } = await pair();
    await refused('update_clip', { id: pic, patch: { muted: false } }, new RegExp(`the sound of ${pic} is the clip ${sound}: unmute that one \\(or join_sound\\)`));
    await refused('update_clip', { id: pic, patch: { bpm: 120 } }, new RegExp(`the tempo of ${pic} is on the clip ${sound}: set it there \\(or join_sound\\)`));
    await refused('update_clip', { id: pic, patch: { beatOffset: 0.1 } }, /the tempo of .* is on the clip/);
    // muted true is fine, and the sound clip takes the tempo
    const ok1 = await call('update_clip', { id: pic, patch: { muted: true, name: 'picture' } });
    expect(ok1.ok, ok1.text).toBe(true);
    const ok2 = await call('update_clip', { id: sound, patch: { bpm: 120 } });
    expect(ok2.ok, ok2.text).toBe(true);
    // a video that never separated takes them all
    const lone = addVideoClip(video, 10);
    const ok3 = await call('update_clip', { id: lone, patch: { muted: false, bpm: 100 } });
    expect(ok3.ok, ok3.text).toBe(true);
  });
});
