'use strict';
/**
 * the decisions of the desktop shell, without electron: which file a url maps to, what may navigate,
 * which permissions the page gets, where the window may reopen. pure, so they are tested in node.
 */

const SCHEME = 'app';
const HOST = 'ncut';
const HOME = `${SCHEME}://${HOST}/`;

/**
 * the page is local only: scripts and styles from the app itself, media / fonts / images also from the
 * blobs it makes of imported files, no network. inline style attributes are how react sets element styles.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob: data:",
  "font-src 'self' blob: data:",
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const MIME = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
};

/**
 * the cache header of a file of dist/, or null for none. the files vite puts in assets/ carry a hash of their
 * content in the name (name-<8 chars>.ext), so a name never changes its bytes and may be kept for good. the html
 * must always be asked for again (it names the current hashed files). everything else gets no header, as before.
 */
function cacheControlFor(rel) {
  if (typeof rel !== 'string') return null;
  if (rel.endsWith('.html')) return 'no-cache';
  if (rel.startsWith('assets/') && /-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/.test(rel)) return 'public, max-age=31536000, immutable';
  return null;
}

/** how long the window waits for the page to say it painted its first screen, then shows anyway (ms) */
const SHOW_FALLBACK_MS = 1500;

/** content type by file extension. unknown = bytes (never guessed as a script). */
function mimeFor(rel) {
  const dot = rel.lastIndexOf('.');
  const ext = dot < 0 ? '' : rel.slice(dot + 1).toLowerCase();
  return Object.prototype.hasOwnProperty.call(MIME, ext) ? MIME[ext] : 'application/octet-stream';
}

function parse(url) {
  try {
    return new URL(String(url));
  } catch {
    return null;
  }
}

/**
 * the file inside dist/ a request is for, as a relative path with forward slashes, or null when the url
 * is not ours or tries to leave the folder. the root is index.html (the app routes with the # part).
 */
