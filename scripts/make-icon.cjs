'use strict';
/**
 * draws the app icon (the same picture as public/favicon.svg) without any image library:
 * build/icon.png (512 px) and build/icon.ico (16 .. 256 px) for the windows exe.
 * run: node scripts/make-icon.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// the favicon, in its 32 x 32 units: [x, y, width, height, corner radius, color]
const SHAPES = [
  [0, 0, 32, 32, 6, '#161616'],
  [5, 8, 14, 6, 1.5, '#f2f2f2'],
  [11, 18, 16, 6, 1.5, '#7a7a7a'],
  [20.5, 5, 2, 22, 0, '#e6e6e6'],
];
const UNITS = 32;
const SAMPLES = 8; // per axis, per pixel

function hex(c) {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}

function insideRounded(px, py, [x, y, w, h, r]) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  if (r <= 0) return true;
  const cx = px < x + r ? x + r : px > x + w - r ? x + w - r : px;
  const cy = py < y + r ? y + r : py > y + h - r ? y + h - r : py;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/** rgba bytes (straight alpha), top row first */
function draw(size) {
  const out = Buffer.alloc(size * size * 4);
  const colors = SHAPES.map((s) => hex(s[5]));
  const n = SAMPLES * SAMPLES;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sj = 0; sj < SAMPLES; sj++) {
        for (let si = 0; si < SAMPLES; si++) {
          const px = ((i + (si + 0.5) / SAMPLES) / size) * UNITS;
          const py = ((j + (sj + 0.5) / SAMPLES) / size) * UNITS;
          // the topmost shape under the sample wins (all shapes are opaque)
          for (let k = SHAPES.length - 1; k >= 0; k--) {
            if (!insideRounded(px, py, SHAPES[k])) continue;
            r += colors[k][0];
            g += colors[k][1];
            b += colors[k][2];
            a += 1;
            break;
          }
        }
      }
      const o = (j * size + i) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return out;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // rgba
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let j = 0; j < size; j++) rgba.copy(raw, j * (size * 4 + 1) + 1, j * size * 4, (j + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** a 32 bit icon bitmap: header, bgra rows bottom up, then the 1 bit mask */
function dib(size, rgba) {
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0);
  head.writeInt32LE(size, 4);
  head.writeInt32LE(size * 2, 8); // picture + mask
  head.writeUInt16LE(1, 12);
  head.writeUInt16LE(32, 14);
  head.writeUInt32LE(size * size * 4, 20);
  const pixels = Buffer.alloc(size * size * 4);
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size);
  for (let j = 0; j < size; j++) {
    const row = size - 1 - j;
    for (let i = 0; i < size; i++) {
      const s = (j * size + i) * 4;
      const d = (row * size + i) * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
      if (rgba[s + 3] === 0) mask[row * maskRow + (i >> 3)] |= 0x80 >> (i & 7);
    }
  }
  return Buffer.concat([head, pixels, mask]);
}

function ico(sizes) {
  const images = sizes.map((size) => {
    const rgba = draw(size);
    return { size, data: size >= 256 ? png(size, rgba) : dib(size, rgba) };
  });
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([head, ...entries, ...images.map((i) => i.data)]);
}

const dir = path.join(__dirname, '..', 'build');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icon.png'), png(512, draw(512)));
fs.writeFileSync(path.join(dir, 'icon.ico'), ico([16, 20, 24, 32, 40, 48, 64, 128, 256]));
console.log('wrote build/icon.png and build/icon.ico');
