import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioClip, CameraClip, Clip, Project, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createProject } from '../lib/factory';
import { MAX_TRACK_GAIN } from '../lib/mix';
import { beginEdit, endEdit, liveOpts } from '../features/properties/edit';
import { useEditor } from './editorStore';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = (id: string): Clip => proj().clips.find((c) => c.id === id)!;
const track = (i: number) => proj().tracks[i]!;

const video = (trackId: string): VideoClip => ({
  id: 'v', name: 'v', type: 'video', trackId, assetId: 'vid', start: 0, duration: 5, trimStart: 0, speed: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, transform: { ...DEFAULT_TRANSFORM },
});
const audio = (trackId: string): AudioClip => ({
  id: 'a', name: 'a', type: 'audio', trackId, assetId: 'snd', start: 0, duration: 5, trimStart: 0, speed: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0,
});
const camera = (trackId: string): CameraClip => ({
  id: 'c', name: 'c', type: 'camera', trackId, start: 6, duration: 5, fadeIn: 0, fadeOut: 0, x: 0, y: 0, z: 5, pan: 10, tilt: 0, roll: 0, fov: 60,
}) as CameraClip;

beforeEach(() => {
  endEdit();
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  const p = createProject('mixer');
  ed().openProject({ ...p, clips: [video(p.tracks[0]!.id), audio(p.tracks[1]!.id), camera(p.tracks[0]!.id)] });
});

describe('the mixer in the store', () => {
  it('an equal updateTrack makes no step', () => {
    const steps = ed().past.length;
    ed().updateTrack(track(1).id, { volume: 1, pan: 0 });
    ed().updateTrack(track(1).id, { name: track(1).name, muted: false });
    expect(ed().past.length).toBe(steps);
    ed().updateTrack(track(1).id, { volume: 0.5 });
    ed().updateTrack(track(1).id, { volume: 0.5 });
    expect(ed().past.length).toBe(steps + 1);
  });

  it('a fader gesture is one step', () => {
    const steps = ed().past.length;
    const id = track(1).id;
    beginEdit();
    ed().updateTrack(id, { volume: 0.8 }, liveOpts());
    ed().updateTrack(id, { volume: 0.4 }, liveOpts());
    endEdit();
    expect(track(1).volume).toBe(0.4);
    expect(ed().past.length).toBe(steps + 1);
    ed().undo();
    expect(track(1).volume).toBeUndefined();
  });

  it('volume 1 stores no field, pan 0 neither', () => {
    const id = track(1).id;
    ed().updateTrack(id, { volume: 0.5, pan: 0.5 });
    ed().updateTrack(id, { volume: 1, pan: 0 });
    expect('volume' in track(1)).toBe(false);
    expect('pan' in track(1)).toBe(false);
    ed().updateTrack(id, { volume: 99 });
    expect(track(1).volume).toBe(MAX_TRACK_GAIN);
  });

  it('resetMixer is one step and none when flat', () => {
    const steps = ed().past.length;
    ed().resetMixer();
    expect(ed().past.length).toBe(steps);
    ed().updateTrack(track(0).id, { volume: 0.5, muted: true });
    ed().updateTrack(track(1).id, { pan: -0.4 });
    ed().updateProject({ output: { volume: 0.7 } });
    const before = ed().past.length;
    ed().resetMixer();
    expect(ed().past.length).toBe(before + 1);
    expect(proj().tracks.some((t) => t.volume !== undefined || t.pan !== undefined)).toBe(false);
    expect(proj().output ?? null).toBeNull();
    expect(track(0).muted).toBe(true);
    ed().resetMixer();
    expect(ed().past.length).toBe(before + 1);
  });

  it('updateProject output: a level is one step, an equal one none, 0 db removes it', () => {
    const steps = ed().past.length;
    ed().updateProject({ output: { volume: 0.5 } });
    expect(proj().output).toEqual({ volume: 0.5 });
    expect(ed().past.length).toBe(steps + 1);
    ed().updateProject({ output: { volume: 0.5 } });
    expect(ed().past.length).toBe(steps + 1);
    ed().updateProject({ output: null });
    expect(proj().output ?? null).toBeNull();
    expect(ed().past.length).toBe(steps + 2);
    ed().updateProject({ output: { volume: 1 } });
    expect(ed().past.length).toBe(steps + 2);
  });

  it('updateClip pan on video and audio clamps, and 0 and null delete it', () => {
    for (const id of ['v', 'a']) {
      ed().updateClip(id, { pan: 0.5 });
      expect((clipOf(id) as VideoClip).pan).toBe(0.5);
      ed().updateClip(id, { pan: 7 });
      expect((clipOf(id) as VideoClip).pan).toBe(1);
      ed().updateClip(id, { pan: -7 });
      expect((clipOf(id) as VideoClip).pan).toBe(-1);
      ed().updateClip(id, { pan: 0 });
      expect('pan' in clipOf(id)).toBe(false);
      ed().updateClip(id, { pan: 0.2 });
      ed().updateClip(id, { pan: null as unknown as number });
      expect('pan' in clipOf(id)).toBe(false);
      const steps = ed().past.length;
      ed().updateClip(id, { pan: 0 });
      expect(ed().past.length).toBe(steps);
    }
  });

  it('a camera keeps its pan in degrees', () => {
    ed().updateClip('c', { pan: 45 });
    expect((clipOf('c') as CameraClip).pan).toBe(45);
    ed().updateClip('c', { pan: 0 });
    expect((clipOf('c') as CameraClip).pan).toBe(0);
    expect('pan' in clipOf('c')).toBe(true);
  });

  it('a locked track refuses a clip pan', () => {
    ed().updateTrack(track(1).id, { locked: true });
    ed().updateClip('a', { pan: 0.5 });
    expect('pan' in clipOf('a')).toBe(false);
  });
});
