import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const rules = createRequire(import.meta.url)('./rules.cjs');

describe('which file a request gets', () => {
  it('the root is index.html, files keep their path', () => {
    expect(rules.filePathFor('app://ncut/')).toBe('index.html');
    expect(rules.filePathFor('app://ncut')).toBe('index.html');
    expect(rules.filePathFor('app://ncut/#/project/prj_1')).toBe('index.html');
    expect(rules.filePathFor('app://ncut/?x=1')).toBe('index.html');
    expect(rules.filePathFor('app://ncut/assets/index-abc.js')).toBe('assets/index-abc.js');
    expect(rules.filePathFor('app://ncut/assets/kode%20mono.woff2')).toBe('assets/kode mono.woff2');
  });

  it('never leaves the folder', () => {
    for (const bad of [
      'app://ncut/../package.json',
      'app://ncut/%2e%2e/package.json',
      'app://ncut/..%2fpackage.json',
      'app://ncut/..%5cpackage.json',
      'app://ncut/assets/..%2f..%2felectron/main.cjs',
      'app://ncut/assets/%2e%2e%2f%2e%2e%2fpackage.json',
      'app://ncut/C:/Windows/win.ini',
      'app://ncut/c%3a/Windows/win.ini',
      'app://ncut/assets/a.js%00.png',
      'app://ncut/index.html::$DATA',
      'app://ncut/%E0%A4%A',
    ]) {
      const got = rules.filePathFor(bad);
      // either refused, or it stays a plain path below the root
      if (got !== null) expect(got.split('/').every((s) => s !== '..' && s !== '.' && !/[\\:\0]/.test(s))).toBe(true);
      expect(got === null || !got.includes('package.json') || got === 'package.json').toBe(true);
    }
    expect(rules.filePathFor('app://ncut/..%5cpackage.json')).toBeNull();
    expect(rules.filePathFor('app://ncut/..%2fpackage.json')).toBeNull();
    expect(rules.filePathFor('app://ncut/c%3a/Windows/win.ini')).toBeNull();
    expect(rules.filePathFor('app://ncut/assets/a.js%00.png')).toBeNull();
    expect(rules.filePathFor('app://ncut/%E0%A4%A')).toBeNull();
  });

  it('only answers for its own scheme and host', () => {
    expect(rules.filePathFor('app://other/index.html')).toBeNull();
    expect(rules.filePathFor('https://ncut/index.html')).toBeNull();
    expect(rules.filePathFor('file:///C:/Windows/win.ini')).toBeNull();
    expect(rules.filePathFor('not a url')).toBeNull();
    expect(rules.filePathFor('')).toBeNull();
  });

  it('isInside keeps to the root', () => {
    expect(rules.isInside('C:\\app\\dist', 'C:\\app\\dist\\index.html', '\\')).toBe(true);
    expect(rules.isInside('C:\\app\\dist', 'C:\\app\\dist', '\\')).toBe(true);
    expect(rules.isInside('C:\\app\\dist\\', 'C:\\app\\dist\\a\\b.js', '\\')).toBe(true);
    expect(rules.isInside('C:\\app\\dist', 'C:\\app\\dist-other\\x', '\\')).toBe(false);
    expect(rules.isInside('C:\\app\\dist', 'C:\\app\\package.json', '\\')).toBe(false);
    expect(rules.isInside('/app/dist', '/app/dist/assets/a.css', '/')).toBe(true);
    expect(rules.isInside('/app/dist', '/app/distx', '/')).toBe(false);
  });

  it('content types: scripts are scripts, unknown is plain bytes', () => {
    expect(rules.mimeFor('index.html')).toMatch(/^text\/html/);
    expect(rules.mimeFor('assets/a.JS')).toMatch(/^text\/javascript/);
    expect(rules.mimeFor('assets/a.css')).toMatch(/^text\/css/);
    expect(rules.mimeFor('a.woff2')).toBe('font/woff2');
    expect(rules.mimeFor('favicon.svg')).toBe('image/svg+xml');
    expect(rules.mimeFor('weird.exe')).toBe('application/octet-stream');
    expect(rules.mimeFor('noext')).toBe('application/octet-stream');
    expect(rules.mimeFor('a.constructor')).toBe('application/octet-stream');
  });
});

