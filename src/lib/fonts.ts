/**
 * fonts for text clips: bundled @fontsource families (loaded lazily), generic system fonts, fonts installed on this
 * computer (queryLocalFonts) and font files the user imported (kept in indexeddb, database 'ncut-fonts').
 * the api below is the contract the renderer, the preview and the exporter use.
 * import-safe in node: nothing touches document / window / indexedDB at module load.
 */
import type { Project } from '../types';
import { canvasWidth, familyRenders } from './fontDetect';
import { faceKey, readFontMeta } from './fontMeta';

export type FontCategory = 'sans' | 'serif' | 'display' | 'handwriting' | 'mono' | 'system' | 'local' | 'imported';

export interface FontInfo {
  /** css font-family name, saved in the clip */
  family: string;
  category: FontCategory;
  /** weights that exist for the family (text clips use 400 and 700) */
  weights: number[];
  italic: boolean;
}

/** r = upright, i = italic, then the weight. */
type FileKey = 'r4' | 'r7' | 'i4' | 'i7';

interface Bundled {
  family: string;
  category: FontCategory;
  files: Partial<Record<FileKey, () => Promise<unknown>>>;
}

// explicit imports so vite code-splits one chunk (css + font files) per family / weight / style
const BUNDLED: Bundled[] = [
  { family: 'Inter', category: 'sans', files: { r4: () => import('@fontsource/inter/400.css'), r7: () => import('@fontsource/inter/700.css'), i4: () => import('@fontsource/inter/400-italic.css'), i7: () => import('@fontsource/inter/700-italic.css') } },
  { family: 'Roboto', category: 'sans', files: { r4: () => import('@fontsource/roboto/400.css'), r7: () => import('@fontsource/roboto/700.css'), i4: () => import('@fontsource/roboto/400-italic.css'), i7: () => import('@fontsource/roboto/700-italic.css') } },
  { family: 'Montserrat', category: 'sans', files: { r4: () => import('@fontsource/montserrat/400.css'), r7: () => import('@fontsource/montserrat/700.css'), i4: () => import('@fontsource/montserrat/400-italic.css'), i7: () => import('@fontsource/montserrat/700-italic.css') } },
  { family: 'Poppins', category: 'sans', files: { r4: () => import('@fontsource/poppins/400.css'), r7: () => import('@fontsource/poppins/700.css'), i4: () => import('@fontsource/poppins/400-italic.css'), i7: () => import('@fontsource/poppins/700-italic.css') } },
  { family: 'Oswald', category: 'sans', files: { r4: () => import('@fontsource/oswald/400.css'), r7: () => import('@fontsource/oswald/700.css') } },
  { family: 'Space Grotesk', category: 'sans', files: { r4: () => import('@fontsource/space-grotesk/400.css'), r7: () => import('@fontsource/space-grotesk/700.css') } },
  { family: 'Comfortaa', category: 'sans', files: { r4: () => import('@fontsource/comfortaa/400.css'), r7: () => import('@fontsource/comfortaa/700.css') } },
  { family: 'Playfair Display', category: 'serif', files: { r4: () => import('@fontsource/playfair-display/400.css'), r7: () => import('@fontsource/playfair-display/700.css'), i4: () => import('@fontsource/playfair-display/400-italic.css'), i7: () => import('@fontsource/playfair-display/700-italic.css') } },
  { family: 'Lora', category: 'serif', files: { r4: () => import('@fontsource/lora/400.css'), r7: () => import('@fontsource/lora/700.css'), i4: () => import('@fontsource/lora/400-italic.css'), i7: () => import('@fontsource/lora/700-italic.css') } },
  { family: 'Merriweather', category: 'serif', files: { r4: () => import('@fontsource/merriweather/400.css'), r7: () => import('@fontsource/merriweather/700.css'), i4: () => import('@fontsource/merriweather/400-italic.css'), i7: () => import('@fontsource/merriweather/700-italic.css') } },
  { family: 'DM Serif Display', category: 'serif', files: { r4: () => import('@fontsource/dm-serif-display/400.css'), i4: () => import('@fontsource/dm-serif-display/400-italic.css') } },
  { family: 'Abril Fatface', category: 'serif', files: { r4: () => import('@fontsource/abril-fatface/400.css') } },
  { family: 'Bebas Neue', category: 'display', files: { r4: () => import('@fontsource/bebas-neue/400.css') } },
  { family: 'Anton', category: 'display', files: { r4: () => import('@fontsource/anton/400.css') } },
  { family: 'Archivo Black', category: 'display', files: { r4: () => import('@fontsource/archivo-black/400.css') } },
  { family: 'Bangers', category: 'display', files: { r4: () => import('@fontsource/bangers/400.css') } },
  { family: 'Righteous', category: 'display', files: { r4: () => import('@fontsource/righteous/400.css') } },
  { family: 'Orbitron', category: 'display', files: { r4: () => import('@fontsource/orbitron/400.css'), r7: () => import('@fontsource/orbitron/700.css') } },
  { family: 'Rubik Mono One', category: 'display', files: { r4: () => import('@fontsource/rubik-mono-one/400.css') } },
  { family: 'Press Start 2P', category: 'display', files: { r4: () => import('@fontsource/press-start-2p/400.css') } },
  { family: 'Pacifico', category: 'handwriting', files: { r4: () => import('@fontsource/pacifico/400.css') } },
  { family: 'Lobster', category: 'handwriting', files: { r4: () => import('@fontsource/lobster/400.css') } },
  { family: 'Caveat', category: 'handwriting', files: { r4: () => import('@fontsource/caveat/400.css'), r7: () => import('@fontsource/caveat/700.css') } },
  { family: 'Permanent Marker', category: 'handwriting', files: { r4: () => import('@fontsource/permanent-marker/400.css') } },
  { family: 'Dancing Script', category: 'handwriting', files: { r4: () => import('@fontsource/dancing-script/400.css'), r7: () => import('@fontsource/dancing-script/700.css') } },
  { family: 'Satisfy', category: 'handwriting', files: { r4: () => import('@fontsource/satisfy/400.css') } },
  { family: 'JetBrains Mono', category: 'mono', files: { r4: () => import('@fontsource/jetbrains-mono/400.css'), r7: () => import('@fontsource/jetbrains-mono/700.css'), i4: () => import('@fontsource/jetbrains-mono/400-italic.css'), i7: () => import('@fontsource/jetbrains-mono/700-italic.css') } },
  { family: 'VT323', category: 'mono', files: { r4: () => import('@fontsource/vt323/400.css') } },
  { family: 'Kode Mono', category: 'mono', files: { r4: () => import('@fontsource/kode-mono/400.css'), r7: () => import('@fontsource/kode-mono/700.css') } },
];

