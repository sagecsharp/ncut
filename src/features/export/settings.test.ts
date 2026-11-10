import { describe, expect, it } from 'vitest';
import { parseExportSettings } from './settings';

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