describe('what counts as the app', () => {
  it('its own origin, and the dev server only when one is used', () => {
    expect(rules.isAppUrl('app://ncut/', null)).toBe(true);
    expect(rules.isAppUrl('app://ncut', null)).toBe(true);
    expect(rules.isAppUrl('app://ncut/#/project/x', null)).toBe(true);
    expect(rules.isAppUrl('app://ncut.evil.com/', null)).toBe(false);
    expect(rules.isAppUrl('http://localhost:5173/', null)).toBe(false);
    expect(rules.isAppUrl('http://localhost:5173/x', 'http://localhost:5173/')).toBe(true);
    expect(rules.isAppUrl('http://localhost:5174/', 'http://localhost:5173/')).toBe(false);
    expect(rules.isAppUrl('https://localhost:5173/', 'http://localhost:5173/')).toBe(false);
    expect(rules.isAppUrl('file:///C:/x.html', null)).toBe(false);
    expect(rules.isAppUrl('', null)).toBe(false);
    expect(rules.isAppUrl(undefined, null)).toBe(false);
  });

  it('only plain web addresses go to the system browser', () => {
    expect(rules.isWebUrl('https://github.com/sagecsharp/ncut')).toBe(true);
    expect(rules.isWebUrl('http://example.com')).toBe(true);
    expect(rules.isWebUrl('file:///C:/Windows/System32/calc.exe')).toBe(false);
    expect(rules.isWebUrl('ms-settings:privacy')).toBe(false);
    expect(rules.isWebUrl('javascript:alert(1)')).toBe(false);
    expect(rules.isWebUrl('smb://host/share')).toBe(false);
    expect(rules.isWebUrl('about:blank')).toBe(false);
  });

  it('the dev url must be a local http address', () => {
    expect(rules.devUrlFromArgs(['electron', '.', '--dev-url=http://localhost:5173'])).toBe('http://localhost:5173/');
    expect(rules.devUrlFromArgs(['--dev-url=http://127.0.0.1:4173/some/page'])).toBe('http://127.0.0.1:4173/');
    expect(rules.devUrlFromArgs(['--dev-url=https://evil.com'])).toBeNull();
    expect(rules.devUrlFromArgs(['--dev-url=http://evil.com'])).toBeNull();
    expect(rules.devUrlFromArgs(['--dev-url=http://user:pw@localhost:5173'])).toBeNull();
    expect(rules.devUrlFromArgs(['--dev-url=http://localhost.evil.com:5173'])).toBeNull();
    expect(rules.devUrlFromArgs(['--dev-url=file:///C:/x.html'])).toBeNull();
    expect(rules.devUrlFromArgs(['--dev-url='])).toBeNull();
    expect(rules.devUrlFromArgs(['electron', '.'])).toBeNull();
  });

  it('permissions: only what the editor uses, only for the app', () => {
    expect(rules.permissionAllowed('fullscreen', 'app://ncut/', null)).toBe(true);
    expect(rules.permissionAllowed('local-fonts', 'app://ncut', null)).toBe(true);
    for (const p of ['media', 'geolocation', 'notifications', 'openExternal', 'clipboard-read', 'fileSystem', 'display-capture', 'midi', 'unknown']) {
      expect(rules.permissionAllowed(p, 'app://ncut/', null)).toBe(false);
    }
    expect(rules.permissionAllowed('fullscreen', 'https://evil.com/', null)).toBe(false);
    expect(rules.permissionAllowed('fullscreen', '', null)).toBe(false);
  });

  it('the page policy allows no network and no inline or evaluated script', () => {
    expect(rules.CSP).toContain("default-src 'self'");
    expect(rules.CSP).toContain("script-src 'self'");
    expect(rules.CSP).not.toMatch(/script-src[^;]*unsafe/);
    expect(rules.CSP).not.toMatch(/https?:/);
    expect(rules.CSP).toContain("object-src 'none'");
  });
});