/** the generic list the app always had: installed on most machines, nothing to load */
const SYSTEM_FONTS = [
  'Kode Mono',
  'Ubuntu',
  'Noto Sans',
  'Arial',
  'Helvetica',
  'Georgia',
  'Times New Roman',
  'Courier New',
  'Verdana',
  'Trebuchet MS',
  'Impact',
  'Comic Sans MS',
];

const BUNDLED_BY_FAMILY = new Map(BUNDLED.map((b) => [b.family, b]));
const SAMPLE = 'AaBbCc 0123456789';

// ---------- change notification ----------

let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version++;
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch {
      /* a broken listener must not stop the others */
    }
  }
}

/** bumps every time a font finishes loading. cached text (measurements, textures) is keyed on it. */
export function fontsVersion(): number {
  return version;
}

/** call back whenever a font finishes loading (redraw the preview). returns the unsubscribe. */
export function onFontsChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// ---------- the list ----------

let localFonts: string[] = [];
const importedFonts = new Map<string, FontInfo>();
let listCache: FontInfo[] | null = null;

function invalidateList(): void {
  listCache = null;
}

/** every font the picker offers right now (bundled + system + local + imported). same array until something changes. */
export function listFonts(): FontInfo[] {
  void restoreImportedFonts();
  if (listCache) return listCache;
  const out: FontInfo[] = [];
  for (const b of BUNDLED) {
    const weights = [400];
    if (b.files.r7 || b.files.i7) weights.push(700);
    out.push({ family: b.family, category: b.category, weights, italic: !!(b.files.i4 || b.files.i7) });
  }
  const taken = new Set(out.map((f) => f.family));
  for (const family of SYSTEM_FONTS) {
    if (taken.has(family)) continue;
    taken.add(family);
    out.push({ family, category: 'system', weights: [400, 700], italic: true });
  }
  for (const f of importedFonts.values()) {
    if (taken.has(f.family)) continue;
    taken.add(f.family);
    out.push(f);
  }
  for (const family of localFonts) {
    if (taken.has(family)) continue;
    taken.add(family);
    out.push({ family, category: 'local', weights: [400, 700], italic: true });
  }
  listCache = out;
  return out;
}

