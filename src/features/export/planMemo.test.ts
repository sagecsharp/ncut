import { describe, expect, it } from 'vitest';
import { createPlanMemo, planKey, probeDelay } from './planMemo';
import type { PlanRequest } from './exporter';

const req = (over: Partial<PlanRequest> = {}): PlanRequest => ({ container: 'mp4', width: 1920, height: 1080, fps: 60, quality: 'high', ...over });

describe('planKey', () => {
  it('tells every part of the question apart', () => {
    const keys = new Set([
      planKey(req()),
      planKey(req({ container: 'webm' })),
      planKey(req({ width: 1280 })),
      planKey(req({ height: 720 })),
      planKey(req({ fps: 59.94 })),
      planKey(req({ quality: 'low' })),
    ]);
    expect(keys.size).toBe(6);
    expect(planKey(req())).toBe(planKey(req()));
  });
});

describe('createPlanMemo', () => {
  it('gives back what it was told', () => {
    const memo = createPlanMemo();
    expect(memo.get(req())).toBeUndefined();
    memo.put(req(), { codec: 'avc', bitrate: 16_000_000 });
    expect(memo.get(req())).toEqual({ codec: 'avc', bitrate: 16_000_000 });
    expect(memo.get(req({ fps: 30 }))).toBeUndefined();
    expect(memo.size).toBe(1);
  });
  it('does not keep a no', () => {
    const memo = createPlanMemo();
    memo.put(req(), null);
    memo.put(req({ fps: 30 }), undefined);
    expect(memo.get(req())).toBeUndefined();
    expect(memo.size).toBe(0);
  });
  it('keeps its own copy', () => {
    const memo = createPlanMemo();
    const plan = { codec: 'avc' as const, bitrate: 1 };
    memo.put(req(), plan);
    plan.bitrate = 2;
    expect(memo.get(req())!.bitrate).toBe(1);
  });
  it('drops the oldest answer when full', () => {
    const memo = createPlanMemo(3);
    for (let i = 0; i < 5; i++) memo.put(req({ fps: 10 + i }), { codec: 'avc', bitrate: i });
    expect(memo.size).toBe(3);
    expect(memo.get(req({ fps: 10 }))).toBeUndefined();
    expect(memo.get(req({ fps: 11 }))).toBeUndefined();
    expect(memo.get(req({ fps: 14 }))!.bitrate).toBe(4);
    // an answer that is already there is replaced, nothing is dropped for it
    memo.put(req({ fps: 12 }), { codec: 'avc', bitrate: 99 });
    expect(memo.size).toBe(3);
    expect(memo.get(req({ fps: 13 }))!.bitrate).toBe(3);
  });
});

describe('probeDelay', () => {
  it('asks at once after a quiet time', () => {
    expect(probeDelay(Number.POSITIVE_INFINITY, 250)).toBe(0);
    expect(probeDelay(250, 250)).toBe(0);
    expect(probeDelay(4000, 250)).toBe(0);
  });
  it('waits when the last question was a moment ago', () => {
    expect(probeDelay(0, 250)).toBe(250);
    expect(probeDelay(249, 250)).toBe(250);
    expect(probeDelay(Number.NaN, 250)).toBe(250);
  });
  it('never waits without a debounce time', () => {
    expect(probeDelay(0, 0)).toBe(0);
    expect(probeDelay(0, -5)).toBe(0);
  });
});
