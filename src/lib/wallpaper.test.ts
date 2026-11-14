import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useUi } from '../store/ui';
import {
  DEFAULT_WALLPAPER,
  ENCODE_ORDER,
  WALLPAPER_ACCEPT,
  WALLPAPER_FITS,
  WALLPAPER_MAX_BYTES,
  WALLPAPER_MAX_PIXELS,
  blurGrow,
  checkPictureFile,
  checkPictureSize,
  clampSettings,
  describeError,
  encodeFirst,
  firstError,
  fitCss,
  initWallpaper,
  isAcceptedPicture,
  layerStyle,
  readImageSize,
  readSettings,
  scaledSize,
  useWallpaper,
} from './wallpaper';

describe('readSettings', () => {
  it('gives the defaults for nothing, bad json and non-objects', () => {
    expect(readSettings(null)).toEqual(DEFAULT_WALLPAPER);
    expect(readSettings(undefined)).toEqual(DEFAULT_WALLPAPER);
    expect(readSettings('')).toEqual(DEFAULT_WALLPAPER);
    expect(readSettings('{nope')).toEqual(DEFAULT_WALLPAPER);
    expect(readSettings('42')).toEqual(DEFAULT_WALLPAPER);
    expect(readSettings('null')).toEqual(DEFAULT_WALLPAPER);
    expect(readSettings('[1,2]')).toEqual(DEFAULT_WALLPAPER);
  });

  it('keeps good values and fills missing keys with the defaults', () => {
    expect(readSettings(JSON.stringify({ fit: 'tile', dim: 10, blur: 12, panels: 60 }))).toEqual({ fit: 'tile', dim: 10, blur: 12, panels: 60 });
    expect(readSettings(JSON.stringify({ blur: 7 }))).toEqual({ ...DEFAULT_WALLPAPER, blur: 7 });
  });

  it('clamps out of range numbers and drops values of the wrong kind', () => {
    const s = readSettings(JSON.stringify({ fit: 'sideways', dim: 400, blur: -5, panels: 3 }));
    expect(s).toEqual({ fit: 'fill', dim: 100, blur: 0, panels: 30 });
    expect(readSettings(JSON.stringify({ dim: '70', blur: null, panels: true }))).toEqual(DEFAULT_WALLPAPER);
    expect(readSettings(JSON.stringify({ blur: 1000 })).blur).toBe(40);
  });
});

describe('clampSettings', () => {
  it('applies a patch over a base and clamps it', () => {
    const base = { fit: 'center', dim: 20, blur: 5, panels: 90 } as const;
    expect(clampSettings({ dim: 150 }, base)).toEqual({ ...base, dim: 100 });
    expect(clampSettings({ panels: 0 }, base).panels).toBe(30);
    expect(clampSettings({ fit: 'stretch' }, base).fit).toBe('stretch');
  });

  it('rounds to whole numbers and ignores NaN / Infinity', () => {
    expect(clampSettings({ blur: 3.6 }).blur).toBe(4);
    expect(clampSettings({ blur: Number.NaN }).blur).toBe(DEFAULT_WALLPAPER.blur);
    expect(clampSettings({ dim: Number.POSITIVE_INFINITY }).dim).toBe(DEFAULT_WALLPAPER.dim);
  });
});

