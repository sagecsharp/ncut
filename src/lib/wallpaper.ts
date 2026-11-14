/**
 * a wallpaper behind the whole ui. the user picks a picture, it is scaled down once, encoded once and kept as a
 * blob in its own indexeddb database 'ncut-wallpaper' (like fonts.ts keeps fonts in 'ncut-fonts'). the settings
 * (fit, dim, blur, panels) are an app setting, so they live in localStorage under ncut.wallpaper, not in a project.
 *
 * how it is drawn: one fixed element (made here with the dom, first child of body, z-index below the app) holds the
 * picture and, above it, a dim layer in the solid app background color. <html> gets data-wallpaper="on" only while
 * a picture shows; styles/theme.css then turns the surface tokens see-through. with no picture nothing changes.
 *
 * import-safe in node: nothing touches document / window / indexedDB at module load, and the dom parts do nothing
 * without a document, so the pure parts (settings, sizes, css values, file checks) are testable on their own.
 * nothing of this reaches the engine, the exporter or the project data.
 */
import { create } from 'zustand';
import { useUi } from '../store/ui';
import { APPEARANCE_EVENT } from './appearance';
import { clamp } from './time';

export type WallpaperFit = 'fill' | 'fit' | 'stretch' | 'center' | 'tile';

export interface WallpaperSettings {
  fit: WallpaperFit;
  /** percent of the theme's background color laid over the picture, 0..100 */
  dim: number;
  /** blur of the picture in px, 0..40 */
  blur: number;
  /** how solid the panels are while a picture shows, in percent, 30..100 (100 = solid) */
  panels: number;
}

export const WALLPAPER_FITS: { id: WallpaperFit; label: string; title: string }[] = [
  { id: 'fill', label: 'fill', title: 'cover the window, cropping what does not fit' },
  { id: 'fit', label: 'fit', title: 'show the whole picture, with bars where it does not fill the window' },
  { id: 'stretch', label: 'stretch', title: 'stretch the picture to the window, ignoring its proportions' },
  { id: 'center', label: 'center', title: 'original size, in the middle' },
  { id: 'tile', label: 'tile', title: 'repeat the picture at its original size' },
];

export const DEFAULT_WALLPAPER: WallpaperSettings = { fit: 'fill', dim: 55, blur: 0, panels: 82 };

export const WALLPAPER_LIMITS = {
  dim: { min: 0, max: 100 },
  blur: { min: 0, max: 40 },
  panels: { min: 30, max: 100 },
} as const;

/** the longest side of the kept picture. a smaller picture is never scaled up. */
export const WALLPAPER_MAX_SIDE = 3840;
/** a bigger file is refused before it is read */
export const WALLPAPER_MAX_BYTES = 64 * 1024 * 1024;

const STORAGE_KEY = 'ncut.wallpaper';
const DB_NAME = 'ncut-wallpaper';
const DB_VERSION = 1;
const STORE = 'wallpaper';
const RECORD_KEY = 'current';

// ---------- pure parts ----------

function isFit(v: unknown): v is WallpaperFit {
  return typeof v === 'string' && WALLPAPER_FITS.some((f) => f.id === v);
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return clamp(Math.round(v), min, max);
}

/** any partial / untrusted settings object to a complete one: missing or bad keys fall back to `base`, numbers are clamped */
export function clampSettings(p: Partial<Record<keyof WallpaperSettings, unknown>>, base: WallpaperSettings = DEFAULT_WALLPAPER): WallpaperSettings {
  const L = WALLPAPER_LIMITS;
  return {
    fit: isFit(p.fit) ? p.fit : base.fit,
    dim: num(p.dim, base.dim, L.dim.min, L.dim.max),
    blur: num(p.blur, base.blur, L.blur.min, L.blur.max),
    panels: num(p.panels, base.panels, L.panels.min, L.panels.max),
  };
}

/** the saved json text to settings. bad json, a non-object or missing keys give the defaults. */
export function readSettings(raw: string | null | undefined): WallpaperSettings {
  if (!raw) return DEFAULT_WALLPAPER;
  try {
    const p: unknown = JSON.parse(raw);
    if (typeof p !== 'object' || p === null || Array.isArray(p)) return DEFAULT_WALLPAPER;
    return clampSettings(p as Record<string, unknown>);
  } catch {
    return DEFAULT_WALLPAPER;
  }
}

