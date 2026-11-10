import { describe, expect, it } from 'vitest';
import { createProject } from '../lib/factory';
import type { MediaAsset } from '../types';
import { packProject, projectFileName, unpackProject } from './projectFile';

function asset(id: string, mime: string): MediaAsset {
  return { id, name: id, kind: 'image', mime, size: 0, duration: 0, width: 4, height: 4, hasAudio: false, createdAt: 1 };
}

describe('project file', () => {
  it('round trips the project and its media', async () => {
    const project = createProject('my film');
    project.assets.push(asset('ast_a', 'image/png'), asset('ast_b', 'video/mp4'), asset('ast_missing', 'image/png'));
    const media = new Map<string, Blob>([
      ['ast_a', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })],
      ['ast_b', new Blob([new Uint8Array([9, 8, 7, 6, 5])], { type: 'video/mp4' })],
    ]);
    const file = packProject(project, media);
    const out = await unpackProject(file);
    expect(out.project).toEqual(project);
    expect([...out.media.keys()]).toEqual(['ast_a', 'ast_b']);
    expect([...new Uint8Array(await out.media.get('ast_a')!.arrayBuffer())]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(await out.media.get('ast_b')!.arrayBuffer())]).toEqual([9, 8, 7, 6, 5]);
    expect(out.media.get('ast_b')!.type).toBe('video/mp4');
  });

  it('keeps non ascii names', async () => {
    const project = createProject('café 映画');
    const out = await unpackProject(packProject(project, new Map()));
    expect(out.project.name).toBe('café 映画');
  });

  it('rejects other files', async () => {
    await expect(unpackProject(new Blob(['hello world, definitely not a project']))).rejects.toThrow('not an ncut project file');
    await expect(unpackProject(new Blob(['x']))).rejects.toThrow('not an ncut project file');
  });

  it('rejects a cut off file', async () => {
    const project = createProject('p');
    project.assets.push(asset('ast_a', 'image/png'));
    const file = packProject(project, new Map([['ast_a', new Blob([new Uint8Array(100)])]]));
    await expect(unpackProject(file.slice(0, file.size - 10))).rejects.toThrow('damaged');
    await expect(unpackProject(file.slice(0, 20))).rejects.toThrow('damaged');
  });

  it('makes safe file names', () => {
    expect(projectFileName('my: film / cut?')).toBe('my film cut.ncut');
    expect(projectFileName('   ')).toBe('project.ncut');
  });
});
