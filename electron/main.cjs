'use strict';
/**
 * desktop shell: one window that shows the built web app (dist/) from its own app:// origin.
 * the page gets no node access, no preload and no network: it is the same app that runs in a browser tab.
 * commonjs on purpose (package.json is "type": "module" for vite, electron's main entry stays simple).
 */
const { app, BrowserWindow, Menu, dialog, protocol, screen, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const shellRules = require('./rules.cjs');

const DIST = path.join(__dirname, '..', 'dist');
const ICON = path.join(__dirname, '..', 'build', 'icon.png');
const STATE_FILE = () => path.join(app.getPath('userData'), 'window.json');
/** how long a closing window may take to write its last autosave */
const CLOSE_WAIT_MS = 4000;

// `electron . --dev-url=http://localhost:5173` shows the vite dev server instead. never in a packaged app.
const devUrl = app.isPackaged ? null : shellRules.devUrlFromArgs(process.argv);

protocol.registerSchemesAsPrivileged([
  { scheme: shellRules.SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

app.setAppUserModelId('com.sagecsharp.ncut');

/** @type {BrowserWindow | null} */
let win = null;

// ---------- serving dist/ ----------

function notFound() {
  return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

async function serve(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const rel = shellRules.filePathFor(request.url);
  if (rel === null) return notFound();
  const file = path.join(DIST, rel);
  // belt and braces: never leave dist/ whatever the url looked like
  if (!shellRules.isInside(DIST, file, path.sep)) return notFound();
  try {
    const body = await fs.promises.readFile(file);
    const headers = { 'content-type': shellRules.mimeFor(rel), 'x-content-type-options': 'nosniff' };
    if (rel.endsWith('.html')) {
      headers['content-security-policy'] = shellRules.CSP;
      headers['cache-control'] = 'no-cache';
    }
    return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
  } catch {
    return notFound();
  }
}

// ---------- window state ----------

/** the folder the last file was saved to: the next save dialog opens there */
let saveDir = null;

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
    if (raw && typeof raw.saveDir === 'string' && path.isAbsolute(raw.saveDir)) saveDir = raw.saveDir;
    return shellRules.cleanWindowState(raw);
  } catch {
    return null;
  }
}

/** the window's place, kept even when there is no window to ask right now */
let lastBounds = null;

function writeState() {
  try {
    if (win && !win.isDestroyed()) {
      const b = win.getNormalBounds();
      lastBounds = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() };
    }
    if (!lastBounds && !saveDir) return;
    fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true });
    fs.writeFileSync(STATE_FILE(), JSON.stringify({ ...(lastBounds ?? {}), saveDir: saveDir ?? undefined }));
  } catch {
    /* losing the window position is not worth an error */
  }
}

