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
  it('has caption cards at the bottom, wrapped, sized by the project', () => {
    for (const id of ['caption-line', 'caption-box', 'karaoke', 'karaoke-box']) {
      const b = byId(id).build(1920, 1080);
      expect(b.transform?.y).toBe(Math.round(1080 * 0.38));
      expect(b.wrapWidth).toBe(Math.round(1920 * 0.82));
      expect(b.fontSize).toBe(Math.round(1080 * 0.045));
    }
    expect(byId('caption-line').build(1920, 1080).stroke).toBeTruthy();
    expect(byId('caption-box').build(1920, 1080).background).toBeTruthy();
  });
  it('has karaoke cards with a highlight', () => {
    expect(byId('karaoke').build(1920, 1080).highlight?.mode).toBe('fill');
    expect(byId('karaoke').build(1920, 1080).highlight?.background).toBeUndefined();
    const boxed = byId('karaoke-box').build(1920, 1080).highlight;
    expect(boxed?.mode).toBe('word');
    expect(boxed?.background).toBeTruthy();
    expect(byId('caption-line').build(1, 1).highlight).toBeUndefined();
  });
});
