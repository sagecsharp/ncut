import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEXT } from './delivery';
import { probeAudio, probeVideoCodecs } from './deliveryProbe';
import type { AudioAsk, CanEncodeAudio, VideoAsk } from './deliveryProbe';
import type { CanEncodeVideo } from './exporter';
import { videoBitrate } from './exporter';

const ask = (over: Partial<VideoAsk> = {}): VideoAsk => ({ container: 'mp4', width: 1920, height: 1080, fps: 30, quality: 'high', bitrate: null, transparent: false, ...over });

type Call = { codec: string; width: number; height: number; fps: number; bitrate: number | undefined; hw: string | undefined; full: string | undefined };

/** a can driven by a rule, recording every question */
function fake(rule: (c: Call) => boolean): { can: CanEncodeVideo; calls: Call[] } {
  const calls: Call[] = [];
  const can: CanEncodeVideo = async (codec, o) => {
    const call: Call = {
      codec,
      width: o.width!,
      height: o.height!,
      fps: o.frameRate!,
      bitrate: (o.quality as unknown as { _bitrate?: number })._bitrate,
      hw: o.hardwareAcceleration,
      full: o.fullCodecString,
    };
    calls.push(call);
    return rule(call);
  };
  return { can, calls };
}

describe('probeVideoCodecs', () => {
  beforeEach(() => {
    vi.stubGlobal('VideoEncoder', function () {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('each reason in order', async () => {
    // a webm does not hold h.264 or h.265, whatever the machine says
    const all = fake(() => true);
    const webm = await probeVideoCodecs(ask({ container: 'webm' }), { can: all.can });
    expect(webm.avc).toEqual({ ok: false, reason: TEXT.webmHolds('h.264') });
    expect(webm.hevc).toEqual({ ok: false, reason: TEXT.webmHolds('h.265') });
    expect(webm.av1?.ok).toBe(true);
    expect(webm.vp9?.ok).toBe(true);
    // see-through is vp9 only
    const alpha = await probeVideoCodecs(ask({ container: 'webm', transparent: true }), { can: all.can });
    expect(alpha.av1).toEqual({ ok: false, reason: TEXT.alphaIsVp9Button });
    expect(alpha.vp9?.ok).toBe(true);
    // no webcodecs
    vi.stubGlobal('VideoEncoder', undefined);
    const none = await probeVideoCodecs(ask(), { can: all.can });
    for (const k of ['avc', 'hevc', 'av1', 'vp9'] as const) expect(none[k]).toEqual({ ok: false, reason: TEXT.noWebcodecs });
    vi.stubGlobal('VideoEncoder', function () {});
    // no encoder at all: even 720p30 is a no
    const noEnc = fake((c) => c.codec !== 'hevc');
    const r1 = await probeVideoCodecs(ask(), { can: noEnc.can });
    expect(r1.hevc).toEqual({ ok: false, reason: TEXT.noEncoder('h.265', 'hevc') });
    expect(r1.hevc && !r1.hevc.ok && r1.hevc.reason).toContain('graphics card');
    expect(r1.avc?.ok).toBe(true);
    // too big: 720p30 is fine, the size is not
    const big = fake((c) => c.width <= 1280);
    const r2 = await probeVideoCodecs(ask({ width: 3840, height: 2160 }), { can: big.can, only: 'avc' });
    expect(r2.avc).toEqual({ ok: false, reason: TEXT.tooBig('h.264', 3840, 2160) });
    // too fast: the size at 30 is fine, 120 fps is not
    const fast = fake((c) => c.fps <= 30);
    const r3 = await probeVideoCodecs(ask({ fps: 120 }), { can: fast.can, only: 'avc' });
    expect(r3.avc).toEqual({ ok: false, reason: TEXT.tooFast('h.264', 1920, 1080, 120) });
    // too much bitrate: a medium file is fine, the asked bitrate is not
    const rate = fake((c) => (c.bitrate ?? 0) < 50_000_000);
    const r4 = await probeVideoCodecs(ask({ bitrate: 80_000_000 }), { can: rate.can, only: 'avc' });
    expect(r4.avc).toEqual({ ok: false, reason: TEXT.tooMuchBitrate('h.264', 80) });
    // a can that throws is a no
    const boom = await probeVideoCodecs(ask(), {
      can: async () => {
        throw new Error('gpu process gone');
      },
      only: 'vp9',
    });
    expect(boom.vp9?.ok).toBe(false);
  });

  it('a yes carries the bitrate it was asked at', async () => {
    const { can, calls } = fake(() => true);
    const r = await probeVideoCodecs(ask(), { can, only: 'hevc' });
    expect(r.hevc).toMatchObject({ ok: true, bitrate: videoBitrate(1920, 1080, 30, 'high', 'hevc') });
    expect(calls[0]!.bitrate).toBe(videoBitrate(1920, 1080, 30, 'high', 'hevc'));
    const custom = await probeVideoCodecs(ask({ bitrate: 12_000_000 }), { can, only: 'hevc' });
    expect(custom.hevc).toMatchObject({ ok: true, bitrate: 12_000_000 });
  });

  it('gpu both ways', async () => {
    const hw = fake(() => true);
    expect((await probeVideoCodecs(ask(), { can: hw.can, only: 'avc' })).avc).toEqual({ ok: true, bitrate: videoBitrate(1920, 1080, 30, 'high', 'avc'), gpu: true });
    expect(hw.calls.map((c) => c.hw)).toEqual([undefined, 'prefer-hardware']);
    // software only: the plain question is a yes, the hardware one a no
    const sw = fake((c) => c.hw === undefined);
    const r = await probeVideoCodecs(ask(), { can: sw.can, only: 'avc' });
    expect(r.avc).toMatchObject({ ok: true, gpu: false });
    // above full hd the arranged setup (a told lower rate) can still get the graphics card
    const told = fake((c) => c.hw === undefined || c.fps <= 30);
    const r2 = await probeVideoCodecs(ask({ width: 3840, height: 2160, fps: 60 }), { can: told.can, only: 'avc' });
    expect(r2.avc).toMatchObject({ ok: true, gpu: true });
    // and not when no rate helps
    const never = fake((c) => c.hw === undefined);
    expect((await probeVideoCodecs(ask({ width: 3840, height: 2160, fps: 60 }), { can: never.can, only: 'avc' })).avc).toMatchObject({ ok: true, gpu: false });
  });

  it('no gpu setup when see-through', async () => {
    const told = fake((c) => c.hw === undefined || c.fps <= 30);
    const r = await probeVideoCodecs(ask({ container: 'webm', width: 3840, height: 2160, fps: 60, transparent: true }), { can: told.can, only: 'vp9' });
    expect(r.vp9).toMatchObject({ ok: true, gpu: false });
    // the plain question and the hardware one, nothing else
    expect(told.calls).toHaveLength(2);
  });

  it('only asks one codec', async () => {
    const { can, calls } = fake(() => true);
    const r = await probeVideoCodecs(ask(), { can, only: 'av1' });
    expect(Object.keys(r)).toEqual(['av1']);
    expect(new Set(calls.map((c) => c.codec))).toEqual(new Set(['av1']));
    const everything = fake(() => true);
    await probeVideoCodecs(ask(), { can: everything.can });
    expect(new Set(everything.calls.map((c) => c.codec))).toEqual(new Set(['avc', 'hevc', 'av1', 'vp9']));
  });

  it('stops when aborted', async () => {
    const early = new AbortController();
    early.abort();
    const { can, calls } = fake(() => true);
    await expect(probeVideoCodecs(ask(), { can, signal: early.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(0);
    // aborted between two codecs: the next is not asked
    const mid = new AbortController();
    const seen: string[] = [];
    const can2: CanEncodeVideo = async (codec) => {
      seen.push(codec);
      mid.abort();
      return true;
    };
    const err = await probeVideoCodecs(ask(), { can: can2, signal: mid.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
    expect(new Set(seen)).toEqual(new Set(['avc']));
  });
});

describe('probeAudio', () => {
  const audioAsk = (over: Partial<AudioAsk> = {}): AudioAsk => ({ container: 'mp4', codec: 'aac', sampleRate: 48000, ...over });
  type ACall = { codec: string; rate: number | undefined; bitrate: number | undefined };
  const fakeAudio = (rule: (c: ACall) => boolean): { can: CanEncodeAudio; calls: ACall[] } => {
    const calls: ACall[] = [];
    const can: CanEncodeAudio = async (codec, o) => {
      const call = { codec, rate: o?.sampleRate, bitrate: (o?.quality as unknown as { _bitrate?: number } | undefined)?._bitrate };
      calls.push(call);
      return rule(call);
    };
    return { can, calls };
  };

  it('audio reasons', async () => {
    // a windows like machine: aac up to 192 kbps
    const win = fakeAudio((c) => c.codec !== 'aac' || (c.bitrate ?? 0) <= 192_000);
    const r = await probeAudio(audioAsk(), { can: win.can });
    expect(r.codecs.aac).toEqual({ ok: true });
    expect(r.codecs.opus).toEqual({ ok: true });
    expect(r.kbps[128]).toEqual({ ok: true });
    expect(r.kbps[192]).toEqual({ ok: true });
    expect(r.kbps[256]).toEqual({ ok: false, reason: TEXT.kbpsMax('aac', 192) });
    expect(r.kbps[320]).toEqual({ ok: false, reason: TEXT.kbpsMax('aac', 192) });
    // nothing at any rate
    const none = fakeAudio(() => false);
    const n = await probeAudio(audioAsk(), { can: none.can });
    expect(n.codecs.aac).toEqual({ ok: false, reason: TEXT.audioNo('aac') });
    expect(n.kbps[128]).toEqual({ ok: false, reason: TEXT.kbpsNone('aac', 128) });
    expect(n.rates[44100]).toEqual({ ok: false, reason: TEXT.rateNo('aac', 44.1) });
    expect(n.rates[48000]).toEqual({ ok: false, reason: TEXT.rateNo('aac', 48) });
    // a webm and an ogg hold no aac, without asking the machine about it
    const web = fakeAudio(() => true);
    const w = await probeAudio(audioAsk({ container: 'webm', codec: 'opus' }), { can: web.can });
    expect(w.codecs.aac).toEqual({ ok: false, reason: TEXT.webmAac });
    expect(w.codecs.opus).toEqual({ ok: true });
    expect(web.calls.some((c) => c.codec === 'aac')).toBe(false);
    const ogg = await probeAudio(audioAsk({ container: 'ogg', codec: 'opus' }), { can: fakeAudio(() => true).can });
    expect(ogg.codecs.aac).toEqual({ ok: false, reason: TEXT.oggAac });
    // a mp4 aac at both rates is fine
    expect(r.rates[44100]).toEqual({ ok: true });
    expect(r.rates[48000]).toEqual({ ok: true });
  });

  it('44.1 khz is not asked for opus', async () => {
    const { can, calls } = fakeAudio(() => true);
    const r = await probeAudio(audioAsk({ container: 'webm', codec: 'opus', sampleRate: 44100 }), { can });
    expect(r.rates[44100]).toEqual({ ok: false, reason: TEXT.rateOpus });
    expect(r.rates[48000]).toEqual({ ok: true });
    expect(calls.filter((c) => c.codec === 'opus').every((c) => c.rate === 48000)).toBe(true);
    // an mp4 with opus asked is the same
    const mp4 = fakeAudio(() => true);
    const o = await probeAudio(audioAsk({ codec: 'opus' }), { can: mp4.can });
    expect(o.rates[44100]).toEqual({ ok: false, reason: TEXT.rateOpus });
    expect(mp4.calls.filter((c) => c.codec === 'opus').every((c) => c.rate === 48000)).toBe(true);
    // aac keeps the asked rate
    const aac = fakeAudio(() => true);
    await probeAudio(audioAsk({ sampleRate: 44100 }), { can: aac.can });
    expect(aac.calls.filter((c) => c.codec === 'aac' && c.bitrate !== undefined).every((c) => c.rate === 44100)).toBe(true);
  });

  it('stops when aborted', async () => {
    const stop = new AbortController();
    stop.abort();
    const { can, calls } = fakeAudio(() => true);
    await expect(probeAudio(audioAsk(), { can, signal: stop.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(0);
  });
});