/** the size the picture is kept at: the longest side at most `maxSide`, never scaled up. null for a size that is no size. */
export function scaledSize(width: number, height: number, maxSide: number = WALLPAPER_MAX_SIDE): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  const longest = Math.max(width, height);
  if (longest <= maxSide) return { width: Math.round(width), height: Math.round(height) };
  const k = maxSide / longest;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

export interface FitCss {
  size: string;
  repeat: string;
  position: string;
}

/** background-size / repeat / position of the picture layer for a fit */
export function fitCss(fit: WallpaperFit): FitCss {
  switch (fit) {
    case 'fill':
      return { size: 'cover', repeat: 'no-repeat', position: 'center' };
    case 'fit':
      return { size: 'contain', repeat: 'no-repeat', position: 'center' };
    case 'stretch':
      return { size: '100% 100%', repeat: 'no-repeat', position: 'center' };
    case 'center':
      return { size: 'auto', repeat: 'no-repeat', position: 'center' };
    case 'tile':
      return { size: 'auto', repeat: 'repeat', position: 'top left' };
  }
}

/** how far the picture layer grows past the window edges: a blur fades the edges, so the rim must lie outside */
export function blurGrow(blur: number): number {
  return blur > 0 ? Math.ceil(blur * 3) : 0;
}

export interface LayerStyle {
  inset: string;
  filter: string;
  backgroundSize: string;
  backgroundRepeat: string;
  backgroundPosition: string;
  /** opacity of the dim layer */
  dimOpacity: string;
}

/** the inline styles of the picture layer and the dim layer for some settings */
export function layerStyle(s: WallpaperSettings): LayerStyle {
  const css = fitCss(s.fit);
  const grow = blurGrow(s.blur);
  return {
    inset: grow > 0 ? `-${grow}px` : '0',
    filter: s.blur > 0 ? `blur(${s.blur}px)` : 'none',
    backgroundSize: css.size,
    backgroundRepeat: css.repeat,
    backgroundPosition: css.position,
    dimOpacity: String(s.dim / 100),
  };
}

