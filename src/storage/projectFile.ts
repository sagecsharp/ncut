/**
 * a project as one file (.ncut): the project json plus every media blob, for backups and moving a
 * project to another browser or machine.
 *
 * layout:  magic "NCUT1\n" | uint32 LE header length | header json (utf-8) | media blobs back to back
 * header:  { version, project, media: [{ assetId, size, mime }] } in the order the blobs follow.
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

interface Header {
  version: number;
  project: Project;
  media: MediaEntry[];
}

export interface UnpackedProject {
  project: Project;
  /** assetId -> its blob (a slice of the file). assets whose media was missing at export are absent. */
  media: Map<string, Blob>;
}

/** build the file. `media` holds the blob of each asset that has one. */
export function packProject(project: Project, media: Map<string, Blob>): Blob {
  const entries: MediaEntry[] = [];
  const blobs: Blob[] = [];
  for (const asset of project.assets) {
    const blob = media.get(asset.id);
    if (!blob) continue;
    entries.push({ assetId: asset.id, size: blob.size, mime: blob.type || asset.mime });
    blobs.push(blob);
  }
  const header: Header = { version: VERSION, project, media: entries };
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
  return { project: header.project, media };
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
