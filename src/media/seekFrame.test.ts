import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRAME_PAUSE_MS, FRAME_WAIT_MS, frameWaitPlan, seekFrame } from './seekFrame';

/** a video element reduced to what seekFrame touches */
function fakeVideo(withCallback: boolean) {
  const listeners = new Map<string, Set<() => void>>();
  let frameCb: ((now: number, meta?: { mediaTime: number }) => void) | null = null;
  const v = {
    time: 0,
    throwOnSeek: false,
    addEventListener(name: string, cb: () => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(cb);
    },
    removeEventListener(name: string, cb: () => void) {
      listeners.get(name)?.delete(cb);
    },
    get currentTime() {
      return this.time;
    },
    set currentTime(t: number) {
      if (this.throwOnSeek) throw new Error('no');
      this.time = t;
    },
    fire(name: string) {
      for (const cb of [...(listeners.get(name) ?? [])]) cb();
    },
    present(mediaTime?: number) {
      const cb = frameCb;
      frameCb = null;
      cb?.(0, mediaTime === undefined ? undefined : { mediaTime });
    },
    count(name: string) {
      return listeners.get(name)?.size ?? 0;
    },
  } as Record<string, unknown> & {
    fire(n: string): void;
    present(mediaTime?: number): void;
    count(n: string): number;
    throwOnSeek: boolean;
    time: number;
  };
  if (withCallback) {
    v.requestVideoFrameCallback = (cb: (now: number, meta?: { mediaTime: number }) => void) => {
      frameCb = cb;
      return 1;
    };
  }
  return v;
}

const run = (v: ReturnType<typeof fakeVideo>, t = 1.5, timeout = 6000) => {
  let result: boolean | null = null;
  void seekFrame(v as unknown as HTMLVideoElement, t, timeout).then((ok) => (result = ok));
  return () => result;
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('seekFrame', () => {
  it('waits for the new frame, not just for seeked', async () => {
    const v = fakeVideo(true);
    const result = run(v);
    expect(v.time).toBe(1.5);
    v.fire('seeked');
    await vi.advanceTimersByTimeAsync(10);
    expect(result()).toBeNull(); // the old picture is still on the element
    v.present();
    await vi.advanceTimersByTimeAsync(0);
    expect(result()).toBe(true);
    expect(v.count('seeked') + v.count('error')).toBe(0);
  });

  it('a frame that is presented before seeked fires also counts', async () => {
    const v = fakeVideo(true);
    const result = run(v);
    v.present();
    await vi.advanceTimersByTimeAsync(0);
    expect(result()).toBeNull();
    v.fire('seeked');
    await vi.advanceTimersByTimeAsync(0);
    expect(result()).toBe(true);
  });

  it('a seek onto the frame already shown presents nothing: it goes on after a short wait', async () => {
    const v = fakeVideo(true);
    const result = run(v);
    v.fire('seeked');
    await vi.advanceTimersByTimeAsync(FRAME_WAIT_MS - 1);
    expect(result()).toBeNull();
    await vi.advanceTimersByTimeAsync(2);
    expect(result()).toBe(true);
  });

  it('without requestVideoFrameCallback a short pause after seeked does it', async () => {
    const v = fakeVideo(false);
    const result = run(v);
    v.fire('seeked');
    await vi.advanceTimersByTimeAsync(FRAME_PAUSE_MS - 1);
    expect(result()).toBeNull();
    await vi.advanceTimersByTimeAsync(2);
    expect(result()).toBe(true);
    expect(frameWaitPlan(false)).toEqual({ waitMs: FRAME_PAUSE_MS, useCallback: false });
    expect(frameWaitPlan(true)).toEqual({ waitMs: FRAME_WAIT_MS, useCallback: true });
  });

  it('false on an error, on a seek that never finishes and when the element refuses the time', async () => {
    const a = fakeVideo(true);
    const ra = run(a);
    a.fire('error');
    await vi.advanceTimersByTimeAsync(0);
    expect(ra()).toBe(false);

    const b = fakeVideo(true);
    const rb = run(b, 1, 500);
    await vi.advanceTimersByTimeAsync(499);
    expect(rb()).toBeNull();
    await vi.advanceTimersByTimeAsync(2);
    expect(rb()).toBe(false);
    expect(b.count('seeked')).toBe(0);

    const c = fakeVideo(true);
    c.throwOnSeek = true;
    const rc = run(c);
    await vi.advanceTimersByTimeAsync(0);
    expect(rc()).toBe(false);
  });

  it('a frame from before the seek does not count, the next one does', async () => {
    const v = fakeVideo(true);
    const result = run(v, 1.5);
    v.present(0); // the first frame after loading, still on its way
    v.fire('seeked');
    await vi.advanceTimersByTimeAsync(10);
    expect(result()).toBeNull();
    v.present(1.5);
    await vi.advanceTimersByTimeAsync(0);
    expect(result()).toBe(true);
  });

  it('settles once: a late frame or event after the end changes nothing', async () => {
    const v = fakeVideo(true);
    const result = run(v);
    v.fire('seeked');
    v.present();
    await vi.advanceTimersByTimeAsync(0);
    expect(result()).toBe(true);
    v.fire('error');
    await vi.advanceTimersByTimeAsync(7000);
    expect(result()).toBe(true);
  });
});
