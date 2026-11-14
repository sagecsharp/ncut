import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// the swap helper of the portable exe (electron/swap.cs), the real thing: it is compiled here with the c# compiler
// that is part of windows and run against files in a temp folder. on a machine without that compiler (not windows)
// there is no helper and nothing to test. three more small programs are compiled for the cases that need another
// process: one that runs for a while (a running exe can not be replaced), one that holds a file open, and one that
// writes down how it was started.

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** runs for the number of milliseconds in its first argument: a running exe */
const SLEEPER = `
using System.Threading;
static class P { static void Main(string[] a) { Thread.Sleep(int.Parse(a[0])); } }
`;

/** opens the file in its first argument without delete sharing, says "held", and keeps it for the milliseconds in its second */
const HOLDER = `
using System;
using System.IO;
using System.Threading;
static class P {
  static void Main(string[] a) {
    using (FileStream f = new FileStream(a[0], FileMode.Open, FileAccess.Read, FileShare.Read)) {
      Console.Out.WriteLine("held");
      Console.Out.Flush();
      Thread.Sleep(int.Parse(a[1]));
    }
  }
}
`;

/** writes its arguments, its folder and some variables to the file named by ECHO_OUT */
const ECHO = `
using System;
using System.IO;
static class P {
  static void Main(string[] a) {
    string o = "args=" + a.Length + "\\n";
    foreach (string s in a) o += "arg=" + s + "\\n";
    o += "cwd=" + Directory.GetCurrentDirectory() + "\\n";
    foreach (string n in new string[] { "PORTABLE_EXECUTABLE_DIR", "PORTABLE_EXECUTABLE_FILE", "PORTABLE_EXECUTABLE_APP_FILENAME", "KEEP_ME" })
      o += n + "=" + Environment.GetEnvironmentVariable(n) + "\\n";
    File.WriteAllText(Environment.GetEnvironmentVariable("ECHO_OUT"), o);
  }
}
`;

