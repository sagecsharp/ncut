import { describe, expect, it } from 'vitest';
import {
  avcCodecString,
  avcCodecStringOf,
  avcLengthSize,
  avcLevel,
  avcLevelOf,
  pickEncoderSetup,
  raiseAvcLevel,
  raiseAvcLevelInPacket,
  scaledBitrate,
} from './encoderSetup';

describe('avcLevel', () => {
  it('is the level a size and frame rate need', () => {
    expect(avcLevel(1280, 720, 30, 5e6)).toBe(0x1f); // 3.1
    expect(avcLevel(1280, 720, 60, 5e6)).toBe(0x20); // 3.2
    expect(avcLevel(1920, 1080, 30, 10e6)).toBe(0x28); // 4
    expect(avcLevel(1920, 1080, 30, 30e6)).toBe(0x29); // 4.1, for the bitrate
    expect(avcLevel(1920, 1080, 60, 16e6)).toBe(0x2a); // 4.2
    expect(avcLevel(1920, 1080, 120, 30e6)).toBe(0x33); // 5.1
    expect(avcLevel(1920, 1080, 240, 40e6)).toBe(0x34); // 5.2
    expect(avcLevel(2560, 1440, 30, 20e6)).toBe(0x32); // 5
    expect(avcLevel(2560, 1440, 60, 30e6)).toBe(0x33); // 5.1
    expect(avcLevel(3840, 2160, 30, 40e6)).toBe(0x33); // 5.1
    expect(avcLevel(3840, 2160, 60, 65e6)).toBe(0x34); // 5.2
    expect(avcLevel(3840, 2160, 120, 100e6)).toBe(0x3c); // 6
    expect(avcLevel(3840, 2160, 240, 200e6)).toBe(0x3d); // 6.1
  });
  it('never goes down with more pixels, frames or bits, and ends at the highest level', () => {
    let last = 0;
    for (const fps of [24, 30, 60, 120, 240]) {
      const l = avcLevel(1920, 1080, fps, 10e6);
      expect(l).toBeGreaterThanOrEqual(last);
      last = l;
    }
    expect(avcLevel(16384, 16384, 240, 1e9)).toBe(0x3e);
  });
  it('writes the codec string of high profile', () => {
    expect(avcCodecString(3840, 2160, 60, 65e6)).toBe('avc1.640034');
    expect(avcCodecString(320, 240, 15, 100_000)).toBe('avc1.64000c');
  });
});

describe('scaledBitrate', () => {
  it('keeps the bits of a frame', () => {
    expect(scaledBitrate(60e6, 30, 60)).toBe(30e6);
    expect(scaledBitrate(40e6, 120, 240)).toBe(20e6);
    expect(scaledBitrate(10e6, 60, 60)).toBe(10e6);
    // per frame: the same number before and after
    expect(scaledBitrate(64_676_604, 30, 60) / 30).toBeCloseTo(64_676_604 / 60, 0);
    expect(scaledBitrate(1, 30, 240)).toBe(1);
  });
});

describe('pickEncoderSetup', () => {
  type Asked = { frameRate?: number; hardwareAcceleration?: string; fullCodecString?: string; width?: number };
  /** an encoder list like chromium on windows: the gpu takes full hd up to 120 fps and anything bigger up to 30 */
  const windows = (asked: Asked[] = []) => async (_codec: string, o: Asked) => {
    asked.push(o);
    if (o.hardwareAcceleration !== 'prefer-hardware') return true;
    return (o.width ?? 0) <= 1920 ? (o.frameRate ?? 0) <= 120 : (o.frameRate ?? 0) <= 30;
  };
  const pick = (w: number, h: number, fps: number, can: ReturnType<typeof windows>) =>
    pickEncoderSetup('avc', w, h, fps, 50e6, can as unknown as Parameters<typeof pickEncoderSetup>[5]);

  it('arranges nothing when the gpu takes the real frame rate', async () => {
    expect(await pick(3840, 2160, 30, windows())).toBeNull();
    expect(await pick(2560, 1440, 24, windows())).toBeNull();
  });
  it('leaves full hd and smaller alone, whatever the frame rate', async () => {
    const asked: Asked[] = [];
    expect(await pick(1920, 1080, 240, windows(asked))).toBeNull();
    expect(await pick(1280, 720, 240, windows(asked))).toBeNull();
    expect(asked.length).toBe(0);
  });
  it('tells the highest rate the gpu takes, with the level of the real one', async () => {
    expect(await pick(3840, 2160, 60, windows())).toEqual({ fps: 30, codecString: 'avc1.640034' });
    expect(await pick(2560, 1440, 240, windows())).toEqual({ fps: 30, codecString: 'avc1.64003c' });
    // a gpu that takes big pictures up to 60
    const better = async (_c: string, o: Asked) => o.hardwareAcceleration !== 'prefer-hardware' || (o.frameRate ?? 0) <= 60;
    expect(await pickEncoderSetup('avc', 3840, 2160, 240, 50e6, better as unknown as Parameters<typeof pickEncoderSetup>[5])).toEqual({
      fps: 60,
      codecString: 'avc1.64003d',
    });
  });
  it('drops the codec string when the encoder does not take it, and asks with the scaled bitrate', async () => {
    const asked: Array<Asked & { quality?: unknown }> = [];
    const picky = async (_c: string, o: Asked) => {
      asked.push(o);
      return o.hardwareAcceleration === 'prefer-hardware' && (o.frameRate ?? 0) <= 30 && !o.fullCodecString;
    };
    expect(await pickEncoderSetup('avc', 3840, 2160, 60, 50e6, picky as unknown as Parameters<typeof pickEncoderSetup>[5])).toEqual({ fps: 30 });
    expect(asked.every((o) => o.hardwareAcceleration === 'prefer-hardware')).toBe(true);
  });
  it('gives up when there is no gpu encoder, or the question throws', async () => {
    expect(await pickEncoderSetup('vp9', 3840, 2160, 60, 50e6, (async () => false) as unknown as Parameters<typeof pickEncoderSetup>[5])).toBeNull();
    const broken = async () => {
      throw new Error('no');
    };
    expect(await pickEncoderSetup('avc', 3840, 2160, 60, 50e6, broken as unknown as Parameters<typeof pickEncoderSetup>[5])).toBeNull();
    expect(await pick(3840, 2160, 0, windows())).toBeNull();
  });
  it('has no codec string for other codecs', async () => {
    expect(await pickEncoderSetup('hevc', 3840, 2160, 60, 50e6, windows() as unknown as Parameters<typeof pickEncoderSetup>[5])).toEqual({ fps: 30 });
  });
});

