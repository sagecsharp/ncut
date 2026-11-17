import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXPORT_SETTINGS_KEY, mergeExportSettings, parseDelivery, parseExportSettings, saveAdvancedOpen, savedDelivery, withLoudness } from './settings';
import type { SavedExportSettings } from './settings';
import { DEFAULT_DELIVERY, isDefaultDelivery } from './delivery';
import type { ExportDelivery } from './delivery';

describe('parseExportSettings', () => {
  it('reads valid values', () => {
    expect(parseExportSettings('{"container":"webm","quality":"high","fps":60,"scale":0.5}')).toEqual({
      container: 'webm',
      quality: 'high',
      fps: 60,
      scale: 0.5,
    });
  });
  it('ignores anything unexpected', () => {
    expect(parseExportSettings(null)).toEqual({});
    expect(parseExportSettings('nope')).toEqual({});
    expect(parseExportSettings('[1]')).toEqual({});
    expect(parseExportSettings('{"container":"avi","quality":3,"fps":-1,"scale":2}')).toEqual({});
  });
  it('keeps the good fields next to bad ones', () => {
    expect(parseExportSettings('{"container":"mp4","fps":9999}')).toEqual({ container: 'mp4' });
  });
});

describe('gif settings', () => {
  it('reads the gif container and its own fps / scale', () => {
    expect(parseExportSettings('{"container":"gif","fps":30,"gif":{"fps":15,"scale":0.5}}')).toEqual({
      container: 'gif',
      fps: 30,
      gif: { fps: 15, scale: 0.5 },
    });
  });
  it('caps the gif frame rate and drops bad gif fields', () => {
    expect(parseExportSettings('{"gif":{"fps":60}}')).toEqual({});
    expect(parseExportSettings('{"gif":{"fps":50,"scale":3}}')).toEqual({ gif: { fps: 50 } });
    expect(parseExportSettings('{"gif":5}')).toEqual({});
  });
  it('keeps video choices when gif is saved', () => {
    const prev = { container: 'mp4' as const, quality: 'high' as const, fps: 60, scale: 1 };
    const next = mergeExportSettings(prev, { container: 'gif', quality: 'high', fps: 15, scale: 0.5 });
    expect(next).toEqual({ container: 'gif', quality: 'high', fps: 60, scale: 1, gif: { fps: 15, scale: 0.5 } });
    const back = mergeExportSettings(next, { container: 'webm', quality: 'low', fps: 24, scale: 0.75 });
    expect(back.gif).toEqual({ fps: 15, scale: 0.5 });
    expect(back.fps).toBe(24);
  });
  it('a picture is remembered as the format and leaves fps and scale alone', () => {
    expect(parseExportSettings('{"container":"png"}')).toEqual({ container: 'png' });
    expect(parseExportSettings('{"container":"jpg","quality":"low"}')).toEqual({ container: 'jpg', quality: 'low' });
    expect(parseExportSettings('{"container":"jpeg"}')).toEqual({});
    const prev = { fps: 60, scale: 0.75, gif: { fps: 15, scale: 0.5 } };
    expect(mergeExportSettings(prev, { container: 'png', quality: 'high', fps: 30, scale: 0.5 })).toEqual({
      fps: 60,
      scale: 0.75,
      gif: { fps: 15, scale: 0.5 },
      container: 'png',
      quality: 'high',
    });
  });
  it('audio containers leave fps and scale alone', () => {
    const prev = { fps: 60, scale: 1 };
    expect(mergeExportSettings(prev, { container: 'wav', quality: 'low', fps: 30, scale: 0.5 })).toEqual({
      fps: 60,
      scale: 1,
      container: 'wav',
      quality: 'low',
    });
  });
});

