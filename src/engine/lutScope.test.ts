import { describe, expect, it } from 'vitest';
import type { LutTable } from '../lib/cube';
import { lutNow, withLuts } from './lutScope';

const table = (key: string): LutTable => ({
  key,
  title: '',
  size3: 2,
  data3: new Float32Array(24),
  min3: [0, 0, 0],
  max3: [1, 1, 1],
  size1: 0,
  data1: new Float32Array(0),
  min1: [0, 0, 0],
  max1: [1, 1, 1],
  identity: false,
});

describe('lutScope', () => {
  it('no table outside a render', () => {
    expect(lutNow('a')).toBeNull();
  });

  it('withLuts gives what fn returns', () => {
    const t = table('a');
    const got = withLuts((id) => (id === 'a' ? t : null), () => [lutNow('a'), lutNow('b')]);
    expect(got).toEqual([t, null]);
    expect(lutNow('a')).toBeNull();
  });

  it('restored after a throw', () => {
    const t = table('a');
    expect(() => withLuts(() => t, () => { throw new Error('boom'); })).toThrow('boom');
    expect(lutNow('a')).toBeNull();
  });

  it('nested scopes restore the outer one', () => {
    const outer = table('outer');
    const inner = table('inner');
    withLuts(() => outer, () => {
      expect(lutNow('x')).toBe(outer);
      withLuts(() => inner, () => expect(lutNow('x')).toBe(inner));
      expect(lutNow('x')).toBe(outer);
    });
    expect(lutNow('x')).toBeNull();
  });

  it('a null lookup means no luts inside', () => {
    const t = table('a');
    withLuts(() => t, () => {
      withLuts(null, () => expect(lutNow('a')).toBeNull());
      withLuts(undefined, () => expect(lutNow('a')).toBeNull());
      expect(lutNow('a')).toBe(t);
    });
  });
});
