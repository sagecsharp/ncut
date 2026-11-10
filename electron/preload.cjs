'use strict';
/**
 * the whole bridge between the page and the shell: one frozen object, window.ncutShell, a few small functions.
 * the page can send numbers and booleans, never a path, a url, a command or html. main checks everything again.
 * sandboxed preload: only electron's contextBridge and ipcRenderer exist here.
 */
const { contextBridge, ipcRenderer } = require('electron');

function version() {
  try {
    const v = ipcRenderer.sendSync('ncut:version');
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

/** subscribe to a main -> page channel; `pick` turns the raw args into the callback value or undefined to drop */
function listen(channel, pick, cb) {
  if (typeof cb !== 'function') return () => {};
  const handler = (_event, ...args) => {
    let value;
    try {
      value = pick(...args);
    } catch {
      return;
    }
    if (value === undefined) return;
    try {
      cb(value);
    } catch {
      /* the page's callback failing is the page's business */
    }
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

function bytesOf(raw) {
  let view = null;
  if (raw instanceof Uint8Array) view = raw;
  else if (raw instanceof ArrayBuffer) view = new Uint8Array(raw);
  if (!view) return undefined;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

const api = {
  version: version(),
  setProgress(fraction) {
    ipcRenderer.send('ncut:progress', typeof fraction === 'number' ? fraction : null);
  },
  keepAwake(on) {
    ipcRenderer.send('ncut:keep-awake', on === true);
  },
  attention() {
    ipcRenderer.send('ncut:attention');
  },
  revealLastSave() {
    return ipcRenderer.invoke('ncut:reveal-last-save').then((ok) => ok === true, () => false);
  },
  lastSaveName() {
    return ipcRenderer.invoke('ncut:last-save-name').then((n) => (typeof n === 'string' ? n : null), () => null);
  },
  onSaved(cb) {
    return listen('ncut:saved', (name) => (typeof name === 'string' ? name : undefined), cb);
  },
  onOpenFile(cb) {
    return listen(
      'ncut:open-file',
      (file) => {
        if (!file || typeof file.name !== 'string') return undefined;
        const bytes = bytesOf(file.bytes);
        return bytes ? { name: file.name, bytes } : undefined;
      },
      cb,
    );
  },
  ready() {
    ipcRenderer.send('ncut:ready');
  },
};

contextBridge.exposeInMainWorld('ncutShell', Object.freeze(api));
