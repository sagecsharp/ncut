import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, ClipGrade, EffectClip, Project, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createEffectClip, createProject } from '../lib/factory';
import { useEditor } from './editorStore';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = (id: string): Clip => proj().clips.find((c) => c.id === id)!;
const gradeOf = (id: string): ClipGrade | null | undefined => (clipOf(id) as VideoClip).grade;

function mkVideo(id: string, trackId: string, over: Partial<VideoClip> = {}): VideoClip {
  return { id, type: 'video', trackId, start: 0, duration: 10, name: id, fadeIn: 0, fadeOut: 0, assetId: 'a', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over };
}

let v = '';
beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  const p = createProject('grade');
  v = p.tracks[0]!.id;
  ed().openProject({ ...p, clips: [mkVideo('c1', v)] });
});

describe('the grade field', () => {
  it('a cleaned grade lands', () => {
    ed().updateClip('c1', { grade: { liftR: 2, gainY: 0.123456, gammaB: Number.NaN, junk: 1 } as ClipGrade });
    expect(gradeOf('c1')).toEqual({ liftR: 1, gainY: 0.1235 });
    expect(ed().past).toHaveLength(1);
    ed().undo();
    expect('grade' in clipOf('c1')).toBe(false);
  });

  it('an equal grade is no undo step', () => {
    ed().updateClip('c1', { grade: { liftR: 0.3, curves: { y: [[0.5, 0.6]] } } });
    const p = proj();
    expect(ed().past).toHaveLength(1);
    // the same grade, written another way
    ed().updateClip('c1', { grade: { curves: { y: [[0.5, 0.6]] }, liftR: 0.30001, liftG: 0 } });
    expect(proj()).toBe(p);
    expect(ed().past).toHaveLength(1);
    // nothing on a clip that has none
    ed().updateClip('c1', { grade: null });
    ed().updateClip('c1', { grade: { liftR: 0 } });
    expect(ed().past).toHaveLength(2);
  });

  it('a grade that cleans to nothing is no field, keys stay', () => {
    ed().updateClip('c1', { grade: { liftR: 0.3 } });
    ed().setKeyframe('c1', 'grade.gainY', 2, 0.2);
    ed().setKeyframe('c1', 'grade.gainY', 4, 0.4);
    expect(clipOf('c1').keyframes?.['grade.gainY']).toHaveLength(2);
    ed().updateClip('c1', { grade: { liftR: 0, offsetB: 0.00001 } });
    expect('grade' in clipOf('c1')).toBe(false);
    expect(clipOf('c1').keyframes?.['grade.gainY']).toHaveLength(2);
    // a grade that cleans to nothing on a clip without one changes nothing
    const p = proj();
    ed().updateClip('c1', { grade: {} });
    expect(proj()).toBe(p);
  });

  it('null drops the field and the grade keys', () => {
    ed().updateClip('c1', { grade: { liftR: 0.3 } });
    ed().setKeyframe('c1', 'grade.gainY', 2, 0.2);
    ed().setKeyframe('c1', 'opacity', 1, 0.5);
    expect(ed().past).toHaveLength(3);
    ed().updateClip('c1', { grade: null });
    expect('grade' in clipOf('c1')).toBe(false);
    const kf = clipOf('c1').keyframes!;
    expect('grade.gainY' in kf).toBe(false);
    expect(kf['opacity']).toHaveLength(1);
    expect(ed().past).toHaveLength(4);
    // only the keys: still one step, and the other keys stay
    ed().updateClip('c1', { grade: { gainG: 0.2 } });
    ed().setKeyframe('c1', 'grade.liftB', 3, 0.1);
    ed().updateClip('c1', { grade: null });
    expect(clipOf('c1').keyframes!['opacity']).toHaveLength(1);
    // the last key group gone: no keyframes field
    ed().setClipKeyframes('c1', { 'grade.liftB': [{ t: 1, v: 0.1, ease: 'linear' }] });
    ed().updateClip('c1', { grade: null });
    expect('keyframes' in clipOf('c1')).toBe(false);
  });

  it('a locked track refuses', () => {
    ed().updateClip('c1', { grade: { liftR: 0.3 } });
    ed().updateTrack(v, { locked: true });
    const p = proj();
    ed().updateClip('c1', { grade: { liftR: 0.9 } });
    ed().updateClip('c1', { grade: null });
    expect(proj()).toBe(p);
    expect(gradeOf('c1')).toEqual({ liftR: 0.3 });
  });

  it("setClipValue 'grade.liftR' clamps", () => {
    ed().setClipValue('c1', 'grade.liftR', 1, 5);
    expect(gradeOf('c1')).toEqual({ liftR: 1 });
    ed().setClipValue('c1', 'grade.liftR', 1, -3);
    expect(gradeOf('c1')).toEqual({ liftR: -1 });
    ed().setClipValue('c1', 'grade.gammaY', 1, 0.25);
    expect(gradeOf('c1')).toEqual({ liftR: -1, gammaY: 0.25 });
  });

  it('an effect clip takes a grade', () => {
    // build the grade effect clip by hand
    const fx = createEffectClip('grade', 'grade', v, 12, { duration: 3 });
    ed().openProject({ ...proj(), clips: [...proj().clips, fx] });
    ed().updateClip(fx.id, { grade: { gainR: 0.2, liftY: -2 } });
    expect((clipOf(fx.id) as EffectClip).grade).toEqual({ gainR: 0.2, liftY: -1 });
    ed().updateClip(fx.id, { grade: null });
    expect('grade' in clipOf(fx.id)).toBe(false);
  });
});
