/**
 * a font kit carries the web fonts of a project from the main thread to a worker. a worker has no stylesheets, so
 * it cannot use the @fontsource css files that the main thread imports on demand: the main thread reads the
 * @font-face rules it already loaded (collectFontKit) and the worker rebuilds the faces (installFontKit).
 * fonts of the computer need no entry (they are drawn by family name). the parts that are pure (css src parsing, url
 * resolving, descriptor normalizing, rule to face matching) are exported and unit tested.
 * import-safe in node and in a worker.
 */
import type { Project } from '../types';
import { fontSet, importedFontFiles, markFontFamiliesInstalled, projectFontUses } from './fonts';

export interface FontKitFace {
  family: string;
  weight: string;
  style: string;
  stretch?: string;
  unicodeRange?: string;
  /** absolute url of the font file, or */
  url?: string;
  /** the file itself */
  bytes?: ArrayBuffer;
}

export interface FontKit {
  faces: FontKitFace[];
}

// ---------- pure parts ----------

/** a family name without quotes, spaces collapsed, lower case: how rules and FontFace objects are compared */
export function normalizeFamily(family: string): string {
  return family.replace(/["']/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** the family as written, without the quotes around it */
export function unquoteFamily(family: string): string {
  return family.replace(/^\s*["']|["']\s*$/g, '').replace(/\s+/g, ' ').trim();
}

/** '400' / 'normal' -> '400', 'bold' -> '700', '100 900' stays a range; empty = normal */
export function normalizeWeight(weight: string | undefined): string {
  const w = (weight ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (w === '' || w === 'normal') return '400';
  if (w === 'bold') return '700';
  const parts = w.split(' ').map((p) => (p === 'normal' ? '400' : p === 'bold' ? '700' : p));
  return parts.length === 2 && parts[0] === parts[1] ? parts[0] : parts.join(' ');
}

/** 'normal' / 'italic' / 'oblique 10deg'; empty = normal */
export function normalizeStyle(style: string | undefined): string {
  const s = (style ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return s === '' ? 'normal' : s;
}

/** unicode ranges compared as lower case without spaces after the commas; empty = the default (everything) */
export function normalizeRange(range: string | undefined): string {
  const r = (range ?? '').trim().toLowerCase().replace(/\s+/g, '');
  return r === '' || r === 'u+0-10ffff' ? 'u+0-10ffff' : r;
}

/** the key that tells two faces apart: family + weight + style + unicode range */
export function faceMatchKey(face: { family: string; weight?: string; style?: string; unicodeRange?: string }): string {
  return `${normalizeFamily(face.family)}|${normalizeWeight(face.weight)}|${normalizeStyle(face.style)}|${normalizeRange(face.unicodeRange)}`;
}

export interface SrcEntry {
  url: string;
  format: string;
}

/** the url() entries of a css src descriptor, in order, with their format() hint (lower case, '' without). local() entries are skipped. */
export function parseSrc(src: string): SrcEntry[] {
  const out: SrcEntry[] = [];
  const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)(?:\s*format\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const url = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!url) continue;
    out.push({ url, format: (m[4] ?? m[5] ?? m[6] ?? '').trim().toLowerCase() });
  }
  return out;
}

function formatOf(e: SrcEntry): string {
  if (e.format) return e.format;
  const path = e.url.split(/[?#]/)[0].toLowerCase();
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot + 1) : '';
}

/** the entry to download: woff2 first, then woff, then ttf / otf, then whatever is first. null when there is none. */
export function pickSrc(entries: SrcEntry[]): SrcEntry | null {
  if (entries.length === 0) return null;
  const rank = (e: SrcEntry): number => {
    const f = formatOf(e);
    if (f === 'woff2') return 0;
    if (f === 'woff') return 1;
    if (f === 'truetype' || f === 'ttf' || f === 'opentype' || f === 'otf') return 2;
    return 3;
  };
  let best = entries[0];
  for (const e of entries) if (rank(e) < rank(best)) best = e;
  return best;
}

/** an absolute url, resolved against the stylesheet (or document) base. null when it cannot be made absolute. */
export function resolveUrl(url: string, base: string | null | undefined): string | null {
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return new URL(url).href;
    if (!base) return null;
    return new URL(url, base).href;
  } catch {
    return null;
  }
}

/** one @font-face rule, read from a stylesheet */
export interface FaceRule {
  family: string;
  weight: string;
  style: string;
  stretch: string;
  unicodeRange: string;
  src: string;
  /** href of the stylesheet that holds the rule, or the document base */
  base: string | null;
}

/**
 * the kit faces for the given rules: only rules of the wanted families whose face is in `loaded` (match keys of the
 * FontFace objects that have status 'loaded'). the family is written the way the project spells it. one face per key.
 */
export function facesFromRules(rules: FaceRule[], wanted: Map<string, string>, loaded: Set<string>): FontKitFace[] {
  const out: FontKitFace[] = [];
  const done = new Set<string>();
  for (const r of rules) {
    const spelled = wanted.get(normalizeFamily(r.family));
    if (spelled === undefined) continue;
    const key = faceMatchKey(r);
    if (!loaded.has(key) || done.has(key)) continue;
    const pick = pickSrc(parseSrc(r.src));
    if (!pick) continue;
    const url = resolveUrl(pick.url, r.base);
    if (!url) continue;
    done.add(key);
    const face: FontKitFace = { family: spelled, weight: normalizeWeight(r.weight), style: normalizeStyle(r.style), url };
    const stretch = r.stretch.trim();
    if (stretch && stretch.toLowerCase() !== 'normal' && stretch !== '100%') face.stretch = stretch;
    const range = r.unicodeRange.trim();
    if (range) face.unicodeRange = range;
    out.push(face);
  }
  return out;
}

/** the descriptors of a FontFace for a kit face (only what is set) */
export function faceDescriptors(face: FontKitFace): { weight: string; style: string; stretch?: string; unicodeRange?: string } {
  const d: { weight: string; style: string; stretch?: string; unicodeRange?: string } = {
    weight: face.weight || '400',
    style: face.style || 'normal',
  };
  if (face.stretch) d.stretch = face.stretch;
  if (face.unicodeRange) d.unicodeRange = face.unicodeRange;
  return d;
}

/** identity of a kit face for "installed already": the match key plus where the file comes from */
export function kitFaceId(face: FontKitFace): string {
  return `${faceMatchKey(face)}|${face.url ?? `bytes:${face.bytes?.byteLength ?? 0}`}`;
}

// ---------- main thread: collect ----------

function readRules(list: CSSRuleList, base: string | null, out: FaceRule[], depth: number): void {
  if (depth > 8) return;
  for (let i = 0; i < list.length; i++) {
    const rule = list[i];
    if (typeof CSSFontFaceRule !== 'undefined' && rule instanceof CSSFontFaceRule) {
      const st = rule.style;
      out.push({
        family: st.getPropertyValue('font-family'),
        weight: st.getPropertyValue('font-weight'),
        style: st.getPropertyValue('font-style'),
        stretch: st.getPropertyValue('font-stretch'),
        unicodeRange: st.getPropertyValue('unicode-range'),
        src: st.getPropertyValue('src'),
        base,
      });
      continue;
    }
    if (typeof CSSImportRule !== 'undefined' && rule instanceof CSSImportRule) {
      readSheet(rule.styleSheet, out, depth + 1);
      continue;
    }
    // @media / @supports / @layer ...
    const nested = (rule as { cssRules?: CSSRuleList }).cssRules;
    if (nested) readRules(nested, base, out, depth + 1);
  }
}

function readSheet(sheet: CSSStyleSheet | null, out: FaceRule[], depth: number): void {
  if (!sheet) return;
  let rules: CSSRuleList;
  try {
    rules = sheet.cssRules; // throws for a cross origin sheet without cors
  } catch {
    return;
  }
  readRules(rules, sheet.href ?? (typeof document !== 'undefined' ? document.baseURI : null), out, depth);
}

/** every @font-face rule of the document's stylesheets that can be read */
function documentFaceRules(): FaceRule[] {
  const out: FaceRule[] = [];
  if (typeof document === 'undefined') return out;
  for (let i = 0; i < document.styleSheets.length; i++) readSheet(document.styleSheets[i], out, 0);
  return out;
}

/** match keys of the faces of the font set that have finished loading */
function loadedKeys(): Set<string> {
  const keys = new Set<string>();
  const set = fontSet();
  if (!set) return keys;
  set.forEach((f) => {
    if (f.status === 'loaded') keys.add(faceMatchKey(f));
  });
  return keys;
}

/**
 * MAIN THREAD. every web font face that the project's text can need, ready to send to a worker. call it after
 * ensureProjectFonts(project): a face is only included when it has been loaded (a stylesheet face no text used is skipped).
 * imported font files are always included (bytes, a copy). fonts of the computer have no entry. never rejects.
 */
export async function collectFontKit(project: Project): Promise<FontKit> {
  const faces: FontKitFace[] = [];
  try {
    const wanted = new Map<string, string>();
    for (const u of projectFontUses(project)) {
      const key = normalizeFamily(u.family);
      if (key && !wanted.has(key)) wanted.set(key, u.family);
    }
    if (wanted.size === 0) return { faces };
    faces.push(...facesFromRules(documentFaceRules(), wanted, loadedKeys()));
    for (const f of await importedFontFiles(wanted.values())) {
      faces.push({
        family: f.family,
        weight: String(f.weight),
        style: f.italic ? 'italic' : 'normal',
        bytes: f.bytes.slice(0),
      });
    }
  } catch {
    /* a kit with fewer faces: the worker falls back to the computer's fonts for those */
  }
  return { faces };
}

// ---------- any thread: install ----------

/** faces installed in this global already (a second call with the same kit adds nothing) */
const installedIds = new Set<string>();

/**
 * ANY THREAD (meant for a worker). builds a FontFace for every kit face, adds it to the font set of this global
 * (self.fonts in a worker, document.fonts on the main thread), waits for all of them and tells lib/fonts that the
 * families are there, so ensureFont answers true for them without any stylesheet. resolves with the families of which a face
 * failed to load (those are not marked as installed). never rejects.
 */
export async function installFontKit(kit: FontKit): Promise<string[]> {
  const families = new Set<string>();
  const failed = new Set<string>();
  try {
    const list = kit?.faces ?? [];
    for (const f of list) if (f?.family) families.add(f.family);
    const set = fontSet();
    if (!set || typeof FontFace === 'undefined') return [...families];
    const have = loadedKeys(); // a face the font set already holds (the main thread) is not added twice
    const jobs: Promise<void>[] = [];
    for (const f of list) {
      if (!f?.family || (!f.url && !f.bytes)) {
        if (f?.family) failed.add(f.family);
        continue;
      }
      const id = kitFaceId(f);
      if (installedIds.has(id) || have.has(faceMatchKey(f))) continue;
      jobs.push(
        (async () => {
          try {
            const source = f.bytes ? f.bytes.slice(0) : `url("${(f.url as string).replace(/["\\]/g, (c) => `\\${c}`)}")`;
            const face = new FontFace(f.family, source, faceDescriptors(f));
            await face.load();
            set.add(face);
            installedIds.add(id);
          } catch {
            failed.add(f.family);
          }
        })(),
      );
    }
    await Promise.all(jobs);
    markFontFamiliesInstalled([...families].filter((fam) => !failed.has(fam)));
  } catch {
    for (const fam of families) failed.add(fam);
  }
  return [...failed];
}
