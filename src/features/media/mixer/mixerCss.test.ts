import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// the over dot has a bigger hit area: an absolute ::before with a negative inset. it only stays on the dot while the
// dot itself is positioned. in 0.4.0 the meter in the transport made the dot static, the hit area took the next
// positioned box (the whole preview pane) and the dot swallowed every click on the preview: no move, scale or rotate.
describe('mixer.css: the over dot', () => {
  const css = readFileSync(new URL('./mixer.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
  const position = (body: string) => /(?:^|[;\s])position:\s*([a-z]+)/.exec(body)?.[1];

  it('has a hit area that is an absolute pseudo element', () => {
    const hit = rules.find((r) => r.selector === '.mixer-over::before');
    expect(hit && position(hit.body)).toBe('absolute');
  });

  it('is positioned in every rule that sets its position, so the hit area stays on it', () => {
    const own = rules.filter((r) => r.selector.split(',').some((s) => /\.mixer-over$/.test(s.trim())));
    const set = own.map((r) => ({ selector: r.selector, position: position(r.body) })).filter((r) => r.position);
    expect(set.length).toBeGreaterThan(0);
    for (const r of set) expect(['absolute', 'relative', 'fixed', 'sticky'], r.selector).toContain(r.position);
  });
});