// ---------- loading ----------

const cssLoads = new Map<string, Promise<boolean>>();
const ready = new Set<string>();
const inflight = new Map<string, Promise<boolean>>();

function hasDocFonts(): boolean {
  return typeof document !== 'undefined' && !!document.fonts;
}

function descriptor(family: string, weight: number, italic: boolean): string {
  return `${italic ? 'italic ' : ''}${weight >= 600 ? 700 : 400} 48px "${family}"`;
}

/** import the stylesheet that holds the closest file to what is asked (the browser synthesizes the rest). false = the import failed. */
function loadCss(b: Bundled, weight: number, italic: boolean): Promise<boolean> {
  const w = weight >= 600 ? 7 : 4;
  const order: FileKey[] = [
    `${italic ? 'i' : 'r'}${w}` as FileKey,
    `${italic ? 'i' : 'r'}4` as FileKey,
    `r${w}` as FileKey,
    'r4',
  ];
  const key = order.find((k) => b.files[k]);
  if (!key) return Promise.resolve(true);
  const id = `${b.family}|${key}`;
  let p = cssLoads.get(id);
  if (!p) {
    p = Promise.resolve()
      .then(() => b.files[key]!())
      .then(() => true)
      .catch(() => {
        cssLoads.delete(id); // allow a retry later
        return false;
      });
    cssLoads.set(id, p);
  }
  return p;
}

/**
 * make a family usable on a canvas. never rejects. resolves true when the font is loaded (or there is nothing to load:
 * system fonts, no document), false when loading failed: nothing is marked ready then, so a later call tries again.
 */
export async function ensureFont(family: string, weight: number = 400, italic = false, text?: string): Promise<boolean> {
  try {
    if (!family || !hasDocFonts()) return true;
    const w = weight >= 600 ? 700 : 400;
    const id = `${family}|${w}|${italic ? 1 : 0}`;
    const customText = text !== undefined && text.trim() !== '';
    if (!customText && ready.has(id)) return true;
    const runId = customText ? `${id}|${text}` : id;
    let p = inflight.get(runId);
    if (!p) {
      p = run(family, w, italic, customText ? text : undefined, id).finally(() => {
        inflight.delete(runId);
      });
      inflight.set(runId, p);
    }
    return await p;
  } catch {
    return false;
  }
}

