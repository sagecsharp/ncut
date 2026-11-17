import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, Project, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { beginEdit, cancelEdit, endEdit, liveOpts } from './edit';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = (id: string): Clip => proj().clips.find((c) => c.id === id)!;

const ASSET = { id: 'vid10', name: 'vid10', kind: 'video' as const, mime: 'video/mp4', size: 1, duration: 10, width: 1920, height: 1080, hasAudio: true, createdAt: 0 };

let id = '';

beforeEach(() => {
  endEdit();
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  const p = createProject('edit', undefined, 30);
  const clip: VideoClip = {
    id: 'c1',
    type: 'video',
    trackId: p.tracks[0]!.id,
    start: 0,
    duration: 5,
    name: 'first',
    fadeIn: 0,
    fadeOut: 0,
    assetId: 'vid10',
    trimStart: 0,
    speed: 1,
    volume: 1,
    muted: false,
    transform: { ...DEFAULT_TRANSFORM },
  };
  ed().openProject({ ...p, assets: [ASSET], clips: [clip] });
  id = clip.id;
  // one normal step, so there is a step before the gesture
  ed().updateClip(id, { name: 'before' });
});

describe('edit gestures', () => {
  it('cancelEdit after a gesture that wrote nothing keeps the step before it', () => {
    expect(ed().past.length).toBe(1);
    beginEdit();
    cancelEdit();
    expect(ed().past.length).toBe(1);
    expect(clipOf(id).name).toBe('before');
    // a step that liveOpts opened but that got no change is not a step either
    beginEdit();
    liveOpts();
    cancelEdit();
    expect(ed().past.length).toBe(1);
    expect(clipOf(id).name).toBe('before');
  });

  it('cancelEdit after a live write puts the project back and past as it was before the gesture', () => {
    const pastBefore = ed().past;
    const projectBefore = proj();
    beginEdit();
    ed().updateClip(id, { name: 'one' }, liveOpts());
    ed().updateClip(id, { name: 'two' }, liveOpts());
    expect(clipOf(id).name).toBe('two');
    expect(ed().past.length).toBe(2);
    cancelEdit();
    expect(clipOf(id).name).toBe('before');
    expect(ed().past.length).toBe(pastBefore.length);
    expect(proj().clips).toEqual(projectBefore.clips);
  });

  it('endEdit forgets the gesture so a later cancelEdit does nothing', () => {
    beginEdit();
    ed().updateClip(id, { name: 'one' }, liveOpts());
    endEdit();
    cancelEdit();
    expect(clipOf(id).name).toBe('one');
    expect(ed().past.length).toBe(2);
  });

  it('liveOpts without beginEdit opens no step', () => {
    const o = liveOpts();
    expect(o).toEqual({ skipHistory: true });
    ed().updateClip(id, { name: 'free' }, o);
    expect(clipOf(id).name).toBe('free');
    // a skipHistory write with no step open adds no past entry
    expect(ed().past.length).toBe(1);
    cancelEdit();
    expect(clipOf(id).name).toBe('free');
  });
});
