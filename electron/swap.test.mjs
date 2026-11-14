import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// the swap helper of the portable exe (electron/swap.cs), the real thing: it is compiled here with the c# compiler
// that is part of windows and run against files in a temp folder. on a machine without that compiler (not windows)
// there is no helper and nothing to test.
// what is not covered here: the wait for an exe that is still in use (that needs a running portable ncut).

const here = path.dirname(fileURLToPath(import.meta.url));

function findCompiler() {
  if (process.platform !== 'win32') return null;
  const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  for (const dir of ['Framework64', 'Framework']) {
    const csc = path.join(windir, 'Microsoft.NET', dir, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(csc)) return csc;
  }
  return null;
}

const csc = findCompiler();
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

describe.skipIf(!csc)('ncut-swap.exe', () => {
  let root;
  let helper;
  let n = 0;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncut-swap-'));
    helper = path.join(root, 'ncut-swap.exe');
    execFileSync(csc, ['/nologo', '/optimize+', '/target:winexe', '/platform:anycpu', `/out:${helper}`, path.join(here, 'swap.cs')], { stdio: 'pipe' });
  }, 60_000);

  afterAll(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      /* the temp folder is cleaned by the system anyway */
    }
  });

  /** a folder with the exe of before and, in its own folder, the download */
  function scene(bytes = Buffer.from('THE NEW EXE, '.repeat(1000))) {
    const dir = path.join(root, `case-${++n}`);
    const updates = path.join(dir, 'updates');
    fs.mkdirSync(updates, { recursive: true });
    const target = path.join(dir, 'my ncut.exe');
    const source = path.join(updates, 'ncut-9.9.9-portable.exe');
    fs.writeFileSync(target, 'THE OLD EXE');
    fs.writeFileSync(source, bytes);
    return { dir, updates, target, source, bytes, log: path.join(updates, 'swap.log') };
  }

  const run = (args) => spawnSync(helper, args, { stdio: 'ignore', timeout: 30_000 }).status;
  const argsFor = (s, over = {}) => [over.source ?? s.source, over.target ?? s.target, over.sha ?? sha(s.bytes), String(over.size ?? s.bytes.length), over.mode ?? 'quiet'];

  it('puts the new exe under the name of the old one, and leaves nothing else', () => {
    const s = scene();
    expect(run(argsFor(s))).toBe(0);
    expect(fs.readFileSync(s.target).equals(s.bytes)).toBe(true);
    expect(fs.readdirSync(s.dir).sort()).toEqual(['my ncut.exe', 'updates']);
    // the download is used up, the note says how it ended
    expect(fs.readdirSync(s.updates)).toEqual(['swap.log']);
    expect(fs.readFileSync(s.log, 'utf8').trim()).toBe('0');
  });

  it('a file that is not the one that was checked changes nothing', () => {
    for (const over of [{ sha: 'ab'.repeat(32) }, { size: 5 }]) {
      const s = scene();
      expect(run(argsFor(s, over))).toBe(4);
      expect(fs.readFileSync(s.target, 'utf8')).toBe('THE OLD EXE');
      expect(fs.readdirSync(s.dir).sort()).toEqual(['my ncut.exe', 'updates']);
      expect(fs.existsSync(s.source)).toBe(true);
      expect(fs.readFileSync(s.log, 'utf8').trim()).toBe('4');
    }
  });

  it('a download that is gone, or a place that is gone, changes nothing', () => {
    const noSource = scene();
    fs.unlinkSync(noSource.source);
    expect(run(argsFor(noSource))).toBe(4);
    expect(fs.readFileSync(noSource.target, 'utf8')).toBe('THE OLD EXE');

    const noTarget = scene();
    fs.unlinkSync(noTarget.target);
    expect(run(argsFor(noTarget))).toBe(3);
    expect(fs.readdirSync(noTarget.dir)).toEqual(['updates']);
    expect(fs.existsSync(noTarget.source)).toBe(true);
  });

  it('what an earlier run left behind (.new, .old) is not in the way', () => {
    const s = scene();
    fs.writeFileSync(`${s.target}.new`, 'half a copy');
    fs.writeFileSync(`${s.target}.old`, 'the exe before the last one');
    expect(run(argsFor(s))).toBe(0);
    expect(fs.readFileSync(s.target).equals(s.bytes)).toBe(true);
    expect(fs.readdirSync(s.dir).sort()).toEqual(['my ncut.exe', 'updates']);
  });

  it('takes nothing but its own arguments', () => {
    const s = scene();
    const good = argsFor(s);
    const bad = [
      [],
      good.slice(0, 4),
      [...good, 'one', 'two'],
      argsFor(s, { mode: 'loud' }),
      argsFor(s, { sha: sha(s.bytes).toUpperCase() }),
      argsFor(s, { sha: 'abc' }),
      argsFor(s, { size: '0' }),
      argsFor(s, { size: '12x' }),
      argsFor(s, { source: 'updates\\x.exe' }),
      argsFor(s, { source: s.source.replace(/\.exe$/, '.txt') }),
      argsFor(s, { target: 'ncut.exe' }),
      argsFor(s, { target: s.source }),
      [...good, 'a"b'],
      [...good, ''],
    ];
    for (const args of bad) {
      expect(run(args), JSON.stringify(args).slice(0, 120)).toBe(2);
    }
    expect(fs.readFileSync(s.target, 'utf8')).toBe('THE OLD EXE');
    expect(fs.existsSync(s.source)).toBe(true);
    expect(fs.readdirSync(s.dir).sort()).toEqual(['my ncut.exe', 'updates']);
  });

  it('start: the new exe is started after the swap (a file that is no program says so, and the swap still stands)', () => {
    // the helper itself is the "new version" here: started with one argument it ends at once
    const exe = fs.readFileSync(helper);
    const ok = scene(exe);
    expect(run([...argsFor(ok, { mode: 'start' }), '--user-data-dir=C:\\some where\\'])).toBe(0);
    expect(fs.readFileSync(ok.target).equals(exe)).toBe(true);

    const notAProgram = scene();
    expect(run(argsFor(notAProgram, { mode: 'start' }))).toBe(1);
    expect(fs.readFileSync(notAProgram.target).equals(notAProgram.bytes)).toBe(true);
    expect(fs.readFileSync(notAProgram.log, 'utf8').trim()).toBe('1');
  });

  it('a place that is a folder or a link is not replaced', () => {
    const s = scene();
    fs.unlinkSync(s.target);
    fs.mkdirSync(s.target);
    expect(run(argsFor(s))).toBe(3);
    expect(fs.statSync(s.target).isDirectory()).toBe(true);
    expect(fs.existsSync(s.source)).toBe(true);
  });
});
