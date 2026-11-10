import { describe, expect, it } from 'vitest';
import { createProject } from '../lib/factory';
import type { MediaAsset } from '../types';
import { packProject, unpackProject } from './projectFile';

function asset(id: string, mime: string): MediaAsset {
  return { id, name: id, kind: 'image', mime, size: 0, duration: 0, width: 4, height: 4, hasAudio: false, createdAt: 1 };
}

const bytes = (...n: number[]) => new Uint8Array(n).buffer;
const raw = async (b: Blob) => [...new Uint8Array(await b.arrayBuffer())];
const header = (obj: unknown) => {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, json.byteLength, true);
  return new Blob(['NCUT1\n', len, json]);
};

describe('project file fonts', () => {
  it('round trips two faces next to media', async () => {
    const project = createProject('f');
    project.assets.push(asset('ast_a', 'image/png'));
    const media = new Map<string, Blob>([['ast_a', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })]]);
    const fonts = [
      { family: 'Foo', weight: 400, italic: false, bytes: bytes(10, 11) },
      { family: 'Foo', weight: 700, italic: true, bytes: new Blob([new Uint8Array([20, 21, 22])]) },
    ];
    const out = await unpackProject(packProject(project, media, fonts));
    expect(await raw(out.media.get('ast_a')!)).toEqual([1, 2, 3]);
    expect(out.fonts.map((f) => [f.family, f.weight, f.italic])).toEqual([
      ['Foo', 400, false],
      ['Foo', 700, true],
    ]);
    expect(await raw(out.fonts[0].blob)).toEqual([10, 11]);
    expect(await raw(out.fonts[1].blob)).toEqual([20, 21, 22]);
  });

  it('a file without fonts unpacks with none', async () => {
    const out = await unpackProject(packProject(createProject('p'), new Map()));
    expect(out.fonts).toEqual([]);
  });

  it('a damaged fonts section never costs the project: it opens without those faces', async () => {
    const project = createProject('p');
    const bad = [
      { family: 'Foo', weight: 400, italic: false, size: 999 },
      { family: 5, weight: 400, italic: false, size: 0 },
      { family: 'x'.repeat(500), weight: 400, italic: false, size: 0 },
      { family: 'Foo', weight: 400, italic: false, size: -1 },
      { family: 'Foo', weight: 400, italic: false, size: '3' },
    ];
    for (const f of bad) {
      const out = await unpackProject(header({ version: 1, project, media: [], fonts: [f] }));
      expect(out.project.name).toBe('p');
      expect(out.fonts).toEqual([]);
    }
    expect((await unpackProject(header({ version: 1, project, media: [], fonts: 'no' }))).fonts).toEqual([]);
  });

  it('a file cut off inside the fonts keeps the faces before the cut', async () => {
    const project = createProject('p');
    project.assets.push(asset('ast_a', 'image/png'));
    const media = new Map<string, Blob>([['ast_a', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })]]);
    const whole = packProject(project, media, [
      { family: 'A', weight: 400, italic: false, bytes: bytes(1, 2, 3, 4) },
      { family: 'B', weight: 400, italic: false, bytes: bytes(5, 6, 7, 8) },
    ]);
    const out = await unpackProject(whole.slice(0, whole.size - 2));
    expect(await raw(out.media.get('ast_a')!)).toEqual([1, 2, 3]);
    expect(out.fonts.map((f) => f.family)).toEqual(['A']);
    expect(await raw(out.fonts[0]!.blob)).toEqual([1, 2, 3, 4]);
  });

  it('a media entry with a size of the wrong type is still a damaged file', async () => {
    const project = createProject('p');
    await expect(unpackProject(header({ version: 1, project, media: [{ assetId: 'a', size: '5', mime: '' }] }))).rejects.toThrow('the project file is damaged');
  });

  it('no more than 512 faces are read', async () => {
    const project = createProject('p');
    const many = Array.from({ length: 600 }, (_, i) => ({ family: 'F' + i, weight: 400, italic: false, bytes: bytes(1) }));
    const out = await unpackProject(packProject(project, new Map(), many));
    expect(out.fonts.length).toBe(512);
  });

  it('clamps a wild weight', async () => {
    const out = await unpackProject(packProject(createProject('p'), new Map(), [{ family: 'A', weight: 5000, italic: false, bytes: bytes(1) }]));
    expect(out.fonts[0].weight).toBe(900);
  });

  it('fonts do not change the media map', async () => {
    const project = createProject('m');
    project.assets.push(asset('ast_a', 'image/png'), asset('ast_b', 'image/png'));
    const media = new Map<string, Blob>([
      ['ast_a', new Blob([new Uint8Array([1])], { type: 'image/png' })],
      ['ast_b', new Blob([new Uint8Array([2, 3])], { type: 'image/png' })],
    ]);
    const out = await unpackProject(packProject(project, media, [{ family: 'A', weight: 400, italic: false, bytes: bytes(9, 9, 9) }]));
    expect([...out.media.keys()]).toEqual(['ast_a', 'ast_b']);
    expect(out.media.get('ast_b')!.size).toBe(2);
  });
});
