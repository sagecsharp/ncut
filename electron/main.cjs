'use strict';
/**
 * desktop shell: one window that shows the built web app (dist/) from its own app:// origin.
 * the page gets no node access and no network: it is the same app that runs in a browser tab.
 * its only way to the shell is preload.cjs: one frozen window.ncutShell with a few dumb functions (taskbar progress,
 * keep awake, flash, show the last saved file, tell when a download is saved, receive a .ncut file that was opened
 * with the app). every ipc handler below re-validates its input and only listens to the top frame of the app origin.
 * the page never sends a path, url, command or html. the csp, permissions and navigation guards are unchanged.
 * commonjs on purpose (package.json is "type": "module" for vite, electron's main entry stays simple).
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, powerSaveBlocker, protocol, screen, session, shell } = require('electron');
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

// ---------- the bridge ----------

/**
 * per window: the file its last download was saved to, the power blocker, whether the page can take a file,
 * and a project file waiting for it. keyed by webContents id, dropped with the window.
 * @type {Map<number, { lastSave: string | null, blocker: number | null, ready: boolean, pending: { name: string, bytes: Buffer } | null }>}
 */
const bridge = new Map();

function bridgeState(id) {
  let st = bridge.get(id);
  if (!st) {
    st = { lastSave: null, blocker: null, ready: false, pending: null };
    bridge.set(id, st);
  }
  return st;
}

function releaseBlocker(st) {
  if (st.blocker === null) return;
  try {
    if (powerSaveBlocker.isStarted(st.blocker)) powerSaveBlocker.stop(st.blocker);
  } catch {
    /* already gone */
  }
  st.blocker = null;
}

/** the window an ipc message came from, or null when it is not the top frame of the app itself */
function trustedWindow(event) {
  try {
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame) return null;
    if (!shellRules.isTrustedSender(frame.url, true, devUrl)) return null;
    const w = BrowserWindow.fromWebContents(event.sender);
    return w && !w.isDestroyed() ? w : null;
  } catch {
    return null;
  }
}

/** a handler that never throws and ignores strangers */
function onMessage(channel, fn) {
  ipcMain.on(channel, (event, ...args) => {
    try {
      const w = trustedWindow(event);
      if (w) fn(w, ...args);
    } catch {
      /* a bad message is dropped */
    }
  });
}

function onRequest(channel, fallback, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const w = trustedWindow(event);
      return w ? await fn(w, ...args) : fallback;
    } catch {
      return fallback;
    }
  });
}

function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function setupBridge() {
  ipcMain.on('ncut:version', (event) => {
    event.returnValue = trustedWindow(event) ? app.getVersion() : '';
  });
  onMessage('ncut:progress', (w, value) => {
    w.setProgressBar(shellRules.clampProgress(value));
  });
  onMessage('ncut:keep-awake', (w, on) => {
    const st = bridgeState(w.webContents.id);
    if (on === true) {
      if (st.blocker === null) st.blocker = powerSaveBlocker.start('prevent-app-suspension');
    } else {
      releaseBlocker(st);
    }
  });
  onMessage('ncut:attention', (w) => {
    if (!w.isFocused()) w.flashFrame(true);
  });
  onMessage('ncut:ready', (w) => {
    bridgeState(w.webContents.id).ready = true;
    flushPending(w);
  });
  onRequest('ncut:reveal-last-save', false, (w) => {
    const file = bridgeState(w.webContents.id).lastSave;
    if (!file || !fileExists(file)) return false;
    shell.showItemInFolder(file);
    return true;
  });
  onRequest('ncut:last-save-name', null, (w) => {
    const file = bridgeState(w.webContents.id).lastSave;
    return file && fileExists(file) ? shellRules.baseName(file) : null;
  });
}

/** the project file the app was started with, or a second start handed over: read it (size cap, regular file only) */
async function readProjectFile(file) {
  try {
    const full = path.resolve(file);
    if (!shellRules.isProjectFile(full)) return null;
    const stat = await fs.promises.stat(full);
    if (!stat.isFile() || stat.size <= 0) return null;
    if (stat.size > shellRules.MAX_OPEN_BYTES) {
      void dialog.showMessageBox({ type: 'warning', title: 'ncut', message: 'this project file is too big to open', buttons: ['ok'] });
      return null;
    }
    const bytes = await fs.promises.readFile(full);
    return { name: path.basename(full), bytes };
  } catch {
    return null;
  }
}

function flushPending(w) {
  if (w.isDestroyed()) return;
  const st = bridgeState(w.webContents.id);
  if (!st.ready || !st.pending) return;
  const file = st.pending;
  st.pending = null;
  w.webContents.send('ncut:open-file', file);
}

async function openProjectFile(w, file) {
  const got = await readProjectFile(file);
  if (!got || w.isDestroyed()) return;
  bridgeState(w.webContents.id).pending = got;
  flushPending(w);
}

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
function onDownload(event, item, contents) {
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
    // tell the window the download came from (the page only ever learns the file name)
    try {
      if (contents && !contents.isDestroyed()) {
        bridgeState(contents.id).lastSave = saved;
        contents.send('ncut:saved', shellRules.baseName(saved));
      }
    } catch {
      /* the window closed while saving */
    }
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
      preload: path.join(__dirname, 'preload.cjs'),
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
  const wcId = wc.id;
  const st = bridgeState(wcId);
  // flashing stops when the window is looked at
  w.on('focus', () => w.flashFrame(false));
  // a reload or a crash leaves no power blocker behind and the new page has to say ready() again
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      releaseBlocker(st);
      st.ready = false;
      if (!w.isDestroyed()) w.setProgressBar(-1);
    }
  });
  wc.on('render-process-gone', () => {
    releaseBlocker(st);
    st.ready = false;
  });
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
    releaseBlocker(st);
    bridge.delete(wcId);
    if (win === w) win = null;
  });

  void wc.loadURL(home);
  return w;
}

// ---------- app ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    if (!win || win.isDestroyed()) return;
    const file = shellRules.projectFileFromArgs(argv, app.isPackaged);
    if (file) void openProjectFile(win, path.resolve(typeof workingDirectory === 'string' ? workingDirectory : '.', file));
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

    setupBridge();
    const first = createWindow();
    const startFile = shellRules.projectFileFromArgs(process.argv, app.isPackaged);
    if (startFile) void openProjectFile(first, startFile);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}
