'use strict';
/**
 * the decisions of the auto updater (docs/UPDATE.md), without electron, fs or network: which versions count, how
 * a github release answer is read, which urls may be followed, what the page is told, what the state file may hold,
 * how the installer is started. pure, so it is tested in node (updateRules.test.mjs). update.cjs does the work.
 * nothing from the network, from a file or from the page is trusted: everything is checked again where it is used.
 */
const path = require('node:path');

// ---------- where releases live ----------

/** the repository the releases come from. a test checks it against repository.url in package.json */
const REPO = Object.freeze({ owner: 'sagecsharp', repo: 'ncut' });
const API_HOST = 'api.github.com';
const WEB_HOST = 'github.com';
const API_URL = `https://${API_HOST}/repos/${REPO.owner}/${REPO.repo}/releases/latest`;
/** the page the "open the releases page" button shows. fixed here, the page never sends an address */
const RELEASES_URL = `https://${WEB_HOST}/${REPO.owner}/${REPO.repo}/releases/latest`;
const DOWNLOAD_PATH_PREFIX = `/${REPO.owner}/${REPO.repo}/releases/download/`;

/** the name electron-builder gives the uninstaller next to the app for productName ncut (nsis common.nsh UNINSTALL_FILENAME) */
const UNINSTALL_FILE = 'Uninstall ncut.exe';

// ---------- limits and timing ----------

const MIB = 1024 * 1024;
const MIN_ASSET_BYTES = 1 * MIB;
const MAX_ASSET_BYTES = 1024 * MIB;
/** the biggest api answer that is read */
const MAX_API_BYTES = 1 * MIB;
const MAX_REDIRECTS = 5;
const MAX_URL_LENGTH = 2048;
const API_TIMEOUT_MS = 20_000;
/** a download dies when no byte came for this long */
const IDLE_TIMEOUT_MS = 30_000;
const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** two checks that nobody asked for are never closer than this, counting the last one of the state file */
const MIN_CHECK_GAP_MS = 60 * 60 * 1000;
const PROGRESS_EVERY_MS = 250;
/** what applying an update may take while the app is closing (the hash of the setup exe) */
const APPLY_BUDGET_MS = 2000;
/** "check now" is never answered twice within this: a page that loops on it does not turn into a flood of requests */
const MIN_MANUAL_GAP_MS = 10_000;
/** a download that failed its checks is not fetched again on its own for this long (the same version and the same hash) */
const REJECT_BACKOFF_MS = 24 * 60 * 60 * 1000;

/** the helper that swaps the portable exe once ncut has closed (electron/swap.cs), and the file it writes its result to */
const SWAP_HELPER = 'ncut-swap.exe';
const SWAP_LOG = 'swap.log';
/** a <file>.new next to the portable exe that is older than this belongs to no helper any more (one waits two minutes at most) */
const STALE_NEW_MS = 15 * 60 * 1000;

const KINDS = ['installed', 'portable', 'manual', 'none'];
const PHASES = ['idle', 'checking', 'downloading', 'ready', 'failed'];

// ---------- versions ----------

/** "1.2.3": exactly three numbers of 0..99999, no leading zeros, no v, nothing else. [a, b, c] or null */
function parseVersion(text) {
  if (typeof text !== 'string') return null;
  const m = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1, 0 or 1; null when either is not a version */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/** is `candidate` a version above `running`? false when either is not a version (never a downgrade, never the same) */
function isNewer(candidate, running) {
  return compareVersions(candidate, running) === 1;
}

/** the version of a release tag: exactly "v" + a version, else null */
function tagVersion(tag) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) return null;
  const v = tag.slice(1);
  return parseVersion(v) ? v : null;
}

// ---------- files ----------

/** the release asset a kind installs from, or null for a kind that downloads nothing */
function assetName(version, kind) {
  if (!parseVersion(version)) return null;
  if (kind === 'installed') return `ncut-${version}-setup.exe`;
  if (kind === 'portable') return `ncut-${version}-portable.exe`;
  return null;
}

