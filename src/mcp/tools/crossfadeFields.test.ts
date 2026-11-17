import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addVideoClip, call, clipOf, ed, fresh, oneStepOf, refused } from './editKit';
import { AUDIO_FIELDS, VIDEO_FIELDS } from './catalogFields';

vi.mock('../../media/importer', () => ({ importFiles: async () => [] }));

let video = '';
let a = '';
let b = '';
beforeEach(async () => {
  ({ video } = fresh());
  // two touching clips of one 20 s file: a 0 to 4 (media 0..4), b 4 to 9 (media 4..9)
  a = addVideoClip(video, 0);
  ed().trimClip(a, 'end', 4);
  b = addVideoClip(video, 4);
  ed().trimClip(b, 'end', 9);
  await call('slip_clip', { id: b, by: 4 });
});

const crossOf = (id: string) => (clipOf(id) as any).crossfade;

describe('update_clip crossfade', () => {
  it('crossfade takes sides 0..10 and a shape, a partial one lies over', async () => {
    const r = await oneStepOf(() => call('update_clip', { id: b, patch: { crossfade: { before: 0.5, after: 0.25 } } }));
    expect(r.data.changed).toContain('crossfade');
    expect(crossOf(b)).toMatchObject({ before: 0.5, after: 0.25 });
    await oneStepOf(() => call('update_clip', { id: b, patch: { crossfade: { shape: 'smooth', withTransition: true } } }));
    expect(crossOf(b)).toMatchObject({ before: 0.5, after: 0.25, shape: 'smooth', withTransition: true });
    await oneStepOf(() => call('update_clip', { id: b, patch: { crossfade: { after: 1 } } }));
    expect(crossOf(b)).toMatchObject({ before: 0.5, after: 1, shape: 'smooth' });
    // a clip with none takes the defaults for the side it leaves out
    await call('update_clip', { id: b, patch: { crossfade: null } });
    await call('update_clip', { id: b, patch: { crossfade: { shape: 'linear' } } });
    expect(crossOf(b)).toMatchObject({ before: 0.125, after: 0.125 });
    await refused('update_clip', { id: b, patch: { crossfade: { before: 11 } } }, /crossfade\.before must be between 0 and 10, got 11/);
    await refused('update_clip', { id: b, patch: { crossfade: { after: -1 } } }, /crossfade\.after must be between 0 and 10/);
    await refused('update_clip', { id: b, patch: { crossfade: { shape: 'sharp' } } }, /crossfade\.shape must be one of: power, linear, smooth/);
    await refused('update_clip', { id: b, patch: { crossfade: { width: 1 } } }, /crossfade\.width is not a known field/);
    await refused('update_clip', { id: b, patch: { crossfade: 'yes' } }, /crossfade must be an object/);
  });

  it('before + after under 0.001 is refused, null takes it away', async () => {
    await refused('update_clip', { id: b, patch: { crossfade: { before: 0, after: 0 } } }, /crossfade: before \+ after must be at least 0\.001 s \(null takes it away\)/);
    await refused('update_clip', { id: b, patch: { crossfade: { before: 0.0004, after: 0.0004 } } }, /before \+ after must be at least 0\.001 s/);
    await call('update_clip', { id: b, patch: { crossfade: { before: 0, after: 0.5 } } });
    // the merged one counts: 0 + 0 is refused over a current crossfade too
    await refused('update_clip', { id: b, patch: { crossfade: { after: 0 } } }, /crossfade: before \+ after must be at least 0\.001 s \(null takes it away\)/);
    expect(crossOf(b)).toMatchObject({ before: 0, after: 0.5 });
    await oneStepOf(() => call('update_clip', { id: b, patch: { crossfade: null } }));
    expect('crossfade' in clipOf(b)).toBe(false);
  });

  it('a picture with its sound apart refuses crossfade and fade shapes', async () => {
    const sep = await call('separate_sound', { ids: [b] });
    const sound = sep.data.pairs[0].sound as string;
    const re = new RegExp(`the sound of this video is the clip ${sound} on an audio track: set it there`);
    await refused('update_clip', { id: b, patch: { crossfade: { before: 0.5, after: 0.5 } } }, new RegExp(`^crossfade: ${re.source}`));
    await refused('update_clip', { id: b, patch: { crossfade: null } }, /^crossfade: the sound of this video/);
    await refused('update_clip', { id: b, patch: { fadeInShape: 'power', name: 'x' } }, new RegExp(`^fadeInShape: ${re.source}`));
    await refused('update_clip', { id: b, patch: { fadeOutShape: null } }, new RegExp(`^fadeOutShape: ${re.source}`));
    expect(clipOf(b).name).not.toBe('x');
    // set on the sound clip it works
    const r = await call('update_clip', { id: sound, patch: { crossfade: { before: 0.5, after: 0.5 }, fadeInShape: 'smooth' } });
    expect(r.ok, r.text).toBe(true);
    expect(crossOf(sound)).toMatchObject({ before: 0.5, after: 0.5 });
  });

  it('a linear fade shape stores no field', async () => {
    ed().updateClip(a, { fadeIn: 1, fadeOut: 1 } as never);
    await oneStepOf(() => call('update_clip', { id: a, patch: { fadeInShape: 'power', fadeOutShape: 'smooth' } }));
    expect(clipOf(a)).toMatchObject({ fadeInShape: 'power', fadeOutShape: 'smooth' });
    const r = await oneStepOf(() => call('update_clip', { id: a, patch: { fadeInShape: 'linear', fadeOutShape: null } }));
    expect(r.data.changed.sort()).toEqual(['fadeInShape', 'fadeOutShape']);
    expect('fadeInShape' in clipOf(a)).toBe(false);
    expect('fadeOutShape' in clipOf(a)).toBe(false);
    await refused('update_clip', { id: a, patch: { fadeInShape: 'sharp' } }, /fadeInShape must be one of: power, linear, smooth/);
    // a linear shape where there is none is no change, but the clip type still has the field
    const same = await call('update_clip', { id: a, patch: { fadeInShape: 'linear' } });
    expect(same.text).toMatch(/nothing changed/);
  });

  it('crossfadePlays says what plays, short media and waits', async () => {
    // b starts at media 4: 4 s of media before the edit and a ends at media 4, 16 s after
    const full = await call('update_clip', { id: b, patch: { crossfade: { before: 0.5, after: 0.25 } } });
    expect(full.data.crossfadePlays).toEqual({ before: 0.5, after: 0.25 });
    // no media past the edit on a: the clip before ends at the end of its file
    ed().updateClip(b, { crossfade: null } as never);
    await call('slip_clip', { id: b, by: -4 });
    const short = await call('update_clip', { id: b, patch: { crossfade: { before: 0.5, after: 0.25 } } });
    expect(short.data.crossfadePlays).toEqual({ before: 0, after: 0.25, short: 'media' });
    // a field that is not the crossfade says nothing about it
    const other = await call('update_clip', { id: b, patch: { name: 'later' } });
    expect(other.data.crossfadePlays).toBeUndefined();
    // a null crossfade says nothing either
    const gone = await call('update_clip', { id: b, patch: { crossfade: null } });
    expect(gone.data.crossfadePlays).toBeUndefined();
    // the clip before has no sound of its own: the crossfade waits
    await call('update_clip', { id: b, patch: { crossfade: { before: 0.5, after: 0.25 } } });
    await call('separate_sound', { ids: [a] });
    const wait = await call('update_clip', { id: b, patch: { crossfade: { before: 0.4, after: 0.25 } } });
    expect(wait.data.crossfadePlays).toEqual({ waits: true });
  });
});

