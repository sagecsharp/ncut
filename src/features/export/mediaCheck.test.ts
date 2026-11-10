import { describe, expect, it } from 'vitest';
import type { Project } from '../../types';
import { IMAGE_HEAD_BYTES, checkPartsMedia, imageKindOf } from './mediaCheck';

const bytes = (...parts: Array<string | number[]>): Uint8Array => {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === 'string') for (const ch of p) out.push(ch.charCodeAt(0));
    else out.push(...p);
  }
  while (out.length < IMAGE_HEAD_BYTES) out.push(0);
  return Uint8Array.from(out);
};

const PNG = bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], [0, 16], 'JFIF');
const WEBP = bytes('RIFF', [1, 2, 3, 4], 'WEBPVP8 ');
const AVIF = bytes([0, 0, 0, 28], 'ftyp', 'avif', [0, 0, 0, 0], 'mif1', 'miaf', 'MA1B');
const AVIF_COMPAT = bytes([0, 0, 0, 28], 'ftyp', 'mif1', [0, 0, 0, 0], 'mif1', 'avif', 'miaf');
const HEIC = bytes([0, 0, 0, 24], 'ftyp', 'heic', [0, 0, 0, 0], 'mif1', 'heic');
const SVG = bytes('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');

describe('imageKindOf', () => {
  it('knows the raster formats every thread decodes', () => {
    expect(imageKindOf(PNG)).toBe('png');
    expect(imageKindOf(JPEG)).toBe('jpeg');
    expect(imageKindOf(bytes('GIF89a'))).toBe('gif');
    expect(imageKindOf(bytes('GIF87a'))).toBe('gif');
    expect(imageKindOf(WEBP)).toBe('webp');
    expect(imageKindOf(bytes('BM', [1, 2, 3, 4]))).toBe('bmp');
    expect(imageKindOf(AVIF)).toBe('avif');
    expect(imageKindOf(AVIF_COMPAT)).toBe('avif');
  });
  it('says null for everything else', () => {
    expect(imageKindOf(SVG)).toBeNull();
    expect(imageKindOf(HEIC)).toBeNull();
    expect(imageKindOf(bytes('<?xml version="1.0"?><svg/>'))).toBeNull();
    expect(imageKindOf(bytes([0, 0, 1, 0]))).toBeNull();
    expect(imageKindOf(new Uint8Array(0))).toBeNull();
    expect(imageKindOf(Uint8Array.of(0xff, 0xd8))).toBeNull();
    // a riff file that is not a picture (wav)
    expect(imageKindOf(bytes('RIFF', [1, 2, 3, 4], 'WAVEfmt '))).toBeNull();
    // an mp4 video
    expect(imageKindOf(bytes([0, 0, 0, 24], 'ftyp', 'isom', [0, 0, 2, 0], 'isom', 'mp41'))).toBeNull();
  });
  it('does not read brands past the ftyp box', () => {
    // box of 16 bytes (major brand only), the letters "avif" follow in the next box
    expect(imageKindOf(bytes([0, 0, 0, 16], 'ftyp', 'isom', [0, 0, 0, 0], 'avif'))).toBeNull();
  });
});

function project(clips: Array<{ type: string; assetId: string; trackId: string }>, hiddenTracks: string[] = []): Project {
  return {
    tracks: [
      { id: 'v', kind: 'video', hidden: hiddenTracks.includes('v') },
      { id: 'v2', kind: 'video', hidden: hiddenTracks.includes('v2') },
      { id: 'a', kind: 'audio' },
    ],
    clips,
  } as unknown as Project;
}

describe('checkPartsMedia', () => {
  const files = new Map<string, Blob>([
    ['png', new Blob([PNG as BlobPart])],
    ['jpg', new Blob([JPEG as BlobPart])],
    ['svg', new Blob([SVG as BlobPart])],
  ]);
  const blobOf = (id: string) => files.get(id);

  it('is fine with raster pictures', async () => {
    const r = await checkPartsMedia(
      project([
        { type: 'image', assetId: 'png', trackId: 'v' },
        { type: 'image', assetId: 'jpg', trackId: 'v2' },
        { type: 'text', assetId: '', trackId: 'v' },
      ]),
      blobOf,
    );
    expect(r).toEqual({ images: true, lenient: [] });
  });
  it('sees a picture only an <img> can show, whatever its name says', async () => {
    const r = await checkPartsMedia(
      project([
        { type: 'image', assetId: 'png', trackId: 'v' },
        { type: 'image', assetId: 'svg', trackId: 'v' },
      ]),
      blobOf,
    );
    expect(r.images).toBe(false);
  });
  it('ignores clips that are never drawn and files that are missing', async () => {
    const r = await checkPartsMedia(
      project(
        [
          { type: 'image', assetId: 'svg', trackId: 'v2' },
          { type: 'image', assetId: 'svg', trackId: 'a' },
          { type: 'image', assetId: 'gone', trackId: 'v' },
          { type: 'image', assetId: 'png', trackId: 'v' },
        ],
        ['v2'],
      ),
      blobOf,
    );
    expect(r).toEqual({ images: true, lenient: [] });
  });
});
