import { describe, expect, it } from 'vitest';
import { deliveryFromArgs } from './deliveryArgs';
import type { DeliveryArgs } from './deliveryArgs';
import { DEFAULT_DELIVERY, TEXT } from './delivery';
import type { ExportContainer } from './exporter';

const project = { width: 1920, height: 1080, fps: 30 };
const run = (container: ExportContainer, args: DeliveryArgs, audio = true) => deliveryFromArgs(container, args, project, audio);
const message = (container: ExportContainer, args: DeliveryArgs, audio = true): string | null => {
  const r = run(container, args, audio);
  return r.ok ? null : r.message;
};
const ok = (container: ExportContainer, args: DeliveryArgs, audio = true) => {
  const r = run(container, args, audio);
  if (!r.ok) throw new Error(r.message);
  return r;
};

describe('deliveryFromArgs', () => {
  it('every error', () => {
    expect(message('mp4', { transparent: true })).toBe('transparent needs format webm or png: an mp4 cannot hold a see-through picture');
    for (const c of ['gif', 'jpg', 'wav', 'ogg'] as const) expect(message(c, { transparent: true })).toBe(`transparent needs format webm or png: a ${c} cannot be see-through`);
    expect(message('webm', { transparent: true })).toBeNull();
    expect(message('png', { transparent: true })).toBeNull();
    expect(message('mp4', { transparent: false })).toBeNull();
    expect(message('webm', { codec: 'h264' })).toBe('a webm holds vp9 or av1: codec h264 needs format mp4');
    expect(message('webm', { codec: 'h265' })).toBe('a webm holds vp9 or av1: codec h265 needs format mp4');
    expect(message('webm', { codec: 'av1' })).toBeNull();
    expect(message('webm', { transparent: true, codec: 'av1' })).toBe('a transparent webm is always vp9: leave codec out or give vp9');
    expect(message('webm', { transparent: true, codec: 'vp9' })).toBeNull();
    expect(message('webm', { transparent: true, codec: 'auto' })).toBeNull();
    // the format error comes before the codec one
    expect(message('mp4', { transparent: true, codec: 'av1' })).toBe('transparent needs format webm or png: an mp4 cannot hold a see-through picture');
    expect(message('mp4', { width: 640 })).toBe('give both width and height, or neither');
    expect(message('mp4', { height: 640 })).toBe('give both width and height, or neither');
    expect(message('mp4', { width: 15, height: 640 })).toBe('width and height are 16 to 8192 pixels');
    expect(message('mp4', { width: 640, height: 8193 })).toBe('width and height are 16 to 8192 pixels');
    expect(message('mp4', { width: 16, height: 8192 })).toBeNull();
    expect(message('mp4', { bitrate_mbps: 0.4 })).toBe('bitrate_mbps is 0.5 to 240');
    expect(message('mp4', { bitrate_mbps: 241 })).toBe('bitrate_mbps is 0.5 to 240');
    expect(message('mp4', { bitrate_mbps: 0.5 })).toBeNull();
    expect(message('mp4', { bitrate_mbps: 240 })).toBeNull();
    expect(message('mp4', { key_seconds: 3 })).toBe('key_seconds is one of 0.5, 1, 2, 4, 5, 10');
    expect(message('mp4', { key_seconds: 0.5 })).toBeNull();
    expect(message('mp4', { audio_kbps: 100 })).toBe('audio_kbps is one of 128, 160, 192, 256, 320');
    expect(message('mp4', { audio_kbps: 320 })).toBeNull();
    expect(message('mp4', { sample_rate: 32000 })).toBe('sample_rate is 44100 or 48000');
    expect(message('mp4', { sample_rate: 44100 })).toBeNull();
    expect(message('webm', { audio_codec: 'aac' })).toBe('a webm holds opus sound: audio_codec aac needs format mp4');
    expect(message('ogg', { audio_codec: 'aac' })).toBe('a ogg holds opus sound: audio_codec aac needs format mp4');
    expect(message('mp4', { audio_codec: 'aac' })).toBeNull();
    // a bad value is an error even where the format would ignore it
    expect(message('wav', { bitrate_mbps: 999 })).toBe('bitrate_mbps is 0.5 to 240');
    expect(message('mp4', { preset: 'nope' as DeliveryArgs['preset'] })).toContain('preset is one of youtube-1080');
  });

  it('every note', () => {
    // the arguments a format does not use
    expect(ok('gif', { bitrate_mbps: 8 }).notes).toEqual(['bitrate_mbps does not apply to a gif and was ignored']);
    expect(ok('gif', { bitrate_mbps: 8, key_seconds: 1, width: 640, height: 360 }).notes).toEqual(['bitrate_mbps, key_seconds, width and height do not apply to a gif and were ignored']);
    expect(ok('wav', { width: 640, height: 360, fit: 'fill', audio_kbps: 192 }).notes).toEqual(['width, height, fit and audio_kbps do not apply to a wav and were ignored']);
    expect(ok('png', { audio_kbps: 192, sample_rate: 44100, key_seconds: 1 }).notes).toEqual(['key_seconds, audio_kbps and sample_rate do not apply to a png and were ignored']);
    expect(ok('wav', { sample_rate: 44100 }).notes).toEqual([]);
    // no sound in the file
    expect(ok('mp4', { audio_kbps: 192 }, false).notes).toEqual(['audio_kbps was ignored: the file has no sound']);
    expect(ok('mp4', { audio_codec: 'opus', audio_kbps: 192, sample_rate: 44100 }, false).notes).toEqual(['audio_codec, audio_kbps and sample_rate were ignored: the file has no sound']);
    // the preset made for mp4
    expect(ok('webm', { preset: 'reels' }).notes).toEqual(["the preset is made for mp4, format webm was kept and the preset's size and sound were used where they fit", TEXT.webmOpus]);
    // the notes of the format come after its own
    expect(ok('webm', { sample_rate: 44100, bitrate_mbps: 8 }).notes).toEqual([TEXT.opusRate]);
    // its own notes first, then the format's
    expect(ok('ogg', { width: 640, height: 360, sample_rate: 44100 }).notes).toEqual(['width and height do not apply to a ogg and were ignored', TEXT.opusRate]);
    expect(ok('mp4', { sample_rate: 44100, audio_codec: 'opus' }).notes).toEqual([TEXT.opusRate]);
    expect(ok('webm', { transparent: true, codec: 'vp9' }).notes).toEqual([]);
  });

  it('h264 is avc', () => {
    expect(ok('mp4', { codec: 'h264' }).delivery).toEqual({ ...DEFAULT_DELIVERY, codec: 'avc' });
    expect(ok('mp4', { codec: 'h265' }).delivery?.codec).toBe('hevc');
    expect(ok('mp4', { codec: 'av1' }).delivery?.codec).toBe('av1');
    expect(ok('mp4', { codec: 'vp9' }).delivery?.codec).toBe('vp9');
    expect(ok('webm', { codec: 'vp9' }).delivery?.codec).toBe('vp9');
    expect(ok('mp4', { codec: 'auto' }).delivery).toBeUndefined();
  });

  it('turns every argument into its field', () => {
    const r = ok('mp4', { bitrate_mbps: 12.3456789, key_seconds: 4, width: 1280.4, height: 721, fit: 'fill', audio_codec: 'opus', audio_kbps: 160, sample_rate: 44100 });
    expect(r.delivery).toEqual({
      ...DEFAULT_DELIVERY,
      bitrate: 12_345_679,
      keySeconds: 4,
      size: { width: 1280, height: 721, fit: 'fill' },
      audioCodec: 'opus',
      audioBitrate: 160_000,
      sampleRate: 48000,
    });
    expect(r.notes).toEqual([TEXT.opusRate]);
    expect(r.preset).toBeNull();
    expect(ok('webm', { transparent: true }).delivery).toEqual({ ...DEFAULT_DELIVERY, codec: 'vp9', transparent: true });
    // a size with no fit fits; 2 s is the usual
    expect(ok('png', { width: 100, height: 100 }).delivery?.size).toEqual({ width: 100, height: 100, fit: 'fit' });
    expect(ok('mp4', { key_seconds: 2 }).delivery).toBeUndefined();
    // a format drops what it cannot use
    expect(ok('png', { bitrate_mbps: 8, width: 100, height: 100 }).delivery).toEqual({ ...DEFAULT_DELIVERY, size: { width: 100, height: 100, fit: 'fit' } });
    expect(ok('ogg', { audio_kbps: 128, sample_rate: 44100 }).delivery).toEqual({ ...DEFAULT_DELIVERY, audioBitrate: 128_000 });
  });

  it('a preset with overrides', () => {
    const plain = ok('mp4', { preset: 'youtube-1080' });
    expect(plain.preset?.id).toBe('youtube-1080');
    expect(plain.delivery).toEqual({ ...DEFAULT_DELIVERY, size: { width: 1920, height: 1080, fit: 'fit' }, audioCodec: 'aac', audioBitrate: 192_000 });
    expect(plain.notes).toEqual([]);
    // given arguments win over what the preset sets
    const over = ok('mp4', { preset: 'vimeo', bitrate_mbps: 10, audio_kbps: 128, fit: 'fill', codec: 'h265' });
    expect(over.delivery).toEqual({ ...DEFAULT_DELIVERY, codec: 'hevc', size: { width: 1920, height: 1080, fit: 'fill' }, bitrate: 10_000_000, audioCodec: 'aac', audioBitrate: 128_000 });
    // a size given beats the preset's size, the preset's fit stays
    expect(ok('mp4', { preset: 'reels', width: 720, height: 1280 }).delivery?.size).toEqual({ width: 720, height: 1280, fit: 'fit' });
    // the master bitrate comes from the project
    const master = deliveryFromArgs('mp4', { preset: 'master' }, { width: 1280, height: 720, fps: 60 }, true);
    expect(master.ok && master.delivery?.bitrate).toBe(Math.min(240_000_000, 3 * Math.round(1280 * 720 * 30 * 0.16 * Math.pow(2, 0.7))));
    expect(master.ok && master.delivery?.keySeconds).toBe(1);
    // another format keeps going with a note
    const webm = ok('webm', { preset: 'youtube-4k' });
    expect(webm.notes[0]).toBe("the preset is made for mp4, format webm was kept and the preset's size and sound were used where they fit");
    expect(webm.delivery?.size).toEqual({ width: 3840, height: 2160, fit: 'fit' });
    // aac does not fit a webm: the format puts it back to auto and says so
    expect(webm.delivery?.audioCodec).toBe('auto');
    expect(webm.notes[1]).toBe(TEXT.webmOpus);
    // no sound in the file: the preset's sound goes too
    const mute = ok('mp4', { preset: 'youtube-1080' }, false);
    expect(mute.delivery).toEqual({ ...DEFAULT_DELIVERY, size: { width: 1920, height: 1080, fit: 'fit' } });
  });

  it('the default gives undefined', () => {
    for (const c of ['mp4', 'webm', 'gif', 'wav', 'ogg', 'png', 'jpg'] as const) {
      const r = ok(c, {});
      expect(r.delivery).toBeUndefined();
      expect(r.notes).toEqual([]);
      expect(r.preset).toBeNull();
    }
    expect(ok('mp4', { transparent: false }).delivery).toBeUndefined();
    expect(ok('mp4', { codec: 'auto', bitrate_mbps: undefined }).delivery).toBeUndefined();
  });
});
