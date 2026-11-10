/**
 * what an imported font file says about itself: family, weight and style. pure (no dom), unit tested.
 * ttf / otf are read from their tables; woff / woff2 are compressed so only the file name can be used for those.
 */

export interface FontMeta {
  /** family name from the name table (id 16, else 1), '' when unknown */
  family: string;
  /** css weight 100..900, from the OS/2 table or the file name */
  weight: number;
  italic: boolean;
}

interface SfntInfo {
  family: string;
  subfamily: string;
  /** undefined when the font has no OS/2 table */
  weight?: number;
  italic?: boolean;
}

const TAG_NAME = 0x6e616d65;
const TAG_OS2 = 0x4f532f32;

function findTable(v: DataView, tag: number): number {
  const n = v.getUint16(4);
  for (let i = 0; i < n; i++) {
    const rec = 12 + i * 16;
    if (v.getUint32(rec) === tag) return v.getUint32(rec + 8);
  }
  return 0;
}

/** best string of the wanted name ids (earlier ids in `ids` win; windows / unicode records win over mac) */
function readName(v: DataView, off: number, ids: readonly number[]): string {
  const count = v.getUint16(off + 2);
  const strings = off + v.getUint16(off + 4);
  let best = '';
  let bestScore = 0;
  for (let i = 0; i < count; i++) {
    const r = off + 6 + i * 12;
    const platform = v.getUint16(r);
    const rank = ids.indexOf(v.getUint16(r + 6));
    if (rank < 0) continue;
    const len = v.getUint16(r + 8);
    const at = strings + v.getUint16(r + 10);
    let s = '';
    if (platform === 3 || platform === 0) {
      for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(v.getUint16(at + k));
    } else if (platform === 1) {
      for (let k = 0; k < len; k++) s += String.fromCharCode(v.getUint8(at + k));
    } else continue;
    const score = (ids.length - rank) * 2 + (platform === 3 ? 0.5 : 0);
    if (s.trim() && score > bestScore) {
      best = s.trim();
      bestScore = score;
    }
  }
  return best;
}

function readSfnt(buf: ArrayBuffer): SfntInfo | null {
  try {
    const v = new DataView(buf);
    const tag = v.getUint32(0);
    if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return null; // not ttf / otf / true
    const info: SfntInfo = { family: '', subfamily: '' };
    const name = findTable(v, TAG_NAME);
    if (name) {
      info.family = readName(v, name, [16, 1]);
      info.subfamily = readName(v, name, [17, 2]);
    }
    const os2 = findTable(v, TAG_OS2);
    if (os2) {
      const w = v.getUint16(os2 + 4);
      if (w >= 1 && w <= 1000) info.weight = w;
      const sel = v.getUint16(os2 + 62);
      info.italic = (sel & 1) !== 0 || (sel & 0x200) !== 0; // italic or oblique
    }
    return info;
  } catch {
    return null;
  }
}

/** the family name of a ttf / otf (id 16, else 1). '' when it cannot be read. */
export function readSfntFamily(buf: ArrayBuffer): string {
  try {
    const v = new DataView(buf);
    const tag = v.getUint32(0);
    if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return '';
    const name = findTable(v, TAG_NAME);
    return name ? readName(v, name, [16, 1]) : '';
  } catch {
    return '';
  }
}

/** weight and style words in a file name or style name ("Foo-SemiBoldItalic.ttf", "Bold Italic"). null weight = no word found. */
export function guessStyleFromName(name: string): { weight: number | null; italic: boolean } {
  const s = name.toLowerCase().replace(/\.(ttf|otf|woff2?)$/, '').replace(/[^a-z0-9]+/g, '');
  const italic = /italic|oblique/.test(s);
  // longer words first: "extrabold" before "bold", "semibold" before "bold", "extralight" before "light"
  const table: Array<[RegExp, number]> = [
    [/extralight|ultralight|hairline/, 200],
    [/extrabold|ultrabold|heavy/, 800],
    [/semibold|demibold/, 600],
    [/thin/, 100],
    [/light/, 300],
    [/medium/, 500],
    [/black/, 900],
    [/bold/, 700],
  ];
  for (const [re, w] of table) if (re.test(s)) return { weight: w, italic };
  return { weight: null, italic };
}

/** family, weight and style of a font file. falls back to the file name, then to 400 normal. */
export function readFontMeta(buf: ArrayBuffer, fileName: string): FontMeta {
  const info = readSfnt(buf);
  const byName = guessStyleFromName(info?.subfamily ? `${fileName} ${info.subfamily}` : fileName);
  const weight = info?.weight ?? byName.weight ?? 400;
  // a font without an OS/2 table: trust the words in the names
  const italic = info?.italic === undefined ? byName.italic : info.italic || byName.italic;
  return { family: info?.family ?? '', weight: Math.max(100, Math.min(900, Math.round(weight / 100) * 100)), italic };
}

/** key of one stored face: a family has one file per weight + style */
export function faceKey(family: string, weight: number, italic: boolean): string {
  return `${family}|${weight}|${italic ? 'italic' : 'normal'}`;
}
