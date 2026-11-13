'use strict';
// writes release/ncut-<version>-web.zip: the browser build (dist-web/, built with a relative base so it runs from any
// folder of a static host) with the licenses and a short how to. `npm run web` builds dist-web/ and then runs this.
// the zip is written here with node's zlib, so no zip tool has to be on the machine and the names in it always use
// forward slashes.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** date and time the way a zip stores them (local time, 2 second steps, nothing before 1980) */
function dosStamp(date) {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * a zip file from `entries` ({ name, data }), names with forward slashes. deflate where it makes a file smaller,
 * stored as is otherwise. no zip64: fine below 65535 files and 4 gb, more than that throws.
 */
function zip(entries, when = new Date()) {
  if (entries.length > 0xfffe) throw new Error(`too many files for a plain zip: ${entries.length}`);
  const stamp = dosStamp(when);
  const seen = new Set();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    if (!entry.name || entry.name.includes('\\') || entry.name.startsWith('/') || entry.name.split('/').includes('..')) {
      throw new Error(`not a name for a zip: ${JSON.stringify(entry.name)}`);
    }
    if (seen.has(entry.name)) throw new Error(`twice in the zip: ${entry.name}`);
    seen.add(entry.name);
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const stored = packed.length >= data.length;
    const body = stored ? data : packed;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // names are utf-8
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4); // made by
    head.writeUInt16LE(20, 6); // version needed
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(stored ? 0 : 8, 10);
    head.writeUInt16LE(stamp.time, 12);
    head.writeUInt16LE(stamp.date, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(name.length, 28);
    // extra, comment, disk, internal and external attributes stay 0
    head.writeUInt32LE(offset, 42);

    parts.push(local, name, body);
    central.push(head, name);
    offset += local.length + name.length + body.length;
    if (offset > 0xfffffffe) throw new Error('too big for a plain zip (4 gb)');
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** every file under `dir` as { name, data }, names relative to it with forward slashes, sorted */
function collect(dir, prefix = '') {
  const out = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) out.push(...collect(full, `${prefix}${item.name}/`));
    else if (item.isFile()) out.push({ name: `${prefix}${item.name}`, data: fs.readFileSync(full) });
  }
  return out;
}

function readme(version) {
  return [
    `ncut ${version}, the browser version.`,
    '',
    'put this folder on any static web host (github pages, netlify, cloudflare pages, your own server), it runs from',
    'any folder there. the address has to be https (or localhost), a browser only gives webcodecs to those.',
    '',
    'to try it on your machine, run this in the folder and open the address it prints:',
    '',
    '  npx serve .',
    '',
    'use a chromium based browser (chrome, edge, brave). opening index.html straight from the disk does not work,',
    'a browser does not load the app from file://.',
    '',
    'ncut is under the mit license (LICENSE). what it bundles is listed in THIRD-PARTY-NOTICES.md.',
    'https://github.com/sagecsharp/ncut',
    '',
  ].join('\n');
}

/** what goes into the web zip: the build, the two license files and the how to, all in one folder */
function webEntries(root, version) {
  const built = path.join(root, 'dist-web');
  if (!fs.existsSync(path.join(built, 'index.html'))) throw new Error('dist-web/index.html is not there: run `npm run web`');
  const files = collect(built);
  for (const extra of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) {
    files.push({ name: extra, data: fs.readFileSync(path.join(root, extra)) });
  }
  files.push({ name: 'readme.txt', data: Buffer.from(readme(version), 'utf8') });
  return files.map((f) => ({ name: `ncut-web/${f.name}`, data: f.data }));
}

module.exports = { crc32, zip, collect, webEntries, readme };

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const index = fs.readFileSync(path.join(root, 'dist-web', 'index.html'), 'utf8');
  if (/(?:src|href)="\//.test(index)) {
    throw new Error('dist-web was built with an absolute base, it would only run from the root of a host: use `npm run web`');
  }
  const entries = webEntries(root, version);
  const out = path.join(root, 'release', `ncut-${version}-web.zip`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const bytes = zip(entries);
  fs.writeFileSync(out, bytes);
  console.log(`[web] wrote ${path.relative(root, out)} (${entries.length} files, ${bytes.length} bytes)`);
}
