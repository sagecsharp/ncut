import { describe, expect, it } from 'vitest';
import { TEXT_PRESETS, paragraphWidth } from './textPresets';

const byId = (id: string) => TEXT_PRESETS.find((p) => p.id === id)!;

describe('text presets', () => {
  it('has unique ids', () => {
    expect(new Set(TEXT_PRESETS.map((p) => p.id)).size).toBe(TEXT_PRESETS.length);
  });
  it('builds a named clip for every card', () => {
    for (const p of TEXT_PRESETS) {
      const b = p.build(1920, 1080);
      expect(b.name).toBe(p.label);
      expect(typeof b.text).toBe('string');
    }
  });
  it('uses the new text fields', () => {
    const g = byId('gradient').build(1920, 1080).gradient;
    expect(g?.from).toBeTruthy();
    expect(g?.to).toBeTruthy();
    expect(byId('arch').build(1, 1).curve).toBe(120);
    expect(byId('smile').build(1, 1).curve).toBe(-120);
    const ring = byId('ring').build(1, 1);
    expect(ring.curve).toBe(360);
    expect(ring.fontSize!).toBeLessThan(byId('title').build(1, 1).fontSize!);
  });
  it('wraps the paragraph at 60% of the project width, left aligned and regular', () => {
    const p = byId('paragraph').build(2000, 1000);
    expect(p.wrapWidth).toBe(1200);
    expect(p.align).toBe('left');
    expect(p.fontWeight).toBe(400);
    expect(paragraphWidth(10)).toBe(100);
  });
  it('uses the exact animation ids', () => {
    expect(byId('glitch').build(1, 1).animLoop?.id).toBe('glitch');
    expect(byId('scramble-in').build(1, 1).animIn?.id).toBe('scramble');
    const neon = byId('neon').build(1, 1);
    expect(neon.animLoop?.id).toBe('neon');
    expect(neon.stroke).toBeTruthy();
  });
});