function assetUrl(version, name) {
  return `https://${WEB_HOST}${DOWNLOAD_PATH_PREFIX}v${version}/${name}`;
}

/** the arguments the setup exe is started with (nsis: --updated keeps the folder, /S is silent, --force-run starts the app after) */
function installerArgs(restart) {
  return restart === true ? ['--updated', '/S', '--force-run'] : ['--updated', '/S'];
}

/**
 * the arguments a restarted portable ncut gets: only the profile folder it was started with (--user-data-dir=...),
 * so someone who keeps the profile next to the exe on a stick does not land in another profile after an update.
 * nothing else is carried (a project file was opened already). the value goes on as one argument, never through
 * a shell, and only when it has nothing odd in it.
 */
function carriedArgs(argv) {
  if (!Array.isArray(argv)) return [];
  const prefix = '--user-data-dir=';
  // the first argument is the exe itself
  for (const arg of argv.slice(1)) {
    if (typeof arg !== 'string' || !arg.startsWith(prefix)) continue;
    const value = arg.slice(prefix.length);
    if (value === '' || arg.length > 1024 || /["<>|?*\u0000-\u001f]/.test(value)) return [];
    return [arg];
  }
  return [];
}

/**
 * the arguments of the swap helper (electron/swap.cs checks them again):
 * <the downloaded exe> <the portable exe> <sha256> <size> start|quiet [<one argument for the new exe>].
 * null when anything is not what it has to be. `extra` is what carriedArgs gave, at most its first entry goes on.
 */
function swapArgs(entry, portableFile, restart, extra, platform = process.platform) {
  if (!entry || typeof entry !== 'object') return null;
  if (!isPortablePath(entry.file, platform) || !isPortablePath(portableFile, platform)) return null;
  if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) return null;
  if (!Number.isSafeInteger(entry.size) || entry.size < 1) return null;
  const args = [entry.file, portableFile, entry.sha256, String(entry.size), restart === true ? 'start' : 'quiet'];
  const one = Array.isArray(extra) ? extra[0] : undefined;
  if (typeof one === 'string' && one !== '' && one.length <= 1024 && !/["\u0000-\u001f]/.test(one)) args.push(one);
  return args;
}

/** what a result number of the swap helper means (electron/swap.cs), for the log */
function swapResult(code) {
  const known = {
    0: 'it worked',
    1: 'the new exe is in place but could not be started',
    2: 'the helper was started the wrong way',
    3: 'ncut was not at its place any more',
    4: 'the downloaded file was not the one that was checked',
    5: 'the new file could not be written next to ncut',
    6: 'the copy did not come out right',
    7: 'the exe stayed in use',
    8: 'another swap was running',
    10: 'the new file could not take its place, the old one was put back',
  };
  return Object.prototype.hasOwnProperty.call(known, code) ? known[code] : 'an error';
}

/**
 * is this the path of a portable exe that may be swapped? a full windows path to an exe with nothing in it that
 * could end a quoted command (the same check as taskbarDetails in rules.cjs). `platform` only lets the tests use
 * posix temp folders: only win32 is a real case.
 */
function isPortablePath(p, platform = process.platform) {
  if (typeof p !== 'string' || p.length < 4 || p.length > 1024) return false;
  if (!/\.exe$/i.test(p)) return false;
  if (/["<>|?*\u0000-\u001f]/.test(p)) return false;
  if (platform === 'win32') return /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/])/.test(p);
  return p.startsWith('/');
}

/**
 * which kind of app this is, from facts the caller collected:
 * { platform, packaged, portableFile (the PORTABLE_EXECUTABLE_FILE value), execPath, isFile(path) }.
 * none = not packaged or not windows. portable = the one file exe says where it lives and that is a real exe.
 * installed = the nsis uninstaller sits next to the running exe. manual = a packaged app that is neither.
 * `portableFile` of the answer is the believed portable path, else null.
 */
function decideKind(facts) {
  const none = { kind: 'none', portableFile: null };
  if (!facts || typeof facts !== 'object') return none;
  if (facts.platform !== 'win32' || facts.packaged !== true) return none;
  const isFile = (p) => {
    try {
      return typeof facts.isFile === 'function' && facts.isFile(p) === true;
    } catch {
      return false;
    }
  };
  // the uninstaller is asked first: PORTABLE_EXECUTABLE_FILE is an environment variable and children inherit it, so an
  // installed ncut started from a program that carries one must not take another exe for itself. a real portable run
  // never has an uninstaller next to its (temp folder) exe, so nothing is lost by asking this first
  const exec = facts.execPath;
  if (typeof exec === 'string' && /^[a-zA-Z]:[\\/]/.test(exec) && exec.length <= 1024) {
    const uninstaller = path.win32.join(path.win32.dirname(exec), UNINSTALL_FILE);
    if (isFile(uninstaller)) return { kind: 'installed', portableFile: null };
  }
  const portable = facts.portableFile;
  if (isPortablePath(portable, 'win32') && isFile(portable)) return { kind: 'portable', portableFile: portable };
  return { kind: 'manual', portableFile: null };
}

// ---------- urls ----------

const USER_CONTENT_HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+githubusercontent\.com$/;

/**
 * may this address be requested? https only, no credentials, no port but the default one, and the host by role:
 * 'api'      exactly the releases api address of this repository
 * 'download' github.com, below this repository's release downloads (the first hop of a download)
 * 'redirect' github.com or a host below githubusercontent.com (a redirect of the download). a lookalike such as
 *            githubusercontent.com.evil.example or xgithubusercontent.com is not one.
 * answers the normalized address (what is to be requested, without a fragment) or null.
 */
function checkUrl(raw, role) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null;
  // the parser would quietly drop tabs and turn backslashes into slashes: such an address is not one of ours
  if (/[\x00-\x20\x7f\\]/.test(raw)) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.username !== '' || u.password !== '') return null;
  // 443 is the default for https and the parser drops it: anything left is another port
  if (u.port !== '') return null;
  u.hash = '';
  const host = u.hostname;
  if (role === 'api') return u.href === API_URL ? u.href : null;
  if (role === 'download') return host === WEB_HOST && u.pathname.startsWith(DOWNLOAD_PATH_PREFIX) ? u.href : null;
  if (role === 'redirect') return host === WEB_HOST || USER_CONTENT_HOST.test(host) ? u.href : null;
  return null;
}

/** where a redirect points, resolved against the address it came from. the result still has to pass checkUrl */
function redirectTarget(base, location) {
  if (typeof base !== 'string' || typeof location !== 'string') return null;
  if (location.length === 0 || location.length > MAX_URL_LENGTH || /[\x00-\x20\x7f\\]/.test(location)) return null;
  try {
    return new URL(location, base).href;
  } catch {
    return null;
  }
}

// ---------- reading a release ----------

/** a sha256 line is short: "<64 hex>  <file name>". longer lines are prose and never looked at */
const MAX_SHA_LINE = 512;
const HEX64_ANY_CASE = /^[0-9A-Fa-f]{64}$/;
const isSpace = (c) => c === ' ' || c === '\t';

/**
 * does the release text hold a sha256 line for this file that says something else? lines look like
 * "<64 hex>  <file name>" (scripts/release-notes.cjs). only a line whose first word is exactly 64 hex characters and
 * whose rest is exactly this file name (an optional * in front, as sha256sum writes it) counts: every other line is
 * prose and is ignored. no line for the file = nothing to compare. the release text is untrusted and may be big, so
 * this walks each line once with no backtracking pattern and skips long lines before touching them.
 */
function bodyDisagrees(body, name, sha256) {
  if (typeof body !== 'string') return false;
  let start = 0;
  while (start <= body.length) {
    let end = body.indexOf('\n', start);
    if (end === -1) end = body.length;
    let stop = end;
    if (stop > start && body[stop - 1] === '\r') stop--;
    if (stop - start <= MAX_SHA_LINE) {
      const line = body.slice(start, stop);
      let i = 0;
      while (i < line.length && isSpace(line[i])) i++;
      let j = i;
      while (j < line.length && !isSpace(line[j])) j++;
      if (j > i && HEX64_ANY_CASE.test(line.slice(i, j))) {
        let k = j;
        while (k < line.length && isSpace(line[k])) k++;
        if (k > j) {
          let rest = line.slice(k).trimEnd();
          if (rest.startsWith('*')) rest = rest.slice(1);
          if (rest === name && line.slice(i, j).toLowerCase() !== sha256) return true;
        }
      }
    }
    start = end + 1;
  }
  return false;
}

const no = (reason) => ({ ok: false, reason });

/**
 * reads the answer of the releases api (untrusted json) for the running version and kind:
 * { ok: false, reason } | { ok: true, version, newer: false } | { ok: true, version, newer: true, asset }
 * with asset { name, size, sha256, url } (null for the kind manual, which downloads nothing).
 * a release is believed only when: the tag is v + a version, it is no draft and no prerelease, and (when it is
 * newer) the asset of this kind is there once, with a sane size, a sha256 digest, the exact download address of
 * this repository, and no other sha256 in the release text. no digest = refused, never installed unverified.
 */
function readRelease(json, running, kind) {
  if (kind !== 'installed' && kind !== 'portable' && kind !== 'manual') return no('updates are not available here');
  if (!parseVersion(running)) return no('the running version is not a version');
  if (!json || typeof json !== 'object' || Array.isArray(json)) return no('the release answer is not an object');
  const version = tagVersion(json.tag_name);
  if (!version) return no('the release tag is not a version');
  if (json.draft !== false) return no('the release is a draft');
  if (json.prerelease !== false) return no('the release is a prerelease');
  if (!isNewer(version, running)) return { ok: true, version, newer: false };
  if (kind === 'manual') return { ok: true, version, newer: true, asset: null };

  const name = assetName(version, kind);
  if (!Array.isArray(json.assets) || json.assets.length > 200) return no('the release has no file list');
  const matches = json.assets.filter((a) => a && typeof a === 'object' && a.name === name);
  if (matches.length === 0) return no('the release has no file for this app');
  if (matches.length > 1) return no('the release lists the file twice');
  const a = matches[0];
  if (!Number.isSafeInteger(a.size) || a.size < MIN_ASSET_BYTES || a.size > MAX_ASSET_BYTES) return no('the file size is not believable');
  if (typeof a.digest !== 'string') return no('the release has no checksum for the file');
  const d = /^sha256:([0-9a-f]{64})$/.exec(a.digest);
  if (!d) return no('the checksum of the file is not a sha256');
  const sha256 = d[1];
  const url = assetUrl(version, name);
  if (a.browser_download_url !== url) return no('the download address is not the one of this repository');
  if (bodyDisagrees(json.body, name, sha256)) return no('the checksum in the release text differs from the api');
  return { ok: true, version, newer: true, asset: { name, size: a.size, sha256, url } };
}

// ---------- what the page is told ----------

const PATH_LIKE = [/[a-zA-Z]:[\\/][^\s"']*/g, /\\\\[^\s\\/]+[\\/][^\s"']*/g, /(^|[\s(])\/[^\s/]+(?:\/[^\s/]*)+/g];

/** a short lowercase sentence without control characters and without anything that looks like a path or an address, or null */
function cleanError(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\bhttps?:\/\/\S*/gi, 'an address');
  s = s.replace(PATH_LIKE[0], 'a file').replace(PATH_LIKE[1], 'a file').replace(PATH_LIKE[2], '$1a file');
  s = s.replace(/\s+/g, ' ').trim().toLowerCase();
  if (s === '') return null;
  return s.length > 160 ? s.slice(0, 160).trim() : s;
}

/**
 * the state that leaves main (and that preload and the page clean again): only these fields, only believable
 * values. never a path, never an address. unknown fields are dropped.
 */
function cleanUpdateState(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const kind = KINDS.includes(r.kind) ? r.kind : 'none';
  const phase = PHASES.includes(r.phase) ? r.phase : 'idle';
  const progress =
    phase === 'downloading' && typeof r.progress === 'number' && Number.isFinite(r.progress) ? Math.min(1, Math.max(0, r.progress)) : 0;
  const checkedAt = Number.isSafeInteger(r.checkedAt) && r.checkedAt >= 0 ? r.checkedAt : null;
  return {
    kind,
    auto: r.auto !== false,
    phase,
    current: parseVersion(r.current) ? r.current : '',
    latest: parseVersion(r.latest) ? r.latest : null,
    progress,
    error: cleanError(r.error),
    checkedAt,
  };
}

// ---------- the state file ----------

const HEX64 = /^[0-9a-f]{64}$/;

/** a "ready" entry as the state file may hold it: a version, the file, its sha256 and its size */
function cleanReady(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!parseVersion(raw.version)) return null;
  if (typeof raw.file !== 'string' || raw.file === '' || raw.file.length > 1024 || raw.file.includes('\0')) return null;
  if (typeof raw.sha256 !== 'string' || !HEX64.test(raw.sha256)) return null;
  if (!Number.isSafeInteger(raw.size) || raw.size < MIN_ASSET_BYTES || raw.size > MAX_ASSET_BYTES) return null;
  return { version: raw.version, file: raw.file, sha256: raw.sha256, size: raw.size };
}

/** <userData>/update.json as it is believed: { auto, checkedAt, ready }. anything broken = the defaults (auto on) */
function cleanStateFile(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    auto: r.auto !== false,
    checkedAt: Number.isSafeInteger(r.checkedAt) && r.checkedAt >= 0 ? r.checkedAt : null,
    ready: cleanReady(r.ready),
  };
}

