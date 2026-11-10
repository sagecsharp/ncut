/**
 * a look at a project's files before an export is split into parts for web workers (parallel.ts): a worker has no
 * <img>, and a worker that cannot decode a video must not quietly drop it. finding that out up front costs a few
 * milliseconds, finding it out in the last part costs the whole export once more.
 */
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import type { Project } from '../../types';

export type ImageKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'avif';

/** how many bytes of a file imageKindOf wants to see */
export const IMAGE_HEAD_BYTES = 64;

function ascii(b: Uint8Array, at: number, length: number): string {
  let s = '';
  for (let i = at; i < at + length && i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}

/**
 * the raster format of a picture by its first bytes: the formats createImageBitmap reads the same way on every
 * thread. null = anything else (svg, heic, ico, a text file ...), which only this thread may be able to show.
 */
export function imageKindOf(head: Uint8Array): ImageKind | null {
  const b = head;
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return 'gif';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  if (b.length >= 14 && ascii(b, 0, 2) === 'BM') return 'bmp';
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') {
    // [size][ftyp][major brand][minor version][compatible brands ...]
    const size = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
    const end = Math.min(b.length, size >= 16 ? size : b.length);
    for (let at = 8; at + 4 <= end; at += 4) {
      if (at === 12) continue;
      const brand = ascii(b, at, 4);
      if (brand === 'avif' || brand === 'avis') return 'avif';
    }
  }
  return null;
}

export interface PartsMedia {
  /** every picture of the project is one a worker reads like this thread */
  images: boolean;
  /** video files this thread cannot decode either: a worker that skips them makes no difference */
  lenient: string[];
}

/** the files of the clips an export shows (clips on hidden and audio tracks are never drawn) */
export async function checkPartsMedia(project: Project, blobOf: (assetId: string) => Blob | undefined): Promise<PartsMedia> {
  const skipped = new Set(project.tracks.filter((t) => t.kind !== 'video' || t.hidden).map((t) => t.id));
  const pictures = new Set<string>();
  const videos = new Set<string>();
  for (const clip of project.clips) {
    if (skipped.has(clip.trackId)) continue;
    if (clip.type === 'image') pictures.add(clip.assetId);
    else if (clip.type === 'video') videos.add(clip.assetId);
  }
  let images = true;
  const lenient: string[] = [];
  await Promise.all([
    ...[...pictures].map(async (id) => {
      // a missing file is skipped the same way on every thread
      const blob = blobOf(id);
      if (!blob) return;
      try {
        const head = new Uint8Array(await blob.slice(0, IMAGE_HEAD_BYTES).arrayBuffer());
        if (!imageKindOf(head)) images = false;
      } catch {
        images = false;
      }
    }),
    ...[...videos].map(async (id) => {
      const blob = blobOf(id);
      if (!blob) return;
      let input: Input | null = null;
      try {
        input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
        const track = await input.getPrimaryVideoTrack();
        if (!track || !(await track.canDecode())) lenient.push(id);
      } catch {
        lenient.push(id);
      } finally {
        try {
          input?.dispose();
        } catch {
          // ignore
        }
      }
    }),
  ]);
  return { images, lenient: lenient.sort() };
}