describe('files the app hands out', () => {
  it('only its own blobs and files are downloads', () => {
    expect(rules.isAppDownload('blob:app://ncut/4ebd31e6-693f', null)).toBe(true);
    expect(rules.isAppDownload('app://ncut/favicon.svg', null)).toBe(true);
    expect(rules.isAppDownload('blob:https://evil.com/1', null)).toBe(false);
    expect(rules.isAppDownload('https://evil.com/setup.exe', null)).toBe(false);
    expect(rules.isAppDownload('data:text/plain,hi', null)).toBe(false);
    expect(rules.isAppDownload('blob:http://localhost:5173/1', 'http://localhost:5173/')).toBe(true);
    expect(rules.isAppDownload('blob:http://localhost:5173/1', null)).toBe(false);
  });

  it('file names are made safe for windows and never a path', () => {
    expect(rules.safeFileName('untitled project.mp4')).toBe('untitled project.mp4');
    expect(rules.safeFileName('a/b\\c:d*?.mp4')).toBe('a_b_c_d__.mp4');
    expect(rules.safeFileName('..\\..\\evil.exe')).toBe('.._.._evil.exe');
    expect(rules.safeFileName('con.mp4')).toBe('_con.mp4');
    expect(rules.safeFileName('COM1')).toBe('_COM1');
    expect(rules.safeFileName('console.mp4')).toBe('console.mp4');
    expect(rules.safeFileName('name. . ')).toBe('name');
    expect(rules.safeFileName('...')).toBe('ncut file');
    expect(rules.safeFileName('')).toBe('ncut file');
    expect(rules.safeFileName(undefined)).toBe('ncut file');
    expect(rules.safeFileName('a\u0000b\u001f.png')).toBe('a_b_.png');
    const long = rules.safeFileName('x'.repeat(300) + '.webm');
    expect(long.length).toBe(180);
    expect(long.endsWith('.webm')).toBe(true);
  });

  it('the save dialog lists the type of the file first', () => {
    expect(rules.saveFilters('clip.mp4')).toEqual([{ name: 'mp4 video', extensions: ['mp4'] }, { name: 'all files', extensions: ['*'] }]);
    expect(rules.saveFilters('my.project.NCUT')[0]).toEqual({ name: 'ncut project', extensions: ['ncut'] });
    expect(rules.saveFilters('a.xyz')[0]).toEqual({ name: 'xyz file', extensions: ['xyz'] });
    expect(rules.saveFilters('noext')).toEqual([{ name: 'all files', extensions: ['*'] }]);
    expect(rules.saveFilters('a.toString')[0]).toEqual({ name: 'tostring file', extensions: ['tostring'] });
    expect(rules.saveFilters('.hidden')).toEqual([{ name: 'all files', extensions: ['*'] }]);
  });
});

describe('where the window reopens', () => {
  it('a stored state needs sane numbers', () => {
    expect(rules.cleanWindowState({ x: 10, y: 20, width: 1440, height: 900, maximized: true })).toEqual({ x: 10, y: 20, width: 1440, height: 900, maximized: true });
    expect(rules.cleanWindowState({ x: 10.4, y: 20, width: 1440, height: 900 })).toEqual({ x: 10, y: 20, width: 1440, height: 900, maximized: false });
    expect(rules.cleanWindowState({ x: 0, y: 0, width: 100, height: 900 })).toBeNull();
    expect(rules.cleanWindowState({ x: 0, y: 0, width: 1e9, height: 900 })).toBeNull();
    expect(rules.cleanWindowState({ x: NaN, y: 0, width: 1440, height: 900 })).toBeNull();
    expect(rules.cleanWindowState({ x: '10', y: 0, width: 1440, height: 900 })).toBeNull();
    expect(rules.cleanWindowState({ saveDir: 'C:\\x' })).toBeNull();
    expect(rules.cleanWindowState(null)).toBeNull();
    expect(rules.cleanWindowState('x')).toBeNull();
    expect(rules.cleanWindowState([])).toBeNull();
  });

  it('a window whose screen is gone starts in the default place', () => {
    const main = { x: 0, y: 0, width: 1920, height: 1040 };
    const left = { x: -1920, y: 0, width: 1920, height: 1040 };
    const w = (x, y) => ({ x, y, width: 1440, height: 900 });
    expect(rules.isOnScreen(w(100, 50), [main])).toBe(true);
    expect(rules.isOnScreen(w(-1800, 50), [main])).toBe(false);
    expect(rules.isOnScreen(w(-1800, 50), [main, left])).toBe(true);
    expect(rules.isOnScreen(w(1800, 50), [main])).toBe(false); // only 120 px of it left on the screen
    expect(rules.isOnScreen(w(1700, 50), [main])).toBe(true);
    expect(rules.isOnScreen(w(100, 1030), [main])).toBe(false); // title bar below the screen
    expect(rules.isOnScreen(w(100, -200), [main])).toBe(false); // title bar above the screen
    expect(rules.isOnScreen(w(100, -8), [main])).toBe(true); // a maximized window sits a few px outside
    expect(rules.isOnScreen(w(100, 50), [])).toBe(false);
  });
});

