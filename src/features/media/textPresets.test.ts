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
  it('has hollow cards with a thin outline and no fill', () => {
    const h = byId('hollow').build(1, 1);
    expect(h.hollow).toBe(true);
    expect(h.stroke!.width).toBeGreaterThanOrEqual(0.03);
    expect(h.stroke!.width).toBeLessThanOrEqual(0.04);
    expect(h.fontWeight).toBe(700);
    const n = byId('neon-sign').build(1, 1);
    expect(n.hollow).toBe(true);
    expect(n.shadow?.color).toBe(n.stroke?.color);
    expect(n.shadow!.blur).toBeGreaterThan(0);
  });
  it('has karaoke cards with a highlight', () => {
    expect(byId('karaoke').build(1920, 1080).highlight?.mode).toBe('fill');
    expect(byId('karaoke').build(1920, 1080).highlight?.background).toBeUndefined();
    const boxed = byId('karaoke-box').build(1920, 1080).highlight;
    expect(boxed?.mode).toBe('word');
    expect(boxed?.background).toBeTruthy();
    expect(byId('caption-line').build(1, 1).highlight).toBeUndefined();
  });
  it('has counter cards with a running number', () => {
    for (const id of ['counter', 'percent', 'money', 'countdown']) {
      const b = byId(id).build(1920, 1080);
      expect(b.counter, id).toBeTruthy();
      expect(b.text, id).toContain('{n}');
    }
    expect(byId('counter').build(1, 1).counter).toMatchObject({ from: 0, to: 100 });
    expect(byId('percent').build(1, 1).text).toBe('{n}%');
    const money = byId('money').build(1, 1);
    expect(money.text).toBe('$ {n}');
    expect(money.counter).toMatchObject({ from: 0, to: 10000, separator: true });
    expect(byId('countdown').build(1, 1).counter).toMatchObject({ from: 10, to: 0, ease: 'linear' });
  });
  it('has a caption box with a box per line and an underlined title', () => {
    const cap = byId('caption-box').build(1920, 1080);
    expect(cap.backgroundPerLine).toBe(true);
    expect(cap.backgroundRadius).toBeGreaterThan(0);
    expect(cap.color).toBe('#ffffff');
    expect(byId('underlined-title').build(1, 1).underline).toBe(true);
  });
  it('has depth cards that use extrude', () => {
    for (const id of ['block', 'retro', 'long-shadow', 'sticker']) {
      const e = byId(id).build(1920, 1080).extrude;
      expect(e, id).toBeTruthy();
      expect(e!.depth).toBeGreaterThan(0);
      expect(e!.depth).toBeLessThanOrEqual(1);
    }
    expect(byId('long-shadow').build(1, 1).extrude!.depth).toBeGreaterThan(byId('block').build(1, 1).extrude!.depth);
    expect(byId('long-shadow').build(1, 1).extrude!.angle).toBe(135);
    expect(byId('retro').build(1, 1).stroke).toBeTruthy();
    expect(byId('sticker').build(1, 1).stroke!.width).toBeGreaterThan(byId('outline').build(1, 1).stroke!.width);
  });
});
