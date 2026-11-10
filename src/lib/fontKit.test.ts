import { afterEach, describe, expect, it } from 'vitest';
import {
  type FaceRule,
  faceDescriptors,
  faceMatchKey,
  facesFromRules,
  installFontKit,
  kitFaceId,
  normalizeFamily,
  normalizeRange,
  normalizeStyle,
  normalizeWeight,
  parseSrc,
  pickSrc,
  resolveUrl,
  unquoteFamily,
} from './fontKit';
import { ensureFont, ensureProjectFonts, fontsVersion } from './fonts';
import type { Project } from '../types';

describe('normalizing', () => {
  it('families', () => {
    expect(normalizeFamily(`  "Space   Grotesk" `)).toBe('space grotesk');
    expect(normalizeFamily(`'Inter'`)).toBe('inter');
    expect(unquoteFamily(`"Space  Grotesk"`)).toBe('Space Grotesk');
  });
  it('weights', () => {
    expect(normalizeWeight('normal')).toBe('400');
    expect(normalizeWeight('')).toBe('400');
    expect(normalizeWeight('bold')).toBe('700');
    expect(normalizeWeight('700')).toBe('700');
    expect(normalizeWeight('100  900')).toBe('100 900');
    expect(normalizeWeight('400 400')).toBe('400');
  });
  it('styles and ranges', () => {
    expect(normalizeStyle('')).toBe('normal');
    expect(normalizeStyle(' Italic ')).toBe('italic');
    expect(normalizeRange('')).toBe('u+0-10ffff');
    expect(normalizeRange('U+0000-00FF, U+0131')).toBe('u+0000-00ff,u+0131');
    expect(normalizeRange('U+0-10FFFF')).toBe('u+0-10ffff');
  });
  it('a rule and a FontFace with different spelling have the same key', () => {
    const rule = faceMatchKey({ family: `"Space Grotesk"`, weight: '400', style: 'normal', unicodeRange: 'U+0000-00FF, U+0131' });
    const face = faceMatchKey({ family: 'Space Grotesk', weight: '400', style: 'normal', unicodeRange: 'U+0000-00FF,U+0131' });
    expect(rule).toBe(face);
    expect(faceMatchKey({ family: 'a', weight: '700' })).not.toBe(faceMatchKey({ family: 'a', weight: '400' }));
    expect(faceMatchKey({ family: 'a', style: 'italic' })).not.toBe(faceMatchKey({ family: 'a' }));
  });
});

describe('src parsing', () => {
  const src = `url(./files/inter-latin-400-normal.woff2) format("woff2"), url('./files/inter-latin-400-normal.woff') format('woff')`;
  it('reads urls and formats', () => {
    expect(parseSrc(src)).toEqual([
      { url: './files/inter-latin-400-normal.woff2', format: 'woff2' },
      { url: './files/inter-latin-400-normal.woff', format: 'woff' },
    ]);
  });
  it('skips local() and reads quoted urls with spaces and no format', () => {
    expect(parseSrc(`local("Foo"), url("a b.ttf")`)).toEqual([{ url: 'a b.ttf', format: '' }]);
    expect(parseSrc('')).toEqual([]);
  });
  it('prefers woff2 over woff over ttf', () => {
    expect(pickSrc(parseSrc(`url(a.ttf) format("truetype"), url(a.woff), url(a.woff2)`))?.url).toBe('a.woff2');
    expect(pickSrc(parseSrc(`url(a.ttf), url(a.woff)`))?.url).toBe('a.woff');
    expect(pickSrc(parseSrc(`url(a.bin), url(a.ttf)`))?.url).toBe('a.ttf');
    expect(pickSrc(parseSrc(`url(a.bin?v=2)`))?.url).toBe('a.bin?v=2');
    expect(pickSrc([])).toBeNull();
  });
  it('a query string does not hide the extension', () => {
    expect(pickSrc(parseSrc(`url(a.woff?x=1), url(a.woff2?x=1)`))?.url).toBe('a.woff2?x=1');
  });
});

