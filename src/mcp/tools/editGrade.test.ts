import { beforeEach, describe, expect, it } from 'vitest';
import { addVideoClip, call, clipOf, fresh, oneStepOf, refused } from './editKit';

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
