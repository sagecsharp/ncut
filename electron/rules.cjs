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

module.exports = {
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
