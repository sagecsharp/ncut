import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clip, ImageClip, MediaAsset, Project } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createEffectClip, createProject, createTrack } from '../lib/factory';
import { runRangeEdit } from '../features/timeline/rangeActions';
import { runEdit } from '../features/timeline/editActions';
import { AUTO_TARGETS } from '../features/timeline/editPlan';
import { resetEditTargets } from '../features/timeline/editTargets';
import { useEditor } from './editorStore';
import { usePlayback } from './playback';
import { useSource } from './source';
import { useUi } from './ui';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const onTrack = (id: string): Clip[] => proj().clips.filter((c) => c.trackId === id).sort((a, b) => a.start - b.start);

const image = (trackId: string, id: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const asset = (id: string, kind: MediaAsset['kind'], duration: number): MediaAsset => ({
  id, name: id, kind, mime: kind + '/x', size: 1, duration, width: 100, height: 100, hasAudio: kind === 'video', createdAt: 0,
});

/** v1 holds A, v0 (sync lock off) holds C with parent A */
function open(range: Project['range'] | null, more: Clip[] = [], base: Clip[] = [image('v1', 'A', 0, 10), image('v0', 'C', 0, 10, { parent: 'A' })]): void {
  const p = createProject('split open');
  const tracks = [
    { ...createTrack('video', 'v0'), id: 'v0', syncLock: false },
    { ...createTrack('video', 'v1'), id: 'v1' },
  ];
  const clips: Clip[] = [...base, ...more];
  const next: Project = { ...p, tracks, clips, assets: [asset('img1', 'image', 0), asset('vid', 'video', 10)] };
  if (range) next.range = range;
  ed().openProject(next);
  useEditor.setState({ selection: [], past: [], future: [], clipboard: [] });
  usePlayback.setState({ time: 0, playing: false });
  useSource.setState({ assetId: 'vid', time: 0, playing: false });
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  useUi.setState({ toasts: [], previewMode: 'output' });
  resetEditTargets();
});

describe('splitClips open', () => {
  it('extract leaves a sync lock off track whole', () => {
    open({ in: 2, out: 4 });
    const r = runRangeEdit('extract');
    expect(r.ok).toBe(true);
    expect(r.syncOffTracks).toBe(1);
    const c = onTrack('v0');
    expect(c).toHaveLength(1);
    expect(c[0]!.start).toBe(0);
    expect(c[0]!.duration).toBe(10);
    // the parent link still points at a clip that exists
    const parent = (c[0] as ImageClip).parent;
    expect(proj().clips.some((x) => x.id === parent)).toBe(true);
    expect(parent).toBe(onTrack('v1').find((x) => Math.abs(x.start - 2) < 1e-6)!.id);
    expect(ed().past).toHaveLength(1);
    ed().undo();
    expect(proj().clips).toHaveLength(2);
  });
  it('an insert does not cut a sync lock off track', () => {
    open(null);
    const r = runEdit({ mode: 'insert', assetId: 'vid', playhead: 3, targets: { ...AUTO_TARGETS, picture: 'v1' } as never, apart: false, selection: [] });
    expect(r.ok).toBe(true);
    const c = onTrack('v0');
    expect(c).toHaveLength(1);
    expect(c[0]!.start).toBe(0);
    expect(c[0]!.duration).toBe(10);
    expect(onTrack('v1').length).toBeGreaterThan(2);
    expect(r.syncOffTracks).toEqual(['v0']);
    expect(ed().past).toHaveLength(1);
  });
  it('a split without open cuts as before', () => {
    open(null);
    const made = ed().splitClips(3, ['A']);
    expect(made.length).toBeGreaterThan(0);
    expect(onTrack('v0')).toHaveLength(2);
    expect(onTrack('v1')).toHaveLength(2);
  });
  it('a split with open leaves the other tracks alone', () => {
    open(null);
    ed().splitClips(3, ['A'], { open: new Set(['v1']) });
    expect(onTrack('v0')).toHaveLength(1);
    expect(onTrack('v1')).toHaveLength(2);
  });
});

describe('splitClips open, what hangs on a cut clip', () => {
  const E = (): Clip => createEffectClip('blur', 'E', 'v0', 0, { id: 'E', duration: 10, target: 'A' });
  it('an effect on a sync lock off track goes with its target across an insert', () => {
    open(null, [E()], [image('v1', 'A', 0, 10)]);
    runEdit({ mode: 'insert', assetId: 'vid', playhead: 3, targets: { ...AUTO_TARGETS, picture: 'v1' } as never, apart: false, selection: [] });
    const e = onTrack('v0');
    expect(e).toHaveLength(2);
    for (const x of e) {
      const t = proj().clips.find((c) => c.id === (x as { target?: string }).target)!;
      expect(t.start <= x.start + 1e-6 && t.start + t.duration >= x.start + x.duration - 1e-6).toBe(true);
    }
  });
  it('an effect on a sync lock off track goes with its target across an extract', () => {
    open({ in: 2, out: 4 }, [E()], [image('v1', 'A', 0, 10)]);
    runRangeEdit('extract');
    const e = onTrack('v0');
    expect(e).toHaveLength(2);
    for (const x of e) {
      const t = proj().clips.find((c) => c.id === (x as { target?: string }).target)!;
      expect(t.start <= x.start + 1e-6 && t.start + t.duration >= x.start + x.duration - 1e-6).toBe(true);
    }
  });
  it('a matte source on a moving track is cut while its user on a sync lock off track stays', () => {
    const m = image('v1', 'M', 0, 10);
    const u = image('v0', 'U', 0, 10, { matte: { clip: 'M', mode: 'alpha' } });
    open(null, [], [m, u]);
    const r = runEdit({ mode: 'insert', assetId: 'vid', playhead: 3, targets: { ...AUTO_TARGETS, picture: 'v1' } as never, apart: false, selection: [] });
    expect(r.ok).toBe(true);
    expect(onTrack('v0')).toHaveLength(1);
    expect(onTrack('v1').length).toBeGreaterThan(2);
  });
});