/**
 * may a ready entry be believed as to where its file is? the file has to be directly inside the updates folder and
 * carry exactly the name this kind downloads for that version. `pathApi` is node's path (win32 in the real app: the
 * comparison of folders ignores case there).
 */
function readyFileOk(entry, updatesDir, kind, pathApi = path) {
  if (!entry || typeof entry.file !== 'string' || typeof updatesDir !== 'string') return false;
  const name = assetName(entry.version, kind);
  if (!name) return false;
  const insensitive = pathApi.sep === '\\';
  const norm = (p) => (insensitive ? p.toLowerCase() : p);
  const file = pathApi.resolve(entry.file);
  if (pathApi.basename(file) !== name) return false;
  return norm(pathApi.dirname(file)) === norm(pathApi.resolve(updatesDir));
}

module.exports = {
  REPO,
  API_HOST,
  WEB_HOST,
  API_URL,
  RELEASES_URL,
  DOWNLOAD_PATH_PREFIX,
  UNINSTALL_FILE,
  MIN_ASSET_BYTES,
  MAX_ASSET_BYTES,
  MAX_API_BYTES,
  MAX_REDIRECTS,
  API_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  FIRST_CHECK_DELAY_MS,
  CHECK_EVERY_MS,
  MIN_CHECK_GAP_MS,
  PROGRESS_EVERY_MS,
  APPLY_BUDGET_MS,
  SWAP_HELPER,
  SWAP_LOG,
  STALE_NEW_MS,
  MIN_MANUAL_GAP_MS,
  REJECT_BACKOFF_MS,
  KINDS,
  PHASES,
  parseVersion,
  compareVersions,
  isNewer,
  tagVersion,
  assetName,
  assetUrl,
  installerArgs,
  carriedArgs,
  swapArgs,
  swapResult,
  isPortablePath,
  decideKind,
  checkUrl,
  redirectTarget,
  readRelease,
  bodyDisagrees,
  cleanError,
  cleanUpdateState,
  cleanReady,
  cleanStateFile,
  readyFileOk,
};