describe('keys the shell takes', () => {
  const key = (k, mods = {}) => ({ type: 'keyDown', key: k, ...mods });
  it('f11, f12 and ctrl+shift+i, nothing else', () => {
    expect(rules.shellKey(key('F11'))).toBe('fullscreen');
    expect(rules.shellKey(key('F12'))).toBe('devtools');
    expect(rules.shellKey(key('I', { control: true, shift: true }))).toBe('devtools');
    expect(rules.shellKey(key('i', { control: true }))).toBeNull();
    expect(rules.shellKey(key('F11', { shift: true }))).toBeNull();
    expect(rules.shellKey(key('r', { control: true }))).toBeNull();
    expect(rules.shellKey(key('e', { control: true }))).toBeNull();
    expect(rules.shellKey({ type: 'keyUp', key: 'F11' })).toBeNull();
    expect(rules.shellKey({ type: 'keyDown', key: 'F11', isAutoRepeat: true })).toBeNull();
    expect(rules.shellKey(null)).toBeNull();
  });
});

describe('the bridge rules', () => {
  it('clampProgress keeps 0..1 and clears everything else', () => {
    expect(rules.clampProgress(0)).toBe(0);
    expect(rules.clampProgress(0.5)).toBe(0.5);
    expect(rules.clampProgress(1)).toBe(1);
    for (const bad of [-0.1, 1.01, NaN, Infinity, -Infinity, null, undefined, '0.5', {}, [], true]) {
      expect(rules.clampProgress(bad)).toBe(-1);
    }
  });

  it('isProjectFile wants the extension and a real name', () => {
    expect(rules.isProjectFile('C:\\a\\b\\my film.ncut')).toBe(true);
    expect(rules.isProjectFile('C:\\a\\b\\MY FILM.NCUT')).toBe(true);
    expect(rules.isProjectFile('rel/x.ncut')).toBe(true);
    for (const bad of ['', '.ncut', 'C:\\a\\.ncut', 'C:\\a\\b.ncut\\', 'a/b.ncut/', 'a.mp4', 'a.ncut.txt', 'a.ncutx', 'a\0.ncut', null, 5, undefined]) {
      expect(rules.isProjectFile(bad)).toBe(false);
    }
    expect(rules.isProjectFile('x'.repeat(5000) + '.ncut')).toBe(false);
  });

  it('projectFileFromArgs skips the exe, the dev app path and flags', () => {
    expect(rules.projectFileFromArgs(['C:\\ncut.exe', 'C:\\f.ncut'], true)).toBe('C:\\f.ncut');
    expect(rules.projectFileFromArgs(['C:\\ncut.exe', '--flag', '"C:\\my f.ncut"'], true)).toBe('C:\\my f.ncut');
    expect(rules.projectFileFromArgs(['C:\\ncut.exe'], true)).toBeNull();
    expect(rules.projectFileFromArgs(['C:\\ncut.exe', 'a.mp4', 'b.ncut', 'c.ncut'], true)).toBe('b.ncut');
    // dev: electron . file
    expect(rules.projectFileFromArgs(['electron.exe', 'C:\\app.ncut', 'f.ncut'], false)).toBe('f.ncut');
    expect(rules.projectFileFromArgs(['electron.exe', '.', '--dev-url=http://localhost:5173', 'f.ncut'], false)).toBe('f.ncut');
    expect(rules.projectFileFromArgs(['electron.exe', '.', '-x.ncut'], false)).toBeNull();
    expect(rules.projectFileFromArgs(null, true)).toBeNull();
    expect(rules.projectFileFromArgs([1, null, 'a.ncut'], true)).toBe('a.ncut');
  });

  it('baseName and the open cap', () => {
    expect(rules.baseName('C:\\a\\b\\c.mp4')).toBe('c.mp4');
    expect(rules.baseName('/a/b/c.mp4')).toBe('c.mp4');
    expect(rules.baseName('c.mp4')).toBe('c.mp4');
    expect(rules.baseName(null)).toBe('');
    expect(rules.MAX_OPEN_BYTES).toBeGreaterThan(0);
  });

  it('only the top frame of the app is a trusted sender', () => {
    expect(rules.isTrustedSender('app://ncut/', true, null)).toBe(true);
    expect(rules.isTrustedSender('app://ncut/', false, null)).toBe(false);
    expect(rules.isTrustedSender('https://evil.example/', true, null)).toBe(false);
    expect(rules.isTrustedSender('http://localhost:5173/', true, null)).toBe(false);
    expect(rules.isTrustedSender('http://localhost:5173/', true, 'http://localhost:5173/')).toBe(true);
    expect(rules.isTrustedSender(undefined, true, null)).toBe(false);
  });
});

