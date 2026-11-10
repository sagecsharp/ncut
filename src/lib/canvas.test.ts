import { afterEach, describe, expect, it } from 'vitest';
import { createCanvas, inWorker } from './canvas';

const g = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};
function stub(name: string, value: unknown): void {
  if (!(name in saved)) saved[name] = g[name];
  if (value === undefined) delete g[name];
  else g[name] = value;
}

afterEach(() => {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete g[k];
    else g[k] = saved[k];
    delete saved[k];
  }
});

class FakeOffscreen {
  constructor(
    public width: number,
    public height: number,
  ) {}
}

describe('createCanvas', () => {
  it('uses a document canvas when there is a document', () => {
    const made: Array<{ width: number; height: number }> = [];
    stub('document', {
      createElement: (tag: string) => {
        expect(tag).toBe('canvas');
        const c = { width: 300, height: 150 };
        made.push(c);
        return c;
      },
    });
    stub('OffscreenCanvas', FakeOffscreen); // present too (a browser): the document still wins
    const c = createCanvas(64, 32) as unknown as { width: number; height: number };
    expect(made).toHaveLength(1);
    expect(c).toBe(made[0]);
    expect([c.width, c.height]).toEqual([64, 32]);
  });
  it('leaves the default size of an element without sizes', () => {
    stub('document', { createElement: () => ({ width: 300, height: 150 }) });
    const c = createCanvas() as unknown as { width: number; height: number };
    expect([c.width, c.height]).toEqual([300, 150]);
  });
  it('makes an OffscreenCanvas without a document', () => {
    stub('document', undefined);
    stub('OffscreenCanvas', FakeOffscreen);
    const c = createCanvas(40, 20);
    expect(c).toBeInstanceOf(FakeOffscreen);
    expect([c.width, c.height]).toEqual([40, 20]);
  });
  it('sizes an OffscreenCanvas 1 x 1 when no sizes are given', () => {
    stub('document', undefined);
    stub('OffscreenCanvas', FakeOffscreen);
    const c = createCanvas();
    expect([c.width, c.height]).toEqual([1, 1]);
  });
  it('throws with neither', () => {
    stub('document', undefined);
    stub('OffscreenCanvas', undefined);
    expect(() => createCanvas(2, 2)).toThrow();
  });
});

describe('inWorker', () => {
  it('is false with a document', () => {
    stub('document', {});
    stub('self', {});
    expect(inWorker()).toBe(false);
  });
  it('is true without a document but with a worker global', () => {
    stub('document', undefined);
    stub('self', {});
    expect(inWorker()).toBe(true);
  });
  it('is false in plain node (no self)', () => {
    stub('document', undefined);
    stub('self', undefined);
    expect(inWorker()).toBe(false);
  });
});