describe('scaledSize', () => {
  it('never scales up', () => {
    expect(scaledSize(1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(scaledSize(3840, 2160)).toEqual({ width: 3840, height: 2160 });
    expect(scaledSize(10, 10)).toEqual({ width: 10, height: 10 });
  });

  it('scales the longest side down to the limit and keeps the proportions', () => {
    expect(scaledSize(7680, 4320)).toEqual({ width: 3840, height: 2160 });
    expect(scaledSize(4320, 7680)).toEqual({ width: 2160, height: 3840 });
    expect(scaledSize(8000, 8000)).toEqual({ width: 3840, height: 3840 });
  });

  it('never makes a side smaller than one pixel', () => {
    expect(scaledSize(100000, 3)).toEqual({ width: 3840, height: 1 });
  });

  it('takes another limit', () => {
    expect(scaledSize(2000, 1000, 1000)).toEqual({ width: 1000, height: 500 });
  });

  it('refuses a size that is no size', () => {
    expect(scaledSize(0, 100)).toBeNull();
    expect(scaledSize(100, -1)).toBeNull();
    expect(scaledSize(Number.NaN, 100)).toBeNull();
  });
});

describe('fitCss', () => {
  it('has a css value set for every fit', () => {
    expect(fitCss('fill')).toEqual({ size: 'cover', repeat: 'no-repeat', position: 'center' });
    expect(fitCss('fit')).toEqual({ size: 'contain', repeat: 'no-repeat', position: 'center' });
    expect(fitCss('stretch')).toEqual({ size: '100% 100%', repeat: 'no-repeat', position: 'center' });
    expect(fitCss('center')).toEqual({ size: 'auto', repeat: 'no-repeat', position: 'center' });
    expect(fitCss('tile')).toEqual({ size: 'auto', repeat: 'repeat', position: 'top left' });
  });

  it('covers every fit the ui offers', () => {
    for (const f of WALLPAPER_FITS) expect(fitCss(f.id).size).toBeTruthy();
    expect(WALLPAPER_FITS.map((f) => f.id)).toEqual(['fill', 'fit', 'stretch', 'center', 'tile']);
  });
});

describe('layerStyle', () => {
  it('has no filter and no growth without a blur', () => {
    const st = layerStyle(DEFAULT_WALLPAPER);
    expect(st.filter).toBe('none');
    expect(st.inset).toBe('0');
    expect(st.dimOpacity).toBe('0.55');
  });

  it('grows the picture past the window edges by more than the blur reaches', () => {
    expect(blurGrow(0)).toBe(0);
    expect(blurGrow(10)).toBe(30);
    const st = layerStyle({ ...DEFAULT_WALLPAPER, blur: 10, dim: 0, fit: 'tile' });
    expect(st.filter).toBe('blur(10px)');
    expect(st.inset).toBe('-30px');
    expect(st.dimOpacity).toBe('0');
    expect(st.backgroundRepeat).toBe('repeat');
    expect(st.backgroundPosition).toBe('top left');
  });
});

describe('picture files', () => {
  it('accepts png, jpg, webp, avif, gif and bmp by type', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif', 'image/bmp']) {
      expect(isAcceptedPicture({ name: 'x', type })).toBe(true);
    }
  });

  it('falls back to the extension when the system gave no type', () => {
    expect(isAcceptedPicture({ name: 'photo.JPG', type: '' })).toBe(true);
    expect(isAcceptedPicture({ name: 'photo.avif', type: '' })).toBe(true);
    expect(isAcceptedPicture({ name: 'photo.tiff', type: '' })).toBe(false);
    expect(isAcceptedPicture({ name: 'noext', type: '' })).toBe(false);
  });

  it('refuses other types even with a picture extension', () => {
    expect(isAcceptedPicture({ name: 'a.png', type: 'image/svg+xml' })).toBe(false);
    expect(isAcceptedPicture({ name: 'a.png', type: 'video/mp4' })).toBe(false);
  });

  it('says why a file is refused', () => {
    expect(checkPictureFile({ name: 'a.png', type: 'image/png', size: 1000 })).toBeNull();
    expect(checkPictureFile({ name: 'a.mp4', type: 'video/mp4', size: 1000 })).toMatch(/not a png/);
    expect(checkPictureFile({ name: 'a.png', type: 'image/png', size: WALLPAPER_MAX_BYTES + 1 })).toMatch(/over 64 mb/);
    expect(checkPictureFile({ name: 'a.png', type: 'image/png', size: WALLPAPER_MAX_BYTES })).toBeNull();
    expect(checkPictureFile({ name: 'a.png', type: 'image/png', size: 0 })).toMatch(/empty/);
  });

  it('offers the types and extensions to the file picker', () => {
    const parts = WALLPAPER_ACCEPT.split(',');
    for (const t of ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif', 'image/bmp']) expect(parts).toContain(t);
    for (const e of ['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.bmp']) expect(parts).toContain(e);
    // the non standard bmp type is accepted when a file has it, but is not offered to the picker
    expect(parts).not.toContain('image/x-ms-bmp');
    expect(isAcceptedPicture({ name: 'a.bmp', type: 'image/x-ms-bmp' })).toBe(true);
  });
});

describe('encodeFirst', () => {
  const blobOf = (type: string, size = 4) => new Blob([new Uint8Array(size)], { type });

  it('takes webp when the browser makes it', async () => {
    const asked: string[] = [];
    const out = await encodeFirst(async (type) => {
      asked.push(type);
      return blobOf(type);
    });
    expect(out?.type).toBe('image/webp');
    expect(asked).toEqual(['image/webp']);
  });

  it('falls back to jpeg when webp comes back as a png', async () => {
    const asked: string[] = [];
    const out = await encodeFirst(async (type) => {
      asked.push(type);
      return type === 'image/jpeg' ? blobOf('image/jpeg') : blobOf('image/png');
    });
    expect(out?.type).toBe('image/jpeg');
    expect(asked).toEqual(['image/webp', 'image/jpeg']);
  });

  it('falls back to png when neither works', async () => {
    const out = await encodeFirst(async () => blobOf('image/png'));
    expect(out?.type).toBe('image/png');
  });

  it('survives an encoder that throws or gives nothing', async () => {
    let n = 0;
    const out = await encodeFirst(async (type) => {
      n++;
      if (n === 1) throw new Error('boom');
      if (n === 2) return null;
      return blobOf(type);
    });
    expect(out?.type).toBe('image/png');
  });

  it('gives null when nothing could be encoded', async () => {
    expect(await encodeFirst(async () => null)).toBeNull();
    expect(await encodeFirst(async (type) => blobOf(type, 0))).toBeNull();
  });

  it('tries webp at 0.9 first', () => {
    expect(ENCODE_ORDER[0]).toEqual({ type: 'image/webp', quality: 0.9 });
    expect(ENCODE_ORDER.map((e) => e.type)).toEqual(['image/webp', 'image/jpeg', 'image/png']);
  });
});

describe('describeError', () => {
  it('names a full disk, a missing indexeddb and falls back to the message', () => {
    expect(describeError({ name: 'QuotaExceededError' })).toBe('the disk is full');
    expect(describeError(new Error('no indexeddb'))).toMatch(/private window/);
    expect(describeError(new Error('the file could not be read as a picture'))).toBe('the file could not be read as a picture');
    expect(describeError('plain text')).toBe('plain text');
    expect(describeError(null)).toBe('unknown error');
  });
});

describe('the store in node (no dom, no indexeddb)', () => {
  it('starts with the defaults and no picture', () => {
    const s = useWallpaper.getState();
    expect(s.url).toBeNull();
    expect(s.busy).toBe(false);
    expect(s.fit).toBe('fill');
    expect(s.dim).toBe(55);
    expect(s.blur).toBe(0);
    expect(s.panels).toBe(82);
  });

  it('clamps a setting that is changed', () => {
    useWallpaper.getState().setSettings({ blur: 99, panels: 1 });
    expect(useWallpaper.getState().blur).toBe(40);
    expect(useWallpaper.getState().panels).toBe(30);
    useWallpaper.getState().setSettings({ blur: 0, panels: 82 });
  });

  const errorToasts = () => useUi.getState().toasts.filter((t) => t.kind === 'error').map((t) => t.message);

  it('refuses a file that is not a picture, says why and leaves the state as it was', async () => {
    const before = useWallpaper.getState().url;
    const toastsBefore = errorToasts().length;
    const file = new File([new Uint8Array(10)], 'clip.mp4', { type: 'video/mp4' });
    expect(await useWallpaper.getState().choosePicture(file)).toBe(false);
    expect(useWallpaper.getState().url).toBe(before);
    expect(useWallpaper.getState().busy).toBe(false);
    const toasts = errorToasts();
    expect(toasts.length).toBe(toastsBefore + 1);
    // the reason comes from the file check, not from a failed decode (node has no createImageBitmap)
    expect(toasts[toasts.length - 1]).toMatch(/^wallpaper not changed: that is not a png/);
  });

  it('refuses a file over 64 mb before reading it', async () => {
    const toastsBefore = errorToasts().length;
    // a file of that size is not made for real: only name, type and size are looked at
    const big = { name: 'huge.png', type: 'image/png', size: WALLPAPER_MAX_BYTES + 1 } as unknown as File;
    expect(await useWallpaper.getState().choosePicture(big)).toBe(false);
    expect(useWallpaper.getState().busy).toBe(false);
    const toasts = errorToasts();
    expect(toasts.length).toBe(toastsBefore + 1);
    expect(toasts[toasts.length - 1]).toMatch(/over 64 mb/);
  });
});

// ---------- size from the header ----------

function bytes(...parts: (number | string | number[] | Uint8Array)[]): Uint8Array {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === 'number') out.push(p);
    else if (typeof p === 'string') for (const c of p) out.push(c.charCodeAt(0));
    else out.push(...Array.from(p));
  }
  return new Uint8Array(out);
}
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => be32(n).reverse();
const be16 = (n: number) => [(n >>> 8) & 255, n & 255];
const le16 = (n: number) => be16(n).reverse();
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const pad = (n: number) => new Array<number>(n).fill(0);

