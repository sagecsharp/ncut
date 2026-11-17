import { beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '../../types';
import { MATTE_TEXT } from '../../engine/matte';
import { createProject, createShapeClip, createTextClip, createTrack } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { splitText } from './textSplitActions';

const ed = () => useEditor.getState();
const json = () => JSON.stringify(ed().project);

// text t on one track is the matte of shape r on another
function setup(): void {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  usePlayback.setState({ time: 1 });
  useUi.setState({ toasts: [] });
  const p = createProject('split matte');
  const t1 = { ...createTrack('video', 'one'), id: 't1' };
  const t2 = { ...createTrack('video', 'two'), id: 't2' };
  const q: Project = {
    ...p,
    tracks: [t1, t2],
    clips: [
      createTextClip('t1', 0, { id: 't', text: 'two words', duration: 5 }),
      createShapeClip('t2', 0, { id: 'r', duration: 5, matte: { clip: 't', mode: 'alpha' } }),
    ],
  };
  ed().openProject(q);
}

beforeEach(setup);

describe('text split with a matte', () => {
  it('splitText refuses a matte text and changes nothing', () => {
    expect(ed().project!.clips.find((c) => c.id === 'r')!).toHaveProperty('matte');
    const before = json();
    const past = ed().past.length;
    expect(splitText('t', 'words')).toBe(0);
    expect(json()).toBe(before);
    expect(ed().past.length).toBe(past);
    expect(useUi.getState().toasts.at(-1)?.message).toBe(MATTE_TEXT.splitMatte);
  });
});