describe('resolveUrl', () => {
  it('resolves against the stylesheet href', () => {
    expect(resolveUrl('./files/a.woff2', 'http://localhost:5173/assets/index-abc.css')).toBe('http://localhost:5173/assets/files/a.woff2');
    expect(resolveUrl('/fonts/a.woff2', 'http://localhost:5173/assets/index-abc.css')).toBe('http://localhost:5173/fonts/a.woff2');
  });
  it('keeps absolute urls and data urls', () => {
    expect(resolveUrl('https://cdn.example.com/a.woff2', null)).toBe('https://cdn.example.com/a.woff2');
    expect(resolveUrl('data:font/woff2;base64,AAAA', 'http://x/')).toBe('data:font/woff2;base64,AAAA');
  });
  it('is null when there is no base for a relative url', () => {
    expect(resolveUrl('a.woff2', null)).toBeNull();
    expect(resolveUrl('a.woff2', 'not a url')).toBeNull();
  });
});

function rule(over: Partial<FaceRule>): FaceRule {
  return {
    family: `"Inter"`,
    weight: '400',
    style: 'normal',
    stretch: '100%',
    unicodeRange: 'U+0000-00FF',
    src: `url(./latin-400.woff2) format("woff2"), url(./latin-400.woff) format("woff")`,
    base: 'http://localhost/assets/a.css',
    ...over,
  };
}

describe('facesFromRules', () => {
  const wanted = new Map([['inter', 'Inter']]);
  it('keeps only loaded faces of wanted families', () => {
    const a = rule({});
    const b = rule({ unicodeRange: 'U+0100-024F', src: 'url(./ext-400.woff2)' });
    const c = rule({ family: `"Roboto"` });
    const d = rule({ weight: '700', src: 'url(./latin-700.woff2)' });
    const loaded = new Set([faceMatchKey(a), faceMatchKey(c), faceMatchKey(d)]);
    const out = facesFromRules([a, b, c, d], wanted, loaded);
    expect(out.map((f) => f.url)).toEqual(['http://localhost/assets/latin-400.woff2', 'http://localhost/assets/latin-700.woff2']);
    expect(out[0]).toMatchObject({ family: 'Inter', weight: '400', style: 'normal', unicodeRange: 'U+0000-00FF' });
    expect(out[0].stretch).toBeUndefined();
  });
  it('writes the family the way the project spells it', () => {
    const r = rule({ family: `'inter'` });
    expect(facesFromRules([r], new Map([['inter', 'Inter']]), new Set([faceMatchKey(r)]))[0].family).toBe('Inter');
  });
  it('one face per key even when two sheets repeat the rule', () => {
    const r = rule({});
    expect(facesFromRules([r, { ...r }], wanted, new Set([faceMatchKey(r)]))).toHaveLength(1);
  });
  it('skips rules without a usable url', () => {
    const r1 = rule({ src: 'local("Inter")' });
    const r2 = rule({ weight: '700', src: 'url(x.woff2)', base: null });
    expect(facesFromRules([r1, r2], wanted, new Set([faceMatchKey(r1), faceMatchKey(r2)]))).toEqual([]);
  });
  it('carries a stretch that is not normal', () => {
    const r = rule({ stretch: '75% 125%' });
    expect(facesFromRules([r], wanted, new Set([faceMatchKey(r)]))[0].stretch).toBe('75% 125%');
  });
});

describe('descriptors and ids', () => {
  it('sets only what is there', () => {
    expect(faceDescriptors({ family: 'A', weight: '700', style: 'italic' })).toEqual({ weight: '700', style: 'italic' });
    expect(faceDescriptors({ family: 'A', weight: '', style: '', unicodeRange: 'U+0-FF' })).toEqual({ weight: '400', style: 'normal', unicodeRange: 'U+0-FF' });
  });
  it('tells a url face from a bytes face', () => {
    const a = kitFaceId({ family: 'A', weight: '400', style: 'normal', url: 'http://x/a.woff2' });
    const b = kitFaceId({ family: 'A', weight: '400', style: 'normal', bytes: new ArrayBuffer(8) });
    expect(a).not.toBe(b);
  });
});

// ---------- installFontKit in a fake worker ----------

const g = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};
function stub(name: string, value: unknown): void {
  if (!(name in saved)) saved[name] = g[name];
  if (value === undefined) delete g[name];
  else g[name] = value;
}
afterEach(() => {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete g[k];
    else g[k] = saved[k];
    delete saved[k];
  }
});

