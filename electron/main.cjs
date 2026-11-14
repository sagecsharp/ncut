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
const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeTheme, powerSaveBlocker, protocol, screen, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const shellRules = require('./rules.cjs');
const { createMcp } = require('./mcp.cjs');
const mcpRules = require('./mcpRules.cjs');
const { createUpdater } = require('./update.cjs');
const updateRules = require('./updateRules.cjs');

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

app.setAppUserModelId(shellRules.APP_ID);

/** @type {BrowserWindow | null} */
let win = null;

// ---------- the bridge ----------

/**
 * per window: the file its last download was saved to, the power blocker, whether the page can take a file,
 * a project file waiting for it, and whether the window was shown yet. keyed by webContents id, dropped with the window.
 * @type {Map<number, { lastSave: string | null, blocker: number | null, ready: boolean, shown: boolean, pending: { name: string, bytes: Buffer } | null }>}
 */
const bridge = new Map();

function bridgeState(id) {
  let st = bridge.get(id);
  if (!st) {
    st = { lastSave: null, blocker: null, ready: false, shown: false, pending: null };
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
  syncExportSpeed();
}

// ---------- full speed for an export in the background ----------

/**
 * windows slows the processes of a minimized or covered window down (power throttling), and an export is what runs
 * while the user looks at something else: measured 10 to 20 % slower. while any window is exporting (it holds the
 * power blocker) the processes of this app are marked as doing work the user waits for, afterwards windows decides
 * again. done by a tiny helper (electron/qos.cs) that gets nothing but the app's own process ids.
 */
const QOS_HELPER = app.isPackaged ? path.join(process.resourcesPath, 'ncut-qos.exe') : path.join(__dirname, '..', 'build', 'bin', 'ncut-qos.exe');
let exportSpeedHigh = false;
// the helper calls run strictly one after another: two at once may finish in the wrong order and leave the
// processes marked the wrong way. only the newest wanted state is kept while one runs.
let qosRunning = false;
let qosPending = null;
let qosApplied = false;

function runQosQueue() {
  if (qosRunning || qosPending === null) return;
  const wanted = qosPending;
  qosPending = null;
  // asked for and taken back before the helper ran: nothing to do
  if (wanted === qosApplied) return;
  qosApplied = wanted;
  try {
    if (!fs.existsSync(QOS_HELPER)) return;
    const args = shellRules.qosArgs(wanted, app.getAppMetrics().map((m) => m.pid));
    if (!args) return;
    qosRunning = true;
    execFile(QOS_HELPER, args, { windowsHide: true, timeout: 5000 }, () => {
      /* best effort: without it the export is only slower in the background */
      qosRunning = false;
      runQosQueue();
    });
  } catch {
    /* best effort */
    qosRunning = false;
    runQosQueue();
  }
}

function syncExportSpeed() {
  if (process.platform !== 'win32') return;
  let wanted = false;
  for (const st of bridge.values()) if (st.blocker !== null) wanted = true;
  if (wanted === exportSpeedHigh) return;
  exportSpeedHigh = wanted;
  qosPending = wanted;
  runQosQueue();
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

/**
 * show the window, once. the page says ready() after its first screen was painted (preload: ncut:ready), so the
 * window never shows the empty page. a timer in createWindow shows it anyway when that never comes.
 */
function revealWindow(w) {
  if (w.isDestroyed()) return;
  const st = bridgeState(w.webContents.id);
  if (st.shown) return;
  st.shown = true;
  if (!w.isVisible()) w.show();
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
      syncExportSpeed();
    } else {
      releaseBlocker(st);
    }
  });
  onMessage('ncut:attention', (w) => {
    if (!w.isFocused()) w.flashFrame(true);
  });
  onMessage('ncut:ready', (w, dark) => {
    // the page's theme comes along: the window gets that color now and the next start opens with it
    if (typeof dark === 'boolean') {
      savedDark = dark;
      try {
        w.setBackgroundColor(shellRules.windowBackground(dark, dark));
      } catch {
        /* the window is closing */
      }
    }
    bridgeState(w.webContents.id).ready = true;
    revealWindow(w);
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

// ---------- the mcp server (docs/MCP.md) ----------

/** @type {ReturnType<typeof createMcp> | null} */
let mcp = null;
const MCP_OFF = { enabled: false, running: false, port: 0, error: null, bridge: false };

/** the main window when its page can take a call, else null */
function readyWindow() {
  if (!win || win.isDestroyed()) return null;
  return bridgeState(win.webContents.id).ready ? win : null;
}

function readBridgeSource() {
  try {
    return fs.readFileSync(path.join(__dirname, 'mcpBridge.cjs'), 'utf8');
  } catch {
    return '';
  }
}

function setupMcp() {
  mcp = createMcp({
    userDataDir: app.getPath('userData'),
    appVersion: app.getVersion(),
    bridgeSource: readBridgeSource(),
    sendCall(call) {
      const w = readyWindow();
      if (!w) return false;
      w.webContents.send('ncut:mcp-call', call);
      return true;
    },
    writeClipboard: (text) => clipboard.writeText(text),
    saveFolder: () => existingDir(saveDir) ?? app.getPath('downloads'),
    // "show in folder" works for a file a tool saved, the page is not told (the tool answer carries the path)
    onSaved(file) {
      if (win && !win.isDestroyed()) bridgeState(win.webContents.id).lastSave = file;
    },
    log: (message) => console.error(message),
  });
  onRequest('ncut:mcp-state', MCP_OFF, () => mcp.state());
  onRequest('ncut:mcp-enable', MCP_OFF, (_w, on) => mcp.setEnabled(on === true));
  onRequest('ncut:mcp-rotate', MCP_OFF, () => mcp.rotate());
  // the token only goes to the clipboard while the window is the one in use, not from a page nobody looks at
  onRequest('ncut:mcp-copy', false, (w, kind) => (mcpRules.copyAllowed(kind, w.isFocused()) ? mcp.copy(kind) : false));
  onRequest('ncut:mcp-save', { ok: false, name: null }, (_w, ticket) =>
    Number.isSafeInteger(ticket) ? mcp.armSave(ticket) : { ok: false, name: null },
  );
  onMessage('ncut:mcp-reply', (w, id, json) => {
    if (w === win && typeof id === 'number' && typeof json === 'string') mcp.reply(id, json);
  });
  mcp.onChange((state) => {
    const w = readyWindow();
    if (w) w.webContents.send('ncut:mcp-changed', state);
  });
  void mcp.init();
}

// ---------- the auto updater (docs/UPDATE.md) ----------

/** @type {ReturnType<typeof createUpdater> | null} */
let updater = null;
/** the user pressed "restart now": the update is applied and the new version started when the app really ends */
let restartWanted = false;

function updateOff() {
  return updateRules.cleanUpdateState({ kind: 'none', auto: true, phase: 'idle', current: app.getVersion() });
}

function setupUpdate() {
  const facts = updateRules.decideKind({
    platform: process.platform,
    packaged: app.isPackaged,
    portableFile: process.env.PORTABLE_EXECUTABLE_FILE,
    execPath: process.execPath,
    isFile: fileExists,
  });
  updater = createUpdater({
    userDataDir: app.getPath('userData'),
    appVersion: app.getVersion(),
    kind: facts.kind,
    portableFile: facts.portableFile,
    execPath: process.execPath,
    restartArgs: updateRules.carriedArgs(process.argv),
    // the helper that swaps the portable exe once ncut has closed (electron/swap.cs, next to ncut-qos.exe)
    swapHelper: app.isPackaged ? path.join(process.resourcesPath, updateRules.SWAP_HELPER) : null,
    log: (message) => console.error(message),
  });
  onRequest('ncut:update-state', updateOff(), () => updater.state());
  onRequest('ncut:update-auto', updateOff(), (_w, on) => updater.setAuto(on === true));
  onRequest('ncut:update-check', updateOff(), () => updater.check());
  onRequest('ncut:update-restart', false, (w) => {
    if (!updater.canRestart()) return false;
    // the window closes the normal way (autosave, the question about a running export), the update is applied when
    // the app really ends: see the will-quit handler
    restartWanted = true;
    w.close();
    return true;
  });
  // the address is fixed here, the page never sends one
  onRequest('ncut:update-open', false, async () => {
    await shell.openExternal(updateRules.RELEASES_URL);
    return true;
  });
  updater.onChange((state) => {
    const w = readyWindow();
    if (w) w.webContents.send('ncut:update-changed', state);
  });
  void updater.init();
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
    if (rel.endsWith('.html')) headers['content-security-policy'] = shellRules.CSP;
    const cache = shellRules.cacheControlFor(rel);
    if (cache !== null) headers['cache-control'] = cache;
    return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
  } catch {
    return notFound();
  }
}

// ---------- window state ----------

/** the folder the last file was saved to: the next save dialog opens there */
let saveDir = null;
/** the theme the page had the last time it said so (true dark, false light, null = never): the window's first color */
let savedDark = null;

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
    if (raw && typeof raw.saveDir === 'string' && path.isAbsolute(raw.saveDir)) saveDir = raw.saveDir;
    if (raw && typeof raw.dark === 'boolean') savedDark = raw.dark;
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
    if (!lastBounds && !saveDir && savedDark === null) return;
    fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true });
    fs.writeFileSync(STATE_FILE(), JSON.stringify({ ...(lastBounds ?? {}), saveDir: saveDir ?? undefined, dark: savedDark ?? undefined }));
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
  // a file an mcp tool made: saved without a dialog when its ticket was armed, cancelled when not
  if (mcp && mcp.claimDownload(item)) return;
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
    backgroundColor: shellRules.windowBackground(savedDark, nativeTheme.shouldUseDarkColors),
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
  // pinned to the taskbar, the pin has to start the file the user started (see rules.taskbarDetails)
  if (process.platform === 'win32' && app.isPackaged) {
    const details = shellRules.taskbarDetails(process.env, process.execPath, (p) => fs.statSync(p).isFile());
    if (details) {
      try {
        w.setAppDetails(details);
      } catch {
        /* the window still works, only the pin is the default one */
      }
    }
  }
  if (saved && saved.maximized) w.maximize();
  // not at ready-to-show: that is the first paint of the empty page. the page tells us (ncut:ready, see revealWindow)
  // once its first screen is in the page. a page that never gets there must not leave an invisible window behind
  setTimeout(() => revealWindow(w), shellRules.SHOW_FALLBACK_MS);

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
      // the calls the old page held are never answered
      if (mcp) mcp.failPending();
      if (!w.isDestroyed()) w.setProgressBar(-1);
    }
  });
  wc.on('render-process-gone', () => {
    releaseBlocker(st);
    st.ready = false;
    if (mcp) mcp.failPending();
  });
  w.on('closed', () => {
    if (mcp) mcp.failPending();
  });
  const home = devUrl ?? shellRules.HOME;
  // the page failed to load at all: show the window (it is blank, but it must not be invisible)
  wc.on('did-fail-load', (_event, _code, _desc, _url, isMainFrame) => {
    if (isMainFrame) revealWindow(w);
  });

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
          // the user stays: no restart is wanted any more
          restartWanted = false;
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
    setupMcp();
    const first = createWindow();
    setupUpdate();
    const startFile = shellRules.projectFileFromArgs(process.argv, app.isPackaged);
    if (startFile) void openProjectFile(first, startFile);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    if (mcp) void mcp.dispose();
    // the updater is not stopped here: a quit can still be called off after this (the window asks "an export is
    // running, close anyway?" and the user keeps working), and a stopped updater would stay dead. see will-quit
  });
  // the order at quit: the window closes ('close' -> destroy -> 'closed') -> window-all-closed -> app.quit() ->
  // before-quit -> will-quit -> quit. will-quit comes once, when every window is gone and nothing can keep the app
  // from ending: that is where an update is applied and where the updater stops (timers, a running download), so
  // both run exactly once and only when the app really ends.
  // the single instance lock goes first, so the new version does not find this one still holding it and quit.
  app.on('will-quit', () => {
    if (!updater) return;
    try {
      const restart = restartWanted;
      if (!updater.wantsApply(restart)) return;
      try {
        app.releaseSingleInstanceLock();
      } catch {
        /* the lock goes with the process anyway */
      }
      const result = updater.applyAtQuit({ restart });
      if (!result.applied || (restart && !result.started)) {
        if (!result.applied) console.error(`update: not applied (${result.why})`);
        else console.error(`update: applied, but ${result.why}`);
        // "restart now" that did not end in a running ncut: it still comes back (electron starts it when this
        // process ends): the file as it was, or the new one that is in place but did not start
        if (restart && typeof result.relaunch === 'string' && result.relaunch !== '') {
          try {
            app.relaunch({ execPath: result.relaunch, args: updateRules.carriedArgs(process.argv) });
          } catch {
            /* the user starts ncut again */
          }
        }
      }
    } finally {
      updater.dispose();
    }
  });
  app.on('window-all-closed', () => app.quit());
}