describe('cache headers and showing the window', () => {
  const IMMUTABLE = 'public, max-age=31536000, immutable';

  it('hashed files under assets/ are kept for good', () => {
    expect(rules.cacheControlFor('assets/index-DAURsuPe.js')).toBe(IMMUTABLE);
    expect(rules.cacheControlFor('assets/index-kSe7rnxU.css')).toBe(IMMUTABLE);
    expect(rules.cacheControlFor('assets/exportWorker-DHN7ARXX.js')).toBe(IMMUTABLE);
    expect(rules.cacheControlFor('assets/400-3FVO97uO.css')).toBe(IMMUTABLE);
    // a hash may start with or contain - and _
    expect(rules.cacheControlFor('assets/kode-mono-latin-400-normal-_-aXATzQ.woff2')).toBe(IMMUTABLE);
    expect(rules.cacheControlFor('assets/ExportDialog-D_-aXATz.js')).toBe(IMMUTABLE);
  });

  it('html is always asked for again', () => {
    expect(rules.cacheControlFor('index.html')).toBe('no-cache');
    expect(rules.cacheControlFor('assets/page-DAURsuPe.html')).toBe('no-cache');
  });

  it('files without a content hash in the name get no header', () => {
    expect(rules.cacheControlFor('favicon.svg')).toBeNull();
    expect(rules.cacheControlFor('assets/logo.svg')).toBeNull();
    expect(rules.cacheControlFor('assets/short-abc.js')).toBeNull();
    // not under assets/: even a hashed looking name stays uncached
    expect(rules.cacheControlFor('other/index-DAURsuPe.js')).toBeNull();
    expect(rules.cacheControlFor('index-DAURsuPe.js')).toBeNull();
    expect(rules.cacheControlFor(undefined)).toBeNull();
    expect(rules.cacheControlFor(null)).toBeNull();
  });

  it('the window waits a short while for the page, never long', () => {
    expect(rules.SHOW_FALLBACK_MS).toBeGreaterThanOrEqual(1000);
    expect(rules.SHOW_FALLBACK_MS).toBeLessThanOrEqual(2000);
  });
});

describe('the arguments of the export speed helper', () => {
  it('is the word and the process ids as digits', () => {
    expect(rules.qosArgs(true, [100, 2044, 31])).toEqual(['high', '100', '2044', '31']);
    expect(rules.qosArgs(false, [7])).toEqual(['auto', '7']);
    // anything but true is auto
    expect(rules.qosArgs('high', [7])).toEqual(['auto', '7']);
    expect(rules.qosArgs(1, [7])).toEqual(['auto', '7']);
  });
  it('lets only whole numbers above 0 through, each once', () => {
    expect(rules.qosArgs(true, [1, 1, 2, '3', -1, 0, 1.5, NaN, Infinity, null, { pid: 4 }, 2 ** 40, 99])).toEqual(['high', '1', '2', '99']);
    for (const a of rules.qosArgs(true, [5, 6, 7]).slice(1)) expect(a).toMatch(/^[0-9]+$/);
  });
  it('is null when there is nothing to do or the input is not a list', () => {
    expect(rules.qosArgs(true, [])).toBeNull();
    expect(rules.qosArgs(true, ['1; calc.exe', '--help'])).toBeNull();
    expect(rules.qosArgs(true, 'high 1')).toBeNull();
    expect(rules.qosArgs(true, undefined)).toBeNull();
  });
  it('never passes more ids than the helper takes', () => {
    const many = Array.from({ length: 500 }, (_, i) => i + 1);
    expect(rules.qosArgs(true, many).length).toBe(1 + rules.QOS_MAX_PIDS);
  });
});