describe('the h264 level in the file', () => {
  // avcC: version 1, high profile, flags 0, level 5.1, 4 byte lengths, one sps of 6 bytes, one pps of 3
  const record = () => Uint8Array.of(1, 0x64, 0x00, 0x33, 0xff, 0xe1, 0, 6, 0x67, 0x64, 0x00, 0x33, 0xac, 0xd9, 1, 0, 3, 0x68, 0xeb, 0xe3);

  it('reads the record', () => {
    expect(avcLevelOf(record())).toBe(0x33);
    expect(avcLengthSize(record())).toBe(4);
    expect(avcCodecStringOf(record())).toBe('avc1.640033');
    expect(avcLevelOf(Uint8Array.of(0, 1, 2))).toBeNull();
  });
  it('raises the level in the record and its sps, on a copy', () => {
    const before = record();
    const raised = raiseAvcLevel(before, 0x34)!;
    expect(raised).not.toBe(before);
    expect(before[3]).toBe(0x33);
    expect(raised[3]).toBe(0x34);
    expect(raised[11]).toBe(0x34);
    expect(avcCodecStringOf(raised)).toBe('avc1.640034');
    // nothing else moved
    const rest = (a: Uint8Array) => [...a].filter((_, i) => i !== 3 && i !== 11);
    expect(rest(raised)).toEqual(rest(before));
  });
  it('leaves a record alone that already says enough, and bytes that are not a record', () => {
    expect(raiseAvcLevel(record(), 0x33)).toBeNull();
    expect(raiseAvcLevel(record(), 0x28)).toBeNull();
    expect(raiseAvcLevel(Uint8Array.of(1, 2, 3), 0x34)).toBeNull();
    // an sps length that runs past the end
    expect(raiseAvcLevel(Uint8Array.of(1, 0x64, 0, 0x33, 0xff, 0xe1, 0, 99, 0x67, 0x64, 0, 0x33), 0x34)).toBeNull();
  });
  it('raises the level of an sps inside a packet and leaves the other nal units alone', () => {
    const sps = [0x67, 0x64, 0x00, 0x33, 0xac];
    const pps = [0x68, 0xeb, 0xe3];
    // a slice whose fourth byte looks like a low level: must not be touched
    const idr = [0x65, 0x88, 0x84, 0x00, 0x33, 0xff];
    const pack = (...nals: number[][]) => Uint8Array.from(nals.flatMap((n) => [0, 0, 0, n.length, ...n]));
    const key = pack(sps, pps, idr);
    const out = raiseAvcLevelInPacket(key, 4, 0x34);
    expect(out).not.toBe(key);
    expect(out[7]).toBe(0x34);
    expect([...out].filter((_, i) => i !== 7)).toEqual([...key].filter((_, i) => i !== 7));
    // nothing to do: the same bytes come back
    const delta = pack(idr);
    expect(raiseAvcLevelInPacket(delta, 4, 0x34)).toBe(delta);
    expect(raiseAvcLevelInPacket(out, 4, 0x34)).toBe(out);
    // broken lengths end the walk without throwing
    const broken = Uint8Array.of(0, 0, 0, 200, 0x67, 0x64, 0, 0x33);
    expect(raiseAvcLevelInPacket(broken, 4, 0x34)).toBe(broken);
  });
});
