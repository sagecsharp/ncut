import { describe, expect, it } from 'vitest';
import type { Clip, ImageClip, MediaAsset, Project, Track, VideoClip, TextClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { modeLabel, trimPress } from './trimPress';
import type { PressMods, PressZone } from './trimPress';

const track = (id: string, locked = false): Track => ({ id, kind: 'video', name: id, muted: false, hidden: false, locked });
const asset = (id: string): MediaAsset => ({ id, name: id, kind: 'video', mime: 'video/x', size: 1, duration: 100, width: 100, height: 100, hasAudio: true, createdAt: 0 });
const video = (trackId: string, id: string, start: number, duration: number): VideoClip => ({
  id, type: 'video', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'long', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM },
});
const image = (trackId: string, id: string, start: number, duration: number): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'pic', transform: { ...DEFAULT_TRANSFORM },
});
const text = (trackId: string, id: string, start: number, duration: number): TextClip => ({
  ...(video(trackId, id, start, duration) as unknown as TextClip), type: 'text', text: id,
});
function proj(clips: Clip[], locked: string[] = []): Project {
  return { ...createProject('press'), tracks: ['v1', 'v2'].map((t) => track(t, locked.includes(t))), assets: [asset('long')], clips };
}
const NONE: PressMods = { ctrl: false, shift: false, alt: false };
const mods = (o: Partial<PressMods>): PressMods => ({ ...NONE, ...o });

// a and b touch, c has a gap before it, i is an image, t a text
const P = proj([video('v1', 'a', 0, 4), video('v1', 'b', 4, 4), video('v1', 'c', 10, 4), image('v2', 'i', 0, 4), text('v2', 't', 6, 3)]);

const press = (id: string, zone: PressZone, m: Partial<PressMods> = {}, trimMode = true, p: Project = P) => trimPress(p, id, zone, mods(m), trimMode);

