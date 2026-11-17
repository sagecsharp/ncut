import { beforeEach, describe, expect, it } from 'vitest';
import type { ClipGrade, MediaAsset, Project } from '../../types';
import { createProject, createShapeClip, createTextClip, createTrack } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { copyLook, pasteLook } from './lookClipboard';
import type { VisualClip } from '../../types';

const ed = () => useEditor.getState();
const lutMedia = (id: string): MediaAsset => ({ id, name: `${id}.cube`, kind: 'lut', mime: 'text/plain', size: 1, duration: 0, width: 0, height: 0, hasAudio: false, createdAt: 0, lut: { size3: 17, size1: 0 } });
const gradeOf = (id: string): ClipGrade | undefined => (ed().project?.clips.find((c) => c.id === id) as { grade?: ClipGrade } | undefined)?.grade;

// a carries a lut of film and wheels, b and c are plain
function setup(assets: MediaAsset[]): void {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  const p = createProject('look clipboard');
  const t1 = { ...createTrack('video', 'one'), id: 't1' };
  const q: Project = {
    ...p,
    assets,
    tracks: [t1],
    clips: [
      createTextClip('t1', 0, { id: 'a', text: 'a', duration: 5, grade: { liftY: 0.2, lut: { media: 'film', mix: 0.5 } } }),
      createShapeClip('t1', 6, { id: 'b', duration: 5 }),
      createShapeClip('t1', 12, { id: 'c', duration: 5 }),
    ],
  };
  ed().openProject(q);
}

beforeEach(() => setup([lutMedia('film')]));

describe('paste look', () => {
  it('paste look drops a lut of another project', () => {
    copyLook(ed().project!.clips.find((c) => c.id === 'a') as VisualClip);
    // this project has the lut: it goes along with the look
    expect(pasteLook(['b'])).toBe(1);
    expect(gradeOf('b')).toEqual({ liftY: 0.2, lut: { media: 'film', mix: 0.5 } });
    // another project: no media of that id (or no lut media of it), the wheels stay and the lut goes
    setup([]);
    expect(pasteLook(['b'])).toBe(1);
    expect(gradeOf('b')).toEqual({ liftY: 0.2 });
    setup([{ ...lutMedia('film'), kind: 'image' }]);
    expect(pasteLook(['c'])).toBe(1);
    expect(gradeOf('c')).toEqual({ liftY: 0.2 });
    // the copy itself is not touched
    setup([lutMedia('film')]);
    expect(pasteLook(['c'])).toBe(1);
    expect(gradeOf('c')!.lut).toEqual({ media: 'film', mix: 0.5 });
  });
});
