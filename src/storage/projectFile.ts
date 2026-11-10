/**
 * a project as one file (.ncut): the project json plus every media blob, for backups and moving a
 * project to another browser or machine.
 *
 * layout:  magic "NCUT1\n" | uint32 LE header length | header json (utf-8) | media blobs back to back
 * header:  { version, project, media: [{ assetId, size, mime }], fonts?: [{ family, weight, italic, size }] }
 * in the order the blobs follow: media blobs first, then the font files. fonts is optional (older files have none);
 * an older build ignores the extra header field and the trailing bytes.
 * the file is built from Blob parts and read with Blob.slice, so media is never copied into memory.
 */
import type { Project } from '../types';

export const PROJECT_FILE_EXT = '.ncut';
export const PROJECT_FILE_MIME = 'application/x-ncut';
const MAGIC = 'NCUT1\n';
const VERSION = 1;
/** a header larger than this is not one of ours (it only holds the project json) */
const MAX_HEADER_BYTES = 64 * 1024 * 1024;

interface MediaEntry {
  assetId: string;
  size: number;
  mime: string;
}

interface FontEntry {
  family: string;
  weight: number;
  italic: boolean;
  size: number;
}

interface Header {
  version: number;
  project: Project;
  media: MediaEntry[];
  fonts?: FontEntry[];
}

/** a font file to pack: the bytes are a Blob or an ArrayBuffer */
export interface PackFont {
  family: string;
  weight: number;
  italic: boolean;
  bytes: Blob | ArrayBuffer;
}

export interface UnpackedFont {
  family: string;
  weight: number;
  italic: boolean;
  blob: Blob;
}

const MAX_FAMILY_LEN = 200;

function clampWeight(w: unknown): number {
  return typeof w === 'number' && Number.isFinite(w) ? Math.max(100, Math.min(900, Math.round(w))) : 400;
}

export interface UnpackedProject {
  project: Project;
  /** assetId -> its blob (a slice of the file). assets whose media was missing at export are absent. */
  media: Map<string, Blob>;
  /** font files that came with the project (empty for files without any) */
  fonts: UnpackedFont[];
}

/** build the file. `media` holds the blob of each asset that has one. */
export function packProject(project: Project, media: Map<string, Blob>, fonts: PackFont[] = []): Blob {
  const entries: MediaEntry[] = [];
  const blobs: Blob[] = [];
  for (const asset of project.assets) {
    const blob = media.get(asset.id);
    if (!blob) continue;
    entries.push({ assetId: asset.id, size: blob.size, mime: blob.type || asset.mime });
    blobs.push(blob);
  }
  const fontEntries: FontEntry[] = [];
  for (const f of fonts) {
    const blob = f.bytes instanceof Blob ? f.bytes : new Blob([f.bytes]);
    fontEntries.push({ family: f.family.slice(0, MAX_FAMILY_LEN), weight: clampWeight(f.weight), italic: !!f.italic, size: blob.size });
    blobs.push(blob);
  }
  const header: Header = { version: VERSION, project, media: entries };
  if (fontEntries.length > 0) header.fonts = fontEntries;
  const json = new TextEncoder().encode(JSON.stringify(header));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, json.byteLength, true);
  return new Blob([MAGIC, len, json, ...blobs], { type: PROJECT_FILE_MIME });
}

function isProject(v: unknown): v is Project {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.width === 'number' &&
    typeof p.height === 'number' &&
    typeof p.fps === 'number' &&
    Array.isArray(p.assets) &&
    Array.isArray(p.tracks) &&
    Array.isArray(p.clips)
  );
}

/** read a file made by packProject. throws an Error with a plain message when it is not one. */
export async function unpackProject(file: Blob): Promise<UnpackedProject> {
  const magicLen = MAGIC.length;
  if (file.size < magicLen + 4) throw new Error('not an ncut project file');
  const head = new Uint8Array(await file.slice(0, magicLen + 4).arrayBuffer());
  const magic = new TextDecoder().decode(head.subarray(0, magicLen));
  if (magic !== MAGIC) throw new Error('not an ncut project file');
  const headerLen = new DataView(head.buffer, head.byteOffset + magicLen, 4).getUint32(0, true);
  const headerStart = magicLen + 4;
  if (headerLen <= 0 || headerLen > MAX_HEADER_BYTES || headerStart + headerLen > file.size) {
    throw new Error('the project file is damaged');
  }
  let header: Header;
  try {
    header = JSON.parse(await file.slice(headerStart, headerStart + headerLen).text()) as Header;
  } catch {
    throw new Error('the project file is damaged');
  }
  if (!header || typeof header.version !== 'number' || !isProject(header.project) || !Array.isArray(header.media)) {
    throw new Error('the project file is damaged');
  }
  if (header.version > VERSION) throw new Error('this project file was made by a newer version of ncut');
  const media = new Map<string, Blob>();
  let offset = headerStart + headerLen;
  for (const entry of header.media) {
    if (!entry || typeof entry.assetId !== 'string' || !(entry.size >= 0) || offset + entry.size > file.size) {
      throw new Error('the project file is damaged');
    }
    media.set(entry.assetId, file.slice(offset, offset + entry.size, entry.mime || ''));
    offset += entry.size;
  }
  const fonts: UnpackedFont[] = [];
  if (header.fonts !== undefined) {
    if (!Array.isArray(header.fonts)) throw new Error('the project file is damaged');
    for (const entry of header.fonts) {
      if (
        !entry ||
        typeof entry.family !== 'string' ||
        entry.family === '' ||
        entry.family.length > MAX_FAMILY_LEN ||
        typeof entry.size !== 'number' ||
        !(entry.size >= 0) ||
        offset + entry.size > file.size
      ) {
        throw new Error('the project file is damaged');
      }
      fonts.push({ family: entry.family, weight: clampWeight(entry.weight), italic: entry.italic === true, blob: file.slice(offset, offset + entry.size) });
      offset += entry.size;
    }
  }
  return { project: header.project, media, fonts };
}

/** a safe file name for a project */
export function projectFileName(name: string): string {
  const base = name
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return (base || 'project') + PROJECT_FILE_EXT;
}
