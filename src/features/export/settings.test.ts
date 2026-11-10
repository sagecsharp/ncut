import { describe, expect, it } from 'vitest';
import { mergeExportSettings, parseExportSettings } from './settings';

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
