import { beforeEach, describe, expect, it } from 'vitest';
import { addVideoClip, call, clipOf, ed, fresh, oneStepOf, refused } from './editKit';

type Graded = { grade?: Record<string, unknown> | null };
const gradeOf = (id: string) => (clipOf(id) as Graded).grade;

let video = '';
beforeEach(() => {
  video = addVideoClip(fresh().video, 0);
});

describe('update_clip grade with keys', () => {
  it('a keyed wheel number is refused, an unkeyed one lands', async () => {
    await call('set_keyframe', { id: video, prop: 'grade.liftR', time: 0, value: 0.2 });
    await refused('update_clip', { id: video, patch: { grade: { liftR: 0.5 } } }, /grade\.liftR is keyed on this clip.*set_keyframe.*clear_keyframes/);
    await refused('update_clip', { id: video, patch: { grade: { liftG: 0.1, liftR: 0.5 } } }, /grade\.liftR is keyed/);
    await oneStepOf(() => call('update_clip', { id: video, patch: { grade: { liftG: 0.1, curves: { y: [[0, 0], [1, 0.9]] } } } }));
    expect(gradeOf(video)).toMatchObject({ liftG: 0.1 });
    expect(gradeOf(video)).not.toHaveProperty('liftR', 0.5);
  });

  it('grade null is refused while grade keys exist', async () => {
    await call('update_clip', { id: video, patch: { grade: { gainB: 0.3 } } });
    await call('set_keyframe', { id: video, prop: 'grade.gammaY', time: 0, value: 0.1 });
    await refused('update_clip', { id: video, patch: { grade: null } }, /grade\.gammaY is keyed on this clip/);
    expect(gradeOf(video)).toMatchObject({ gainB: 0.3 });
  });

  it('after clear_keyframes grade null takes the grade away', async () => {
    await call('update_clip', { id: video, patch: { grade: { gainB: 0.3 } } });
    await call('set_keyframe', { id: video, prop: 'grade.gammaY', time: 0, value: 0.1 });
    await refused('update_clip', { id: video, patch: { grade: null } }, /grade\.gammaY is keyed/);
    const cleared = await call('clear_keyframes', { id: video, prop: 'grade.gammaY' });
    expect(cleared.ok, cleared.text).toBe(true);
    const r = await call('update_clip', { id: video, patch: { grade: null } });
    expect(r.ok, r.text).toBe(true);
    expect(gradeOf(video) ?? null).toBeNull();
  });

  it('a grade effect refuses a keyed number the same way', async () => {
    const fx = (await call('add_effect', { effect: 'grade', start: 0, duration: 3 })).data.id as string;
    await call('set_keyframe', { id: fx, prop: 'grade.offsetR', time: 0, value: 0.1 });
    await refused('update_clip', { id: fx, patch: { grade: { offsetR: 0.2 } } }, /grade\.offsetR is keyed on this clip/);
    await refused('update_clip', { id: fx, patch: { grade: null } }, /grade\.offsetR is keyed/);
    await oneStepOf(() => call('update_clip', { id: fx, patch: { grade: { offsetG: 0.2 } } }));
    expect(gradeOf(fx)).toMatchObject({ offsetG: 0.2 });
  });
});

describe('update_clip grade.lut', () => {
  const lutOf = (id: string) => (gradeOf(id) as { lut?: Record<string, unknown> } | undefined | null)?.lut;
  function addLut(id = 'cube1'): string {
    ed().addAsset({ id, name: `${id}.cube`, kind: 'lut', mime: '', size: 1, duration: 0, width: 0, height: 0, hasAudio: false, createdAt: 0, lut: { size3: 33, size1: 0 } });
    return id;
  }

  it('grade.lut puts a lut on', async () => {
    const cube = addLut();
    await oneStepOf(() => call('update_clip', { id: video, patch: { grade: { lut: { media: cube } } } }));
    expect(lutOf(video)).toEqual({ media: cube });
    await oneStepOf(() => call('update_clip', { id: video, patch: { grade: { lut: { media: cube, mix: 0.5, last: true, tv: true } } } }));
    expect(lutOf(video)).toEqual({ media: cube, mix: 0.5, last: true, tv: true });
    // false flags are passed and the store cleans them
    await call('update_clip', { id: video, patch: { grade: { lut: { media: cube, mix: 1, last: false, tv: false } } } });
    expect(lutOf(video)).toEqual({ media: cube });
    await refused('update_clip', { id: video, patch: { grade: { lut: { media: cube, mix: 2 } } } }, /grade\.lut\.mix must be between 0 and 1/);
    await refused('update_clip', { id: video, patch: { grade: { lut: { media: cube, size: 3 } } } }, /grade\.lut\.size is not a known field/);
    // the grade effect takes it the same way
    const fx = (await call('add_effect', { effect: 'grade', start: 0, duration: 3 })).data.id as string;
    const r = await call('update_clip', { id: fx, patch: { grade: { lut: { media: cube } } } });
    expect(r.ok, r.text).toBe(true);
    expect(lutOf(fx)).toEqual({ media: cube });
  });

  it('a partial lut lies over the current one', async () => {
    const cube = addLut();
    await call('update_clip', { id: video, patch: { grade: { lut: { media: cube, mix: 0.5, tv: true }, liftR: 0.1 } } });
    await oneStepOf(() => call('update_clip', { id: video, patch: { grade: { lut: { last: true } } } }));
    expect(lutOf(video)).toEqual({ media: cube, mix: 0.5, tv: true, last: true });
    await call('update_clip', { id: video, patch: { grade: { lut: { mix: 0.25 } } } });
    expect(lutOf(video)).toMatchObject({ media: cube, mix: 0.25, last: true });
    expect(gradeOf(video)).toMatchObject({ liftR: 0.1 });
    const other = addLut('cube2');
    await call('update_clip', { id: video, patch: { grade: { lut: { media: other } } } });
    expect(lutOf(video)).toMatchObject({ media: other, mix: 0.25, last: true });
  });

  it('media that is no lut is refused', async () => {
    await refused('update_clip', { id: video, patch: { grade: { lut: { media: 'med_none' } } } }, /no media med_none/);
    await refused('update_clip', { id: video, patch: { grade: { lut: { media: 'vid1' } } } }, /the media vid1 is video, not a lut\. import a \.cube file with import_media/);
    expect(gradeOf(video) ?? null).toBeNull();
  });

  it('media is needed without a lut', async () => {
    await refused('update_clip', { id: video, patch: { grade: { lut: { mix: 0.5 } } } }, /grade\.lut needs media: the id of a lut \(import a \.cube file with import_media\)/);
    await refused('update_clip', { id: video, patch: { grade: { lut: {} } } }, /grade\.lut needs media/);
    await refused('update_clip', { id: video, patch: { grade: { lut: { media: 5 } } } }, /grade\.lut\.media must be the id of a lut media/);
  });

  it('null takes the lut off', async () => {
    const cube = addLut();
    await call('update_clip', { id: video, patch: { grade: { lut: { media: cube }, liftG: 0.2 } } });
    await oneStepOf(() => call('update_clip', { id: video, patch: { grade: { lut: null } } }));
    expect(lutOf(video)).toBeUndefined();
    expect(gradeOf(video)).toMatchObject({ liftG: 0.2 });
    await call('update_clip', { id: video, patch: { grade: { lut: { media: cube } } } });
    await call('update_clip', { id: video, patch: { grade: null } });
    expect(gradeOf(video) ?? null).toBeNull();
  });
});
