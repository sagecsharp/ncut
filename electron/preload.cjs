'use strict';
/**
 * the whole bridge between the page and the shell: one frozen object, window.ncutShell, a few small functions.
 * the page can send numbers and booleans, never a path, a url, a command or html. main checks everything again.
 * the one exception is the mcp reply: the text of a tool answer (main parses and re-checks it, see mcpRules.cleanReply).
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

const MCP_KINDS = new Set(['claude', 'http', 'stdio']);

function mcpState(v) {
  if (!v || typeof v !== 'object') return undefined;
  return {
    enabled: v.enabled === true,
    running: v.running === true,
    port: Number.isInteger(v.port) ? v.port : 0,
    error: typeof v.error === 'string' ? v.error : null,
    bridge: v.bridge === true,
  };
}

/** a tool request of an mcp client: numbers, words, plain args and the bytes of the files main read */
function mcpCall(c) {
  if (!c || typeof c !== 'object' || typeof c.id !== 'number' || (c.kind !== 'list' && c.kind !== 'call')) return undefined;
  const files = [];
  if (Array.isArray(c.files)) {
    for (const f of c.files) {
      const bytes = f && typeof f.name === 'string' ? bytesOf(f.bytes) : undefined;
      if (bytes) files.push({ name: f.name, bytes });
    }
  }
  return {
    id: c.id,
    kind: c.kind,
    name: typeof c.name === 'string' ? c.name : '',
    args: c.args && typeof c.args === 'object' && !Array.isArray(c.args) ? c.args : {},
    files,
    ticket: typeof c.ticket === 'number' ? c.ticket : null,
  };
}

const mcp = {
  state() {
    return ipcRenderer.invoke('ncut:mcp-state').then(mcpState, () => undefined);
  },
  setEnabled(on) {
    return ipcRenderer.invoke('ncut:mcp-enable', on === true).then(mcpState, () => undefined);
  },
  rotate() {
    return ipcRenderer.invoke('ncut:mcp-rotate').then(mcpState, () => undefined);
  },
  copy(kind) {
    if (typeof kind !== 'string' || !MCP_KINDS.has(kind)) return Promise.resolve(false);
    return ipcRenderer.invoke('ncut:mcp-copy', kind).then((ok) => ok === true, () => false);
  },
  save(ticket) {
    if (typeof ticket !== 'number' || !Number.isSafeInteger(ticket)) return Promise.resolve({ ok: false, name: null });
    return ipcRenderer.invoke('ncut:mcp-save', ticket).then(
      (r) => (r && r.ok === true ? { ok: true, name: typeof r.name === 'string' ? r.name : null } : { ok: false, name: null }),
      () => ({ ok: false, name: null }),
    );
  },
  reply(id, json) {
    if (typeof id !== 'number' || typeof json !== 'string') return;
    ipcRenderer.send('ncut:mcp-reply', id, json);
  },
  onState(cb) {
    return listen('ncut:mcp-changed', mcpState, cb);
  },
  onCall(cb) {
    return listen('ncut:mcp-call', mcpCall, cb);
  },
};

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
  ready(dark) {
    ipcRenderer.send('ncut:ready', typeof dark === 'boolean' ? dark : null);
  },
  mcp: Object.freeze(mcp),
};

contextBridge.exposeInMainWorld('ncutShell', Object.freeze(api));