describe('readImageSize', () => {
  it('reads a png', () => {
    expect(readImageSize(bytes(0x89, 'PNG\r\n', 0x1a, 0x0a, be32(13), 'IHDR', be32(20000), be32(15000), pad(5)))).toEqual({ width: 20000, height: 15000 });
  });

  it('reads a gif', () => {
    expect(readImageSize(bytes('GIF89a', le16(640), le16(480), pad(4)))).toEqual({ width: 640, height: 480 });
  });

  it('reads a bmp, also a top down one with a negative height, and the old core header', () => {
    expect(readImageSize(bytes('BM', pad(12), le32(40), le32(800), le32(600), pad(8)))).toEqual({ width: 800, height: 600 });
    expect(readImageSize(bytes('BM', pad(12), le32(40), le32(800), le32(-600 >>> 0), pad(8)))).toEqual({ width: 800, height: 600 });
    expect(readImageSize(bytes('BM', pad(12), le32(12), le16(320), le16(200), pad(8)))).toEqual({ width: 320, height: 200 });
  });

  it('reads the three kinds of webp', () => {
    expect(readImageSize(bytes('RIFF', le32(100), 'WEBP', 'VP8X', le32(10), pad(4), le24(4000 - 1), le24(3000 - 1), pad(4)))).toEqual({ width: 4000, height: 3000 });
    const bits = (1920 - 1) | ((1080 - 1) << 14);
    expect(readImageSize(bytes('RIFF', le32(100), 'WEBP', 'VP8L', le32(10), 0x2f, le32(bits >>> 0), pad(8)))).toEqual({ width: 1920, height: 1080 });
    expect(readImageSize(bytes('RIFF', le32(100), 'WEBP', 'VP8 ', le32(10), pad(3), 0x9d, 0x01, 0x2a, le16(1280), le16(720), pad(4)))).toEqual({ width: 1280, height: 720 });
  });

  it('reads a jpeg past other segments and fill bytes', () => {
    const app0 = bytes(0xff, 0xe0, be16(16), pad(14));
    const sof = bytes(0xff, 0xc0, be16(17), 8, be16(6000), be16(8000), pad(10));
    expect(readImageSize(bytes(0xff, 0xd8, app0, 0xff, sof))).toEqual({ width: 8000, height: 6000 });
    // a huffman table (c4) is no frame header
    const dht = bytes(0xff, 0xc4, be16(6), pad(4));
    expect(readImageSize(bytes(0xff, 0xd8, dht, sof))).toEqual({ width: 8000, height: 6000 });
  });

  it('reads an avif and takes the biggest image extent', () => {
    const ispe = (w: number, h: number) => bytes(be32(20), 'ispe', pad(4), be32(w), be32(h));
    const file = bytes(be32(16), 'ftyp', 'avif', pad(4), ispe(160, 120), ispe(9000, 6000));
    expect(readImageSize(file)).toEqual({ width: 9000, height: 6000 });
  });

  it('gives null for what it does not know or a cut short header', () => {
    expect(readImageSize(new Uint8Array(0))).toBeNull();
    expect(readImageSize(bytes('hello, this is no picture at all'))).toBeNull();
    expect(readImageSize(bytes(0x89, 'PNG', 0x0d, 0x0a))).toBeNull();
    expect(readImageSize(bytes(0xff, 0xd8, 0xff, 0xe0, be16(16), pad(14)))).toBeNull();
    // a size of zero is no size
    expect(readImageSize(bytes('GIF89a', le16(0), le16(480), pad(4)))).toBeNull();
  });
});

