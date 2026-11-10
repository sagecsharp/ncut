import { describe, expect, it } from 'vitest';
import { DISK_HEADROOM, DISK_MIN_BYTES, expectedExportBytes, openExportSink, wantsDisk } from './sink';

describe('expectedExportBytes', () => {
  it('is the bitrates times the length', () => {
    expect(expectedExportBytes(16_000_000, 0, 60)).toBe(120_000_000);
    expect(expectedExportBytes(64_000_000, 192_000, 600)).toBe(4_814_400_000);
    expect(expectedExportBytes(8_000_000, 0, 0)).toBe(0);
    expect(expectedExportBytes(8_000_000, 0, -3)).toBe(0);
  });
});

describe('wantsDisk', () => {
  it('keeps small exports in memory', () => {
    expect(wantsDisk(DISK_MIN_BYTES - 1, 1e12)).toBe(false);
    expect(wantsDisk(0, null)).toBe(false);
    expect(wantsDisk(Number.NaN, 1e12)).toBe(false);
  });
  it('writes big ones to disk when there is room for the file and its swap file', () => {
    expect(wantsDisk(DISK_MIN_BYTES, 1e12)).toBe(true);
    expect(wantsDisk(4e9, 4e9 * DISK_HEADROOM)).toBe(true);
    expect(wantsDisk(4e9, 4e9 * DISK_HEADROOM - 1)).toBe(false);
    expect(wantsDisk(4e9, 0)).toBe(false);
  });
  it('tries when the browser gives no number', () => {
    expect(wantsDisk(4e9, null)).toBe(true);
  });
  it('takes another threshold (tests force the disk with 0)', () => {
    expect(wantsDisk(1000, 1e9, 0)).toBe(true);
    expect(wantsDisk(1000, 1e9, 2000)).toBe(false);
  });
});

describe('openExportSink', () => {
  it('is a memory sink for a small export', async () => {
    const sink = await openExportSink(1000, 'mp4');
    expect(sink.onDisk).toBe(false);
    await sink.discard();
  });
  it('falls back to memory where there is no file system to write to (node)', async () => {
    const sink = await openExportSink(10e9, 'mp4');
    expect(sink.onDisk).toBe(false);
    // nothing was written: finishing says so instead of handing out an empty file
    await expect(sink.finish('video/mp4')).rejects.toThrow('no data');
  });
});
