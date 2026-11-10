/**
 * importing files into the open project: probe -> store blob -> register -> add asset to the store.
 */
import { create } from 'zustand';
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import type { MediaAsset, MediaKind } from '../types';
import { uid } from '../lib/id';
import { putMediaBlob, deleteMediaBlob } from '../storage/db';
import { useEditor } from '../store/editorStore';
import { useUi } from '../store/ui';
import { registerAsset, releaseAsset } from './registry';
import { releaseDerived } from './derived';

export const ACCEPTED_TYPES = 'video/*,audio/*,image/*';

const CONCURRENCY = 3;
const PROBE_TIMEOUT_MS = 20000;

const EXT_KIND: Record<string, MediaKind> = {
  mp4: 'video', m4v: 'video', mov: 'video', webm: 'video', mkv: 'video', ogv: 'video', avi: 'video', ts: 'video', mts: 'video', '3gp': 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', oga: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', opus: 'audio', weba: 'audio', aiff: 'audio', aif: 'audio',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', avif: 'image', svg: 'image',
};

const EXT_MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', ogv: 'video/ogg',
  avi: 'video/x-msvideo', ts: 'video/mp2t', mts: 'video/mp2t', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  opus: 'audio/ogg', weba: 'audio/webm', aiff: 'audio/aiff', aif: 'audio/aiff',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  avif: 'image/avif', svg: 'image/svg+xml',
};

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

/** media kind from a mime type / file name, or null when the file is not supported */
export function detectKind(file: { type: string; name: string }): MediaKind | null {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('image/')) return 'image';
  if (!file.type || file.type === 'application/octet-stream') return EXT_KIND[extOf(file.name)] ?? null;
  return null;
}

/** how many files are currently being imported (for the media panel) */
export const useImporting = create<{ count: number }>()(() => ({ count: 0 }));

function bump(delta: number): void {
  useImporting.setState((s) => ({ count: Math.max(0, s.count + delta) }));
}

interface Probe {
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/* ---------- probing with mediabunny ---------- */

async function probeWithMediabunny(blob: Blob, kind: 'video' | 'audio'): Promise<Probe> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  try {
    const audioTrack = await input.getPrimaryAudioTrack();
    if (kind === 'audio') {
      if (!audioTrack) throw new Error('no audio track');
      if (!(await audioTrack.canDecode())) throw new Error('audio codec not supported');
      const duration = await input.computeDuration();
      return { duration, width: 0, height: 0, hasAudio: true };
    }
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error('no video track');
    if (!(await videoTrack.canDecode())) throw new Error('video codec not supported');
    const duration = await input.computeDuration();
    return {
      duration,
      width: videoTrack.displayWidth,
      height: videoTrack.displayHeight,
      hasAudio: !!audioTrack && (await audioTrack.canDecode()),
    };
  } finally {
    input.dispose();
  }
}

/* ---------- probing with media elements (fallback) ---------- */

interface MediaElementExtras {
  mozHasAudio?: boolean;
  webkitAudioDecodedByteCount?: number;
  audioTracks?: { length: number };
}

function waitFor(el: HTMLMediaElement, ok: string[], fail = 'error'): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      for (const n of ok) el.removeEventListener(n, onOk);
      el.removeEventListener(fail, onFail);
    };
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onFail = () => {
      cleanup();
      reject(new Error('the browser cannot decode this file'));
    };
    for (const n of ok) el.addEventListener(n, onOk);
    el.addEventListener(fail, onFail);
  });
}

async function probeWithElement(blob: Blob, kind: 'video' | 'audio'): Promise<Probe> {
  const url = URL.createObjectURL(blob);
  const el = document.createElement(kind === 'video' ? 'video' : 'audio');
  el.preload = 'metadata';
  el.muted = true;
  try {
    const loaded = waitFor(el, ['loadedmetadata']);
    el.src = url;
    await withTimeout(loaded, PROBE_TIMEOUT_MS, 'timed out reading the file');
    let duration = el.duration;
    if (!Number.isFinite(duration)) {
      // webm recorded live reports Infinity until the end has been seen
      const changed = waitFor(el, ['durationchange', 'seeked', 'timeupdate']);
      el.currentTime = 1e101;
      await withTimeout(changed, 8000, 'could not determine the duration').catch(() => undefined);
      duration = el.duration;
      try {
        el.currentTime = 0;
      } catch {
        /* ignore */
      }
    }
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('could not determine the duration');
    if (kind === 'audio') return { duration, width: 0, height: 0, hasAudio: true };
    const v = el as HTMLVideoElement;
    if (!v.videoWidth || !v.videoHeight) throw new Error('the browser cannot decode this video');
    const x = el as unknown as MediaElementExtras;
    let hasAudio = true;
    if (typeof x.mozHasAudio === 'boolean') hasAudio = x.mozHasAudio;
    else if (x.audioTracks && typeof x.audioTracks.length === 'number') hasAudio = x.audioTracks.length > 0;
    return { duration, width: v.videoWidth, height: v.videoHeight, hasAudio };
  } finally {
    el.removeAttribute('src');
    el.load();
    URL.revokeObjectURL(url);
  }
}