function fakeWorker(failFamilies: string[] = []): { added: Array<{ family: string; source: unknown; desc: unknown }>; loads: string[] } {
  const added: Array<{ family: string; source: unknown; desc: unknown }> = [];
  const loads: string[] = [];
  class FakeFace {
    status = 'unloaded';
    constructor(
      public family: string,
      public source: unknown,
      public desc: unknown,
    ) {}
    async load(): Promise<this> {
      if (failFamilies.includes(this.family)) throw new Error('network');
      this.status = 'loaded';
      return this;
    }
  }
  const faces: FakeFace[] = [];
  const set = {
    add: (f: FakeFace) => {
      faces.push(f);
      added.push({ family: f.family, source: f.source, desc: f.desc });
    },
    delete: () => true,
    forEach: (cb: (f: FakeFace) => void) => faces.forEach(cb),
    check: () => true,
    load: async (desc: string) => {
      loads.push(desc);
      return [];
    },
  };
  stub('document', undefined);
  stub('self', { fonts: set });
  stub('FontFace', FakeFace);
  return { added, loads };
}

describe('installFontKit', () => {
  it('adds every face, marks the families ready and bumps the version', async () => {
    const w = fakeWorker();
    const v0 = fontsVersion();
    const failed = await installFontKit({
      faces: [
        { family: 'KitOne', weight: '400', style: 'normal', url: 'http://x/one.woff2', unicodeRange: 'U+0-FF' },
        { family: 'KitOne', weight: '700', style: 'normal', bytes: new ArrayBuffer(4) },
      ],
    });
    expect(failed).toEqual([]);
    expect(w.added).toHaveLength(2);
    expect(w.added[0].source).toBe('url("http://x/one.woff2")');
    expect(w.added[0].desc).toEqual({ weight: '400', style: 'normal', unicodeRange: 'U+0-FF' });
    expect(w.added[1].source).toBeInstanceOf(ArrayBuffer);
    expect(fontsVersion()).toBeGreaterThan(v0);
    // no font set load, no measuring: answered at once
    expect(await ensureFont('KitOne', 400, false)).toBe(true);
    expect(await ensureFont('KitOne', 700, true, 'some text')).toBe(true);
    expect(w.loads).toEqual([]);
  });
  it('the same kit twice adds nothing more', async () => {
    const w = fakeWorker();
    const kit = { faces: [{ family: 'KitTwo', weight: '400', style: 'normal', url: 'http://x/two.woff2' }] };
    await installFontKit(kit);
    await installFontKit(kit);
    expect(w.added).toHaveLength(1);
  });
  it('reports families that failed and does not mark them ready', async () => {
    fakeWorker(['KitBad']);
    const failed = await installFontKit({
      faces: [
        { family: 'KitBad', weight: '400', style: 'normal', url: 'http://x/bad.woff2' },
        { family: 'KitGood', weight: '400', style: 'normal', url: 'http://x/good.woff2' },
      ],
    });
    expect(failed).toEqual(['KitBad']);
    expect(await ensureFont('KitGood')).toBe(true);
  });
  it('never rejects on junk', async () => {
    fakeWorker();
    await expect(installFontKit(undefined as never)).resolves.toEqual([]);
    await expect(installFontKit({ faces: [{ family: 'X', weight: '400', style: 'normal' }] })).resolves.toEqual(['X']);
  });
  it('without a font set every family is reported', async () => {
    stub('document', undefined);
    stub('self', undefined);
    await expect(installFontKit({ faces: [{ family: 'Z', weight: '400', style: 'normal', url: 'http://x/z.woff2' }] })).resolves.toEqual(['Z']);
  });
});

describe('fonts in a worker', () => {
  it('a family that was not installed is a font of the computer: measured, never a stylesheet', async () => {
    const w = fakeWorker();
    // no canvas to measure with in node: unmeasurable counts as there, like on the main thread
    expect(await ensureFont('Inter', 400)).toBe(true);
    expect(w.loads.length).toBeGreaterThan(0);
  });
  it('ensureProjectFonts does not throw and lists nothing missing when everything is installed', async () => {
    fakeWorker();
    await installFontKit({ faces: [{ family: 'KitProj', weight: '400', style: 'normal', url: 'http://x/p.woff2' }] });
    const project = { clips: [{ type: 'text', fontFamily: 'KitProj', fontWeight: 400, italic: false, text: 'hi' }] } as unknown as Project;
    await expect(ensureProjectFonts(project)).resolves.toEqual([]);
  });
});