function filePathFor(requestUrl) {
  const url = parse(requestUrl);
  if (!url || url.protocol !== `${SCHEME}:` || url.host !== HOST) return null;
  let p;
  try {
    p = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  // no nul bytes, no windows separators, no drive letters / alternate streams
  if (/[\0\\:]/.test(p)) return null;
  const parts = p.split('/').filter((s) => s !== '');
  if (parts.some((s) => s === '.' || s === '..')) return null;
  if (parts.length === 0) return 'index.html';
  return parts.join('/');
}

/** true when `file` is `root` or lies below it (both already normalized, `sep` = the path separator) */
function isInside(root, file, sep) {
  const r = root.endsWith(sep) ? root.slice(0, -sep.length) : root;
  return file === r || file.startsWith(r + sep);
}

/** `--dev-url=http://localhost:5173` from the command line. only a local http address counts. */
function devUrlFromArgs(argv) {
  for (const a of argv) {
    if (typeof a !== 'string' || !a.startsWith('--dev-url=')) continue;
    const url = parse(a.slice('--dev-url='.length));
    if (!url || url.protocol !== 'http:') return null;
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return null;
    if (url.username || url.password) return null;
    return `${url.origin}/`;
  }
  return null;
}

/** is this url the app itself (its own origin, or the dev server when one is used)? */
function isAppUrl(candidate, devUrl) {
  const url = parse(candidate);
  if (!url) return false;
  if (url.protocol === `${SCHEME}:` && url.host === HOST) return true;
  if (devUrl) {
    const dev = parse(devUrl);
    if (dev && url.protocol === dev.protocol && url.host === dev.host) return true;
  }
  return false;
}

/** a plain web address: the only thing that is ever handed to the system browser */
function isWebUrl(candidate) {
  const url = parse(candidate);
  return !!url && (url.protocol === 'https:' || url.protocol === 'http:');
}

/** what the editor uses: full screen for the preview, the installed fonts for the font picker */
const PERMISSIONS = new Set(['fullscreen', 'local-fonts']);

function permissionAllowed(permission, fromUrl, devUrl) {
  return PERMISSIONS.has(permission) && isAppUrl(fromUrl, devUrl);
}

/** a file the app itself hands out (a blob it made, or one of its own files): the only downloads there are */
function isAppDownload(candidate, devUrl) {
  const s = String(candidate);
  return isAppUrl(s.startsWith('blob:') ? s.slice(5) : s, devUrl);
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

/** a file name windows accepts, from whatever the page asked for. never a path. */
function safeFileName(raw) {
  let name = String(raw ?? '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  if (name.length > 180) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = name.slice(0, 180 - ext.length) + ext;
  }
  if (name === '' || /^\.+$/.test(name)) return 'ncut file';
  if (RESERVED.test(name)) name = '_' + name;
  return name;
}

const KINDS = { mp4: 'mp4 video', webm: 'webm video', gif: 'animated gif', wav: 'wav audio', ogg: 'ogg audio', png: 'png image', jpg: 'jpeg image', srt: 'subtitles', ncut: 'ncut project' };

/** the file type list of the save dialog: the type of the file first, then everything */
function saveFilters(name) {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const all = { name: 'all files', extensions: ['*'] };
  if (!/^[a-z0-9]{1,8}$/.test(ext)) return [all];
  return [{ name: Object.prototype.hasOwnProperty.call(KINDS, ext) ? KINDS[ext] : `${ext} file`, extensions: [ext] }, all];
}

/** the page's own background in its dark and its light theme (styles/theme.css, --surface-1) */
const WINDOW_DARK = '#171717';
const WINDOW_LIGHT = '#e1e1e1';

/**
 * the color of the window before the page has painted. the window is shown as soon as the page has its first
 * screen, a moment before the gpu can paint it, so this color is what is seen first and must be the page's.
 * `saved`: what the page said its theme was the last time (true = dark, false = light), anything else = never
 * said: then the system's setting decides, which is what the page follows by default.
 */
function windowBackground(saved, systemDark) {
  const dark = typeof saved === 'boolean' ? saved : systemDark !== false;
  return dark ? WINDOW_DARK : WINDOW_LIGHT;
}

/** a stored window state with sane numbers, or null */
function cleanWindowState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
  const x = n(raw.x);
  const y = n(raw.y);
  const width = n(raw.width);
  const height = n(raw.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (width < 400 || height < 300 || width > 16384 || height > 16384) return null;
  if (Math.abs(x) > 100000 || Math.abs(y) > 100000) return null;
  return { x, y, width, height, maximized: raw.maximized === true };
}

/** does the window still land on a screen (a monitor may be gone since last time)? needs a grabbable piece. */
function isOnScreen(state, areas) {
  for (const a of areas) {
    const w = Math.min(state.x + state.width, a.x + a.width) - Math.max(state.x, a.x);
    // the title bar is at the top: the top edge must be inside the area
    const top = state.y >= a.y - 8 && state.y <= a.y + a.height - 48;
    if (w >= 160 && top) return true;
  }
  return false;
}

/** the few keys the shell takes for itself. `input` is electron's before-input-event input. */
function shellKey(input) {
  if (!input || input.type !== 'keyDown' || input.isAutoRepeat) return null;
  const key = String(input.key || '').toLowerCase();
  const ctrl = !!(input.control || input.meta);
  if (key === 'f11' && !ctrl && !input.alt && !input.shift) return 'fullscreen';
  if (key === 'f12' && !ctrl && !input.alt && !input.shift) return 'devtools';
  if (key === 'i' && ctrl && input.shift && !input.alt) return 'devtools';
  return null;
}

// ---------- the bridge (preload) ----------

/** the extension of an exported project (src/storage/projectFile.ts PROJECT_FILE_EXT) */
const PROJECT_EXT = '.ncut';
/** biggest project file handed to the page: it goes over ipc in one piece, so it stays below what a page can hold */
const MAX_OPEN_BYTES = 1024 * 1024 * 1024;

/** taskbar progress: the fraction when it is a number in 0..1, otherwise -1 (= clear the bar) */
function clampProgress(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return -1;
  return value;
}

/** most process ids ncut-qos.exe is given at once */
const QOS_MAX_PIDS = 64;

/**
 * the arguments for ncut-qos.exe (electron/qos.cs): the word and the process ids as plain digits. null when there
 * is nothing to do. only whole numbers above 0 get through, each once.
 */
function qosArgs(high, pids) {
  if (!Array.isArray(pids)) return null;
  const seen = new Set();
  for (const pid of pids) {
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff) continue;
    seen.add(String(pid));
    if (seen.size >= QOS_MAX_PIDS) break;
  }
  if (seen.size === 0) return null;
  return [high === true ? 'high' : 'auto', ...seen];
}

/** does this look like the path of a project file? (right extension, a real name, not a folder) */
function isProjectFile(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096) return false;
  if (p.includes('\0')) return false;
  if (/[/\\]$/.test(p)) return false;
  const base = p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
  return base.length > PROJECT_EXT.length && base.toLowerCase().endsWith(PROJECT_EXT);
}