function existingDir(dir) {
  try {
    return typeof dir === 'string' && fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/** exports, frames, captions and project files: a save dialog with the real file name, in the last used folder */
function onDownload(event, item) {
  if (!shellRules.isAppDownload(item.getURL(), devUrl)) {
    event.preventDefault();
    return;
  }
  const name = shellRules.safeFileName(item.getFilename());
  const dir = existingDir(saveDir) ?? app.getPath('downloads');
  item.setSaveDialogOptions({
    title: `save ${name}`,
    defaultPath: path.join(dir, name),
    filters: shellRules.saveFilters(name),
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  item.once('done', (_event, state) => {
    if (state !== 'completed') return;
    const saved = item.getSavePath();
    if (!saved) return;
    saveDir = path.dirname(saved);
    writeState();
  });
}

// ---------- the window ----------

function createWindow() {
  const saved = readState();
  const areas = screen.getAllDisplays().map((d) => d.workArea);
  const place = saved && shellRules.isOnScreen(saved, areas) ? saved : null;

  win = new BrowserWindow({
    width: place ? place.width : 1440,
    height: place ? place.height : 900,
    x: place ? place.x : undefined,
    y: place ? place.y : undefined,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'ncut',
    backgroundColor: '#111111',
    autoHideMenuBar: true,
    icon: fs.existsSync(ICON) ? ICON : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
      // an export keeps its speed while the window is minimized or behind other windows
      backgroundThrottling: false,
      devTools: true,
    },
  });
  const w = win;
  if (saved && saved.maximized) w.maximize();
  w.once('ready-to-show', () => w.show());
  // a page that never gets ready must not leave an invisible window behind
  setTimeout(() => {
    if (!w.isDestroyed() && !w.isVisible()) w.show();
  }, 5000);

  const wc = w.webContents;
  const home = devUrl ?? shellRules.HOME;

  // nothing opens inside the app except the app. web links go to the real browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (shellRules.isWebUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  const guard = (event, url) => {
    if (shellRules.isAppUrl(url, devUrl)) return;
    event.preventDefault();
    if (shellRules.isWebUrl(url)) void shell.openExternal(url);
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
  wc.on('will-attach-webview', (event) => event.preventDefault());

  // keys a browser would have: f11 full screen, f12 / ctrl+shift+i dev tools. everything else belongs to the editor.
  wc.on('before-input-event', (event, input) => {
    const action = shellRules.shellKey(input);
    if (action === null) return;
    event.preventDefault();
    if (action === 'fullscreen') w.setFullScreen(!w.isFullScreen());
    else if (action === 'devtools') wc.toggleDevTools();
  });

  let reloads = 0;
  wc.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit' || w.isDestroyed()) return;
    // the work is autosaved every moment: load the app again once, then ask
    if (reloads++ < 1) {
      void wc.loadURL(home);
      return;
    }
    const pick = dialog.showMessageBoxSync(w, {
      type: 'error',
      title: 'ncut',
      message: 'the editor stopped working',
      detail: `reason: ${details.reason}. your projects are saved on this machine.`,
      buttons: ['reload', 'quit'],
      defaultId: 0,
      cancelId: 1,
    });
    if (pick === 0) void wc.loadURL(home);
    else w.destroy();
  });

  // closing: let the page write its last autosave first (it has no beforeunload promise to wait on)
  const ask = (code) => {
    if (wc.isDestroyed() || wc.isCrashed()) return Promise.resolve(null);
    const wait = new Promise((resolve) => setTimeout(() => resolve(null), CLOSE_WAIT_MS));
    return Promise.race([wc.executeJavaScript(code, false).catch(() => null), wait]);
  };
  let closing = false;
  w.on('close', (event) => {
    // destroy() below does not come back here: this only sees the user (or the system) closing the window
    event.preventDefault();
    if (closing) return;
    closing = true;
    writeState();
    void (async () => {
      const busy = await ask('typeof window.__ncutBusy === "function" ? window.__ncutBusy() : null');
      if (typeof busy === 'string' && busy !== '' && !w.isDestroyed()) {
        const pick = dialog.showMessageBoxSync(w, {
          type: 'warning',
          title: 'ncut',
          message: String(busy).slice(0, 200),
          detail: 'closing now stops it. your project itself is saved.',
          buttons: ['keep working', 'close anyway'],
          defaultId: 0,
          cancelId: 0,
        });
        if (pick === 0) {
          closing = false;
          return;
        }
      }
      await ask('typeof window.__ncutBeforeClose === "function" ? Promise.resolve(window.__ncutBeforeClose()).then(() => true) : false');
      if (!w.isDestroyed()) w.destroy();
    })();
  });
  // a page that wants to stay (beforeunload) never blocks a reload after a crash: closing is handled above
  wc.on('will-prevent-unload', (event) => event.preventDefault());
  w.on('closed', () => {
    if (win === w) win = null;
  });

  void wc.loadURL(home);
}

// ---------- app ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  });

  app.on('web-contents-created', (_event, contents) => {
    // the only web contents this app ever wants is the one window above
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  void app.whenReady().then(() => {
    Menu.setApplicationMenu(null);

    const ses = session.defaultSession;
    ses.protocol.handle(shellRules.SCHEME, serve);
    // the page may only ask for what the editor uses, and only from its own origin
    ses.setPermissionRequestHandler((contents, permission, callback, details) => {
      const from = (details && details.requestingUrl) || (contents ? contents.getURL() : '');
      callback(shellRules.permissionAllowed(permission, from, devUrl));
    });
    ses.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
      const from = requestingOrigin || (contents ? contents.getURL() : '');
      return shellRules.permissionAllowed(permission, from, devUrl);
    });
    ses.on('will-download', onDownload);

    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}
