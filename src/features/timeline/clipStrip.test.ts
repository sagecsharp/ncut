import { describe, expect, it } from 'vitest';
import { FILM_MIN_H, VIDEO_WAVE_MAX, clipBands, filmstripHeight } from './clipStrip';
import { CLIP_LABEL_H } from './layout';

describe('filmstripHeight', () => {
  it('filmstripHeight is 48 up to 48 px, then 96', () => {
    expect(filmstripHeight(24)).toBe(48);
    expect(filmstripHeight(48)).toBe(48);
    expect(filmstripHeight(49)).toBe(96);
    expect(filmstripHeight(232)).toBe(96);
  });
});

describe('clipBands', () => {
  it('clipBands keeps the old wave for h 4 to 101', () => {
    for (let h = 4; h <= 101; h++) {
      const b = clipBands('video', h);
      expect(b.waveTop).toBe(Math.round(0.6 * h));
      expect(b.waveH).toBe(h - Math.round(0.6 * h));
    }
    // a default video lane: inner 48
    expect(clipBands('video', 48)).toEqual({ film: true, waveTop: 29, waveH: 19 });
  });
  it('no film under 24 px', () => {
    expect(FILM_MIN_H).toBe(24);
    expect(clipBands('video', 23).film).toBe(false);
    expect(clipBands('video', 24).film).toBe(true);
    expect(clipBands('audio', 200).film).toBe(false);
  });
  it('the video wave stops at 40 px', () => {
    expect(VIDEO_WAVE_MAX).toBe(40);
    expect(clipBands('video', 100).waveH).toBe(40);
    expect(clipBands('video', 232)).toEqual({ film: true, waveTop: 192, waveH: 40 });
  });
  it('the audio wave fills under the label', () => {
    expect(clipBands('audio', 40)).toEqual({ film: false, waveTop: CLIP_LABEL_H, waveH: 40 - CLIP_LABEL_H });
    expect(clipBands('audio', 232).waveH).toBe(232 - CLIP_LABEL_H);
  });
});
