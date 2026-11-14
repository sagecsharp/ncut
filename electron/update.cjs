'use strict';
/**
 * the auto updater of the desktop app (docs/UPDATE.md): asks github for the latest release, downloads the file that
 * fits how ncut is installed, checks it against the sha256 github's api gives, and applies it when ncut closes.
 * main owns the window, the ipc and the quit, this owns the rest. everything electron-ish is handed in (createUpdater
 * options) so this runs under plain node in the tests. the decisions are in updateRules.cjs.
 * the exe files are not code signed: the only proof a download is the real one is that it came from github over
 * https and that its sha256 is the one github's api names for that asset. nothing here trusts anything else.
 * nothing here may throw into main, and a failed check or download never opens a dialog.
 */
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const rules = require('./updateRules.cjs');

/** a failure with a sentence that may be shown to the user */
class Reason extends Error {}
const reason = (text) => new Reason(text);
/** a download that came out different from what github announced (size or sha256): not fetched again on its own for a day */
class Mismatch extends Reason {}
const mismatch = (text) => new Mismatch(text);
/** what an aborted job rejects with when nobody has to be told (the app closes, the switch went off) */
const CANCELLED = new Error('cancelled');

/** the one https GET: resolves when the headers are in, never follows a redirect, never sends anything but `headers` */
function createRequest(httpsApi = https) {
  return function request({ url, headers, timeoutMs, signal }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        reject(e);
      };
      let req;
      try {
        req = httpsApi.get(url, { headers, agent: false, timeout: timeoutMs, minVersion: 'TLSv1.2' }, (res) => {
          if (settled) {
            res.destroy();
            return;
          }
          settled = true;
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: res,
            destroy() {
              try {
                res.destroy();
                req.destroy();
              } catch {
                /* already gone */
              }
            },
          });
        });
      } catch (e) {
        fail(e);
        return;
      }
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', fail);
      if (signal) {
        const stop = () => req.destroy(new Error('aborted'));
        if (signal.aborted) stop();
        else signal.addEventListener('abort', stop, { once: true });
      }
    });
  };
}

function header(res, name) {
  const h = res.headers;
  if (!h || typeof h !== 'object') return undefined;
  const v = h[name] ?? h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** why a network or file error is shown as: a short sentence that never holds a path */
function sentenceFor(e) {
  if (e instanceof Reason) return e.message;
  const code = e && typeof e.code === 'string' ? e.code : '';
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|EPROTO|HOSTNAME_MISMATCH/.test(code)) return 'the secure connection to github could not be made';
  if (code === 'ENOSPC') return 'there is no room left to save the download';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'the update folder can not be written';
  if (/^E(NOTFOUND|AI_AGAIN|CONNREFUSED|CONNRESET|HOSTUNREACH|NETUNREACH|TIMEDOUT|PIPE)$/.test(code)) return 'github can not be reached';
  return 'the update failed';
}

/** reads the file to the end and hashes it: 'ok', 'slow' (out of time) or 'bad' (not the size or hash asked for; a read error throws) */
function pump(fsApi, inFd, expect, deadline, now) {
  const hash = crypto.createHash('sha256');
  const buf = Buffer.allocUnsafe(1 << 20);
  let total = 0;
  for (;;) {
    if (now() > deadline) return 'slow';
    const n = fsApi.readSync(inFd, buf, 0, buf.length, null);
    if (n <= 0) break;
    total += n;
    // more than announced: stop reading, the file is not the one
    if (total > expect.size) return 'bad';
    hash.update(buf.subarray(0, n));
  }
  if (total !== expect.size || hash.digest('hex') !== expect.sha256) return 'bad';
  return 'ok';
}

/** the sentence for a destination that could not be written */
function writeSentence(code) {
  if (code === 'ENOSPC') return 'there is no room left next to ncut';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'the folder of ncut can not be written';
  return 'the folder of ncut could not be written';
}

function closeQuiet(fsApi, fd) {
  if (fd === null) return;
  try {
    fsApi.closeSync(fd);
  } catch {
    /* nothing to do */
  }
}

/** a plain file of exactly the size and sha256 asked for ('bad' also for a missing file, a link or a folder) */
function verifyFileSync(fsApi, file, expect, deadline, now) {
  let fd = null;
  try {
    const st = fsApi.lstatSync(file);
    if (!st.isFile() || st.size !== expect.size) return 'bad';
    fd = fsApi.openSync(file, 'r');
    return pump(fsApi, fd, expect, deadline, now);
  } catch {
    return 'bad';
  } finally {
    closeQuiet(fsApi, fd);
  }
}

