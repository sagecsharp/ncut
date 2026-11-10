import { describe, expect, it } from 'vitest';
import { faceKey, guessStyleFromName, readFontMeta, readSfntFamily } from './fontMeta';

interface Opts {
  family: string;
  subfamily?: string;
  weight?: number;
  fsSelection?: number;
  os2?: boolean;
}

/** a minimal ttf: header, a table directory with 'name' (+ 'OS/2'), nothing else */
function buildFont(o: Opts): ArrayBuffer {
  const withOs2 = o.os2 !== false && o.weight !== undefined;
  const records: Array<[number, string]> = [[16, o.family]];
  if (o.subfamily) records.push([2, o.subfamily]);
  // name table: format 0, count, string offset, records, then utf-16be strings
  const strBytes = records.map(([, s]) => s.length * 2);
  const nameLen = 6 + records.length * 12 + strBytes.reduce((a, b) => a + b, 0);
  const tables = withOs2 ? 2 : 1;
  const dirLen = 12 + tables * 16;
  const nameOff = dirLen;
  const os2Off = nameOff + nameLen;
  const os2Len = 64;
  const buf = new ArrayBuffer(os2Off + (withOs2 ? os2Len : 0));
  const v = new DataView(buf);
  v.setUint32(0, 0x00010000);
  v.setUint16(4, tables);
  const tag = (i: number, t: string, off: number, len: number) => {
    const r = 12 + i * 16;
    for (let k = 0; k < 4; k++) v.setUint8(r + k, t.charCodeAt(k));
    v.setUint32(r + 8, off);
    v.setUint32(r + 12, len);
  };
  tag(0, 'name', nameOff, nameLen);
  if (withOs2) tag(1, 'OS/2', os2Off, os2Len);
  v.setUint16(nameOff + 2, records.length);
  v.setUint16(nameOff + 4, 6 + records.length * 12);
  let strAt = 0;
  records.forEach(([id, s], i) => {
    const r = nameOff + 6 + i * 12;
    v.setUint16(r, 3); // windows
    v.setUint16(r + 2, 1);
    v.setUint16(r + 4, 0x409);
    v.setUint16(r + 6, id);
    v.setUint16(r + 8, s.length * 2);
    v.setUint16(r + 10, strAt);
    for (let k = 0; k < s.length; k++) v.setUint16(nameOff + 6 + records.length * 12 + strAt + k * 2, s.charCodeAt(k));
    strAt += s.length * 2;
  });
  if (withOs2) {
    v.setUint16(os2Off + 4, o.weight!);
    v.setUint16(os2Off + 62, o.fsSelection ?? 0);
  }
  return buf;
}

describe('readFontMeta', () => {
  it('reads family, weight and italic from the tables', () => {
    const m = readFontMeta(buildFont({ family: 'Foo', subfamily: 'Bold Italic', weight: 700, fsSelection: 0x21 }), 'x.ttf');
    expect(m).toEqual({ family: 'Foo', weight: 700, italic: true });
  });

  it('a regular file is 400 normal', () => {
    const m = readFontMeta(buildFont({ family: 'Foo', subfamily: 'Regular', weight: 400, fsSelection: 0x40 }), 'Foo-Regular.ttf');
    expect(m).toEqual({ family: 'Foo', weight: 400, italic: false });
  });

  it('the os/2 weight wins over the file name', () => {
    const m = readFontMeta(buildFont({ family: 'Foo', weight: 300, fsSelection: 0 }), 'Foo-Bold.ttf');
    expect(m.weight).toBe(300);
  });

  it('oblique counts as italic', () => {
    const m = readFontMeta(buildFont({ family: 'Foo', weight: 400, fsSelection: 0x200 }), 'x.ttf');
    expect(m.italic).toBe(true);
  });

  it('without an os/2 table the style name and file name decide', () => {
    const m = readFontMeta(buildFont({ family: 'Foo', subfamily: 'Bold Italic' }), 'Foo.ttf');
    expect(m).toEqual({ family: 'Foo', weight: 700, italic: true });
    const n = readFontMeta(buildFont({ family: 'Foo' }), 'Foo-Light.ttf');
    expect(n.weight).toBe(300);
  });

  it('falls back to the file name for files it cannot parse (woff, junk)', () => {
    const junk = new ArrayBuffer(4);
    expect(readFontMeta(junk, 'Foo-BoldItalic.woff2')).toEqual({ family: '', weight: 700, italic: true });
    expect(readFontMeta(junk, 'whatever.woff')).toEqual({ family: '', weight: 400, italic: false });
  });

  it('two files of one family get different keys', () => {
    const a = readFontMeta(buildFont({ family: 'Foo', weight: 400, fsSelection: 0 }), 'Foo-Regular.ttf');
    const b = readFontMeta(buildFont({ family: 'Foo', weight: 700, fsSelection: 0 }), 'Foo-Bold.ttf');
    expect(faceKey(a.family, a.weight, a.italic)).not.toBe(faceKey(b.family, b.weight, b.italic));
    expect(faceKey('Foo', 400, false)).toBe('Foo|400|normal');
  });
});

describe('readSfntFamily', () => {
  it('reads the family and returns empty for junk', () => {
    expect(readSfntFamily(buildFont({ family: 'My Font', weight: 400 }))).toBe('My Font');
    expect(readSfntFamily(new ArrayBuffer(2))).toBe('');
  });
});

describe('guessStyleFromName', () => {
  it('finds weights, longest word first', () => {
    expect(guessStyleFromName('Foo-ExtraBold.ttf').weight).toBe(800);
    expect(guessStyleFromName('Foo SemiBold').weight).toBe(600);
    expect(guessStyleFromName('Foo-ExtraLight.otf').weight).toBe(200);
    expect(guessStyleFromName('Foo-Black.ttf').weight).toBe(900);
    expect(guessStyleFromName('Foo-Regular.ttf').weight).toBeNull();
  });
  it('finds italic', () => {
    expect(guessStyleFromName('Foo_Light_Italic.ttf')).toEqual({ weight: 300, italic: true });
  });
});