/**
 * the project file a start / second start was given: the first argument that is a project file path.
 * skips the exe itself (and in dev the app path after `electron`), flags and anything else.
 */
function projectFileFromArgs(argv, isPackaged) {
  if (!Array.isArray(argv)) return null;
  for (let i = isPackaged ? 1 : 2; i < argv.length; i++) {
    let a = argv[i];
    if (typeof a !== 'string') continue;
    a = a.trim();
    if (a.length >= 2 && a.startsWith('"') && a.endsWith('"')) a = a.slice(1, -1);
    if (a.startsWith('-')) continue;
    if (isProjectFile(a)) return a;
  }
  return null;
}

/** the last part of a path with either separator: what the page may be told about a saved file */
function baseName(p) {
  const s = String(p ?? '');
  return s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1);
}

/** the id windows groups the app's windows, shortcuts and taskbar pin under. the same as build.appId (package.json) */
const APP_ID = 'com.sagecsharp.ncut';

/**
 * what the windows taskbar keeps when the window is pinned (right click on the taskbar icon, pin to taskbar).
 * the portable exe unpacks itself into a new temp folder on every start and runs the app from there: without
 * this the pin would point into that folder, which is gone when the app closes, and the pin would be dead.
 * the portable starter says where it really lives in PORTABLE_EXECUTABLE_FILE: the pin starts that file and
 * takes its icon from it. the installed app and the plain folder pin the exe that runs.
 * null = leave the window alone (not an exe, or the file is not there).
 */
function taskbarDetails(env, execPath, exists) {
  const usable = (p) => {
    if (typeof p !== 'string' || p.length < 4 || p.length > 1024) return false;
    // a full windows path to an exe, with nothing in it that could end the quoted command
    if (!/^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/])/.test(p) || !/\.exe$/i.test(p)) return false;
    if (/["<>|?*\u0000-\u001f]/.test(p)) return false;
    try {
      return exists(p) === true;
    } catch {
      return false;
    }
  };
  const portable = env && typeof env === 'object' ? env.PORTABLE_EXECUTABLE_FILE : undefined;
  const exe = usable(portable) ? portable : usable(execPath) ? execPath : null;
  if (!exe) return null;
  return { appId: APP_ID, appIconPath: exe, appIconIndex: 0, relaunchCommand: `"${exe}"`, relaunchDisplayName: 'ncut' };
}

/** may this ipc message be believed? only the top frame of the app itself (or the dev server) */
function isTrustedSender(frameUrl, isMainFrame, devUrl) {
  return isMainFrame === true && typeof frameUrl === 'string' && isAppUrl(frameUrl, devUrl);
}

module.exports = {
  APP_ID,
  taskbarDetails,
  cacheControlFor,
  SHOW_FALLBACK_MS,
  PROJECT_EXT,
  MAX_OPEN_BYTES,
  clampProgress,
  qosArgs,
  QOS_MAX_PIDS,
  windowBackground,
  WINDOW_DARK,
  WINDOW_LIGHT,
  isProjectFile,
  projectFileFromArgs,
  baseName,
  isTrustedSender,
  SCHEME,
  HOST,
  HOME,
  CSP,
  mimeFor,
  filePathFor,
  isInside,
  devUrlFromArgs,
  isAppUrl,
  isWebUrl,
  permissionAllowed,
  isAppDownload,
  safeFileName,
  saveFilters,
  cleanWindowState,
  isOnScreen,
  shellKey,
};