async function run(family: string, weight: number, italic: boolean, text: string | undefined, id: string): Promise<boolean> {
  let b = BUNDLED_BY_FAMILY.get(family);
  if (!b && !importedFonts.has(family)) {
    await restoreImportedFonts(); // a project can name an imported font before the list was ever asked for
    b = BUNDLED_BY_FAMILY.get(family);
  }
  const cssOk = b ? await loadCss(b, weight, italic) : true;
  const desc = descriptor(family, weight, italic);
  const wasThere = safeCheck(desc, text ?? SAMPLE);
  let loaded = true;
  try {
    await document.fonts.load(desc, text ?? SAMPLE);
  } catch {
    loaded = false; // the font file could not be fetched / decoded: the canvas falls back
  }
  // a failed load is not "ready": the next ensureFont tries again instead of showing the fallback for good
  if (!cssOk || !loaded) return false;
  // load() resolves with nothing for an unknown family: measure to know if it is really there. a missing family is
  // not marked ready (the caller backs off on false; an import / local font list adds it to ready when it arrives)
  if (!b && !importedFonts.has(family) && !ready.has(id) && !familyRenders(family, weight, canvasWidth)) return false;
  if (!ready.has(id)) {
    ready.add(id);
    if (b || !wasThere) bump();
  } else if (!wasThere && safeCheck(desc, text ?? SAMPLE)) {
    bump(); // new unicode ranges arrived for a custom text
  }
  return true;
}

function safeCheck(desc: string, text: string): boolean {
  try {
    return document.fonts.check(desc, text);
  } catch {
    return false;
  }
}

/**
 * load every font the project's text clips use. the exporter awaits this before the first frame.
 * resolves with the families that could not be loaded (their text is drawn in the fallback font). never rejects.
 */
