import { describe, expect, it } from 'vitest';
import {
  EMPTY_FOLDERS,
  addFolder,
  cleanFolderName,
  folderCounts,
  folderOf,
  moveProjects,
  parseFolders,
  pruneFolders,
  removeFolder,
  renameFolder,
  sortedFolders,
  uniqueFolderName,
} from './folders';

const two = addFolder(addFolder(EMPTY_FOLDERS, 'f1', 'clients', 1), 'f2', 'personal', 2);

describe('project folders', () => {
  it('a new folder gets a free name', () => {
    expect(uniqueFolderName(EMPTY_FOLDERS)).toBe('new folder');
    const a = addFolder(EMPTY_FOLDERS, 'a', 'new folder', 0);
    const b = addFolder(a, 'b', 'New Folder', 0);
    expect(b.folders.map((f) => f.name)).toEqual(['new folder', 'New Folder 2']);
    expect(addFolder(b, 'a', 'x', 0)).toBe(b);
  });

  it('names are one trimmed line', () => {
    expect(cleanFolderName('  my\n  work  ')).toBe('my work');
    expect(cleanFolderName('   ')).toBe('');
    expect(cleanFolderName('x'.repeat(100))).toHaveLength(60);
  });

  it('rename: to nothing or the same name changes nothing', () => {
    expect(renameFolder(two, 'f1', ' work ').folders[0]!.name).toBe('work');
    expect(renameFolder(two, 'f1', '  ')).toBe(two);
    expect(renameFolder(two, 'f1', 'clients')).toBe(two);
    expect(renameFolder(two, 'nope', 'x')).toBe(two);
  });

  it('move puts projects in a folder or in none', () => {
    const s = moveProjects(two, ['p1', 'p2'], 'f1');
    expect(folderOf(s, 'p1')).toBe('f1');
    expect(folderOf(moveProjects(s, ['p1'], 'f2'), 'p1')).toBe('f2');
    expect(folderOf(moveProjects(s, ['p1'], null), 'p1')).toBeNull();
    expect(moveProjects(s, ['p1'], 'f1')).toBe(s);
    expect(moveProjects(s, ['p1'], 'gone')).toBe(s);
  });

  it('removing a folder keeps its projects, out of any folder', () => {
    const s = moveProjects(moveProjects(two, ['p1'], 'f1'), ['p2'], 'f2');
    const r = removeFolder(s, 'f1');
    expect(r.folders.map((f) => f.id)).toEqual(['f2']);
    expect(folderOf(r, 'p1')).toBeNull();
    expect(folderOf(r, 'p2')).toBe('f2');
  });

  it('prune drops links of deleted projects, never folders', () => {
    const s = moveProjects(two, ['p1', 'p2'], 'f1');
    const p = pruneFolders(s, ['p2']);
    expect(Object.keys(p.of)).toEqual(['p2']);
    expect(p.folders).toHaveLength(2);
    expect(pruneFolders(p, ['p2', 'p3'])).toBe(p);
  });

  it('counts and order', () => {
    const s = moveProjects(two, ['p1', 'p2'], 'f2');
    expect([...folderCounts(s, ['p1', 'p2', 'p3'])]).toEqual([
      ['f1', 0],
      ['f2', 2],
    ]);
    const z = addFolder(addFolder(EMPTY_FOLDERS, 'a', 'b10', 0), 'b', 'b9', 0);
    expect(sortedFolders(z).map((f) => f.name)).toEqual(['b9', 'b10']);
  });

  it('a saved state is read part by part', () => {
    expect(parseFolders(null)).toEqual(EMPTY_FOLDERS);
    expect(parseFolders('{oops')).toEqual(EMPTY_FOLDERS);
    const s = parseFolders(
      JSON.stringify({
        folders: [{ id: 'f1', name: ' a ', createdAt: 3 }, { id: 'f1', name: 'dupe' }, { id: 'f2', name: '' }, { name: 'no id' }, 7],
        of: { p1: 'f1', p2: 'f2', p3: 5 },
      }),
    );
    expect(s).toEqual({ folders: [{ id: 'f1', name: 'a', createdAt: 3 }], of: { p1: 'f1' } });
  });
});
