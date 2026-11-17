import { describe, expect, it } from 'vitest';
import { TRIM_CURSORS } from './trimCursors';
import type { TrimCursor } from './trimPress';

const SHAPED = (Object.keys(TRIM_CURSORS) as TrimCursor[]).filter((k) => k !== 'blocked');

describe('trim cursors', () => {
  it('every cursor has a hotspot in 0..23 and a fallback', () => {
    expect(SHAPED).toHaveLength(7);
    for (const k of SHAPED) {
      const m = /^url\("data:image\/svg\+xml,([^"]*)"\) (\d+) (\d+), ([a-z-]+)$/.exec(TRIM_CURSORS[k]);
      expect(m, k).not.toBeNull();
      const [x, y] = [Number(m![2]), Number(m![3])];
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(23);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(23);
      expect(m![4]!.length).toBeGreaterThan(0);
    }
  });

  it('the svg is encoded: no raw # or quote', () => {
    for (const k of SHAPED) {
      const m = /^url\("data:image\/svg\+xml,([^"]*)"\)/.exec(TRIM_CURSORS[k])!;
      const body = m[1]!;
      expect(body).not.toMatch(/[#'"<> ]/);
      const svg = decodeURIComponent(body);
      expect(svg.startsWith('<svg ')).toBe(true);
      expect(svg).toContain('stroke="black"');
      expect(svg).toContain('stroke="white"');
      expect(svg).not.toContain("'");
    }
  });

  it('blocked is not-allowed', () => {
    expect(TRIM_CURSORS.blocked).toBe('not-allowed');
  });
});
