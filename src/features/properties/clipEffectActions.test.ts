import { describe, expect, it } from 'vitest';
import type { AudioClip, Clip, EffectClip, ImageClip, MediaAsset, Project } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { addEffectToClips } from './clipEffectActions';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const effects = (): EffectClip[] => proj().clips.filter((c): c is EffectClip => c.type === 'effect');

const asset = (id: string, kind: 'image' | 'audio' = 'image'): MediaAsset => ({
  id, name: id, kind, mime: kind + '/x', size: 1, duration: kind === 'image' ? 0 : 60, width: 100, height: 100, hasAudio: kind !== 'image', createdAt: 0,
});
const image = (trackId: string, id: string, start: number, duration: number): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM },
});
const audio = (trackId: string, id: string, start: number, duration: number): AudioClip => ({
  id, type: 'audio', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'aud1', trimStart: 0, speed: 1, volume: 1, muted: false,
});

/** two video tracks (t[0] on top) and an audio track */
function open(make: (t: string[]) => Clip[]): void {
  const p = createProject('fx');
  ed().openProject({ ...p, assets: [asset('img1'), asset('aud1', 'audio')], clips: [] });
  ed().addTrack('video');
  const ids = proj().tracks.map((t) => t.id);
  useEditor.setState({ project: { ...proj(), clips: make(ids) }, past: [], future: [] });
}

describe('addEffectToClips', () => {
  it('puts one effect clip on each selected picture clip, in one undo step', () => {
    open((t) => [image(t[0]!, 'a', 0, 4), image(t[1]!, 'b', 2, 3), audio(t[2]!, 's', 0, 5)]);
    useEditor.setState({ selection: ['a', 'b', 's'] });
    const before = proj();
    expect(addEffectToClips(['a', 'b', 's'], 'blur')).toBe(2);
    const made = effects();
    expect(made.map((e) => e.target).sort()).toEqual(['a', 'b']);
    // each covers its clip's time
    const onB = made.find((e) => e.target === 'b')!;
    expect([onB.start, onB.duration]).toEqual([2, 3]);
    // every effect sits above its clip
    const order = proj().tracks.map((x) => x.id);
    for (const e of made) {
      const target = proj().clips.find((c) => c.id === e.target)!;
      expect(order.indexOf(e.trackId)).toBeLessThan(order.indexOf(target.trackId));
    }
    // the clips stay selected
    expect(ed().selection).toEqual(['a', 'b', 's']);
    ed().undo();
    expect(effects()).toHaveLength(0);
    expect(proj().clips).toEqual(before.clips);
  });

  it('a single clip works as before and nothing happens without a picture clip', () => {
    open((t) => [image(t[0]!, 'a', 0, 4), audio(t[2]!, 's', 0, 5)]);
    useEditor.setState({ selection: ['a'] });
    expect(addEffectToClips(['a'], 'blur')).toBe(1);
    expect(effects()[0]!.target).toBe('a');
    expect(ed().selection).toEqual(['a']);
    expect(addEffectToClips(['s'], 'blur')).toBe(0);
    expect(addEffectToClips(['a'], 'no-such-effect')).toBe(0);
    expect(effects()).toHaveLength(1);
  });
});
