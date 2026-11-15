import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, Project, SceneLight, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createProject } from '../lib/factory';
import { resolveClip } from '../lib/anim';
import { useEditor } from './editorStore';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = (id: string): VideoClip => proj().clips.find((c) => c.id === id) as VideoClip;

const LIGHT: SceneLight = { sky: '#334455', horizon: '#556677', ground: '#111111', sun: 0.4, sunColor: '#fff4e0', sunTurn: -35, sunHeight: 45 };

const video = (trackId: string, id: string): Clip => ({
  id,
  type: 'video',
  trackId,
  start: 0,
  duration: 5,
  name: id,
  fadeIn: 0,
  fadeOut: 0,
  assetId: 'long',
  trimStart: 0,
  speed: 1,
  volume: 1,
  muted: false,
  threeD: true,
  transform: { ...DEFAULT_TRANSFORM },
});

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  const p = createProject('lit');
  ed().openProject({ ...p, clips: [video(p.tracks[0]!.id, 'a')] });
});

describe('light in the store', () => {
  it('sets the light as one undo step and undo brings back no light', () => {
    const steps = ed().past.length;
    ed().updateProject({ light: LIGHT });
    expect(proj().light).toEqual(LIGHT);
    expect(ed().past.length).toBe(steps + 1);
    ed().undo();
    expect(proj().light ?? null).toBeNull();
  });

  it('null on a project without light changes nothing', () => {
    const steps = ed().past.length;
    ed().updateProject({ light: null });
    expect(ed().past.length).toBe(steps);
  });

  it('null on a light removes it as one step', () => {
    ed().updateProject({ light: LIGHT });
    const steps = ed().past.length;
    ed().updateProject({ light: null });
    expect(proj().light).toBeNull();
    expect(ed().past.length).toBe(steps + 1);
  });

  it('stores lit on a video clip', () => {
    ed().updateClip('a', { lit: 0.5 });
    expect(clipOf('a').lit).toBe(0.5);
  });

  it('sets lit with setClipValue on a clip that has none', () => {
    expect(clipOf('a').lit).toBeUndefined();
    ed().setClipValue('a', 'lit', 1, 0.3);
    expect(clipOf('a').lit).toBeCloseTo(0.3, 6);
  });

  it('a keyed lit resolves between two keys', () => {
    ed().setKeyframe('a', 'lit', 0, 0);
    ed().setKeyframe('a', 'lit', 2, 1);
    const mid = resolveClip(clipOf('a'), 1).lit!;
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.8);
    expect(resolveClip(clipOf('a'), 0).lit).toBeCloseTo(0, 6);
    expect(resolveClip(clipOf('a'), 2).lit).toBeCloseTo(1, 6);
  });
});