describe('the catalog and the brief', () => {
  it('list_options has the sound rows and fadeShapes', async () => {
    for (const rows of [VIDEO_FIELDS, AUDIO_FIELDS]) {
      const names = rows.map((r) => r.field);
      const at = names.indexOf('beatOffset');
      expect(names.slice(at + 1, at + 4)).toEqual(['crossfade', 'fadeInShape', 'fadeOutShape']);
      expect(rows.find((r) => r.field === 'crossfade')!.type).toBe('{ before, after, shape?, withTransition? } | null');
      expect(rows.find((r) => r.field === 'fadeInShape')!.example).toBe('power');
      expect(rows.find((r) => r.field === 'fadeOutShape')!.example).toBe('smooth');
    }
    const r = await call('list_options', { kind: 'enums' });
    expect(r.data.fadeShapes).toEqual([
      { id: 'power', label: 'equal power' },
      { id: 'linear', label: 'linear' },
      { id: 'smooth', label: 'smooth' },
    ]);
    const fields = await call('list_options', { kind: 'fields' });
    expect(fields.data.video.map((f: any) => f.field)).toContain('crossfade');
    expect(fields.text.length).toBeLessThan(20000);
  });

  it('clipBrief has crossfade only when set', async () => {
    expect((await call('get_project')).data.clipList.find((c: any) => c.id === b)).not.toHaveProperty('crossfade');
    await call('update_clip', { id: b, patch: { crossfade: { before: 0.5, after: 0.25, shape: 'smooth' } } });
    const list = (await call('get_project')).data.clipList as Record<string, any>[];
    expect(list.find((c) => c.id === b)!.crossfade).toEqual({ before: 0.5, after: 0.25, shape: 'smooth' });
    expect(list.find((c) => c.id === a)).not.toHaveProperty('crossfade');
    const text = await call('add_text', { text: 'hi' });
    expect((await call('get_project')).data.clipList.find((c: any) => c.id === text.data.id)).not.toHaveProperty('crossfade');
  });
});
