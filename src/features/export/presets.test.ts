import { describe, expect, it } from 'vitest';
import { EXPORT_PRESETS, matchingPreset, presetChoices } from './presets';
import { parseExportSettings } from './settings';

describe('export presets', () => {
  it('have unique ids and plain lowercase labels', () => {
    const ids = EXPORT_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of EXPORT_PRESETS) {
      expect(p.label).toBe(p.label.toLowerCase());
      expect(p.title.length).toBeGreaterThan(10);
    }
  });

  it('only use values the dialog can show and remember', () => {
    for (const p of EXPORT_PRESETS) {
      const c = presetChoices(p, 30);
      const back = parseExportSettings(JSON.stringify(c.container === 'gif' ? { container: 'gif', gif: { fps: c.fps, scale: c.scale } } : c));
      expect(back.container).toBe(c.container);
      if (c.container === 'gif') expect(back.gif).toEqual({ fps: c.fps, scale: c.scale });
      else {
        expect(back.fps).toBe(c.fps);
        expect(back.scale).toBe(c.scale);
        expect(back.quality).toBe(c.quality);
      }
    }
  });

  it('"best" follows the project frame rate', () => {
    const best = EXPORT_PRESETS.find((p) => p.id === 'best')!;
    expect(presetChoices(best, 24).fps).toBe(24);
    expect(presetChoices(best, 120).fps).toBe(120);
  });

  it('finds the preset that equals the choices', () => {
    for (const p of EXPORT_PRESETS) {
      // at 60 fps "best" and "smooth 60" are the same choices: the first one wins
      const want = p.id === 'smooth' ? 'best' : p.id;
      expect(matchingPreset(presetChoices(p, 60), 60)).toBe(want);
    }
    expect(matchingPreset({ container: 'mp4', quality: 'high', fps: 60, scale: 1 }, 30)).toBe('smooth');
    expect(matchingPreset({ container: 'webm', quality: 'high', fps: 30, scale: 1 }, 30)).toBeNull();
    expect(matchingPreset({ container: 'mp4', quality: 'low', fps: 30, scale: 1 }, 30)).toBeNull();
  });

  it('gif ignores the quality', () => {
    expect(matchingPreset({ container: 'gif', quality: 'high', fps: 15, scale: 0.5 }, 30)).toBe('gif');
  });
});