describe('checkPictureSize', () => {
  it('lets a normal picture and an unknown size pass', () => {
    expect(checkPictureSize(null)).toBeNull();
    expect(checkPictureSize({ width: 3840, height: 2160 })).toBeNull();
    expect(checkPictureSize({ width: 10000, height: WALLPAPER_MAX_PIXELS / 10000 })).toBeNull();
  });

  it('refuses a picture too big to decode and says its size', () => {
    expect(checkPictureSize({ width: 20000, height: 20000 })).toMatch(/20000 x 20000 px, over the 120 megapixels/);
    expect(checkPictureSize({ width: 10000, height: WALLPAPER_MAX_PIXELS / 10000 + 1 })).not.toBeNull();
  });
});

describe('firstError', () => {
  it('takes the first real error, also a dom exception, and has a fallback', () => {
    const quota = new DOMException('full', 'QuotaExceededError');
    expect(firstError(null, quota)).toBe(quota);
    const plain = new Error('x');
    expect(firstError(undefined, null, plain, quota)).toBe(plain);
    expect(firstError(null, null).message).toBe('wallpaper database error');
  });
});

// ---------- the database, with a fake indexeddb ----------

/** an indexeddb with one request that the test finishes by hand. the request error lands before the transaction error. */
function fakeIndexedDb(opts: { openFails?: Error; onRequest?: (request: any, tx: any) => void }) {
  return {
    open() {
      const req: any = { error: null };
      queueMicrotask(() => {
        if (opts.openFails) {
          req.error = opts.openFails;
          req.onerror?.();
          return;
        }
        req.result = {
          objectStoreNames: { contains: () => true },
          close() {},
          transaction() {
            const tx: any = { error: null };
            const request: any = { error: null, result: undefined };
            const act = () => queueMicrotask(() => opts.onRequest?.(request, tx));
            tx.objectStore = () => ({
              delete: () => (act(), request),
              get: () => (act(), request),
              put: () => (act(), request),
            });
            return tx;
          },
        };
        req.onsuccess?.();
      });
      return req;
    },
  };
}

