import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { crc32, zip, collect, readme } = require('./make-web-zip.cjs');

/** reads a zip back the way an unzip tool does: end record -> directory -> each file's own header */
function unzip(buf) {
  const end = buf.length - 22;
  expect(buf.readUInt32LE(end)).toBe(0x06054b50);
  const count = buf.readUInt16LE(end + 10);
  expect(buf.readUInt16LE(end + 8)).toBe(count);
  const size = buf.readUInt32LE(end + 12);
  let at = buf.readUInt32LE(end + 16);
  expect(at + size).toBe(end);
  const files = [];
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(at)).toBe(0x02014b50);
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const packed = buf.readUInt32LE(at + 20);
    const full = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);

    // the file's own header has to say the same as the directory
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    expect(buf.readUInt16LE(local + 6)).toBe(flags);
    expect(buf.readUInt16LE(local + 8)).toBe(method);
    expect(buf.readUInt32LE(local + 14)).toBe(crc);
    expect(buf.readUInt32LE(local + 18)).toBe(packed);
    expect(buf.readUInt32LE(local + 22)).toBe(full);
    const localName = buf.readUInt16LE(local + 26);
    expect(buf.subarray(local + 30, local + 30 + localName).toString('utf8')).toBe(name);
    const start = local + 30 + localName + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + packed);
    const data = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
    expect([0, 8]).toContain(method);
    expect(data.length).toBe(full);
    expect(crc32(data)).toBe(crc);
    files.push({ name, data, method, flags });
  }
  expect(at).toBe(end);
  return files;
}

/** bytes that do not get smaller when deflated */
function noise(n) {
  const out = Buffer.alloc(n);
  let s = 0x2545f491;
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out[i] = s & 0xff;
  }
  return out;
}

describe('the web zip', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ncut-zip-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('crc32 is the zip one', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
    expect(crc32(noise(5000))).toBe(zlib.crc32(noise(5000)));
  });

  it('gives every file back byte for byte', () => {
    const entries = [
      { name: 'ncut-web/index.html', data: Buffer.from('<!doctype html>\n'.repeat(400)) },
      { name: 'ncut-web/assets/a-B1.js', data: Buffer.from('export const a = 1;\n'.repeat(3000)) },
      { name: 'ncut-web/assets/font.woff2', data: noise(70000) },
      { name: 'ncut-web/empty.txt', data: Buffer.alloc(0) },
      { name: 'ncut-web/zoë müller/ü.txt', data: Buffer.from('ü\n') },
    ];
    const back = unzip(zip(entries, new Date(2026, 10, 12, 21, 30, 44)));
    expect(back.map((f) => f.name)).toEqual(entries.map((e) => e.name));
    for (let i = 0; i < entries.length; i++) expect(back[i].data.equals(entries[i].data)).toBe(true);
    // text is deflated, what would only grow is stored as is, names are marked utf-8
    expect(back[0].method).toBe(8);
    expect(back[2].method).toBe(0);
    expect(back[3].method).toBe(0);
    for (const f of back) expect(f.flags).toBe(0x0800);
  });

  it('stores the date as a zip does', () => {
    const buf = zip([{ name: 'a.txt', data: Buffer.from('a') }], new Date(2026, 10, 12, 21, 30, 44));
    const time = buf.readUInt16LE(10);
    const date = buf.readUInt16LE(12);
    expect([time >> 11, (time >> 5) & 63, (time & 31) * 2]).toEqual([21, 30, 44]);
    expect([(date >> 9) + 1980, (date >> 5) & 15, date & 31]).toEqual([2026, 11, 12]);
  });

  it('an empty zip is still a zip', () => {
    const buf = zip([]);
    expect(buf.length).toBe(22);
    expect(unzip(buf)).toEqual([]);
  });

  it('refuses names an unzip tool would trip over', () => {
    const data = Buffer.from('x');
    expect(() => zip([{ name: 'a\\b.txt', data }])).toThrow(/not a name/);
    expect(() => zip([{ name: '/a.txt', data }])).toThrow(/not a name/);
    expect(() => zip([{ name: 'a/../b.txt', data }])).toThrow(/not a name/);
    expect(() => zip([{ name: '', data }])).toThrow(/not a name/);
    expect(() => zip([{ name: 'a.txt', data }, { name: 'a.txt', data }])).toThrow(/twice/);
  });

  it('collects a folder with forward slashes, sorted', () => {
    fs.mkdirSync(path.join(tmp, 'assets', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'index.html'), 'i');
    fs.writeFileSync(path.join(tmp, 'assets', 'b.js'), 'b');
    fs.writeFileSync(path.join(tmp, 'assets', 'a.js'), 'a');
    fs.writeFileSync(path.join(tmp, 'assets', 'deep', 'c.css'), 'c');
    const got = collect(tmp);
    expect(got.map((f) => f.name)).toEqual(['assets/a.js', 'assets/b.js', 'assets/deep/c.css', 'index.html']);
    expect(got.map((f) => f.data.toString())).toEqual(['a', 'b', 'c', 'i']);
    expect(unzip(zip(got)).map((f) => f.name)).toEqual(got.map((f) => f.name));
  });

  it('the how to names the version and the two license files', () => {
    const text = readme('1.2.3');
    expect(text).toContain('ncut 1.2.3');
    expect(text).toContain('LICENSE');
    expect(text).toContain('THIRD-PARTY-NOTICES.md');
    expect(text).not.toContain('\r');
  });
});
