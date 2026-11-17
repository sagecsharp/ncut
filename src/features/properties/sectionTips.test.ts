import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SECTION_TIPS } from './sectionTips';

const dir = 'src/features/properties';
const text = readdirSync(dir)
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => readFileSync(`${dir}/${f}`, 'utf8'))
  .join('\n');

describe('section tips', () => {
  it('every key is a real section id', () => {
    const missing = Object.keys(SECTION_TIPS).filter((k) => !new RegExp(`<Section[^>]*\\bid="${k}"`).test(text));
    expect(missing).toEqual([]);
  });

  it('every blurb is lowercase, at most 110 letters, no em dash and no "asset"', () => {
    for (const [k, v] of Object.entries(SECTION_TIPS)) {
      expect(v, k).toBe(v.toLowerCase());
      expect(v.length, k).toBeLessThanOrEqual(110);
      expect(v, k).not.toContain('—');
      expect(v, k).not.toMatch(/asset/);
    }
  });
});
