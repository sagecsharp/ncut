import { describe, expect, it } from 'vitest';
import { EFFECTS } from './registry';

const synced = EFFECTS.filter((d) => d.sync);

describe('effect sync metadata (the rate the tempo lock replaces)', () => {
  it('some effects have it', () => {
    expect(synced.length).toBeGreaterThan(10);
    for (const id of ['zoom-pulse', 'flash', 'duotone-strobe', 'glitch', 'static', 'hue-wash', 'scanlines']) {
      expect(synced.map((d) => d.id)).toContain(id);
    }
  });

  it('every sync param exists on its def and is a number param, not a choice', () => {
    for (const d of synced) {
      const p = d.params.find((x) => x.key === d.sync!.param);
      expect(p, `${d.id}: ${d.sync!.param}`).toBeDefined();
      expect(p!.options, `${d.id}: ${d.sync!.param} is a choice`).toBeUndefined();
    }
  });

  it('every sync param is a rate in hz that the glsl reads together with u_time', () => {
    for (const d of synced) {
      const p = d.params.find((x) => x.key === d.sync!.param)!;
      expect(p.unit, d.id).toBe('hz');
      const code = d.glsl.replace(/\/\/[^\n]*/g, ' ');
      expect(new RegExp(`u_time[^;]*p_${p.key}\\b|p_${p.key}\\b[^;]*u_time`).test(code), `${d.id} does not read u_time with p_${p.key}`).toBe(true);
    }
  });

  it('cycles are a positive number', () => {
    for (const d of synced) {
      expect(d.sync!.cycles).toBeGreaterThan(0);
      expect(Number.isFinite(d.sync!.cycles)).toBe(true);
    }
  });

  it('temporal effects have none (they have no pass of their own)', () => {
    for (const d of EFFECTS.filter((x) => x.temporal)) expect(d.sync, d.id).toBeUndefined();
  });

  it('effects that only run on noise in time have none', () => {
    for (const id of ['shake', 'drift', 'wave', 'heat-haze', 'snow', 'rain', 'confetti', 'light-leak']) {
      expect(EFFECTS.find((d) => d.id === id)?.sync, id).toBeUndefined();
    }
  });
});