describe('the database errors', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('tells a full disk that arrives as a failed request, not a generic error', async () => {
    const quota = new DOMException('full', 'QuotaExceededError');
    vi.stubGlobal(
      'indexedDB',
      fakeIndexedDb({
        onRequest(request, tx) {
          // like a browser: the request fails first (tx.error still null), the transaction aborts after
          request.error = quota;
          request.onerror?.();
          tx.onerror?.();
          tx.error = quota;
          tx.onabort?.();
        },
      }),
    );
    expect(await useWallpaper.getState().removePicture()).toBe(false);
    const toasts = useUi.getState().toasts;
    expect(toasts.length).toBeGreaterThan(0);
    expect(toasts[toasts.length - 1].message).toBe('could not remove the wallpaper: the disk is full');
    expect(toasts[toasts.length - 1].kind).toBe('error');
    expect(useWallpaper.getState().busy).toBe(false);
  });

  it('tells a full disk that arrives only as an abort of the transaction', async () => {
    const quota = new DOMException('full', 'QuotaExceededError');
    vi.stubGlobal(
      'indexedDB',
      fakeIndexedDb({
        onRequest(_request, tx) {
          tx.error = quota;
          tx.onabort?.();
        },
      }),
    );
    expect(await useWallpaper.getState().removePicture()).toBe(false);
    const toasts = useUi.getState().toasts;
    expect(toasts[toasts.length - 1].message).toBe('could not remove the wallpaper: the disk is full');
  });

  it('stays silent at start when the database can not be opened and nothing was ever stored', async () => {
    vi.stubGlobal('indexedDB', fakeIndexedDb({ openFails: new DOMException('blocked', 'SecurityError') }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = useUi.getState().toasts.map((t) => t.id);
    initWallpaper();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(useUi.getState().toasts.map((t) => t.id)).toEqual(before);
    // it goes to the console
    expect(warn).toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(useWallpaper.getState().url).toBeNull();
    warn.mockRestore();
    error.mockRestore();
  });
});

// ---------- theme.css ----------

describe('theme.css and the wallpaper', () => {
  const css = readFileSync(new URL('../styles/theme.css', import.meta.url), 'utf8');
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

  it('has a solid color for every surface in both themes, and the surface tokens point at them', () => {
    const dark = noComments.slice(0, noComments.indexOf(":root[data-theme='light']"));
    const light = noComments.slice(noComments.indexOf(":root[data-theme='light']"), noComments.indexOf(":root[data-wallpaper='on']"));
    for (let n = 0; n <= 5; n++) {
      expect(dark).toMatch(new RegExp(`--solid-${n}: oklch\\(`));
      expect(light).toMatch(new RegExp(`--solid-${n}: oklch\\(`));
      expect(dark).toContain(`--surface-${n}: var(--solid-${n});`);
    }
    // a light theme that kept a plain surface color would never turn see-through
    expect(light).not.toMatch(/--surface-\d: oklch/);
  });

  it('makes every surface see-through under data-wallpaper and resets all of them on the solid roots', () => {
    const on = noComments.slice(noComments.indexOf(":root[data-wallpaper='on'] {"));
    for (let n = 0; n <= 5; n++) {
      expect(on).toContain(`--surface-${n}: color-mix(in oklch, var(--solid-${n}) calc(var(--wp-panels, 82) * 1%), transparent);`);
      expect(on).toContain(`--surface-${n}: var(--solid-${n});`);
    }
    // the floating layers stay solid
    for (const sel of ['.menu', '.dialog', '.shell-palette', '.toast', '.input', '.select', '.preview-frame']) expect(on).toContain(sel + ',');
  });
});
