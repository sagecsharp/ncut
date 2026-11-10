import { describe, expect, it } from 'vitest';
import type { Clip, Track } from '../../types';
import { effectDropTarget, effectOnLabel, effectsOn, hoverLinkedIds, linkedIds, pickEffectTrack, targetNameById } from './effectTarget';

const track = (id: string, name = id, locked = false, kind = 'video') => ({ id, name, kind, locked }) as unknown as Track;
const vid = (id: string, trackId: string, start: number, duration: number, name = id) =>
  ({ id, type: 'video', trackId, start, duration, name }) as unknown as Clip;
const fx = (id: string, trackId: string, start: number, duration: number, target: string | null) =>
  ({ id, type: 'effect', trackId, start, duration, name: 'blur', target }) as unknown as Clip;
const text = (id: string, trackId: string, text: string) => ({ id, type: 'text', trackId, start: 0, duration: 1, text }) as unknown as Clip;

describe('effect labels', () => {
  it('names the target or says it is missing', () => {
    const clips = [vid('a', 'v', 0, 1, 'beach'), text('t', 'v', 'hello\n  world')];
    expect(effectOnLabel('blur', targetNameById(clips, 'a'))).toBe('blur on beach');
    expect(effectOnLabel('blur', targetNameById(clips, 't'))).toBe('blur on hello world');
    expect(effectOnLabel('blur', targetNameById(clips, 'nope'))).toBe('blur on a missing clip');
  });
});

describe('link marks', () => {
  const clips = [vid('a', 'v', 0, 2), vid('b', 'v', 3, 2), fx('e1', 'fx', 0, 2, 'a'), fx('e2', 'fx', 3, 2, null), fx('e3', 'fx', 6, 1, 'gone')];
  it('lists the effects on a clip', () => {
    expect(effectsOn(clips, 'a').map((c) => c.id)).toEqual(['e1']);
    expect(effectsOn(clips, 'b')).toEqual([]);
  });
  it('a selected effect marks its target', () => {
    expect([...linkedIds(clips, ['e1'])]).toEqual(['a']);
  });
  it('a selected clip marks the effects on it', () => {
    expect([...linkedIds(clips, ['a'])]).toEqual(['e1']);
  });
  it('marks nothing for plain effects, unknown targets or an empty selection', () => {
    expect(linkedIds(clips, ['e2', 'e3', 'b']).size).toBe(0);
    expect(linkedIds(clips, []).size).toBe(0);
    expect(linkedIds([vid('a', 'v', 0, 1)], ['a']).size).toBe(0);
  });
  it('hover marks the target of an effect only', () => {
    expect([...hoverLinkedIds(clips, 'e1')]).toEqual(['a']);
    expect(hoverLinkedIds(clips, 'a').size).toBe(0);
    expect(hoverLinkedIds(clips, 'e3').size).toBe(0);
    expect(hoverLinkedIds(clips, null).size).toBe(0);
  });
});

describe('alt drop of an effect on a clip', () => {
  const tracks = [track('fx'), track('v'), track('lock', 'lock', true), track('au', 'au', false, 'audio')];
  const clips = [vid('a', 'v', 2, 4), vid('l', 'lock', 0, 5), fx('e', 'fx', 0, 1, null)];
  const project = { clips, tracks };
  it('finds the visual clip under the pointer', () => {
    expect(effectDropTarget(project, 'v', 3)?.id).toBe('a');
    expect(effectDropTarget(project, 'v', 6)).toBeNull();
    expect(effectDropTarget(project, 'v', 1.9)).toBeNull();
  });
  it('ignores locked tracks, effect clips and unknown lanes', () => {
    expect(effectDropTarget(project, 'lock', 1)).toBeNull();
    expect(effectDropTarget(project, 'fx', 0.5)).toBeNull();
    expect(effectDropTarget(project, undefined, 0)).toBeNull();
    expect(effectDropTarget(project, 'zzz', 0)).toBeNull();
  });
  it('reuses an effects track above with room, else asks for a new one', () => {
    expect(pickEffectTrack(project, 'v', 2, 4)).toBe('fx');
    expect(pickEffectTrack({ clips: [...clips, fx('e2', 'fx', 3, 1, null)], tracks }, 'v', 2, 4)).toBeNull();
    expect(pickEffectTrack({ clips: [vid('x', 'fx', 0, 1), vid('a', 'v', 2, 4)], tracks }, 'v', 2, 4)).toBeNull();
  });
  it('uses an empty track only when it is named effects', () => {
    const t = [track('top', 'effects'), track('v')];
    expect(pickEffectTrack({ clips: [], tracks: t }, 'v', 0, 1)).toBe('top');
    expect(pickEffectTrack({ clips: [], tracks: [track('top', 'video 2'), track('v')] }, 'v', 0, 1)).toBeNull();
  });
});
