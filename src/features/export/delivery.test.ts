import { describe, expect, it } from 'vitest';
import { QUALITY_MEDIUM } from 'mediabunny';
import {
  ALPHA_SHARE,
  DEFAULT_DELIVERY,
  DELIVERY_LABEL,
  TEXT,
  autoAudioBitrate,
  canBeTransparent,
  changedCount,
  deliverySize,
  estimateBytes,
  formatBitrate,
  isDefaultDelivery,
  opusOnly,
  resolveDelivery,
  sameDelivery,
} from './delivery';
import type { ExportDelivery } from './delivery';
import { CODEC_LABEL, outputSize } from './exporter';
import type { ExportContainer } from './exporter';

const ALL: ExportContainer[] = ['mp4', 'webm', 'gif', 'wav', 'ogg', 'png', 'jpg'];
const set = (over: Partial<ExportDelivery>): ExportDelivery => ({ ...DEFAULT_DELIVERY, ...over });

describe('resolveDelivery', () => {
  it('no delivery is the default for every format', () => {
    for (const c of ALL) {
      expect(resolveDelivery(c, undefined)).toEqual({ ...DEFAULT_DELIVERY, notes: [] });
      expect(resolveDelivery(c, DEFAULT_DELIVERY)).toEqual({ ...DEFAULT_DELIVERY, notes: [] });
    }
    expect(isDefaultDelivery(undefined)).toBe(true);
    expect(isDefaultDelivery({ ...DEFAULT_DELIVERY })).toBe(true);
    expect(isDefaultDelivery(set({ bitrate: 1_000_000 }))).toBe(false);
  });

  it('a gif keeps nothing of the advanced choices', () => {
    const all = set({ codec: 'hevc', bitrate: 9_000_000, keySeconds: 1, size: { width: 100, height: 100, fit: 'fill' }, transparent: true, sampleRate: 44100 });
    expect(resolveDelivery('gif', all)).toEqual({ ...DEFAULT_DELIVERY, notes: [] });
  });

  it('each rule with its note', () => {
    // see-through: mp4 and jpg say so, wav and ogg drop it quietly, webm and png keep it
    expect(resolveDelivery('mp4', set({ transparent: true })).notes).toEqual([TEXT.transparentMp4]);
    expect(resolveDelivery('mp4', set({ transparent: true })).transparent).toBe(false);
    expect(resolveDelivery('jpg', set({ transparent: true })).notes).toEqual([TEXT.transparentJpg]);
    expect(resolveDelivery('wav', set({ transparent: true }))).toEqual({ ...DEFAULT_DELIVERY, notes: [] });
    expect(resolveDelivery('ogg', set({ transparent: true })).transparent).toBe(false);
    expect(resolveDelivery('ogg', set({ transparent: true })).notes).toEqual([]);
    expect(resolveDelivery('png', set({ transparent: true })).transparent).toBe(true);
    // a see-through webm is vp9
    const w = resolveDelivery('webm', set({ transparent: true, codec: 'av1' }));
    expect(w.codec).toBe('vp9');
    expect(w.transparent).toBe(true);
    expect(w.notes).toEqual([TEXT.alphaIsVp9]);
    expect(resolveDelivery('webm', set({ transparent: true, codec: 'vp9' })).notes).toEqual([]);
    expect(resolveDelivery('webm', set({ transparent: true })).codec).toBe('vp9');
    // a codec the format cannot hold
    expect(resolveDelivery('webm', set({ codec: 'avc' }))).toEqual({ ...DEFAULT_DELIVERY, notes: [TEXT.webmAuto('h.264')] });
    expect(resolveDelivery('webm', set({ codec: 'av1' })).codec).toBe('av1');
    expect(resolveDelivery('mp4', set({ codec: 'hevc' })).codec).toBe('hevc');
    expect(resolveDelivery('png', set({ codec: 'hevc' })).codec).toBe('auto');
    // bitrate and key frames: mp4 and webm only, 2 s is the usual
    const v = set({ bitrate: 8_000_000, keySeconds: 2 });
    expect(resolveDelivery('mp4', v).bitrate).toBe(8_000_000);
    expect(resolveDelivery('mp4', v).keySeconds).toBeNull();
    expect(resolveDelivery('webm', set({ keySeconds: 4 })).keySeconds).toBe(4);
    for (const c of ['png', 'jpg', 'wav', 'ogg'] as const) {
      expect(resolveDelivery(c, v).bitrate).toBeNull();
      expect(resolveDelivery(c, set({ keySeconds: 4 })).keySeconds).toBeNull();
    }
    // size: video and pictures
    const size = { width: 1080, height: 1920, fit: 'fill' as const };
    for (const c of ['mp4', 'webm', 'png', 'jpg'] as const) expect(resolveDelivery(c, set({ size })).size).toEqual(size);
    for (const c of ['wav', 'ogg', 'gif'] as const) expect(resolveDelivery(c, set({ size })).size).toBeNull();
    // sound codec
    expect(resolveDelivery('webm', set({ audioCodec: 'aac' }))).toEqual({ ...DEFAULT_DELIVERY, notes: [TEXT.webmOpus] });
    expect(resolveDelivery('ogg', set({ audioCodec: 'aac' }))).toEqual({ ...DEFAULT_DELIVERY, notes: [TEXT.oggOpus] });
    expect(resolveDelivery('mp4', set({ audioCodec: 'aac' })).audioCodec).toBe('aac');
    expect(resolveDelivery('webm', set({ audioCodec: 'opus' })).audioCodec).toBe('opus');
    expect(resolveDelivery('wav', set({ audioCodec: 'opus' })).audioCodec).toBe('auto');
    expect(resolveDelivery('png', set({ audioCodec: 'opus' })).audioCodec).toBe('auto');
    // sound bitrate and rate
    for (const c of ['mp4', 'webm', 'ogg'] as const) expect(resolveDelivery(c, set({ audioBitrate: 160_000 })).audioBitrate).toBe(160_000);
    for (const c of ['wav', 'png', 'jpg'] as const) expect(resolveDelivery(c, set({ audioBitrate: 160_000 })).audioBitrate).toBeNull();
    expect(resolveDelivery('wav', set({ sampleRate: 44100 })).sampleRate).toBe(44100);
    expect(resolveDelivery('png', set({ sampleRate: 44100 })).sampleRate).toBe(48000);
    expect(resolveDelivery('png', set({ sampleRate: 44100 })).notes).toEqual([]);
    expect(resolveDelivery('mp4', set({ sampleRate: 44100 })).sampleRate).toBe(44100);
    expect(resolveDelivery('mp4', set({ sampleRate: 44100 })).notes).toEqual([]);
  });

  it('opus is always 48 khz', () => {
    expect(resolveDelivery('webm', set({ sampleRate: 44100 }))).toEqual({ ...DEFAULT_DELIVERY, notes: [TEXT.opusRate] });
    expect(resolveDelivery('ogg', set({ sampleRate: 44100 })).sampleRate).toBe(48000);
    expect(resolveDelivery('ogg', set({ sampleRate: 44100 })).notes).toEqual([TEXT.opusRate]);
    const mp4 = resolveDelivery('mp4', set({ sampleRate: 44100, audioCodec: 'opus' }));
    expect(mp4.sampleRate).toBe(48000);
    expect(mp4.notes).toEqual([TEXT.opusRate]);
    // aac asked of a webm becomes opus first, so the rate is forced too
    expect(resolveDelivery('webm', set({ sampleRate: 44100, audioCodec: 'aac' })).notes).toEqual([TEXT.webmOpus, TEXT.opusRate]);
    expect(opusOnly('mp4', 'auto')).toBe(false);
    expect(opusOnly('mp4', 'opus')).toBe(true);
    expect(opusOnly('webm', 'auto')).toBe(true);
    expect(opusOnly('wav', 'auto')).toBe(false);
  });

  it('knows which formats can be see-through', () => {
    for (const c of ALL) expect(canBeTransparent(c)).toBe(c === 'webm' || c === 'png');
  });
});