function unlinkQuiet(fsApi, file) {
  try {
    fsApi.unlinkSync(file);
  } catch {
    /* gone, or in use: the next start tries again */
  }
}

function isPlainFile(fsApi, file) {
  try {
    const st = fsApi.lstatSync(file);
    return st.isFile() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.userDataDir where update.json and updates/ live
 * @param {string} opts.appVersion the running version
 * @param {'installed' | 'portable' | 'manual' | 'none'} opts.kind
 * @param {string | null} [opts.portableFile] the portable exe that was started (kind portable)
 * @param {string} [opts.execPath] the running exe (a failed restart starts it again, kind installed)
 * @param {string[]} [opts.restartArgs] what a restarted portable ncut is started with (updateRules.carriedArgs)
 * @param {string | null} [opts.swapHelper] ncut-swap.exe as it sits in the app (kind portable: without it the app is a manual one)
 * @param {Function} [opts.request] one https GET, see createRequest. default: node:https
 * @param {Function} [opts.spawn] default child_process.spawn
 * @param {() => number} [opts.now]
 * @param {{ setTimeout?: Function, clearTimeout?: Function }} [opts.timers]
 * @param {(message: string) => void} [opts.log]
 * @param {number} [opts.applyBudgetMs] for tests (the hash of the setup exe while the app closes)
 * @param {object} [opts.fs] the sync fs functions used when applying, for tests
 */
function createUpdater(opts) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const timers = { setTimeout, clearTimeout, ...(opts.timers ?? {}) };
  const request = typeof opts.request === 'function' ? opts.request : createRequest();
  const spawn = typeof opts.spawn === 'function' ? opts.spawn : childProcess.spawn;
  const fsApi = opts.fs ?? fs;
  const applyBudget = Number.isFinite(opts.applyBudgetMs) ? opts.applyBudgetMs : rules.APPLY_BUDGET_MS;
  const current = String(opts.appVersion);
  const stateFile = path.join(opts.userDataDir, 'update.json');
  const updatesDir = path.join(opts.userDataDir, 'updates');

  let kind = rules.KINDS.includes(opts.kind) ? opts.kind : 'none';
  if (!rules.parseVersion(current)) kind = 'none';
  const portableFile = kind === 'portable' && rules.isPortablePath(opts.portableFile) ? opts.portableFile : null;
  // a portable app that does not know its own file can not swap it: it only says that a version is out
  if (kind === 'portable' && !portableFile) kind = 'manual';
  // windows does not let the running portable exe be renamed or replaced (its starter holds the file), so the swap
  // is done by a helper once ncut has closed. a build without the helper can not update itself
  const swapHelper = typeof opts.swapHelper === 'string' && opts.swapHelper !== '' && isPlainFile(fs, opts.swapHelper) ? opts.swapHelper : null;
  if (kind === 'portable' && !swapHelper) kind = 'manual';
  // the helper takes no path of 260 characters or more: a profile folder so deep that the download would get one can not update
  if (kind === 'portable' && path.join(opts.userDataDir, 'updates', rules.assetName('99999.99999.99999', 'portable')).length > rules.MAX_SWAP_SOURCE_PATH) kind = 'manual';
  const execPath = typeof opts.execPath === 'string' && opts.execPath !== '' ? opts.execPath : null;
  const restartArgs = Array.isArray(opts.restartArgs) ? opts.restartArgs.filter((a) => typeof a === 'string') : [];

  // what update.json holds
  const stored = { auto: true, checkedAt: null, ready: null, swapFails: 0 };
  // what the page sees
  const live = { phase: 'idle', latest: null, progress: 0, error: null };
  /** the stored ready entry, once its file was hashed again and found right */
  let ready = null;
  let job = null;
  let timer = null;
  let disposed = false;
  let applying = false;
  let started = false;
  let lastProgressAt = 0;
  /** when the last check ended (this run only): "check now" is not answered again within MIN_MANUAL_GAP_MS */
  let lastCheckEndAt = null;
  /** the download that failed its checks: { version, sha256, size, at }. the same one is not fetched again on its own for a day */
  let rejected = null;
  const listeners = new Set();

  // ---------- state ----------

  function state() {
    return rules.cleanUpdateState({ kind, auto: stored.auto, ...live, current, checkedAt: stored.checkedAt });
  }

  function emit() {
    const snapshot = state();
    for (const cb of [...listeners]) {
      try {
        cb(snapshot);
      } catch (e) {
        log(`update: a state listener failed (${e && e.message ? e.message : 'error'})`);
      }
    }
  }

  function onChange(cb) {
    if (typeof cb !== 'function') return () => {};
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  function writeAtomic(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file);
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* nothing was written */
      }
      throw e;
    }
  }

  function persist() {
    try {
      writeAtomic(stateFile, JSON.stringify({ auto: stored.auto, checkedAt: stored.checkedAt, ready: stored.ready, swapFails: stored.swapFails }));
    } catch (e) {
      log(`update: could not save update.json (${e && e.code ? e.code : 'error'})`);
    }
  }

  function loadStateFile() {
    try {
      const clean = rules.cleanStateFile(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
      stored.auto = clean.auto;
      stored.checkedAt = clean.checkedAt;
      stored.ready = clean.ready;
      stored.swapFails = clean.swapFails;
    } catch {
      stored.auto = true;
      stored.checkedAt = null;
      stored.ready = null;
      stored.swapFails = 0;
    }
  }

  // ---------- the updates folder ----------

  function isLink(p) {
    try {
      return fs.lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  }

  /** the folder exists and is a real folder of ours (a planted link to somewhere else is removed, never followed) */
  function ensureUpdatesDir() {
    if (isLink(updatesDir)) {
      try {
        fs.unlinkSync(updatesDir);
      } catch {
        try {
          fs.rmdirSync(updatesDir);
        } catch {
          /* checked below */
        }
      }
      if (isLink(updatesDir)) throw reason('the update folder is not usable');
    }
    fs.mkdirSync(updatesDir, { recursive: true });
  }

  function removeEntry(p) {
    try {
      const st = fs.lstatSync(p);
      if (st.isDirectory() && !st.isSymbolicLink()) fs.rmSync(p, { recursive: true, force: true });
      else fs.unlinkSync(p);
    } catch {
      /* in use or gone: the next start tries again */
    }
  }

  /** everything in the updates folder but `keep` goes: old downloads, unfinished .part files */
  function cleanUpdatesDir(keep) {
    if (isLink(updatesDir)) {
      ensureUpdatesDirQuiet();
      return;
    }
    let names;
    try {
      names = fs.readdirSync(updatesDir);
    } catch {
      return;
    }
    const keepName = keep ? path.basename(keep) : null;
    for (const name of names) {
      if (name === keepName) continue;
      removeEntry(path.join(updatesDir, name));
    }
  }

  function ensureUpdatesDirQuiet() {
    try {
      ensureUpdatesDir();
    } catch {
      /* the next download says so */
    }
  }

  // ---------- starting ----------

  function dropStoredReady(deleteFile) {
    const entry = stored.ready;
    stored.ready = null;
    ready = null;
    // only a file that is really in the updates folder is ever deleted
    if (deleteFile && entry && rules.readyFileOk(entry, updatesDir, kind, path)) removeEntry(entry.file);
  }

  /** how the helper of the close before ended (it writes one number): a swap that did not work goes to the log. the number, or null */
  function noteLastSwap() {
    let fd = null;
    try {
      const file = path.join(updatesDir, rules.SWAP_LOG);
      if (isLink(updatesDir) || !isPlainFile(fs, file)) return null;
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(8);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.subarray(0, n).toString('latin1').trim();
      if (!/^\d{1,3}$/.test(text)) return null;
      if (text !== '0') log(`update: the last swap of the exe did not work: ${rules.swapResult(Number(text))}`);
      return Number(text);
    } catch {
      /* no swap happened */
      return null;
    } finally {
      closeQuiet(fs, fd);
    }
  }

  /**
   * a portable swap that did not work again and again (no room next to the exe, no rights, a scanner in the way) must
   * not be handed over at every close for ever while the page says "ready": after SWAP_MAX_FAILS the update stays
   * downloaded but is not applied on its own, the page says so and offers the download page. "check now" tries again,
   * and a newer release replaces the entry (which starts the count over)
   */
  function stuck() {
    return kind === 'portable' && stored.swapFails >= rules.SWAP_MAX_FAILS;
  }

  /** what the page shows while nothing runs: an update that is ready is ready, unless it is stuck */
  function rest() {
    if (!ready) {
      live.phase = 'idle';
    } else if (stuck()) {
      live.phase = 'failed';
      live.error = 'replacing this exe did not work, get the new version from the download page';
    } else {
      live.phase = 'ready';
      live.error = null;
    }
  }

  function hashFileAsync(file) {
    return new Promise((resolve) => {
      const hash = crypto.createHash('sha256');
      let size = 0;
      const stream = fs.createReadStream(file);
      stream.on('data', (chunk) => {
        size += chunk.length;
        hash.update(chunk);
      });
      stream.on('error', () => resolve(null));
      stream.on('end', () => resolve({ size, sha256: hash.digest('hex') }));
    });
  }

  /**
   * start: read update.json, clean up after the last run, believe a ready entry only after its file was hashed again.
   * the synchronous part is small; the hash of a big file runs in the background and says ready when it is done.
   */
  function init() {
    if (started || disposed) return Promise.resolve();
    started = true;
    if (kind === 'none') return Promise.resolve();
    loadStateFile();
    let swapCode = null;
    if (portableFile) {
      // what a swap left next to the exe (the helper deletes its copy itself, this is for one that was cut short).
      // <file>.new may belong to a helper that is still waiting for this file (ncut was started again right after it
      // closed), so only an old one goes
      const fresh = `${portableFile}.new`;
      try {
        const st = fs.lstatSync(fresh);
        if (st.isFile() && !st.isSymbolicLink() && now() - st.mtimeMs > rules.STALE_NEW_MS) unlinkQuiet(fs, fresh);
      } catch {
        /* there is none */
      }
      swapCode = noteLastSwap();
    }
    // the swap of the close before did not work: counted, so a swap that never works is not tried for ever
    if (swapCode === 0) stored.swapFails = 0;
    else if (swapCode !== null && rules.swapFailureCounts(swapCode)) stored.swapFails = Math.min(99, stored.swapFails + 1);
    const entry = stored.ready;
    let believed = null;
    if (entry && kind !== 'manual') {
      if (!rules.isNewer(entry.version, current)) {
        // the update happened (or an older one is left): nothing to apply any more
        dropStoredReady(true);
      } else if (!rules.readyFileOk(entry, updatesDir, kind, path)) {
        dropStoredReady(false);
      } else {
        believed = entry;
      }
    } else if (entry) {
      dropStoredReady(true);
    }
    if (!believed) stored.swapFails = 0;
    cleanUpdatesDir(believed ? believed.file : null);
    persist();
    arm(true);
    emit();
    if (!believed) return Promise.resolve();
    return (async () => {
      const got = await hashFileAsync(believed.file);
      if (disposed || stored.ready !== believed) return;
      if (got && got.size === believed.size && got.sha256 === believed.sha256) {
        ready = believed;
        live.latest = believed.version;
        rest();
      } else {
        dropStoredReady(true);
        log('update: the downloaded update did not match its checksum any more and was removed');
      }
      persist();
      emit();
    })().catch(() => {});
  }

  // ---------- when to ask ----------

  function clearTimer() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  }

  function schedule(ms) {
    clearTimer();
    timer = timers.setTimeout(tick, Math.max(0, ms));
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function canAutoCheck() {
    return !disposed && !applying && stored.auto && (kind === 'installed' || kind === 'portable' || kind === 'manual');
  }

  /** with auto off nothing is ever asked on its own */
  function arm(first) {
    clearTimer();
    if (!canAutoCheck()) return;
    schedule(first ? rules.FIRST_CHECK_DELAY_MS : rules.CHECK_EVERY_MS);
  }

  function gateRemaining() {
    if (stored.checkedAt === null) return 0;
    const left = stored.checkedAt + rules.MIN_CHECK_GAP_MS - now();
    // a clock that went back must not hold the checks for good
    return left > rules.MIN_CHECK_GAP_MS ? 0 : Math.max(0, left);
  }

  function tick() {
    timer = null;
    if (!canAutoCheck()) return;
    const wait = gateRemaining();
    if (wait > 0) {
      schedule(wait);
      return;
    }
    // an update that is ready needs no new question (one that is stuck does: a newer release may be the fix), a running job is not started twice
    if ((ready && !stuck()) || job) {
      schedule(rules.CHECK_EVERY_MS);
      return;
    }
    void runCheck(false).then(() => {
      if (canAutoCheck() && timer === null) schedule(live.phase === 'failed' ? rules.MIN_CHECK_GAP_MS : rules.CHECK_EVERY_MS);
    });
  }

  // ---------- a job: one check or download at a time ----------

  function newJob(manual) {
    let rejectGone = () => {};
    const gone = new Promise((_, reject) => {
      rejectGone = reject;
    });
    gone.catch(() => {});
    const ac = new AbortController();
    const j = {
      manual,
      ac,
      res: null,
      aborted: false,
      timer: null,
      race: (p) => Promise.race([p, gone]),
      disarm() {
        if (j.timer !== null) timers.clearTimeout(j.timer);
        j.timer = null;
      },
      arm(ms, text) {
        j.disarm();
        j.timer = timers.setTimeout(() => j.abort(reason(text)), ms);
        if (j.timer && typeof j.timer.unref === 'function') j.timer.unref();
      },
      abort(cause) {
        if (j.aborted) return;
        j.aborted = true;
        j.disarm();
        try {
          ac.abort();
        } catch {
          /* nothing to stop */
        }
        try {
          if (j.res && typeof j.res.destroy === 'function') j.res.destroy();
        } catch {
          /* already gone */
        }
        rejectGone(cause ?? CANCELLED);
      },
    };
    return j;
  }

  const HEADERS = () => ({ Accept: 'application/vnd.github+json', 'User-Agent': `ncut-updater/${current}` });

  /** one GET of an address that passed the url rules for `role`. the answer is not followed anywhere. */
  async function get(j, role, url, headers, timeoutMs) {
    const checked = rules.checkUrl(url, role);
    if (!checked) throw reason('the address is not one this app may ask');
    const pending = new Promise((resolve) => resolve(request({ url: checked, headers, timeoutMs, signal: j.ac.signal })));
    pending.then(
      (res) => {
        // an answer that comes after the job ended is thrown away
        if (j.aborted && res && typeof res.destroy === 'function') {
          try {
            res.destroy();
          } catch {
            /* already gone */
          }
        }
      },
      () => {},
    );
    const res = await j.race(pending);
    if (!res || typeof res !== 'object' || !Number.isInteger(res.status)) throw reason('the answer of github was not understood');
    // the answer before this one is done with
    try {
      if (j.res && typeof j.res.destroy === 'function') j.res.destroy();
    } catch {
      /* already gone */
    }
    j.res = res;
    return res;
  }

  /** the chunks of an answer body, one by one (a stalled body ends with the job, not with the body) */
  async function eachChunk(j, res, fn) {
    const body = res.body;
    if (!body || typeof body[Symbol.asyncIterator] !== 'function') throw reason('github answered without content');
    const it = body[Symbol.asyncIterator]();
    for (;;) {
      const r = await j.race(it.next());
      if (r.done) return;
      await fn(Buffer.isBuffer(r.value) ? r.value : Buffer.from(r.value));
    }
  }

  async function fetchRelease(j) {
    j.arm(rules.API_TIMEOUT_MS, 'github did not answer in time');
    const res = await get(j, 'api', rules.API_URL, HEADERS(), rules.API_TIMEOUT_MS);
    if (res.status === 403 || res.status === 429) throw reason('github is limiting requests, try again later');
    if (res.status !== 200) throw reason(`github answered with status ${res.status}`);
    if (!/json/i.test(String(header(res, 'content-type') ?? ''))) throw reason('the answer of github is not json');
    const declared = Number(header(res, 'content-length'));
    if (Number.isFinite(declared) && declared > rules.MAX_API_BYTES) throw reason('the answer of github is too big');
    const parts = [];
    let total = 0;
    await eachChunk(j, res, (chunk) => {
      total += chunk.length;
      if (total > rules.MAX_API_BYTES) throw reason('the answer of github is too big');
      parts.push(chunk);
    });
    j.disarm();
    try {
      return JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch {
      throw reason('the answer of github is not json');
    }
  }

  async function download(j, found) {
    const { version, asset } = found;
    const name = rules.assetName(version, kind);
    // the release reader built this already: the name is rebuilt here so a file never gets a name from the network
    if (!name || asset.name !== name) throw reason('the release has no file for this app');
    live.phase = 'downloading';
    live.progress = 0;
    live.latest = version;
    live.error = null;
    lastProgressAt = 0;
    emit();
    ensureUpdatesDir();
    const part = path.join(updatesDir, `${name}.part`);
    const final = path.join(updatesDir, name);
    removeEntry(part);
    let fh = null;
    try {
      let url = asset.url;
      let redirects = 0;
      let res;
      for (;;) {
        j.arm(rules.IDLE_TIMEOUT_MS, 'the download stalled');
        res = await get(j, redirects === 0 ? 'download' : 'redirect', url, { 'User-Agent': `ncut-updater/${current}`, Accept: 'application/octet-stream' }, rules.IDLE_TIMEOUT_MS);
        if (![301, 302, 303, 307, 308].includes(res.status)) break;
        const location = header(res, 'location');
        try {
          res.destroy();
        } catch {
          /* already gone */
        }
        if (redirects >= rules.MAX_REDIRECTS) throw reason('the download was sent around too often');
        const next = rules.redirectTarget(url, location);
        if (!next) throw reason('the download was sent somewhere that is not usable');
        url = next;
        redirects++;
      }
      if (res.status !== 200) throw reason(`the download answered with status ${res.status}`);
      const declared = header(res, 'content-length');
      if (declared !== undefined && Number(declared) !== asset.size) throw mismatch('the download is not the size github announced');
      fh = await fs.promises.open(part, 'wx');
      const hash = crypto.createHash('sha256');
      let received = 0;
      await eachChunk(j, res, async (chunk) => {
        received += chunk.length;
        if (received > asset.size) throw mismatch('the download is bigger than announced');
        j.arm(rules.IDLE_TIMEOUT_MS, 'the download stalled');
        hash.update(chunk);
        let off = 0;
        while (off < chunk.length) {
          const { bytesWritten } = await j.race(fh.write(chunk, off, chunk.length - off));
          off += bytesWritten;
        }
        live.progress = received / asset.size;
        const t = now();
        if (t - lastProgressAt >= rules.PROGRESS_EVERY_MS) {
          lastProgressAt = t;
          emit();
        }
      });
      j.disarm();
      await fh.close();
      fh = null;
      if (received !== asset.size) throw mismatch('the download is shorter than announced');
      if (hash.digest('hex') !== asset.sha256) throw mismatch('the download does not match the checksum of github');
      removeEntry(final);
      await fs.promises.rename(part, final);
      const older = stored.ready;
      stored.ready = { version, file: final, sha256: asset.sha256, size: asset.size };
      stored.swapFails = 0;
      ready = stored.ready;
      if (older && older.file !== final && rules.readyFileOk(older, updatesDir, kind, path)) removeEntry(older.file);
      persist();
      rest();
      live.progress = 0;
    } catch (e) {
      if (fh) {
        try {
          await fh.close();
        } catch {
          /* the file goes anyway */
        }
      }
      removeEntry(part);
      throw e;
    }
  }

  function failWith(e, j) {
    if (e === CANCELLED || (j.aborted && !(e instanceof Reason))) {
      // the app closes or the switch went off: nobody is told about a stop they asked for
      rest();
      live.progress = 0;
      return;
    }
    live.progress = 0;
    if (ready) {
      // a check or a newer download that failed while an update is ready: the ready one is still good and is what the
      // page shows. the reason goes to the log
      rest();
      log(`update: ${sentenceFor(e)}`);
      return;
    }
    live.phase = 'failed';
    live.error = sentenceFor(e);
    if (!(e instanceof Reason)) log(`update: ${e && e.code ? e.code : e && e.message ? e.message : 'error'}`);
  }

  /** a check, and the download when it finds a newer version. resolves when it is over, never throws */
  async function runCheck(manual) {
    // "check now" is also the retry of a swap that did not work: the next close hands the update over again
    if (manual && stored.swapFails > 0) {
      stored.swapFails = 0;
      persist();
    }
    const j = newJob(manual);
    job = j;
    live.phase = 'checking';
    live.progress = 0;
    live.error = null;
    emit();
    let stamped = false;
    // the asset being downloaded: a download that fails its checks is remembered by it
    let fetching = null;
    let cancelled = false;
    try {
      const json = await fetchRelease(j);
      stored.checkedAt = now();
      stamped = true;
      persist();
      const found = rules.readRelease(json, current, kind);
      if (!found.ok) throw reason(found.reason);
      // an update that is ready and is not older than what github has stays the newest known
      const covered = ready !== null && !rules.isNewer(found.version, ready.version);
      live.latest = covered ? ready.version : found.version;
      if (!found.newer || covered || kind === 'manual' || !(stored.auto || manual) || j.aborted) {
        rest();
      } else {
        const t = now();
        if (
          !manual &&
          rejected &&
          rejected.version === found.version &&
          rejected.sha256 === found.asset.sha256 &&
          rejected.size === found.asset.size &&
          t >= rejected.at &&
          t - rejected.at < rules.REJECT_BACKOFF_MS
        ) {
          // the same bytes failed the checks not long ago: asking github again is cheap, fetching the file again is not
          throw reason('the last download of this version did not match its checksum, not trying it again yet');
        }
        fetching = found;
        await download(j, found);
        rejected = null;
      }
    } catch (e) {
      if (e instanceof Mismatch && fetching) {
        rejected = { version: fetching.version, sha256: fetching.asset.sha256, size: fetching.asset.size, at: now() };
      }
      cancelled = e === CANCELLED || (j.aborted && !(e instanceof Reason));
      // a check that ended badly counts for the once an hour rule like a good one, one that was stopped does not
      if (!stamped && !cancelled) {
        stored.checkedAt = now();
        persist();
      }
      failWith(e, j);
    } finally {
      // whatever ended it, the answer in hand is closed and a late one is thrown away
      j.abort(CANCELLED);
      if (job === j) job = null;
      if (!cancelled) lastCheckEndAt = now();
    }
    emit();
  }

  // ---------- what the page can do ----------

  function setAuto(on) {
    const want = on === true;
    if (want !== stored.auto) {
      stored.auto = want;
      persist();
      if (!want && job && !job.manual) job.abort(CANCELLED);
      arm(true);
      emit();
    }
    return state();
  }

  function check() {
    if (disposed || applying || kind === 'none' || job) return state();
    // a page that asks again and again gets the state back: github's limit for one address is small
    const t = now();
    if (lastCheckEndAt !== null && t >= lastCheckEndAt && t - lastCheckEndAt < rules.MIN_MANUAL_GAP_MS) return state();
    void runCheck(true);
    return state();
  }

  function canRestart() {
    return !disposed && !applying && ready !== null && !stuck() && (kind === 'installed' || kind === 'portable');
  }

  // ---------- applying, when the app really quits ----------

  /**
   * starts a file detached. true when the process exists (it has a pid): a file that could not be started at all
   * (removed by a virus scanner, no right to run it) has none, and an error event that comes later is only logged.
   * what the started program does afterwards (a refused elevation) can not be seen from here.
   */
  function startDetached(file, args, cwd, hide) {
    try {
      const child = spawn(file, args, { shell: false, stdio: 'ignore', detached: true, windowsHide: hide, cwd });
      if (child && typeof child.on === 'function') child.on('error', (e) => log(`update: a started file failed (${e && e.code ? e.code : 'error'})`));
      if (child && typeof child.unref === 'function') child.unref();
      return !!child && Number.isInteger(child.pid) && child.pid > 0;
    } catch (e) {
      log(`update: a file could not be started (${e && e.code ? e.code : 'error'})`);
      return false;
    }
  }

  /**
   * the portable exe: windows does not let the file of the running starter be renamed or replaced, so the app can not
   * swap its own exe. the helper (electron/swap.cs) does it once ncut has closed: it gets the downloaded file, where
   * it goes, and the size and sha256 it must have, checks the file itself, swaps, and starts the new exe for a
   * restart. so nothing is hashed here and closing does not wait. the helper is copied into the updates folder
   * first: the folder of the app itself is deleted when its starter ends, and a helper running from there would be
   * in the way. the ready entry stays in update.json: the new version drops it when it starts, and when the swap
   * did not happen the next close tries again.
   */
  function handOverPortable(entry, wanted) {
    // a hand over that did not happen counts (see stuck), unless the helper of the close before is still at it
    const no = (why, counts = true) => {
      if (counts) {
        stored.swapFails = Math.min(99, stored.swapFails + 1);
        persist();
      }
      return { applied: false, started: false, why };
    };
    // a folder that can not be written (a read only stick, program files) is found here, not by a helper nobody sees.
    // the name is ours alone: a file the user keeps next to the exe is never touched
    const probe = `${portableFile}.check-${process.pid}`;
    try {
      fsApi.closeSync(fsApi.openSync(probe, 'wx'));
    } catch (e) {
      return no(writeSentence(e && e.code));
    }
    unlinkQuiet(fsApi, probe);
    if (!isPlainFile(fsApi, portableFile)) return no('ncut is not at the place it was started from');
    if (!isPlainFile(fsApi, entry.file)) {
      dropStoredReady(false);
      persist();
      return no('the downloaded update is gone', false);
    }
    const args = rules.swapArgs(entry, portableFile, wanted, restartArgs);
    if (!args) return no('the update could not be handed over');
    const helper = path.join(updatesDir, rules.SWAP_HELPER);
    try {
      fsApi.copyFileSync(swapHelper, helper);
    } catch (e) {
      // a helper that runs can not be overwritten (EBUSY): the one of the close before still waits for the exe and will
      // do the job. any other refusal (a read only copy from before, a folder that does not let us write) is no such thing
      if (e && e.code === 'EBUSY') return no('an earlier update step is still running', false);
      try {
        fsApi.unlinkSync(helper);
        fsApi.copyFileSync(swapHelper, helper);
      } catch {
        return no('the update helper could not be put in place');
      }
    }
    if (!startDetached(helper, args, updatesDir, true)) return no('the update helper could not be started');
    return { applied: true, started: wanted };
  }

  function wantsApply(restart) {
    return !applying && ready !== null && !stuck() && (kind === 'installed' || kind === 'portable') && (restart === true || stored.auto);
  }

  /**
   * the apply step: called once, when the app really ends (main: will-quit). `restart` = the user pressed restart,
   * the new version is started; else it only installs and starts when the user starts ncut next.
   * installed: the setup exe is hashed again right before (it sat in a folder the user can write): not what it was =
   * deleted and nothing applied, not done in time = nothing applied either. portable: handed to the helper, which
   * checks the file itself (handOverPortable). answers { applied, started, why?, relaunch? }, never throws.
   * applied means handed over: the installer or the helper runs. relaunch: only after a failed restart, the path of
   * the exe main should start again.
   */
  function applyAtQuit({ restart } = {}) {
    const wanted = restart === true;
    if (!wantsApply(wanted)) return { applied: false, started: false, why: 'nothing to apply' };
    applying = true;
    clearTimer();
    if (job) job.abort(CANCELLED);
    const entry = ready;
    let result = { applied: false, started: false, why: 'the update could not be applied' };
    try {
      if (!rules.readyFileOk(entry, updatesDir, kind, path)) {
        dropStoredReady(false);
        persist();
        result = { applied: false, started: false, why: 'the update file is not in the update folder' };
      } else if (kind === 'installed') {
        const deadline = now() + applyBudget;
        const verdict = verifyFileSync(fsApi, entry.file, entry, deadline, now);
        if (verdict === 'ok') {
          if (startDetached(entry.file, rules.installerArgs(wanted), updatesDir, true)) {
            // handed over once: an installer that fails (a refused elevation) must not come back on every close
            stored.ready = null;
            persist();
            result = { applied: true, started: wanted };
          } else {
            // not started at all: the download stays ready for the next try
            result = { applied: false, started: false, why: 'the installer could not be started' };
          }
        } else if (verdict === 'slow') {
          result = { applied: false, started: false, why: 'checking the update took too long, nothing was applied' };
        } else {
          dropStoredReady(true);
          persist();
          result = { applied: false, started: false, why: 'the downloaded update changed on disk and was removed' };
        }
      } else {
        result = handOverPortable(entry, wanted);
      }
    } catch (e) {
      result = { applied: false, started: false, why: sentenceFor(e) };
      log(`update: applying failed (${e && e.code ? e.code : e && e.message ? e.message : 'error'})`);
    }
    if (!result.applied) {
      live.phase = 'failed';
      live.error = result.why;
      // after "restart now" that did not work the user still wants ncut back: the file they started, as it was.
      // main starts it (this never starts anything but a verified update)
      if (wanted) result.relaunch = kind === 'portable' ? portableFile : execPath;
    }
    return result;
  }

  function dispose() {
    disposed = true;
    clearTimer();
    if (job) job.abort(CANCELLED);
    listeners.clear();
  }

  return { init, state, setAuto, check, canRestart, wantsApply, applyAtQuit, onChange, dispose };
}

module.exports = { createUpdater, createRequest, verifyFileSync };
