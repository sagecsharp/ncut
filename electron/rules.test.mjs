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