describe('deliverySize', () => {
  it('the size is the old size at the defaults', () => {
    for (const [w, h] of [[1920, 1080], [1280, 720], [1080, 1920], [1921, 1081], [1000, 1000]] as const) {
      for (const scale of [1, 0.75, 0.5]) {
        const base = outputSize({ width: w, height: h }, scale);
        for (const c of ALL) expect(deliverySize(base, c, resolveDelivery(c, undefined))).toEqual(base);
      }
    }
  });
  it('a set size is even for a video and as given for a picture', () => {
    const size = { width: 1001, height: 563, fit: 'fit' as const };
    const base = { width: 1920, height: 1080 };
    expect(deliverySize(base, 'mp4', resolveDelivery('mp4', set({ size })))).toEqual({ width: 1002, height: 564 });
    expect(deliverySize(base, 'webm', resolveDelivery('webm', set({ size })))).toEqual({ width: 1002, height: 564 });
    expect(deliverySize(base, 'png', resolveDelivery('png', set({ size })))).toEqual({ width: 1001, height: 563 });
    expect(deliverySize(base, 'gif', resolveDelivery('gif', set({ size })))).toEqual(base);
  });
});

describe('counting and comparing', () => {
  it('counts what differs from auto after the format dropped what it cannot hold', () => {
    expect(changedCount('mp4', undefined)).toBe(0);
    expect(changedCount('mp4', set({ codec: 'hevc', bitrate: 9_000_000, size: { width: 640, height: 360, fit: 'fit' } }))).toBe(3);
    // 2 s is the usual, a size of a gif and the rate of a webm opus are dropped
    expect(changedCount('mp4', set({ keySeconds: 2 }))).toBe(0);
    expect(changedCount('gif', set({ codec: 'hevc', size: { width: 640, height: 360, fit: 'fit' } }))).toBe(0);
    expect(changedCount('webm', set({ sampleRate: 44100 }))).toBe(0);
    expect(changedCount('webm', set({ transparent: true }))).toBe(2);
  });
  it('compares every field, the size by its parts', () => {
    const a = set({ size: { width: 640, height: 360, fit: 'fit' } });
    expect(sameDelivery(a, set({ size: { width: 640, height: 360, fit: 'fit' } }))).toBe(true);
    expect(sameDelivery(a, set({ size: { width: 640, height: 361, fit: 'fit' } }))).toBe(false);
    expect(sameDelivery(a, set({ size: { width: 640, height: 360, fit: 'fill' } }))).toBe(false);
    expect(sameDelivery(a, DEFAULT_DELIVERY)).toBe(false);
    for (const over of [{ codec: 'vp9' }, { bitrate: 1 }, { keySeconds: 1 }, { audioCodec: 'opus' }, { audioBitrate: 128_000 }, { sampleRate: 44100 }, { transparent: true }] as const) {
      expect(sameDelivery(set(over), DEFAULT_DELIVERY)).toBe(false);
    }
  });
});

