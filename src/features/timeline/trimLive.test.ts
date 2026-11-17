import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Clip, ImageClip, MediaAsset, Project, TextClip, Track, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { getTrimView, setTrimView, subscribeTrimView, trimSides } from './trimLive';
import type { TrimViewReq } from './trimLive';

const track = (id: string): Track => ({ id, kind: 'video', name: id, muted: false, hidden: false, locked: false });
const asset = (id: string, duration: number): MediaAsset => ({ id, name: id, kind: 'video', mime: 'video/x', size: 1, duration, width: 100, height: 100, hasAudio: true, createdAt: 0 });
const video = (trackId: string, id: string, start: number, duration: number, o: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'long', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...o,
});
const image = (trackId: string, id: string, start: number, duration: number): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'pic', transform: { ...DEFAULT_TRANSFORM },
});
const words = (trackId: string, id: string, start: number, duration: number): TextClip => ({
  ...(video(trackId, id, start, duration) as unknown as TextClip), type: 'text', text: id,
});
function proj(clips: Clip[]): Project {
  return { ...createProject('live'), fps: 24, tracks: [track('v1'), track('v2')], assets: [asset('long', 100)], clips };
}

afterEach(() => {
  setTrimView(null);
  vi.useRealTimers();
});

describe('trim view store', () => {
  it('setTrimView notifies once per change', () => {
    let n = 0;
    const off = subscribeTrimView(() => n++);
    const a: TrimViewReq = { mode: 'slip', clipId: 'a' };
    setTrimView(a);
    setTrimView({ mode: 'slip', clipId: 'a' });
    expect(n).toBe(1);
    expect(getTrimView()).toBe(a);
    setTrimView({ mode: 'ripple', clipId: 'a', edge: 'end' });
    setTrimView({ mode: 'ripple', clipId: 'a', edge: 'start' });
    expect(n).toBe(3);
    setTrimView(null);
    setTrimView(null);
    expect(n).toBe(4);
    off();
    setTrimView(a);
    expect(n).toBe(4);
  });

  it('holdMs hides it and a later call replaces the timer', () => {
    vi.useFakeTimers();
    const req: TrimViewReq = { mode: 'slide', clipId: 'a' };
    setTrimView(req, 1500);
    vi.advanceTimersByTime(1000);
    expect(getTrimView()).toBe(req);
    // a later call restarts the wait
    setTrimView(req, 1500);
    vi.advanceTimersByTime(1000);
    expect(getTrimView()).toBe(req);
    vi.advanceTimersByTime(600);
    expect(getTrimView()).toBeNull();
    // a request without holdMs stays and stops an old timer
    setTrimView(req, 1500);
    setTrimView({ mode: 'slide', clipId: 'b' });
    vi.advanceTimersByTime(5000);
    expect(getTrimView()?.clipId).toBe('b');
    // null cancels the timer too
    setTrimView(req, 1500);
    setTrimView(null);
    setTrimView(req);
    vi.advanceTimersByTime(5000);
    expect(getTrimView()).toBe(req);
  });
});