describe('trimPress', () => {
  it('outside trim mode only ctrl on an edge answers', () => {
    expect(press('a', 'end', {}, false)).toBeNull();
    expect(press('a', 'body', { ctrl: true }, false)).toBeNull();
    expect(press('a', 'band', { ctrl: true }, false)).toBeNull();
    expect(press('a', 'end', { alt: true }, false)).toBeNull();
    const r = press('c', 'start', { ctrl: true }, false)!;
    expect(r.mode).toBe('ripple');
    expect(r.edge).toBe('start');
    expect(r.alone).toBe(false);
    expect(r.hint).toBe('ripple trim');
    expect(r.cursor).toBe('ripple-start');
    expect(press('c', 'end', { ctrl: true, alt: true }, false)!.alone).toBe(true);
    // a touching edge still ripples: no edit to move outside trim mode
    expect(press('a', 'end', { ctrl: true }, false)!.mode).toBe('ripple');
  });

  it('an edge at an edit moves the edit, ctrl ripples, shift stretches', () => {
    const r = press('a', 'end')!;
    expect(r).toMatchObject({ mode: 'move-edit', clipId: 'a', edge: 'end', leftId: 'a', rightId: 'b', alone: false, blocked: null, cursor: 'move-edit' });
    const s = press('b', 'start')!;
    expect(s).toMatchObject({ mode: 'move-edit', clipId: 'b', edge: 'start', leftId: 'a', rightId: 'b' });
    expect(press('a', 'end', { alt: true })!.alone).toBe(true);
    const c = press('a', 'end', { ctrl: true })!;
    expect(c).toMatchObject({ mode: 'ripple', edge: 'end', hint: 'ripple trim this side', cursor: 'ripple-end' });
    expect(press('a', 'end', { ctrl: true, alt: true })!.hint).toBe('ripple trim this side');
    const sh = press('a', 'end', { shift: true })!;
    expect(sh).toMatchObject({ mode: 'stretch', edge: 'end', cursor: 'stretch-end' });
    expect(press('b', 'start', { shift: true })!.cursor).toBe('stretch-start');
  });

  it('a free edge ripples, alt alone', () => {
    const r = press('c', 'start')!;
    expect(r).toMatchObject({ mode: 'ripple', edge: 'start', alone: false, cursor: 'ripple-start' });
    expect(press('c', 'end')!.cursor).toBe('ripple-end');
    expect(press('c', 'end', { alt: true })).toMatchObject({ alone: true, hint: 'ripple trim, only this clip' });
    // the last clip of a track has nothing after it
    expect(press('b', 'end')!.mode).toBe('ripple');
    expect(press('a', 'start')!.mode).toBe('ripple');
  });

  it('a band moves the edit, without a clip before it acts as the body', () => {
    const r = press('b', 'band')!;
    expect(r).toMatchObject({ mode: 'move-edit', clipId: 'b', edge: 'start', leftId: 'a', rightId: 'b', hint: 'move the edit', alone: false });
    expect(press('b', 'band', { alt: true })!.alone).toBe(true);
    // c has a gap before it: the body rules
    expect(press('c', 'band')!.mode).toBe('slip');
    expect(press('c', 'band', { alt: true })!.mode).toBe('slide');
    expect(press('c', 'band', { ctrl: true })).toBeNull();
  });

  it('bodies: alt slides, video and audio slip, others move, ctrl or shift null', () => {
    expect(press('a', 'body', { alt: true })).toMatchObject({ mode: 'slide', alone: false, cursor: 'slide', hint: 'slide (the neighbours trim to stay touching)' });
    expect(press('a', 'body')).toMatchObject({ mode: 'slip', alone: false, cursor: 'slip', hint: 'slip (alt: slide)' });
    expect(press('i', 'body')).toMatchObject({ mode: 'move', cursor: null, blocked: null, hint: 'move (only video and audio clips slip, alt: slide)' });
    expect(press('t', 'body')!.mode).toBe('move');
    expect(press('i', 'body', { alt: true })!.mode).toBe('slide');
    expect(press('a', 'body', { ctrl: true })).toBeNull();
    expect(press('a', 'body', { shift: true })).toBeNull();
    expect(press('zz', 'body')).toBeNull();
  });

  it('shift on an image edge is needs-media', () => {
    const r = press('i', 'end', { shift: true })!;
    expect(r.mode).toBe('stretch');
    expect(r.blocked).toEqual({ why: 'needs-media', clipId: 'i' });
    expect(r.cursor).toBe('blocked');
    expect(r.hint).toBe('slip and stretch need a video or audio clip');
  });

  it('a locked track blocks all but move', () => {
    const p = proj([video('v1', 'a', 0, 4), video('v1', 'b', 4, 4), image('v1', 'i', 8, 2)], ['v1']);
    for (const [zone, m] of [['end', {}], ['start', { ctrl: true }], ['end', { shift: true }], ['body', {}], ['body', { alt: true }], ['band', {}]] as [PressZone, Partial<PressMods>][]) {
      const r = press(zone === 'start' ? 'b' : 'a', zone, m, true, p)!;
      expect(r.blocked).toEqual({ why: 'locked', clipId: r.clipId });
      expect(r.cursor).toBe('blocked');
      expect(r.hint).toContain('is on a locked track');
    }
    // a body that would only move says nothing of it
    const m = press('i', 'body', {}, true, p)!;
    expect(m.mode).toBe('move');
    expect(m.blocked).toBeNull();
    // outside trim mode ctrl on an edge is blocked too
    expect(press('a', 'end', { ctrl: true }, false, p)!.blocked?.why).toBe('locked');
  });

  it('every hint word for word, none says roll or cut', () => {
    const hints = [
      press('c', 'end')!.hint,
      press('c', 'end', { alt: true })!.hint,
      press('a', 'end')!.hint,
      press('a', 'end', { alt: true })!.hint,
      press('a', 'end', { ctrl: true })!.hint,
      press('a', 'end', { shift: true })!.hint,
      press('a', 'end', { shift: true, alt: true })!.hint,
      press('b', 'band')!.hint,
      press('a', 'body')!.hint,
      press('a', 'body', { alt: true })!.hint,
      press('i', 'body')!.hint,
      press('c', 'end', { ctrl: true }, false)!.hint,
    ];
    expect(hints).toEqual([
      'ripple trim (shift: stretch, alt: only this clip)',
      'ripple trim, only this clip',
      'move the edit (ctrl: ripple trim this side, shift: stretch it)',
      'move the edit, only these two clips',
      'ripple trim this side',
      'stretch: the speed follows the length',
      'stretch, only this clip',
      'move the edit',
      'slip (alt: slide)',
      'slide (the neighbours trim to stay touching)',
      'move (only video and audio clips slip, alt: slide)',
      'ripple trim',
    ]);
    for (const h of hints) expect(h).not.toMatch(/\b(roll|cut)\b/);
  });

  it('modeLabel', () => {
    expect(modeLabel('ripple')).toBe('ripple trim');
    expect(modeLabel('move-edit')).toBe('move the edit');
    expect(modeLabel('slip')).toBe('slip');
    expect(modeLabel('slide')).toBe('slide');
    expect(modeLabel('stretch')).toBe('stretch');
  });
});