describe.skipIf(!csc)('ncut-swap.exe', () => {
  let root;
  let helper;
  let sleeper;
  let holder;
  let echo;
  let n = 0;

  const compile = (out, ...files) =>
    execFileSync(csc, ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', `/out:${out}`, ...files], { stdio: 'pipe' });

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncut-swap-'));
    helper = path.join(root, 'ncut-swap.exe');
    execFileSync(csc, ['/nologo', '/optimize+', '/target:winexe', '/platform:anycpu', `/out:${helper}`, path.join(here, 'swap.cs')], { stdio: 'pipe' });
    const small = (name, code) => {
      const src = path.join(root, `${name}.cs`);
      const out = path.join(root, `${name}.exe`);
      fs.writeFileSync(src, code);
      compile(out, src);
      return out;
    };
    sleeper = small('sleeper', SLEEPER);
    holder = small('holder', HOLDER);
    echo = small('echo', ECHO);
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

  const run = (args, env) => spawnSync(helper, args, { stdio: 'ignore', timeout: 30_000, env: env ?? process.env }).status;
  const argsFor = (s, over = {}) => [over.source ?? s.source, over.target ?? s.target, over.sha ?? sha(s.bytes), String(over.size ?? s.bytes.length), over.mode ?? 'quiet'];

  /** the helper started on purpose in the background (it waits for a file): resolves with its exit code */
  function runAsync(args) {
    return new Promise((resolve) => {
      const child = spawn(helper, args, { stdio: 'ignore' });
      child.on('exit', (code) => resolve(code));
    });
  }

  /** starts the holder on a file and resolves when it holds it. kill() frees the file */
  function hold(file, ms) {
    return new Promise((resolve, reject) => {
      const child = spawn(holder, [file, String(ms)], { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.once('data', () => resolve({ kill: () => child.kill(), done: new Promise((r) => child.on('exit', r)) }));
      child.on('error', reject);
    });
  }

  it('puts the new exe under the name of the old one, and leaves nothing else', () => {
    const s = scene();
    expect(run(argsFor(s))).toBe(0);
    expect(fs.readFileSync(s.target).equals(s.bytes)).toBe(true);
    expect(fs.readdirSync(s.dir).sort()).toEqual(['my ncut.exe', 'updates']);
    // the download is used up, the note says how it ended
    expect(fs.readdirSync(s.updates)).toEqual(['swap.log']);
    expect(fs.readFileSync(s.log, 'utf8').trim()).toBe('0');
  });

  it('replaces an exe that is read only', () => {
    const s = scene();
    fs.chmodSync(s.target, 0o444);
    expect(run(argsFor(s))).toBe(0);
    expect(fs.readFileSync(s.target).equals(s.bytes)).toBe(true);
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

  it('what an earlier run left behind (.new) is not in the way, and the old name .old is left alone', () => {
    const s = scene();
    fs.writeFileSync(`${s.target}.new`, 'half a copy');
    fs.writeFileSync(`${s.target}.old`, 'a file of the user');
    expect(run(argsFor(s))).toBe(0);
    expect(fs.readFileSync(s.target).equals(s.bytes)).toBe(true);
    expect(fs.readdirSync(s.dir).sort()).toEqual(['my ncut.exe', 'my ncut.exe.old', 'updates']);
    expect(fs.readFileSync(`${s.target}.old`, 'utf8')).toBe('a file of the user');
  });

  it('takes nothing but its own arguments', () => {
    const s = scene();
    const good = argsFor(s);
    const long = path.join(s.dir, `${'a'.repeat(260 - s.dir.length - 5)}.exe`);
    const bad = [
      [],
      good.slice(0, 4),
      [...good, 'one', 'two'],
      argsFor(s, { mode: 'loud' }),
      argsFor(s, { sha: sha(s.bytes).toUpperCase() }),
      argsFor(s, { sha: 'abc' }),
      argsFor(s, { size: '0' }),
      argsFor(s, { size: '12x' }),
      // no spaces, no sign, nothing but digits
      argsFor(s, { size: ` ${s.bytes.length} ` }),
      argsFor(s, { size: `+${s.bytes.length}` }),
      argsFor(s, { source: 'updates\\x.exe' }),
      argsFor(s, { source: s.source.replace(/\.exe$/, '.txt') }),
      argsFor(s, { target: 'ncut.exe' }),
      argsFor(s, { target: s.source }),
      // paths windows (or this compiler) can not take: a device path, a stream name, a share without a file, too long
      argsFor(s, { target: '\\\\.\\C:\\x.exe' }),
      argsFor(s, { target: `${s.dir}\\a.txt:b.exe` }),
      argsFor(s, { target: '\\\\x.exe' }),
      argsFor(s, { target: long }),
      [...good, 'a"b'],
      [...good, ''],
    ];
    expect(long.length).toBe(260);
    for (const args of bad) {
      expect(run(args), JSON.stringify(args).slice(0, 120)).toBe(2);
    }
    expect(fs.readFileSync(s.target, 'utf8')).toBe('THE OLD EXE');
    expect(fs.existsSync(s.source)).toBe(true);
    // nothing was written, not even the note
    expect(fs.readdirSync(s.dir).sort()).toEqual(['my ncut.exe', 'updates']);
    expect(fs.readdirSync(s.updates)).toEqual(['ncut-9.9.9-portable.exe']);
  });

  it('the download and the exe are never the same file, whatever the names', () => {
    // a folder junction to the folder of the exe: the string compare of the two paths sees two files
    const s = scene();
    const jun = path.join(s.dir, 'jun');
    fs.symlinkSync(s.dir, jun, 'junction');
    fs.writeFileSync(s.target, s.bytes);
    expect(run(argsFor(s, { source: path.join(jun, 'my ncut.exe') }))).toBe(2);
    expect(fs.readFileSync(s.target).equals(s.bytes)).toBe(true);
    fs.rmdirSync(jun);

    // a second name of the same file
    const h = scene();
    fs.unlinkSync(h.target);
    fs.linkSync(h.source, h.target);
    expect(run(argsFor(h))).toBe(2);
    expect(fs.readFileSync(h.target).equals(h.bytes)).toBe(true);
    expect(fs.readFileSync(h.source).equals(h.bytes)).toBe(true);
  });

  it('start: the new exe is started with the one argument as it was given, and without the variables of the old starter', async () => {
    const out = path.join(root, 'echo-start.txt');
    const env = { ...process.env, ECHO_OUT: out, KEEP_ME: 'kept', PORTABLE_EXECUTABLE_DIR: 'x', PORTABLE_EXECUTABLE_FILE: 'y', PORTABLE_EXECUTABLE_APP_FILENAME: 'z' };
    const exe = fs.readFileSync(echo);
    // a path with a space and a backslash at the end: the case a naive command line gets wrong
    const arg = '--user-data-dir=C:\\some where\\';
    const s = scene(exe);
    expect(run([...argsFor(s, { mode: 'start' }), arg], env)).toBe(0);
    expect(fs.readFileSync(s.target).equals(exe)).toBe(true);
    for (let i = 0; i < 100 && !fs.existsSync(out); i++) await sleep(50);
    const lines = fs.readFileSync(out, 'utf8').split('\n');
    expect(lines).toContain('args=1');
    expect(lines).toContain(`arg=${arg}`);
    // the long name: the temp folder can be a short one (C:\Users\RUNNER~1 on github), the helper starts the exe by its full name
    expect(lines).toContain(`cwd=${fs.realpathSync.native(s.dir)}`);
    expect(lines).toContain('KEEP_ME=kept');
    expect(lines).toContain('PORTABLE_EXECUTABLE_DIR=');
    expect(lines).toContain('PORTABLE_EXECUTABLE_FILE=');
    expect(lines).toContain('PORTABLE_EXECUTABLE_APP_FILENAME=');

    // without an argument there is none
    fs.rmSync(out);
    const bare = scene(exe);
    expect(run(argsFor(bare, { mode: 'start' }), env)).toBe(0);
    for (let i = 0; i < 100 && !fs.existsSync(out); i++) await sleep(50);
    expect(fs.readFileSync(out, 'utf8').split('\n')).toContain('args=0');
  });

  it('quiet: nothing is started', async () => {
    const out = path.join(root, 'echo-quiet.txt');
    const exe = fs.readFileSync(echo);
    const s = scene(exe);
    expect(run([...argsFor(s), '--user-data-dir=C:\\x'], { ...process.env, ECHO_OUT: out })).toBe(0);
    expect(fs.readFileSync(s.target).equals(exe)).toBe(true);
    await sleep(1500);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('start of a file that is no program says so, and the swap still stands', () => {
    const s = scene();
    expect(run(argsFor(s, { mode: 'start' }))).toBe(1);
    expect(fs.readFileSync(s.target).equals(s.bytes)).toBe(true);
    expect(fs.readFileSync(s.log, 'utf8').trim()).toBe('1');
  });

  it('a place that is a folder is not replaced', () => {
    const s = scene();
    fs.unlinkSync(s.target);
    fs.mkdirSync(s.target);
    expect(run(argsFor(s))).toBe(3);
    expect(fs.statSync(s.target).isDirectory()).toBe(true);
    expect(fs.existsSync(s.source)).toBe(true);
  });

  it('a copy that can not be written ends with 5 and leaves the old exe', () => {
    const s = scene();
    // a folder in the way of <exe>.new
    fs.mkdirSync(`${s.target}.new`);
    expect(run(argsFor(s))).toBe(5);
    expect(fs.readFileSync(s.target, 'utf8')).toBe('THE OLD EXE');
    expect(fs.existsSync(s.source)).toBe(true);
    expect(fs.readFileSync(s.log, 'utf8').trim()).toBe('5');
  });

  it('waits for an exe that is open without delete sharing (an old starter) and replaces it when it lets go', async () => {
    const s = scene();
    const held = await hold(s.target, 1500);
    const t0 = Date.now();
    expect(await runAsync(argsFor(s))).toBe(0);
    expect(Date.now() - t0).toBeGreaterThan(1000);
    await held.done;
    expect(fs.readFileSync(s.target).equals(s.bytes)).toBe(true);
    expect(fs.readdirSync(s.dir).sort()).toEqual(['my ncut.exe', 'updates']);
    expect(fs.existsSync(s.source)).toBe(false);
  });

  it('waits for an exe that is running, and a second helper for the same exe steps aside', async () => {
    const s = scene(fs.readFileSync(echo));
    fs.copyFileSync(sleeper, s.target);
    const running = spawn(s.target, ['2500'], { stdio: 'ignore' });
    const ended = new Promise((resolve) => running.on('exit', resolve));
    await sleep(500);
    const t0 = Date.now();
    const first = runAsync(argsFor(s));
    await sleep(800);
    // the first one waits for the running exe and holds the mutex: this one does nothing
    expect(run(argsFor(s))).toBe(8);
    expect(await first).toBe(0);
    expect(Date.now() - t0).toBeGreaterThan(1500);
    await ended;
    expect(fs.readFileSync(s.target).equals(s.bytes)).toBe(true);
    expect(fs.readdirSync(s.dir).sort()).toEqual(['my ncut.exe', 'updates']);
  });
});
