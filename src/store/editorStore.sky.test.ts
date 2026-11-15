import { beforeEach, describe, expect, it } from 'vitest';
import type { MediaAsset, Project, SceneSky } from '../types';
import { createProject } from '../lib/factory';
import { skyUsable } from '../engine/scene3d/sky';
import { useEditor } from './editorStore';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;

const img = (id: string, name: string, w: number, h: number): MediaAsset => ({ id, name, kind: 'image', mime: 'image/png', size: 1, duration: 0, width: w, height: h, hasAudio: false, createdAt: 0 });
const SKY: SceneSky = {
  asset: 'a1',
  turn: 0,
  brightness: 1,
  blur: 0,
  light: { sky: '#8090a0', horizon: '#808080', ground: '#404040', sun: 0, sunColor: '#fff4e0', sunTurn: -35, sunHeight: 45 },
};

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  const p = createProject('sky');
  ed().openProject({ ...p, assets: [img('a1', 'sky', 1024, 768), img('a2', 'other', 640, 480)], sky: SKY });
});

describe('sky in the store', () => {
  it('updateProject sets and clears the sky in one undo step each', () => {
    const steps = ed().past.length;
    ed().updateProject({ sky: null });
    expect(proj().sky).toBeNull();
    expect(ed().past.length).toBe(steps + 1);
    ed().updateProject({ sky: SKY });
    expect(proj().sky).toEqual(SKY);
    expect(ed().past.length).toBe(steps + 2);
    ed().undo();
    expect(proj().sky).toBeNull();
    const before = ed().past.length;
    ed().updateProject({ sky: null });
    expect(ed().past.length).toBe(before);
  });

  it('removing a sky picture takes the sky off and keeps the undo history', () => {
    ed().updateProject({ name: 'one' });
    ed().updateProject({ name: 'two' });
    const steps = ed().past.length;
    expect(steps).toBeGreaterThan(0);
    ed().removeAsset('a1');
    expect(proj().sky).toBeNull();
    expect(proj().assets.map((a) => a.id)).toEqual(['a2']);
    expect(ed().past.length).toBe(steps);
  });

  it('an undo after that brings the sky back without its picture, so it is not usable', () => {
    ed().updateProject({ name: 'one' });
    ed().removeAsset('a1');
    ed().undo();
    expect(proj().sky).toEqual(SKY);
    expect(proj().assets.map((a) => a.id)).toEqual(['a2']);
    expect(skyUsable(proj())).toBe(false);
  });

  it('removing other media leaves the sky', () => {
    ed().removeAsset('a2');
    expect(proj().sky).toEqual(SKY);
    expect(skyUsable(proj())).toBe(true);
  });
});