describe('delivery settings', () => {
  afterEach(() => vi.unstubAllGlobals());

  const full: ExportDelivery = {
    codec: 'hevc',
    bitrate: 20_000_000,
    keySeconds: 1,
    size: { width: 1080, height: 1920, fit: 'fill' },
    audioCodec: 'aac',
    audioBitrate: 192_000,
    sampleRate: 44100,
    transparent: true,
  };
  const next = { container: 'mp4' as const, quality: 'high' as const, fps: 30, scale: 1 };
  /** a localStorage with one key, as a plain object */
  const store = (start: string | null = null) => {
    const kept: Record<string, string> = start === null ? {} : { [EXPORT_SETTINGS_KEY]: start };
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => kept[k] ?? null,
      setItem: (k: string, v: string) => {
        kept[k] = v;
      },
    });
    return kept;
  };

  it('delivery round trip', () => {
    const back = parseExportSettings(JSON.stringify({ container: 'mp4', delivery: full, sizeFor: { width: 1920, height: 1080 }, advanced: true }));
    expect(back.delivery).toEqual(full);
    expect(back.sizeFor).toEqual({ width: 1920, height: 1080 });
    expect(back.advanced).toBe(true);
    const merged = mergeExportSettings({}, { ...next, delivery: full, sizeFor: { width: 1920, height: 1080 } });
    expect(parseExportSettings(JSON.stringify(merged))).toEqual({ ...merged });
  });

  it('bad fields one by one', () => {
    const bad: Array<[string, unknown, Partial<ExportDelivery>]> = [
      ['codec', 'h264', { codec: 'auto' }],
      ['codec', 7, { codec: 'auto' }],
      ['bitrate', 100_000, { bitrate: null }],
      ['bitrate', 300_000_000, { bitrate: null }],
      ['bitrate', '9000000', { bitrate: null }],
      ['keySeconds', 3, { keySeconds: null }],
      ['keySeconds', 2, { keySeconds: null }],
      ['size', { width: 8, height: 100, fit: 'fit' }, { size: null }],
      ['size', { width: 100, height: 9000, fit: 'fit' }, { size: null }],
      ['size', { width: 100.5, height: 100, fit: 'fit' }, { size: null }],
      ['size', { width: 100, height: 100, fit: 'stretch' }, { size: null }],
      ['size', 5, { size: null }],
      ['audioCodec', 'mp3', { audioCodec: 'auto' }],
      ['audioBitrate', 100_000, { audioBitrate: null }],
      ['audioBitrate', 192, { audioBitrate: null }],
      ['sampleRate', 32000, { sampleRate: 48000 }],
      ['transparent', 'yes', { transparent: false }],
      ['transparent', false, { transparent: false }],
    ];
    for (const [key, value, expected] of bad) {
      // the good field next to it survives, the bad one takes its default
      const d = parseDelivery({ codec: 'vp9', [key]: value });
      const want: ExportDelivery = { ...DEFAULT_DELIVERY, codec: 'vp9', ...expected };
      if (key === 'codec') want.codec = 'auto';
      expect(isDefaultDelivery(want) ? undefined : want).toEqual(d);
    }
    expect(parseDelivery('nope')).toBeUndefined();
    expect(parseDelivery(null)).toBeUndefined();
    expect(parseDelivery([1])).toBeUndefined();
    expect(parseDelivery({ codec: 'avc', bitrate: 500_000, keySeconds: 0.5, audioBitrate: 320_000, size: { width: 16, height: 8192, fit: 'fit' } })).toEqual({
      ...DEFAULT_DELIVERY,
      codec: 'avc',
      bitrate: 500_000,
      keySeconds: 0.5,
      audioBitrate: 320_000,
      size: { width: 16, height: 8192, fit: 'fit' },
    });
  });

  it('a fractional bitrate is dropped', () => {
    expect(parseDelivery({ bitrate: 8_000_000.5 })).toBeUndefined();
    expect(parseDelivery({ codec: 'avc', bitrate: 8_000_000.5 })).toEqual({ ...DEFAULT_DELIVERY, codec: 'avc' });
  });

  it('a default delivery leaves no key', () => {
    expect(parseExportSettings(JSON.stringify({ container: 'mp4', delivery: { codec: 'auto', bitrate: null } }))).toEqual({ container: 'mp4' });
    expect('delivery' in parseExportSettings('{"delivery":{"codec":"bad"}}')).toBe(false);
    const prev = mergeExportSettings({}, { ...next, delivery: full, sizeFor: { width: 1920, height: 1080 } });
    const cleared = mergeExportSettings(prev, { ...next, delivery: { ...DEFAULT_DELIVERY } });
    expect('delivery' in cleared).toBe(false);
    expect('sizeFor' in cleared).toBe(false);
  });

  it('merge without delivery keeps it', () => {
    const prev = mergeExportSettings({}, { ...next, delivery: full, sizeFor: { width: 1920, height: 1080 } });
    const kept = mergeExportSettings(prev, { container: 'webm', quality: 'low', fps: 24, scale: 0.5 });
    expect(kept.delivery).toEqual(full);
    expect(kept.sizeFor).toEqual({ width: 1920, height: 1080 });
    expect(kept.container).toBe('webm');
  });

  it('the size is kept with the project size it was set on, and only with a size', () => {
    const noSize = { ...full, size: null };
    const a = mergeExportSettings({ sizeFor: { width: 1, height: 1 } }, { ...next, delivery: noSize, sizeFor: { width: 1920, height: 1080 } });
    expect('sizeFor' in a).toBe(false);
    const b = mergeExportSettings({}, { ...next, delivery: full });
    expect('sizeFor' in b).toBe(false);
    expect(b.delivery).toEqual(full);
  });

  it('saveAdvancedOpen keeps delivery', () => {
    const kept = store(JSON.stringify({ container: 'webm', delivery: full, sizeFor: { width: 1920, height: 1080 } }));
    saveAdvancedOpen(true);
    const on = parseExportSettings(kept[EXPORT_SETTINGS_KEY]!);
    expect(on.advanced).toBe(true);
    expect(on.delivery).toEqual(full);
    expect(on.container).toBe('webm');
    saveAdvancedOpen(false);
    const off = parseExportSettings(kept[EXPORT_SETTINGS_KEY]!);
    expect('advanced' in off).toBe(false);
    expect(off.delivery).toEqual(full);
    expect(() => {
      vi.stubGlobal('localStorage', undefined);
      saveAdvancedOpen(true);
    }).not.toThrow();
  });

  it('savedDelivery drops a size of another project size', () => {
    const saved = { delivery: full, sizeFor: { width: 1920, height: 1080 } };
    expect(savedDelivery(saved, 1920, 1080)).toEqual(full);
    expect(savedDelivery(saved, 1920, 1080).size).not.toBe(full.size);
    expect(savedDelivery(saved, 1280, 720)).toEqual({ ...full, size: null });
    expect(savedDelivery({ delivery: full }, 1920, 1080)).toEqual({ ...full, size: null });
    expect(savedDelivery({}, 1920, 1080)).toEqual(DEFAULT_DELIVERY);
    expect(savedDelivery({}, 1920, 1080)).not.toBe(DEFAULT_DELIVERY);
  });

  it('the rate is saved', () => {
    // the loudness meter reads saved.delivery?.sampleRate: it is there in a delivery that is not default
    const kept = mergeExportSettings({}, { ...next, delivery: { ...DEFAULT_DELIVERY, sampleRate: 44100 } });
    expect(parseExportSettings(JSON.stringify(kept)).delivery?.sampleRate).toBe(44100);
    expect(parseExportSettings('{}').delivery?.sampleRate).toBeUndefined();
  });

  it('a key it does not know is kept', () => {
    const prev = { container: 'mp4', loudness: { target: -14, ceiling: -1 } } as unknown as SavedExportSettings;
    const merged = mergeExportSettings(prev, { ...next, delivery: full }) as unknown as Record<string, unknown>;
    expect(merged.loudness).toEqual({ target: -14, ceiling: -1 });
    const gone = mergeExportSettings(prev, { ...next, delivery: { ...DEFAULT_DELIVERY } }) as unknown as Record<string, unknown>;
    expect(gone.loudness).toEqual({ target: -14, ceiling: -1 });
  });

  it('bad size for and advanced values are ignored', () => {
    expect(parseExportSettings('{"sizeFor":{"width":0,"height":5}}')).toEqual({});
    expect(parseExportSettings('{"sizeFor":{"width":1.5,"height":5}}')).toEqual({});
    expect(parseExportSettings('{"advanced":false}')).toEqual({});
    expect(parseExportSettings('{"advanced":"yes"}')).toEqual({});
  });
});