describe('trimSides', () => {
  const P = proj([video('v1', 'a', 0, 4, { trimStart: 10 }), video('v1', 'b', 4, 4, { trimStart: 20, speed: 2 }), video('v1', 'c', 12, 2, { trimStart: 1 }), image('v2', 'i', 0, 3), words('v2', 's', 3, 2)]);
  const fps = 24;

  it('trimSides: slip', () => {
    const r = trimSides(P, { mode: 'slip', clipId: 'b' }, fps)!;
    expect(r[0]).toEqual({ show: 'video', assetId: 'long', time: 20, label: 'first frame of b, 00:20:00' });
    // trimStart + (duration - 1 frame) * speed = 20 + (4 - 1/24) * 2
    expect(r[1].show).toBe('video');
    expect(r[1].time).toBeCloseTo(20 + (4 - 1 / 24) * 2, 9);
    expect(r[1].label.startsWith('last frame of b, ')).toBe(true);
  });

  it('move the edit', () => {
    const r = trimSides(P, { mode: 'move-edit', clipId: 'a', edge: 'end', otherId: 'b' }, fps)!;
    expect(r[0].label.startsWith('last frame of a, ')).toBe(true);
    expect(r[0].time).toBeCloseTo(10 + (4 - 1 / 24), 9);
    expect(r[1]).toEqual({ show: 'video', assetId: 'long', time: 20, label: 'first frame of b, 00:20:00' });
    // the pressed clip on the right side: clipId is the right clip
    const s = trimSides(P, { mode: 'move-edit', clipId: 'b', edge: 'start', otherId: 'a' }, fps)!;
    expect(s).toEqual(r);
    // without otherId the clip that touches is used
    expect(trimSides(P, { mode: 'move-edit', clipId: 'a', edge: 'end' }, fps)).toEqual(r);
    expect(trimSides(P, { mode: 'move-edit', clipId: 'b', edge: 'start' }, fps)).toEqual(r);
  });

  it('ripple start and end with a gap', () => {
    const end = trimSides(P, { mode: 'ripple', clipId: 'b', edge: 'end' }, fps)!;
    expect(end[0].label.startsWith('last frame of b, ')).toBe(true);
    // c is not touching b: a gap
    expect(end[1]).toEqual({ show: 'gap', time: 0, label: 'gap' });
    const start = trimSides(P, { mode: 'ripple', clipId: 'b', edge: 'start' }, fps)!;
    expect(start[0].label.startsWith('last frame of a, ')).toBe(true);
    expect(start[1].label).toBe('first frame of b, 00:20:00');
    const alone = trimSides(P, { mode: 'ripple', clipId: 'c', edge: 'start' }, fps)!;
    expect(alone[0]).toEqual({ show: 'gap', time: 0, label: 'gap' });
    expect(alone[1].label).toBe('first frame of c, 00:01:00');
    const next = trimSides(P, { mode: 'ripple', clipId: 'a', edge: 'end' }, fps)!;
    expect(next[1].label).toBe('first frame of b, 00:20:00');
  });

  it('slide', () => {
    const r = trimSides(P, { mode: 'slide', clipId: 'a' }, fps)!;
    expect(r[0]).toEqual({ show: 'gap', time: 0, label: 'gap' });
    expect(r[1].label).toBe('first frame of b, 00:20:00');
    const m = trimSides(proj([video('v1', 'x', 0, 2), video('v1', 'y', 2, 2), video('v1', 'z', 4, 2, { trimStart: 3 })]), { mode: 'slide', clipId: 'y' }, fps)!;
    expect(m[0].label.startsWith('last frame of x, ')).toBe(true);
    expect(m[1].label).toBe('first frame of z, 00:03:00');
  });

  it('stretch and a gone clip give null', () => {
    expect(trimSides(P, { mode: 'stretch', clipId: 'a', edge: 'end' }, fps)).toBeNull();
    expect(trimSides(P, { mode: 'slip', clipId: 'zz' }, fps)).toBeNull();
    expect(trimSides(P, { mode: 'ripple', clipId: 'zz', edge: 'end' }, fps)).toBeNull();
  });

  it('image and name sides', () => {
    // i is an image, s a text that touches it
    const r = trimSides(P, { mode: 'move-edit', clipId: 'i', edge: 'end', otherId: 's' }, fps)!;
    expect(r[0]).toEqual({ show: 'image', assetId: 'pic', time: 0, label: 'last frame of i' });
    expect(r[1]).toEqual({ show: 'name', time: 0, label: 'first frame of s' });
    const sl = trimSides(P, { mode: 'slip', clipId: 'i' }, fps)!;
    expect(sl[0].show).toBe('image');
    expect(sl[0].time).toBe(0);
  });
});
