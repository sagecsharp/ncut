import { describe, expect, it } from 'vitest';
import { DEFAULT_DELIVERY, isDefaultDelivery, sameDelivery } from './delivery';
import { EXPORT_PRESETS, masterBitrate, matchingPreset, presetChoices } from './presets';
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

describe('the newer presets', () => {
  const find = (id: string) => EXPORT_PRESETS.find((p) => p.id === id)!;
  it('are the old five and then the five of the delivery part', () => {
    expect(EXPORT_PRESETS.map((p) => p.id)).toEqual(['best', 'smooth', 'share', 'small', 'gif', 'youtube-1080', 'youtube-4k', 'vimeo', 'reels', 'master']);
  });
  it('the old five put every advanced choice back to auto', () => {
    for (const id of ['best', 'smooth', 'share', 'small', 'gif']) {
      const c = presetChoices(find(id), 30);
      expect(c.delivery).toEqual(DEFAULT_DELIVERY);
      expect(c.delivery).not.toBe(DEFAULT_DELIVERY);
    }
  });
  it('youtube 1080p at 60 fps', () => {
    const c = presetChoices(find('youtube-1080'), 60);
    expect(c).toEqual({
      container: 'mp4',
      quality: 'high',
      fps: 60,
      scale: 1,
      delivery: { ...DEFAULT_DELIVERY, size: { width: 1920, height: 1080, fit: 'fit' }, audioCodec: 'aac', audioBitrate: 192_000 },
    });
  });
  it('the others', () => {
    expect(presetChoices(find('youtube-4k'), 24).delivery!.size).toEqual({ width: 3840, height: 2160, fit: 'fit' });
    expect(presetChoices(find('vimeo'), 24).delivery!.bitrate).toBe(20_000_000);
    const reels = presetChoices(find('reels'), 60);
    expect(reels.fps).toBe(30);
    expect(reels.delivery!.size).toEqual({ width: 1080, height: 1920, fit: 'fit' });
    expect(reels.delivery!.audioBitrate).toBeNull();
  });
  it('master on 1080p30', () => {
    expect(masterBitrate(1920, 1080, 30)).toBe(29_859_840);
    const c = presetChoices(find('master'), 30, { width: 1920, height: 1080 });
    expect(c.delivery).toEqual({ ...DEFAULT_DELIVERY, bitrate: 29_859_840, keySeconds: 1, audioCodec: 'aac', audioBitrate: 192_000 });
    // another project size and frame rate move it, and it is capped
    expect(presetChoices(find('master'), 60, { width: 1280, height: 720 }).delivery!.bitrate).toBe(masterBitrate(1280, 720, 60));
    expect(masterBitrate(7680, 4320, 240)).toBe(240_000_000);
  });
  it('matchingPreset finds each new preset', () => {
    for (const p of EXPORT_PRESETS) {
      const want = p.id === 'smooth' ? 'best' : p.id;
      expect(matchingPreset(presetChoices(p, 60), 60)).toBe(want);
      expect(matchingPreset(presetChoices(p, 30, { width: 1280, height: 720 }), 30, { width: 1280, height: 720 })).toBe(p.id);
    }
    // a changed advanced choice is no longer the preset
    const c = presetChoices(find('youtube-1080'), 30);
    expect(matchingPreset({ ...c, delivery: { ...c.delivery!, bitrate: 9_000_000 } }, 30)).toBeNull();
    // the old five, with no delivery at all, are still found
    expect(matchingPreset({ container: 'mp4', quality: 'high', fps: 30, scale: 1 }, 30)).toBe('best');
    // gif ignores quality but not the delivery
    expect(matchingPreset({ container: 'gif', quality: 'low', fps: 15, scale: 0.5, delivery: { ...DEFAULT_DELIVERY, sampleRate: 44100 } }, 30)).toBeNull();
  });
  it('no preset sets loudness', () => {
    for (const p of EXPORT_PRESETS) {
      expect(Object.keys(presetChoices(p, 30))).not.toContain('loudness');
      expect(Object.keys(p.delivery ?? {})).not.toContain('loudness');
    }
  });
  it('every preset delivery survives a save', () => {
    for (const p of EXPORT_PRESETS) {
      const d = presetChoices(p, 30).delivery!;
      const back = parseExportSettings(JSON.stringify({ delivery: d })).delivery;
      expect(back === undefined ? isDefaultDelivery(d) : sameDelivery(back, d)).toBe(true);
    }
  });
});
