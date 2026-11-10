import { describe, expect, it, vi } from 'vitest';
import type { Clip, Project, VisualClip } from '../../types';

vi.mock('../../engine/parent', () => ({
  // a stand-in parent: offsets by (100, 50), doubles the scale, and a parent scaled by 2 halves a world delta
  worldTransform: (_p: unknown, clip: VisualClip) => ({ ...clip.transform, x: clip.transform.x * 2 + 100, y: clip.transform.y * 2 + 50, scale: clip.transform.scale * 2 }),
  worldDeltaToLocal: (_p: unknown, _c: unknown, _t: number, dx: number, dy: number) => ({ x: dx / 2, y: dy / 2 }),
}));

const { isAttached, localDelta, withoutRidingChildren, worldClip } = await import('./attached');
const { sceneCenter } = await import('./overlayMath');

const img = (id: string, over: Partial<VisualClip> = {}): VisualClip =>
  ({
    id,
    type: 'image',
    trackId: 't',
    start: 0,
    duration: 10,
    name: id,
    fadeIn: 0,
    fadeOut: 0,
    assetId: 'a',
    transform: { x: 10, y: 20, scale: 1, rotation: 0, opacity: 1 },
    ...over,
  }) as VisualClip;

const project = (clips: Clip[]): Project =>
  ({ width: 1000, height: 500, tracks: [{ id: 't', kind: 'video', name: 'v', locked: false, hidden: false }], clips, assets: [] }) as unknown as Project;

describe('attached clips', () => {
  const p = img('p');
  const c = img('c', { parent: 'p' });
  const proj = project([p, c]);

  it('knows an attached clip', () => {
    expect(isAttached(c)).toBe(true);
    expect(isAttached(p)).toBe(false);
  });
  it('a clip without a parent is measured as it is', () => {
    expect(worldClip(proj, p, 1)).toBe(p);
  });
  it('an attached clip is measured at its world pose', () => {
    const w = worldClip(proj, c, 1);
    expect(w.transform.x).toBe(120);
    expect(w.transform.y).toBe(90);
    expect(w.transform.scale).toBe(2);
    // the real clip is untouched
    expect(c.transform.x).toBe(10);
  });
  it('turns a world drag into the own delta only when attached', () => {
    expect(localDelta(proj, p, 1, 8, 4)).toEqual({ x: 8, y: 4 });
    expect(localDelta(proj, c, 1, 8, 4)).toEqual({ x: 4, y: 2 });
  });
  it('a child that rides along with its dragged parent is not written', () => {
    const g = img('g', { parent: 'c' });
    const all = project([p, c, g]);
    expect(withoutRidingChildren(all, [p, c, g]).map((x) => x.id)).toEqual(['p']);
    expect(withoutRidingChildren(all, [c, g]).map((x) => x.id)).toEqual(['c']);
    expect(withoutRidingChildren(all, [g, p]).map((x) => x.id)).toEqual(['p']);
    expect(withoutRidingChildren(all, [g]).map((x) => x.id)).toEqual(['g']);
  });
});

describe('sceneCenter', () => {
  it('puts a picture at its world pose on the canvas', () => {
    const c = img('c', { parent: 'p' });
    const proj = project([img('p'), c]);
    expect(sceneCenter(proj, c, 1)).toEqual([500 + 120, 250 + 90, 0]);
  });
  it('has no place for an effect', () => {
    const e = { id: 'e', type: 'effect' } as unknown as Clip;
    expect(sceneCenter(project([e]), e, 0)).toBeNull();
  });
});
