import { beforeEach, describe, expect, it } from 'vitest';
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { AUTO_TARGETS, targetTrackId } from './editPlan';
import { currentTargets, resetEditTargets, setEditTarget, toggleTargetOf, useEditTargets } from './editTargets';

const ed = () => useEditor.getState();
const tracks = () => ed().project!.tracks;
const pid = () => ed().project!.id;

/** a project with video 1, audio 1 and two more tracks of each kind (video 3 is the lowest) */
function open(): void {
  ed().openProject(createProject('targets'));
  ed().addTrack('video');
  ed().addTrack('audio');
}

beforeEach(() => {
  useEditor.setState({ project: null, past: [], future: [], selection: [] });
  resetEditTargets();
});

describe('edit targets', () => {
  it('auto by default', () => {
    open();
    const t = tracks();
    expect(currentTargets(pid())).toEqual(AUTO_TARGETS);
    const videos = t.filter((x) => x.kind === 'video');
    const audios = t.filter((x) => x.kind === 'audio');
    expect(targetTrackId(t, 'video', null)).toBe(videos[videos.length - 1].id);
    expect(targetTrackId(t, 'audio', null)).toBe(audios[0].id);
    expect(currentTargets(null)).toEqual(AUTO_TARGETS);
  });

  it('targets belong to one project', () => {
    open();
    const first = pid();
    setEditTarget('picture', false);
    expect(currentTargets(first).picture).toBe(false);
    ed().openProject(createProject('other'));
    expect(currentTargets(pid())).toEqual(AUTO_TARGETS);
    setEditTarget('sound', false);
    expect(currentTargets(pid())).toEqual({ picture: null, sound: false });
    expect(currentTargets(first)).toEqual(AUTO_TARGETS);
  });

  it('no write when equal', () => {
    open();
    let writes = 0;
    const off = useEditTargets.subscribe(() => writes++);
    setEditTarget('picture', null);
    expect(writes).toBe(0);
    setEditTarget('picture', false);
    expect(writes).toBe(1);
    setEditTarget('picture', false);
    expect(writes).toBe(1);
    off();
    resetEditTargets();
    useEditor.setState({ project: null });
    setEditTarget('sound', false);
    expect(useEditTargets.getState().projectId).toBeNull();
  });

  it('toggle: lit turns off, unlit takes the track', () => {
    open();
    const videos = tracks().filter((x) => x.kind === 'video');
    const lit = videos[videos.length - 1];
    const other = videos[0];
    expect(toggleTargetOf(lit)).toBe(true);
    expect(currentTargets(pid()).picture).toBe(false);
    expect(toggleTargetOf(other)).toBe(true);
    expect(currentTargets(pid()).picture).toBe(other.id);
    expect(toggleTargetOf(other)).toBe(true);
    expect(currentTargets(pid()).picture).toBe(false);
    const audio = tracks().filter((x) => x.kind === 'audio')[1];
    expect(toggleTargetOf(audio)).toBe(true);
    expect(currentTargets(pid())).toEqual({ picture: false, sound: audio.id });
  });

  it('a locked track cannot be taken', () => {
    open();
    const videos = tracks().filter((x) => x.kind === 'video');
    ed().updateTrack(videos[0].id, { locked: true });
    const locked = tracks().find((x) => x.id === videos[0].id)!;
    expect(toggleTargetOf(locked)).toBe(false);
    expect(currentTargets(pid())).toEqual(AUTO_TARGETS);
  });

  it('a lit target on a locked track turns off', () => {
    open();
    const videos = tracks().filter((x) => x.kind === 'video');
    const first = videos[0];
    expect(toggleTargetOf(first)).toBe(true);
    expect(currentTargets(pid()).picture).toBe(first.id);
    ed().updateTrack(first.id, { locked: true });
    const locked = tracks().find((x) => x.id === first.id)!;
    expect(toggleTargetOf(locked)).toBe(true);
    expect(currentTargets(pid()).picture).toBe(false);
  });
});