describe('the estimate', () => {
  it('the four estimates', () => {
    const mp4 = estimateBytes({ container: 'mp4', seconds: 10, frames: 300, videoBitrate: 9_953_280, alpha: false, audio: { codec: 'aac', bitrate: null, sampleRate: 48000 } });
    expect(mp4.total).toBe(12_613_048);
    expect(mp4).toEqual({ video: 12_441_600, alpha: 0, audio: 160_000, overhead: 11_448, total: 12_613_048 });
    const webm = estimateBytes({ container: 'webm', seconds: 4, frames: 120, videoBitrate: 3_538_944, alpha: true, audio: null });
    expect(webm).toEqual({ video: 1_769_472, alpha: 442_368, audio: 0, overhead: 5_536, total: 2_217_376 });
    expect(estimateBytes({ container: 'wav', seconds: 10, frames: 0, videoBitrate: 0, alpha: false, audio: { codec: 'pcm-s16', bitrate: null, sampleRate: 44100 } }).total).toBe(1_764_044);
    expect(estimateBytes({ container: 'ogg', seconds: 10, frames: 0, videoBitrate: 0, alpha: false, audio: { codec: 'opus', bitrate: null, sampleRate: 48000 } }).total).toBe(91_209);
    expect(ALPHA_SHARE).toBe(0.25);
  });
  it('a set sound bitrate is used', () => {
    const e = estimateBytes({ container: 'mp4', seconds: 8, frames: 0, videoBitrate: 0, alpha: false, audio: { codec: 'aac', bitrate: 320_000, sampleRate: 44100 } });
    expect(e.audio).toBe(320_000);
  });
});

describe('helpers', () => {
  it('auto audio bitrate is the medium one', () => {
    const medium = QUALITY_MEDIUM as unknown as { _toAudioBitrate(codec: string): number };
    expect(autoAudioBitrate('aac')).toBe(medium._toAudioBitrate('aac'));
    expect(autoAudioBitrate('opus')).toBe(medium._toAudioBitrate('opus'));
    expect(autoAudioBitrate('vorbis')).toBe(medium._toAudioBitrate('vorbis'));
  });
  it('the labels match CODEC_LABEL', () => {
    for (const k of ['avc', 'hevc', 'av1', 'vp9'] as const) expect(DELIVERY_LABEL[k]).toBe(CODEC_LABEL[k]);
  });
  it('writes a bitrate like the dialog always did', () => {
    expect(formatBitrate(500_000)).toBe('500 kbps');
    expect(formatBitrate(9_953_280)).toBe('10.0 mbps');
    expect(formatBitrate(12_000_000)).toBe('12 mbps');
  });
  it('the texts are lowercase', () => {
    expect(TEXT.noPlan('h.265', 1920, 1080, 60, 20_000_000)).toContain('at 20 mbps');
    expect(TEXT.noPlan('h.265', 1920, 1080, 60, null)).not.toContain('mbps');
    for (const t of [TEXT.transparentMp4, TEXT.opusRate, TEXT.alphaLost, TEXT.noWebcodecs, TEXT.noEncoder('h.265', 'hevc'), TEXT.audioFallback('aac', 192, 48, 'opus')]) {
      expect(t).toBe(t.toLowerCase());
      expect(t).not.toContain('—');
    }
  });
});