export async function ensureProjectFonts(project: Project): Promise<string[]> {
  try {
    await restoreImportedFonts();
    const jobs: Promise<string | null>[] = [];
    const seen = new Set<string>();
    for (const c of project.clips) {
      if (c.type !== 'text') continue;
      const key = `${c.fontFamily}|${c.fontWeight}|${c.italic}|${c.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const family = c.fontFamily;
      jobs.push(ensureFont(family, c.fontWeight, c.italic, c.text).then((ok) => (ok ? null : family)));
    }
    const failed = (await Promise.all(jobs)).filter((f): f is string => f !== null);
    return [...new Set(failed)];
  } catch {
    return [];
  }
}

/** warm a family (both text weights, upright). fire and forget; handy for hover / focus. */
export function warmFont(family: string): void {
  void ensureFont(family, 400);
  void ensureFont(family, 700);
}

// ---------- recent ----------

const RECENT_KEY = 'ncut-recent-fonts';
const RECENT_MAX = 6;

/** the last few families picked, newest first */
export function recentFonts(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function noteFontUsed(family: string): void {
  try {
    const next = [family, ...recentFonts().filter((f) => f !== family)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage can be blocked */
  }
}

// ---------- fonts installed on this computer ----------

interface LocalFontData {
  family: string;
}
type QueryLocalFonts = () => Promise<LocalFontData[]>;

export function canLoadLocalFonts(): boolean {
  return (
    typeof window !== 'undefined' && typeof (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts === 'function'
  );
}

/** asks for permission and lists the installed families. call it from a click only. resolves with how many were added. */
export async function loadLocalFonts(): Promise<number> {
  if (!canLoadLocalFonts()) throw new Error('this browser cannot list installed fonts');
  const query = (window as unknown as { queryLocalFonts: QueryLocalFonts }).queryLocalFonts;
  const data = await query.call(window);
  const have = new Set(listFonts().map((f) => f.family));
  const found = new Set<string>();
  for (const d of data) {
    if (d.family && !have.has(d.family)) found.add(d.family);
  }
  const added = [...found];
  if (added.length) {
    localFonts = [...new Set([...localFonts, ...added])].sort((a, b) => a.localeCompare(b));
    for (const family of added) for (const w of [400, 700]) for (const i of [0, 1]) ready.add(`${family}|${w}|${i}`);
    invalidateList();
    bump();
  }
  return added.length;
}

// ---------- imported font files (own indexeddb database) ----------

const DB_NAME = 'ncut-fonts';
const DB_VERSION = 2;
/** version 1 kept one row per family (keyPath 'family'). version 2 keeps one row per family + weight + style. */
const LEGACY_STORE = 'fonts';
const STORE = 'faces';

interface StoredFont {
  /** faceKey(family, weight, italic) */
  key: string;
  family: string;
  weight: number;
  italic: boolean;
  bytes: ArrayBuffer;
}

function openFontDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no indexeddb'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      const tx = req.transaction;
      if (tx && db.objectStoreNames.contains(LEGACY_STORE)) {
        // old rows (family only) become 400 normal faces
        const all = tx.objectStore(LEGACY_STORE).getAll();
        all.onsuccess = () => {
          const faceStore = tx.objectStore(STORE);
          for (const old of all.result as Array<{ family: string; bytes: ArrayBuffer }>) {
            faceStore.put({ key: faceKey(old.family, 400, false), family: old.family, weight: 400, italic: false, bytes: old.bytes } satisfies StoredFont);
          }
          db.deleteObjectStore(LEGACY_STORE);
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('could not open the font database'));
  });
}

async function dbRun<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openFontDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? new Error('font database error'));
      tx.onabort = () => reject(tx.error ?? new Error('font database error'));
    });
  } finally {
    db.close();
  }
}

/** every registered face, by faceKey */
const faces = new Map<string, { family: string; face: FontFace; weight: number; italic: boolean; bytes: ArrayBuffer }>();

/** one picker entry per family, summed up from its faces */
function refreshImportedInfo(family: string): void {
  const weights = new Set<number>();
  let italic = false;
  for (const [key, e] of faces) {
    if (e.family !== family) continue;
    const parts = key.split('|');
    weights.add(Number(parts[parts.length - 2]) || 400);
    if (parts[parts.length - 1] === 'italic') italic = true;
  }
  if (weights.size === 0) importedFonts.delete(family);
  else importedFonts.set(family, { family, category: 'imported', weights: [...weights].sort((a, b) => a - b), italic });
}

async function registerImported(family: string, weight: number, italic: boolean, bytes: ArrayBuffer): Promise<void> {
  const key = faceKey(family, weight, italic);
  const face = new FontFace(family, bytes.slice(0), { weight: String(weight), style: italic ? 'italic' : 'normal' });
  await face.load();
  const old = faces.get(key);
  if (old) document.fonts.delete(old.face);
  document.fonts.add(face);
  // the file itself is kept: a project file takes it along, also when the database could not store it
  faces.set(key, { family, face, weight, italic, bytes });
  refreshImportedInfo(family);
  for (const w of [400, 700]) for (const i of [0, 1]) ready.add(`${family}|${w}|${i}`);
}

let restoring: Promise<void> | null = null;

/** re-register the font files the user imported earlier. runs once, lazily. */
export function restoreImportedFonts(): Promise<void> {
  if (restoring) return restoring;
  if (!hasDocFonts() || typeof indexedDB === 'undefined') return Promise.resolve();
  restoring = (async () => {
    try {
      const all = await dbRun<StoredFont[]>('readonly', (s) => s.getAll() as IDBRequest<StoredFont[]>);
      let any = false;
      for (const f of all) {
        if (faces.has(f.key)) continue; // imported this session before the restore finished
        try {
          await registerImported(f.family, f.weight ?? 400, !!f.italic, f.bytes);
          any = true;
        } catch {
          /* a broken file stays in the database, it just is not offered */
        }
      }
      if (any) {
        invalidateList();
        bump();
      }
    } catch {
      /* no storage: imported fonts last for this session only */
    }
  })();
  return restoring;
}

const FONT_EXT = /\.(ttf|otf|woff2?)$/i;

function nameFromFile(file: File): string {
  const base = file.name.replace(FONT_EXT, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  // "Foo Bold Italic" -> "Foo": the weight and style words are not part of the family
  const cleaned = base.replace(/(\s+(regular|bold|italic|oblique|light|medium|semibold|black|thin))+$/i, '').trim();
  return (cleaned || base || 'imported font').slice(0, 60);
}

/**
 * add a .ttf / .otf / .woff / .woff2 file. keeps the bytes so it is there next session. throws a readable error.
 * several files of one family (regular, bold, italic ...) all stay: they are told apart by weight + style.
 */
export async function importFontFile(file: File): Promise<FontInfo> {
  if (!hasDocFonts()) throw new Error('fonts are not available here');
  if (!FONT_EXT.test(file.name)) throw new Error('use a .ttf, .otf, .woff or .woff2 file');
  const bytes = await file.arrayBuffer();
  const meta = readFontMeta(bytes, file.name);
  let family = meta.family || nameFromFile(file);
  family = family.replace(/["\\]/g, '').slice(0, 60) || 'imported font';
  // never shadow a bundled / system family
  if (BUNDLED_BY_FAMILY.has(family) || SYSTEM_FONTS.includes(family)) family = `${family} (imported)`;
  try {
    await registerImported(family, meta.weight, meta.italic, bytes);
  } catch {
    throw new Error(`could not read ${file.name}, is it a valid font?`);
  }
  try {
    await dbRun('readwrite', (s) =>
      s.put({ key: faceKey(family, meta.weight, meta.italic), family, weight: meta.weight, italic: meta.italic, bytes } satisfies StoredFont),
    );
  } catch {
    /* works for this session, just not saved */
  }
  invalidateList();
  bump();
  return importedFonts.get(family)!;
}

/** remove an imported family with all its files */
export async function removeImportedFont(family: string): Promise<void> {
  const keys = [...faces.entries()].filter(([, e]) => e.family === family).map(([k]) => k);
  for (const k of keys) {
    const e = faces.get(k);
    if (e && hasDocFonts()) document.fonts.delete(e.face);
    faces.delete(k);
  }
  importedFonts.delete(family);
  for (const k of [...ready]) if (k.startsWith(`${family}|`)) ready.delete(k);
  invalidateList();
  for (const k of keys) {
    try {
      await dbRun('readwrite', (s) => s.delete(k));
    } catch {
      /* nothing stored */
    }
  }
  bump();
}

// ---------- font files inside a project file ----------

export interface FontFile {
  family: string;
  weight: number;
  italic: boolean;
  bytes: ArrayBuffer;
}

/** every imported face of these families (for packing into a .ncut file), read from the registered faces. never rejects. */
export async function importedFontFiles(families: Iterable<string>): Promise<FontFile[]> {
  try {
    const want = new Set(families);
    if (want.size === 0) return [];
    // every stored face is registered by now, and so is a face that only lives in this session (storage full)
    await restoreImportedFonts();
    const out: FontFile[] = [];
    for (const f of faces.values()) {
      if (!want.has(f.family) || !f.bytes) continue;
      out.push({ family: f.family, weight: f.weight, italic: f.italic, bytes: f.bytes });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * register + store faces that came with a project file. a face that is already here is left alone (the user's own
 * copy wins), bundled / system families are never shadowed, broken files are skipped. resolves with how many were added.
 */
export async function addFontFiles(files: FontFile[]): Promise<number> {
  let added = 0;
  try {
    await restoreImportedFonts();
    for (const f of files) {
      try {
        if (!f.family || BUNDLED_BY_FAMILY.has(f.family) || SYSTEM_FONTS.includes(f.family)) continue;
        const key = faceKey(f.family, f.weight, f.italic);
        if (faces.has(key)) continue;
        await registerImported(f.family, f.weight, f.italic, f.bytes);
        added++;
        try {
          await dbRun('readwrite', (s) =>
            s.put({ key, family: f.family, weight: f.weight, italic: f.italic, bytes: f.bytes } satisfies StoredFont),
          );
        } catch {
          /* works for this session, just not saved */
        }
      } catch {
        /* a broken file is skipped */
      }
    }
    if (added > 0) {
      invalidateList();
      bump();
    }
  } catch {
    /* nothing more to do */
  }
  return added;
}