const ACCEPTED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif', 'image/bmp', 'image/x-ms-bmp'];
const ACCEPTED_EXT = ['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'bmp'];
/** for <input type=file accept=...> */
export const WALLPAPER_ACCEPT = [...ACCEPTED_MIME.slice(0, 6), ...ACCEPTED_EXT.map((e) => `.${e}`)].join(',');

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

/** a file is accepted by its mime type, or by its extension when the system gave it no type */
export function isAcceptedPicture(file: { name: string; type: string }): boolean {
  if (file.type) return ACCEPTED_MIME.includes(file.type.toLowerCase());
  return ACCEPTED_EXT.includes(extOf(file.name));
}

/** why a picked file is refused before reading it, or null when it may be read */
export function checkPictureFile(file: { name: string; type: string; size: number }): string | null {
  if (!isAcceptedPicture(file)) return 'that is not a png, jpg, webp, avif, gif or bmp picture';
  if (file.size > WALLPAPER_MAX_BYTES) return `the file is over ${Math.round(WALLPAPER_MAX_BYTES / (1024 * 1024))} mb`;
  if (file.size === 0) return 'the file is empty';
  return null;
}

/** the encodings tried in order: webp, then jpeg, then png (which every browser can make) */
export const ENCODE_ORDER: { type: string; quality?: number }[] = [
  { type: 'image/webp', quality: 0.9 },
  { type: 'image/jpeg', quality: 0.9 },
  { type: 'image/png' },
];

/**
 * encode with the first format the browser really makes. canvas.toBlob quietly gives a png when it can not do the
 * asked type, so a blob only counts when its type is the one that was asked for.
 */
export async function encodeFirst(toBlob: (type: string, quality?: number) => Promise<Blob | null>): Promise<Blob | null> {
  for (const { type, quality } of ENCODE_ORDER) {
    let blob: Blob | null = null;
    try {
      blob = await toBlob(type, quality);
    } catch {
      blob = null;
    }
    if (blob && blob.size > 0 && blob.type === type) return blob;
  }
  return null;
}

/** the first real error of some candidates (a request error is still there when the transaction error is not yet) */
export function firstError(...candidates: unknown[]): Error {
  for (const c of candidates) {
    if (c instanceof Error) return c;
    // a DOMException from indexeddb is not an Error instance in every runtime, but it has a name
    if (typeof c === 'object' && c !== null && 'name' in c) return c as Error;
  }
  return new Error('wallpaper database error');
}

/** a storage / decode error to a short reason for a toast */
export function describeError(e: unknown): string {
  const name = typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : '';
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  if (name === 'QuotaExceededError' || /quota|disk is full/i.test(message)) return 'the disk is full';
  if (message === 'no indexeddb') return 'this browser has no storage for it (a private window?)';
  if (name === 'SecurityError') return 'this browser does not let the page store files';
  return message || 'unknown error';
}

/** a picture over this many pixels is refused: the decode alone needs 4 bytes per pixel (120 mpx = 480 mb) */
export const WALLPAPER_MAX_PIXELS = 120_000_000;
/** how much of the start of a file is looked at for its size (a jpeg can carry a big thumbnail before its size) */
const HEADER_BYTES = 2 * 1024 * 1024;

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u32le = (b: Uint8Array, i: number) => ((b[i + 3] << 24) | (b[i + 2] << 16) | (b[i + 1] << 8) | b[i]) >>> 0;
const hasTag = (b: Uint8Array, i: number, t: string) => {
  if (i < 0 || i + t.length > b.length) return false;
  for (let k = 0; k < t.length; k++) if (b[i + k] !== t.charCodeAt(k)) return false;
  return true;
};

/**
 * the pixel size of a picture from the start of its file, without decoding it. png, gif, bmp, jpeg, webp and avif.
 * null when the format is not known or the header is cut short: the caller then just decodes.
 */
export function readImageSize(b: Uint8Array): { width: number; height: number } | null {
  const ok = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : null);
  if (b.length >= 24 && b[0] === 0x89 && hasTag(b, 1, 'PNG')) return ok(u32be(b, 16), u32be(b, 20));
  if (b.length >= 10 && hasTag(b, 0, 'GIF8')) return ok(u16le(b, 6), u16le(b, 8));
  if (b.length >= 26 && hasTag(b, 0, 'BM')) {
    if (u32le(b, 14) === 12) return ok(u16le(b, 18), u16le(b, 20));
    return ok(u32le(b, 18) | 0, Math.abs(u32le(b, 22) | 0));
  }
  if (b.length >= 30 && hasTag(b, 0, 'RIFF') && hasTag(b, 8, 'WEBP')) {
    if (hasTag(b, 12, 'VP8X')) return ok((b[24] | (b[25] << 8) | (b[26] << 16)) + 1, (b[27] | (b[28] << 8) | (b[29] << 16)) + 1);
    if (hasTag(b, 12, 'VP8L') && b[20] === 0x2f) {
      const bits = u32le(b, 21);
      return ok((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (hasTag(b, 12, 'VP8 ') && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return ok(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xff) {
        i++; // fill byte
        continue;
      }
      // a start of frame marker (not the huffman table, the jpeg extension and the arithmetic coding markers)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return ok(u16be(b, i + 7), u16be(b, i + 5));
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        i += 2; // markers without a length
        continue;
      }
      i += 2 + u16be(b, i + 2);
    }
    return null;
  }
  if (b.length >= 16 && hasTag(b, 4, 'ftyp')) {
    // avif / heif: the image spatial extents box 'ispe' (version + flags, width, height). the biggest one is the picture.
    let best: { width: number; height: number } | null = null;
    for (let i = 8; i + 16 <= b.length; i++) {
      if (b[i] === 0x69 && hasTag(b, i, 'ispe')) {
        const size = ok(u32be(b, i + 8), u32be(b, i + 12));
        if (size && (!best || size.width * size.height > best.width * best.height)) best = size;
      }
    }
    return best;
  }
  return null;
}

/** why a picture of this pixel size is refused before it is decoded, or null */
export function checkPictureSize(size: { width: number; height: number } | null): string | null {
  if (!size) return null;
  if (size.width * size.height > WALLPAPER_MAX_PIXELS) {
    return `the picture is ${size.width} x ${size.height} px, over the ${WALLPAPER_MAX_PIXELS / 1_000_000} megapixels it can be read at`;
  }
  return null;
}

// ---------- own indexeddb database ----------

interface StoredWallpaper {
  key: string;
  blob: Blob;
  width: number;
  height: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no indexeddb'));
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      return reject(e);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('could not open the wallpaper database'));
  });
}