describe('windowBackground', () => {
  it('is the color of the theme the page had last time', () => {
    expect(rules.windowBackground(true, false)).toBe(rules.WINDOW_DARK);
    expect(rules.windowBackground(false, true)).toBe(rules.WINDOW_LIGHT);
  });
  it('follows the system when the page never said', () => {
    expect(rules.windowBackground(null, true)).toBe(rules.WINDOW_DARK);
    expect(rules.windowBackground(undefined, false)).toBe(rules.WINDOW_LIGHT);
    expect(rules.windowBackground('light', false)).toBe(rules.WINDOW_LIGHT);
    expect(rules.windowBackground(1, true)).toBe(rules.WINDOW_DARK);
  });
  it('is dark when nothing is known', () => {
    expect(rules.windowBackground(null, undefined)).toBe(rules.WINDOW_DARK);
    expect(rules.windowBackground()).toBe(rules.WINDOW_DARK);
  });
  it('gives plain hex colors', () => {
    expect(rules.WINDOW_DARK).toMatch(/^#[0-9a-f]{6}$/);
    expect(rules.WINDOW_LIGHT).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('what the taskbar pin starts', () => {
  const yes = () => true;
  const portable = 'D:\\apps\\ncut-0.1.0-portable.exe';
  const temp = 'C:\\Users\\me\\AppData\\Local\\Temp\\2abc\\ncut.exe';
  it('is the portable file itself, not the copy it unpacked into the temp folder', () => {
    expect(rules.taskbarDetails({ PORTABLE_EXECUTABLE_FILE: portable }, temp, yes)).toEqual({
      appId: rules.APP_ID,
      appIconPath: portable,
      appIconIndex: 0,
      relaunchCommand: `"${portable}"`,
      relaunchDisplayName: 'ncut',
    });
  });
  it('is the exe that runs for the installed app and the plain folder', () => {
    const exe = 'C:\\Users\\me\\AppData\\Local\\Programs\\ncut\\ncut.exe';
    const d = rules.taskbarDetails({}, exe, yes);
    expect(d.relaunchCommand).toBe(`"${exe}"`);
    expect(d.appIconPath).toBe(exe);
    expect(rules.taskbarDetails(undefined, exe, yes).appIconPath).toBe(exe);
    expect(rules.taskbarDetails(null, exe, yes).appIconPath).toBe(exe);
  });
  it('uses the id the installer gives its shortcuts', () => {
    const pkg = createRequire(import.meta.url)('../package.json');
    expect(rules.APP_ID).toBe(pkg.build.appId);
  });
  it('takes paths with spaces, forward slashes, network shares, odd characters and a drive root', () => {
    for (const p of [
      'C:\\my apps\\ncut portable.exe',
      'c:/tools/ncut.EXE',
      '\\\\server\\share\\ncut.exe',
      'D:\\ncut.exe',
      'C:\\Users\\zoë müller\\Downloads\\ncut.exe',
      "C:\\tom & jerry's (apps) 100%\\ncut.exe",
    ]) {
      expect(rules.taskbarDetails({ PORTABLE_EXECUTABLE_FILE: p }, temp, yes).relaunchCommand).toBe(`"${p}"`);
    }
  });
  it('falls back to the running exe when the portable file is gone or is not a usable path', () => {
    const gone = (p) => p !== portable;
    expect(rules.taskbarDetails({ PORTABLE_EXECUTABLE_FILE: portable }, temp, gone).appIconPath).toBe(temp);
    const long = 'C:\\' + 'a'.repeat(2000) + '.exe';
    for (const bad of ['', 'ncut.exe', '..\\ncut.exe', 'C:\\x\\ncut.bat', 'C:\\x\\a.exe" --evil "', 'C:\\x\\a.exe\n', 'C:\\x\\a<b>.exe', 'C:\\x\\a|b.exe', 42, null, {}, long]) {
      expect(rules.taskbarDetails({ PORTABLE_EXECUTABLE_FILE: bad }, temp, yes).appIconPath).toBe(temp);
    }
  });
  it('leaves the window alone when nothing usable is there', () => {
    expect(rules.taskbarDetails({}, temp, () => false)).toBeNull();
    expect(rules.taskbarDetails({}, '/usr/bin/ncut', yes)).toBeNull();
    expect(rules.taskbarDetails({}, undefined, yes)).toBeNull();
    expect(rules.taskbarDetails({}, temp, () => 'yes')).toBeNull();
    expect(
      rules.taskbarDetails({}, temp, () => {
        throw new Error('no such file');
      }),
    ).toBeNull();
  });
});
