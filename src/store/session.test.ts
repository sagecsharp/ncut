import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject } from '../lib/factory';
import type { Project } from '../types';

// the database is a map, the dom is a stub: what matters is the order of the reads and writes
const db = vi.hoisted(() => ({ rows: new Map<string, unknown>(), reads: [] as string[] }));
vi.mock('../storage/db', () => ({
  loadProject: async (id: string) => {
    // a read answers with what is stored when it is made
    const copy = structuredClone(db.rows.get(id));
    await Promise.resolve();
    db.reads.push(id);
    return copy;
  },
  loadProjectMediaRows: async () => new Map(),
  saveProject: async (p: Project) => {
    await Promise.resolve();
    db.rows.set(p.id, structuredClone(p));
  },
  warmDb: () => {},
  listProjects: async () => [],
  getMediaBlob: async () => undefined,
  putMediaBlob: async () => {},
  deleteProject: async () => {},
}));
vi.mock('../storage/idle', () => ({ whenIdle: () => () => {} }));
vi.mock('../media/registry', () => ({ loadProjectMedia: async () => [], releaseAllAssets: () => {} }));
vi.mock('../media/derived', () => ({ releaseAllDerived: () => {} }));
vi.mock('./playback', () => ({ resetPlayback: () => {} }));

const { useEditor } = await import('../store/editorStore');
const { openProjectById, startAutosave } = await import('./session');

beforeEach(() => {
  db.rows.clear();
  db.reads.length = 0;
  const loc = { hash: '', pathname: '/', search: '' };
  vi.stubGlobal('location', loc);
  vi.stubGlobal('history', { pushState: (_a: unknown, _b: unknown, h: string) => (loc.hash = h) });
  vi.stubGlobal('window', { addEventListener: () => {} });
  vi.stubGlobal('document', { visibilityState: 'visible' });
  useEditor.getState().closeProject();
  startAutosave();
});

describe('openProjectById', () => {
  it('saves the edits of the open project before it reads the project from the database', async () => {
    const p = createProject('a');
    db.rows.set(p.id, structuredClone(p));
    expect(await openProjectById(p.id)).toBe(true);
    // an edit that autosave has not written yet
    useEditor.getState().addText();
    expect(useEditor.getState().project!.clips).toHaveLength(1);
    expect(db.rows.get(p.id)).toMatchObject({ clips: [] });
    expect(await openProjectById(p.id)).toBe(true);
    expect(useEditor.getState().project!.clips).toHaveLength(1);
    expect((db.rows.get(p.id) as Project).clips).toHaveLength(1);
  });

  it('answers false for an unknown id', async () => {
    expect(await openProjectById('nope')).toBe(false);
  });
});
