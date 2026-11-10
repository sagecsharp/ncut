import { describe, expect, it } from 'vitest';
import { createScheduler } from './derivedQueue';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('derived scheduler', () => {
  it('runs thumbnails before filmstrips before waveforms, newest first inside a kind', async () => {
    const s = createScheduler({ concurrency: 1 });
    const order: string[] = [];
    const gate = deferred();
    const first = s.submit('wave', async () => {
      await gate.promise;
      order.push('w0');
    });
    await tick();
    const rest = [
      s.submit('wave', async () => void order.push('w1')),
      s.submit('film', async () => void order.push('f1')),
      s.submit('thumb', async () => void order.push('t1')),
      s.submit('film', async () => void order.push('f2')),
      s.submit('thumb', async () => void order.push('t2')),
      s.submit('wave', async () => void order.push('w2')),
    ];
    gate.resolve();
    await Promise.all([first, ...rest]);
    expect(order).toEqual(['w0', 't2', 't1', 'f2', 'f1', 'w2', 'w1']);
  });

  it('never runs more than the concurrency cap', async () => {
    for (const cap of [1, 2]) {
      const s = createScheduler({ concurrency: cap });
      let active = 0;
      let peak = 0;
      const jobs = Array.from({ length: 8 }, () =>
        s.submit('film', async () => {
          active++;
          peak = Math.max(peak, active);
          await tick();
          active--;
        }),
      );
      await Promise.all(jobs);
      expect(peak).toBe(cap);
    }
  });

  it('returns the same promise for a key while pending or running', async () => {
    const s = createScheduler({ concurrency: 1 });
    let runs = 0;
    const gate = deferred();
    const a = s.submit('thumb', async () => {
      runs++;
      await gate.promise;
      return 7;
    }, 'k');
    const b = s.submit('thumb', async () => {
      runs++;
      return 8;
    }, 'k');
    expect(b).toBe(a);
    await tick();
    const c = s.submit('thumb', async () => 9, 'k');
    expect(c).toBe(a);
    gate.resolve();
    expect(await a).toBe(7);
    expect(runs).toBe(1);
    // finished: a new request with the same key is a new job (callers keep the done result themselves)
    expect(await s.submit('thumb', async () => 10, 'k')).toBe(10);
  });

  it('a failed job rejects only itself and the queue goes on', async () => {
    const s = createScheduler({ concurrency: 1 });
    const bad = s.submit('film', async () => {
      throw new Error('boom');
    });
    const good = s.submit('wave', async () => 'ok');
    await expect(bad).rejects.toThrow('boom');
    expect(await good).toBe('ok');
    expect(s.size()).toBe(0);
  });

  it('a failed keyed job frees its key', async () => {
    const s = createScheduler();
    await expect(s.submit('thumb', async () => Promise.reject(new Error('x')), 'k')).rejects.toThrow('x');
    expect(await s.submit('thumb', async () => 1, 'k')).toBe(1);
  });

  it('a rejecting yield function does not stall the queue', async () => {
    const s = createScheduler({ yieldFn: () => Promise.reject(new Error('no')) });
    expect(await s.submit('thumb', async () => 3)).toBe(3);
  });
});