async function dbRun<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      // a failed request fires its error event before the transaction aborts, so tx.error is still null then and the
      // real reason (a full disk, say) is on the request
      req.onerror = () => reject(firstError(req.error, tx.error));
      tx.onerror = () => reject(firstError(req.error, tx.error));
      tx.onabort = () => reject(firstError(tx.error, req.error));
    });
  } finally {
    db.close();
  }
}

// ---------- decode + encode ----------

async function encodePicture(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  // the decode needs the whole picture in memory, so a huge one is refused from its header first
  let head: Uint8Array | null = null;
  try {
    head = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
  } catch {
    head = null;
  }
  const tooBig = checkPictureSize(head ? readImageSize(head) : null);
  if (tooBig) throw new Error(tooBig);
  let bitmap: ImageBitmap;
  try {
    // a gif gives its first frame
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('the file could not be read as a picture (or it is too big to decode)');
  }
  let canvas: HTMLCanvasElement | null = null;
  try {
    const size = scaledSize(bitmap.width, bitmap.height);
    if (!size) throw new Error('the picture has no size');
    canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const cx = canvas.getContext('2d');
    if (!cx) throw new Error('could not make a canvas to scale the picture');
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(bitmap, 0, 0, size.width, size.height);
    const c = canvas;
    const blob = await encodeFirst((type, quality) => new Promise<Blob | null>((resolve) => c.toBlob(resolve, type, quality)));
    if (!blob) throw new Error('the picture could not be encoded');
    return { blob, width: size.width, height: size.height };
  } finally {
    bitmap.close();
    // a canvas of this size holds tens of megabytes until it is collected: let go of them at once
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

/** the browser can show this url as an image (a stored blob may be damaged) */
async function canShow(url: string): Promise<void> {
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    throw new Error('the stored picture could not be shown');
  }
}

// ---------- the drawn layer ----------

interface Layer {
  root: HTMLDivElement;
  pic: HTMLDivElement;
  dim: HTMLDivElement;
}

let layer: Layer | null = null;

/** made once, the first time a picture shows. first child of body, so no react file has to know about it. */
function ensureLayer(): Layer {
  if (layer) return layer;
  const root = document.createElement('div');
  root.id = 'ncut-wallpaper';
  root.setAttribute('aria-hidden', 'true');
  const pic = document.createElement('div');
  pic.className = 'ncut-wp-pic';
  const dim = document.createElement('div');
  dim.className = 'ncut-wp-dim';
  root.append(pic, dim);
  document.body.insertBefore(root, document.body.firstChild);
  layer = { root, pic, dim };
  return layer;
}

function applyLook(s: WallpaperSettings, url: string | null): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  html.style.setProperty('--wp-panels', String(s.panels));
  const wasOn = html.dataset.wallpaper === 'on';
  const on = url !== null;
  if (on) {
    const l = ensureLayer();
    const st = layerStyle(s);
    l.pic.style.backgroundImage = `url("${url}")`;
    l.pic.style.inset = st.inset;
    l.pic.style.filter = st.filter;
    l.pic.style.backgroundSize = st.backgroundSize;
    l.pic.style.backgroundRepeat = st.backgroundRepeat;
    l.pic.style.backgroundPosition = st.backgroundPosition;
    l.dim.style.opacity = st.dimOpacity;
    l.root.hidden = false;
    html.dataset.wallpaper = 'on';
  } else {
    delete html.dataset.wallpaper;
    if (layer) {
      layer.root.hidden = true;
      layer.pic.style.backgroundImage = '';
    }
  }
  // the canvases that read theme tokens redraw when the look flips (they read the solid tokens, so only to be safe)
  if (on !== wasOn && typeof window !== 'undefined') window.dispatchEvent(new Event(APPEARANCE_EVENT));
}

// ---------- the store ----------

