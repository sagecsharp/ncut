import { describe, expect, it, vi } from 'vitest';
import { createFileQueue, importFailureMessage, openShellFile } from './openShellFile';
import type { OpenFileDeps } from './openShellFile';

function deps(over: Partial<OpenFileDeps> = {}) {
  const calls: string[] = [];
  const d: OpenFileDeps = {
    importFile: vi.fn(async (f: File) => {
      calls.push('import ' + f.name);
      return 'prj_1';
    }),
    openProject: vi.fn(async (id: string) => {
      calls.push('open ' + id);
      return true;
    }),
    toast: vi.fn(),
    log: vi.fn(),
    ...over,
  };
  return { d, calls };
}

const file = (name = 'a.ncut') => ({ name, bytes: new Uint8Array([1, 2, 3]).buffer });

describe('open a project file from the shell', () => {
  it('imports the bytes as a File with the same name, then opens the new project', async () => {
    const { d, calls } = deps();
    await openShellFile(file('holiday.ncut'), d);
    expect(calls).toEqual(['import holiday.ncut', 'open prj_1']);
    const got = (d.importFile as ReturnType<typeof vi.fn>).mock.calls[0]![0] as File;
    expect(got.size).toBe(3);
    expect(d.toast).not.toHaveBeenCalled();
  });

  it('a failed import is a toast with the error message, and nothing is opened', async () => {
    const { d } = deps({
      importFile: vi.fn(async () => {
        throw new Error('this is not an ncut project');
      }),
    });
    await openShellFile(file(), d);
    expect(d.toast).toHaveBeenCalledWith('this is not an ncut project', 'error');
    expect(d.openProject).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledOnce();
  });

  it('an error without a message falls back to the file name', async () => {
    const { d } = deps({
      importFile: vi.fn(async () => {
        throw 'boom';
      }),
    });
    await openShellFile(file('x.ncut'), d);
    expect(d.toast).toHaveBeenCalledWith('could not open x.ncut', 'error');
    expect(importFailureMessage(new Error(''), 'y.ncut')).toBe('could not open y.ncut');
  });

  it('a project that cannot be found afterwards says so', async () => {
    const { d } = deps({ openProject: vi.fn(async () => false) });
    await openShellFile(file(), d);
    expect(d.toast).toHaveBeenCalledWith('project not found', 'error');
  });

  it('an open that throws is a toast too, never an unhandled rejection', async () => {
    const { d } = deps({
      openProject: vi.fn(async () => {
        throw new Error('db closed');
      }),
    });
    await expect(openShellFile(file(), d)).resolves.toBeUndefined();
    expect(d.toast).toHaveBeenCalledWith('db closed', 'error');
  });

  it('files are handled one after the other', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { d } = deps({
      importFile: vi.fn(async (f: File) => {
        order.push('start ' + f.name);
        if (f.name === 'one.ncut') await gate;
        order.push('end ' + f.name);
        return f.name;
      }),
      openProject: vi.fn(async () => true),
    });
    const push = createFileQueue(d);
    const a = push(file('one.ncut'));
    const b = push(file('two.ncut'));
    await Promise.resolve();
    expect(order).toEqual(['start one.ncut']);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(['start one.ncut', 'end one.ncut', 'start two.ncut', 'end two.ncut']);
  });
});