describe('loudness', () => {
  const store = (start: string | null = null) => {
    const kept: Record<string, string> = start === null ? {} : { [EXPORT_SETTINGS_KEY]: start };
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => kept[k] ?? null,
      setItem: (k: string, v: string) => {
        kept[k] = v;
      },
    });
    return kept;
  };
  const next = { container: 'mp4' as const, quality: 'high' as const, fps: 30, scale: 1 };

  it('loudness is read back', () => {
    expect(parseExportSettings('{"loudness":{"target":-14,"ceiling":-1}}').loudness).toEqual({ target: -14, ceiling: -1 });
    expect(parseExportSettings('{"loudness":{"target":-40,"ceiling":null}}').loudness).toEqual({ target: -36, ceiling: null });
    expect(parseExportSettings('{"loudness":{"target":null,"ceiling":-3}}').loudness).toEqual({ target: null, ceiling: -3 });
  });

  it('a broken loudness is ignored', () => {
    expect(parseExportSettings('{"loudness":5}')).toEqual({});
    expect(parseExportSettings('{"loudness":{"target":"x"}}')).toEqual({});
    expect(parseExportSettings('{"loudness":{"target":null,"ceiling":null}}')).toEqual({});
    expect(parseExportSettings('{"container":"mp4","loudness":[1]}')).toEqual({ container: 'mp4' });
  });

  it('mergeExportSettings keeps loudness', () => {
    const prev = parseExportSettings('{"container":"mp4","loudness":{"target":-16,"ceiling":-1}}');
    expect(mergeExportSettings(prev, next).loudness).toEqual({ target: -16, ceiling: -1 });
    expect(mergeExportSettings(prev, { ...next, delivery: { ...DEFAULT_DELIVERY, sampleRate: 44100 } }).loudness).toEqual({ target: -16, ceiling: -1 });
  });

  it('off deletes the key', () => {
    const prev: SavedExportSettings = { container: 'mp4', loudness: { target: -14, ceiling: -1 } };
    const off = withLoudness(prev, { target: null, ceiling: null });
    expect('loudness' in off).toBe(false);
    expect(off.container).toBe('mp4');
    expect(prev.loudness).toEqual({ target: -14, ceiling: -1 });
    expect(withLoudness({}, { target: null, ceiling: -2 }).loudness).toEqual({ target: null, ceiling: -2 });
    const on = withLoudness(prev, { target: -23, ceiling: null });
    expect(on.loudness).toEqual({ target: -23, ceiling: null });
    expect(prev.loudness).toEqual({ target: -14, ceiling: -1 });
  });

  it('setLoudnessPref saves next to delivery', async () => {
    const kept = store(JSON.stringify({ container: 'webm', delivery: { ...DEFAULT_DELIVERY, sampleRate: 44100 } }));
    const { setLoudnessPref, useLoudnessPref } = await import('./loudnessPrefs');
    setLoudnessPref({ target: -14.04, ceiling: -1 });
    const saved = parseExportSettings(kept[EXPORT_SETTINGS_KEY]!);
    expect(saved.loudness).toEqual({ target: -14, ceiling: -1 });
    expect(saved.delivery?.sampleRate).toBe(44100);
    expect(saved.container).toBe('webm');
    expect(useLoudnessPref.getState().loudness).toEqual({ target: -14, ceiling: -1 });
    setLoudnessPref({ target: null, ceiling: null });
    expect(parseExportSettings(kept[EXPORT_SETTINGS_KEY]!).loudness).toBeUndefined();
    expect(useLoudnessPref.getState().loudness).toEqual({ target: null, ceiling: null });
    vi.stubGlobal('localStorage', undefined);
    expect(() => setLoudnessPref({ target: -16, ceiling: null })).not.toThrow();
    expect(useLoudnessPref.getState().loudness.target).toBe(-16);
  });

  it('measureRate follows the saved rate', async () => {
    const { measureRate } = await import('./loudnessPrefs');
    store(JSON.stringify({ delivery: { ...DEFAULT_DELIVERY, sampleRate: 44100 } }));
    expect(measureRate()).toBe(44100);
    store(JSON.stringify({ delivery: { ...DEFAULT_DELIVERY, sampleRate: 48000 } }));
    expect(measureRate()).toBe(48000);
    store(null);
    expect(measureRate()).toBe(48000);
    vi.stubGlobal('localStorage', undefined);
    expect(measureRate()).toBe(48000);
  });
});