export interface WallpaperState extends WallpaperSettings {
  /** object url of the picture on show, null when there is none */
  url: string | null;
  /** a picture is being read / saved / removed */
  busy: boolean;
  setSettings(patch: Partial<WallpaperSettings>): void;
  /** scales, encodes and keeps a picked file. false (with a toast) when it was refused: the old wallpaper stays. */
  choosePicture(file: File): Promise<boolean>;
  /** deletes the stored picture. false (with a toast) when that failed: the picture stays. */
  removePicture(): Promise<boolean>;
}

function toastError(what: string, e: unknown): void {
  useUi.getState().toast(`${what}: ${describeError(e)}`, 'error');
}

/** bumps whenever the picture on show is replaced or removed, so a slow read at start can tell it came too late */
let pictureGen = 0;

function currentSettings(s: WallpaperSettings): WallpaperSettings {
  return { fit: s.fit, dim: s.dim, blur: s.blur, panels: s.panels };
}

function saveSettings(s: WallpaperSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // ignore, like the appearance settings
  }
}

function swapUrl(url: string | null): void {
  const old = useWallpaper.getState().url;
  pictureGen++;
  useWallpaper.setState({ url });
  applyLook(currentSettings(useWallpaper.getState()), url);
  if (old && old !== url) URL.revokeObjectURL(old);
}

export const useWallpaper = create<WallpaperState>()((set, get) => ({
  ...DEFAULT_WALLPAPER,
  url: null,
  busy: false,
  setSettings(patch) {
    const next = clampSettings(patch, currentSettings(get()));
    set(next);
    applyLook(next, get().url);
    saveSettings(next);
  },
  async choosePicture(file) {
    if (get().busy) return false;
    const refused = checkPictureFile(file);
    if (refused) {
      toastError('wallpaper not changed', refused);
      return false;
    }
    set({ busy: true });
    let url: string | null = null;
    try {
      const { blob, width, height } = await encodePicture(file);
      url = URL.createObjectURL(blob);
      await canShow(url);
      // saved before it is shown: when the disk is full or there is no indexeddb, the old wallpaper stays as it was
      await dbRun('readwrite', (s) => s.put({ key: RECORD_KEY, blob, width, height } satisfies StoredWallpaper));
      swapUrl(url);
      return true;
    } catch (e) {
      if (url) URL.revokeObjectURL(url);
      toastError('wallpaper not changed', e);
      return false;
    } finally {
      set({ busy: false });
    }
  },
  async removePicture() {
    if (get().busy) return false;
    set({ busy: true });
    try {
      await dbRun('readwrite', (s) => s.delete(RECORD_KEY));
      swapUrl(null);
      return true;
    } catch (e) {
      toastError('could not remove the wallpaper', e);
      return false;
    } finally {
      set({ busy: false });
    }
  },
}));

let started = false;

/**
 * the stored picture, shown a moment after start. nothing stored (or no indexeddb) = nothing happens. a database that
 * can not be opened or read (a private window where indexedDB exists but is blocked) is no news to a user who never
 * set a wallpaper, so that goes to the console only. a picture that was stored and can not be shown is told.
 */
async function loadStored(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const gen = pictureGen;
  let url: string | null = null;
  let rec: StoredWallpaper | undefined;
  try {
    rec = await dbRun<StoredWallpaper | undefined>('readonly', (s) => s.get(RECORD_KEY) as IDBRequest<StoredWallpaper | undefined>);
  } catch (e) {
    console.warn('the wallpaper database could not be read', e);
    return;
  }
  try {
    if (!rec || !(rec.blob instanceof Blob)) return;
    url = URL.createObjectURL(rec.blob);
    await canShow(url);
    if (gen !== pictureGen) {
      // the user picked or removed one while this was reading
      URL.revokeObjectURL(url);
      return;
    }
    swapUrl(url);
  } catch (e) {
    if (url) URL.revokeObjectURL(url);
    console.error(e);
    toastError('could not load the wallpaper', e);
  }
}

/** call once before the first render (after initAppearance): applies the saved settings, then loads the picture. */
export function initWallpaper(): void {
  if (started) return;
  started = true;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  const initial = readSettings(raw);
  useWallpaper.setState(initial);
  applyLook(initial, null);
  void loadStored();
}