async function probeImage(blob: Blob): Promise<Probe> {
  try {
    const bmp = await createImageBitmap(blob);
    const out = { duration: 0, width: bmp.width, height: bmp.height, hasAudio: false };
    bmp.close();
    if (out.width > 0 && out.height > 0) return out;
  } catch {
    /* fall through to <img> */
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await withTimeout(img.decode(), PROBE_TIMEOUT_MS, 'timed out reading the image');
    const width = img.naturalWidth || 1920;
    const height = img.naturalHeight || 1080;
    return { duration: 0, width, height, hasAudio: false };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function probeOne(blob: Blob, kind: 'video' | 'audio'): Promise<Probe> {
  let result: Probe;
  try {
    result = await probeWithMediabunny(blob, kind);
    if (!(result.duration > 0)) throw new Error('empty');
  } catch {
    result = await probeWithElement(blob, kind);
  }
  return result;
}

async function probe(blob: Blob, kind: MediaKind): Promise<{ info: Probe; kind: MediaKind }> {
  if (kind === 'image') return { info: await probeImage(blob), kind };
  try {
    return { info: await probeOne(blob, kind), kind };
  } catch (err) {
    if (kind !== 'video') throw err;
    // mime says video (every .webm / .mp4) but the file may hold audio only
    try {
      return { info: await probeOne(blob, 'audio'), kind: 'audio' };
    } catch {
      throw err;
    }
  }
}

/* ---------- import ---------- */

async function importOne(file: File, requestedKind: MediaKind, projectId: string): Promise<MediaAsset> {
  const mime = file.type || EXT_MIME[extOf(file.name)] || '';
  // files with an empty type get the guessed one so media elements can sniff reliably
  const blob: File | Blob = file.type || !mime ? file : new Blob([file], { type: mime });
  const probed = await probe(blob, requestedKind);
  const info = probed.info;
  const kind = probed.kind;
  const id = uid('ast');
  await putMediaBlob(projectId, id, blob);
  registerAsset(id, blob);
  const asset: MediaAsset = {
    id,
    name: file.name,
    kind,
    mime,
    size: file.size,
    duration: kind === 'image' ? 0 : info.duration,
    width: kind === 'audio' ? 0 : info.width,
    height: kind === 'audio' ? 0 : info.height,
    hasAudio: kind === 'audio' ? true : kind === 'video' ? info.hasAudio : false,
    createdAt: Date.now(),
  };
  const current = useEditor.getState().project;
  if (!current || current.id !== projectId) {
    // the project was closed while importing: do not leave orphans behind
    releaseAsset(id);
    void deleteMediaBlob(id).catch(() => undefined);
    throw new Error('project closed');
  }
  useEditor.getState().addAsset(asset);
  return asset;
}

/**
 * import files into the open project. unsupported / unreadable files are skipped (with a toast).
 * resolves with the assets that were added.
 */
export async function importFiles(files: File[] | FileList): Promise<MediaAsset[]> {
  const project = useEditor.getState().project;
  const ui = useUi.getState();
  if (!project) {
    ui.toast('open a project first', 'error');
    return [];
  }
  const list = Array.from(files);
  const supported: { file: File; kind: MediaKind }[] = [];
  let unsupported = 0;
  for (const file of list) {
    const kind = detectKind(file);
    if (kind) supported.push({ file, kind });
    else unsupported++;
  }
  const added: (MediaAsset | undefined)[] = new Array<MediaAsset | undefined>(supported.length);
  const failed: string[] = [];
  let next = 0;
  bump(supported.length);

  const worker = async () => {
    while (next < supported.length) {
      const i = next++;
      const item = supported[i]!;
      try {
        added[i] = await importOne(item.file, item.kind, project.id);
      } catch (e) {
        const why = e instanceof Error ? e.message : 'unreadable';
        if (why !== 'project closed') failed.push(`${item.file.name} (${why})`);
      } finally {
        bump(-1);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, supported.length) }, worker));

  const result = added.filter((a): a is MediaAsset => !!a);
  const skipped = unsupported + failed.length;
  if (skipped > 0) {
    if (failed.length === 1 && unsupported === 0) ui.toast(`could not import ${failed[0]}`, 'error');
    else if (result.length === 0 && failed.length === 0) ui.toast('unsupported file type', 'error');
    else ui.toast(`skipped ${skipped} file${skipped === 1 ? '' : 's'} (unsupported or unreadable)`, 'error');
  }
  return result;
}

/** remove an asset from the project, the registry and indexeddb */
export async function deleteAsset(assetId: string): Promise<void> {
  useEditor.getState().removeAsset(assetId);
  releaseDerived(assetId);
  releaseAsset(assetId);
  try {
    await deleteMediaBlob(assetId);
  } catch {
    /* blob already gone */
  }
}
