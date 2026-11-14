import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const rules = createRequire(import.meta.url)('./updateRules.cjs');
const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));

const MIB = 1024 * 1024;
const SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);

function release(over = {}, kind = 'installed', version = '0.3.0') {
  const name = kind === 'portable' ? `ncut-${version}-portable.exe` : `ncut-${version}-setup.exe`;
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    body: `what is new\n\n## sha256\n\n\`\`\`text\n${SHA}  ${name}\n${OTHER_SHA}  ncut-${version}-web.zip\n\`\`\`\n`,
    assets: [
      { name: `ncut-${version}-setup.exe`, size: 90 * MIB, digest: `sha256:${SHA}`, browser_download_url: `https://github.com/sagecsharp/ncut/releases/download/v${version}/ncut-${version}-setup.exe` },
      { name: `ncut-${version}-portable.exe`, size: 91 * MIB, digest: `sha256:${SHA}`, browser_download_url: `https://github.com/sagecsharp/ncut/releases/download/v${version}/ncut-${version}-portable.exe` },
      { name: `ncut-${version}-web.zip`, size: 5 * MIB, digest: `sha256:${OTHER_SHA}`, browser_download_url: `https://github.com/sagecsharp/ncut/releases/download/v${version}/ncut-${version}-web.zip` },
    ],
    ...over,
  };
}

/** a release whose asset of the given kind is changed by `fn` */
function withAsset(fn, kind = 'installed', version = '0.3.0') {
  const r = release({}, kind, version);
  const name = kind === 'portable' ? `ncut-${version}-portable.exe` : `ncut-${version}-setup.exe`;
  const i = r.assets.findIndex((a) => a.name === name);
  const next = fn({ ...r.assets[i] });
  if (next === null) r.assets.splice(i, 1);
  else r.assets[i] = next;
  return r;
}

describe('the repository', () => {
  it('is the one in package.json, the urls are built from it', () => {
    expect(pkg.repository.url).toBe(`git+https://github.com/${rules.REPO.owner}/${rules.REPO.repo}.git`);
    expect(rules.API_URL).toBe('https://api.github.com/repos/sagecsharp/ncut/releases/latest');
    expect(rules.RELEASES_URL).toBe('https://github.com/sagecsharp/ncut/releases/latest');
  });

  it('the uninstaller name follows the product name', () => {
    expect(rules.UNINSTALL_FILE).toBe(`Uninstall ${pkg.build.productName}.exe`);
  });

  it('the file names are the ones electron-builder is told to make', () => {
    expect(pkg.build.nsis.artifactName).toBe('ncut-${version}-setup.exe');
    expect(pkg.build.portable.artifactName).toBe('ncut-${version}-portable.exe');
    expect(rules.assetName('1.2.3', 'installed')).toBe('ncut-1.2.3-setup.exe');
    expect(rules.assetName('1.2.3', 'portable')).toBe('ncut-1.2.3-portable.exe');
    expect(rules.assetName('1.2.3', 'manual')).toBeNull();
    expect(rules.assetName('1.2', 'installed')).toBeNull();
  });
});

describe('versions', () => {
  it('parses exactly three numbers', () => {
    expect(rules.parseVersion('0.2.0')).toEqual([0, 2, 0]);
    expect(rules.parseVersion('1.20.99999')).toEqual([1, 20, 99999]);
    for (const bad of ['v1.2.3', '1.2', '1.2.3.4', '1.2.3-beta', '1.2.3 ', ' 1.2.3', '01.2.3', '1.02.3', '1.2.100000', '-1.2.3', '1.2.x', '', '1..3', '1.2.3\n', 1, null, undefined, {}]) {
      expect(rules.parseVersion(bad)).toBeNull();
    }
  });

  it('compares number by number, not as text', () => {
    expect(rules.compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(rules.compareVersions('0.2.0', '0.2.0')).toBe(0);
    expect(rules.compareVersions('0.2.9', '0.3.0')).toBe(-1);
    expect(rules.compareVersions('1.0.0', '0.99999.99999')).toBe(1);
    expect(rules.compareVersions('1.0', '1.0.0')).toBeNull();
  });

  it('only a higher version is newer', () => {
    expect(rules.isNewer('0.2.1', '0.2.0')).toBe(true);
    expect(rules.isNewer('0.2.0', '0.2.0')).toBe(false);
    expect(rules.isNewer('0.1.9', '0.2.0')).toBe(false);
    expect(rules.isNewer('junk', '0.2.0')).toBe(false);
    expect(rules.isNewer('0.3.0', 'junk')).toBe(false);
  });

  it('a tag is v + a version', () => {
    expect(rules.tagVersion('v1.2.3')).toBe('1.2.3');
    for (const bad of ['1.2.3', 'V1.2.3', 'v1.2', 'vv1.2.3', 'v1.2.3-rc1', 'v 1.2.3', '', null, 5]) expect(rules.tagVersion(bad)).toBeNull();
  });
});

describe('reading a release', () => {
  it('a newer release with everything right gives the asset of the kind', () => {
    const got = rules.readRelease(release(), '0.2.0', 'installed');
    expect(got).toEqual({
      ok: true,
      version: '0.3.0',
      newer: true,
      asset: { name: 'ncut-0.3.0-setup.exe', size: 90 * MIB, sha256: SHA, url: 'https://github.com/sagecsharp/ncut/releases/download/v0.3.0/ncut-0.3.0-setup.exe' },
    });
    const p = rules.readRelease(release({}, 'portable'), '0.2.0', 'portable');
    expect(p.ok && p.newer && p.asset.name).toBe('ncut-0.3.0-portable.exe');
  });

  it('the kind manual needs no asset', () => {
    const r = release({ assets: [] });
    expect(rules.readRelease(r, '0.2.0', 'manual')).toEqual({ ok: true, version: '0.3.0', newer: true, asset: null });
  });

  it('the kind none and a bad running version are refused', () => {
    expect(rules.readRelease(release(), '0.2.0', 'none').ok).toBe(false);
    expect(rules.readRelease(release(), '0.2.0', 'whatever').ok).toBe(false);
    expect(rules.readRelease(release(), 'dev', 'installed').ok).toBe(false);
  });

  it('is not an object', () => {
    for (const bad of [null, undefined, 'x', 5, [], [release()]]) expect(rules.readRelease(bad, '0.2.0', 'installed').ok).toBe(false);
  });

  it('every wrong tag is refused', () => {
    for (const tag of [undefined, null, 3, '0.3.0', 'V0.3.0', 'v0.3', 'v0.3.0-beta', 'v01.3.0', 'v0.3.0 ', 'latest', '']) {
      const got = rules.readRelease(release({ tag_name: tag }), '0.2.0', 'installed');
      expect(got.ok, String(tag)).toBe(false);
    }
  });

  it('a draft and a prerelease are refused, and so is a missing flag', () => {
    expect(rules.readRelease(release({ draft: true }), '0.2.0', 'installed').ok).toBe(false);
    expect(rules.readRelease(release({ prerelease: true }), '0.2.0', 'installed').ok).toBe(false);
    expect(rules.readRelease(release({ draft: undefined }), '0.2.0', 'installed').ok).toBe(false);
    expect(rules.readRelease(release({ prerelease: 'false' }), '0.2.0', 'installed').ok).toBe(false);
    expect(rules.readRelease(release({ draft: 0 }), '0.2.0', 'installed').ok).toBe(false);
  });

  it('a missing or odd file list is refused', () => {
    for (const assets of [undefined, null, 'x', {}, [], [null, 5, 'x'], new Array(201).fill({ name: 'x' })]) {
      expect(rules.readRelease(release({ assets }), '0.2.0', 'installed').ok).toBe(false);
    }
  });

  it('the file of the other kind does not count', () => {
    const r = withAsset(() => null, 'installed');
    expect(rules.readRelease(r, '0.2.0', 'installed').ok).toBe(false);
    expect(rules.readRelease(r, '0.2.0', 'portable').ok).toBe(true);
  });

  it('a wrong name is refused (only the exact name counts)', () => {
    for (const name of ['ncut-0.3.0-setup.exe ', 'NCUT-0.3.0-setup.exe', 'ncut-0.3.1-setup.exe', 'ncut-0.3.0-setup.exe.blockmap', 'x/ncut-0.3.0-setup.exe', 'ncut-0.3.0-Setup.exe']) {
      const r = withAsset((a) => ({ ...a, name }));
      expect(rules.readRelease(r, '0.2.0', 'installed').ok, name).toBe(false);
    }
  });

  it('the same file twice is refused', () => {
    const r = release();
    r.assets.push({ ...r.assets[0] });
    expect(rules.readRelease(r, '0.2.0', 'installed')).toMatchObject({ ok: false });
  });

  it('every wrong size is refused', () => {
    for (const size of [undefined, null, '90000000', 0, -5, MIB - 1, 1024 * MIB + 1, 1.5 * MIB + 0.5, NaN, Infinity, 2 ** 60, [], {}]) {
      const r = withAsset((a) => ({ ...a, size }));
      expect(rules.readRelease(r, '0.2.0', 'installed').ok, String(size)).toBe(false);
    }
    expect(rules.readRelease(withAsset((a) => ({ ...a, size: MIB })), '0.2.0', 'installed').ok).toBe(true);
    expect(rules.readRelease(withAsset((a) => ({ ...a, size: 1024 * MIB })), '0.2.0', 'installed').ok).toBe(true);
  });

  it('no digest is refused, never installed unverified', () => {
    const r = withAsset((a) => {
      const { digest, ...rest } = a;
      return rest;
    });
    const got = rules.readRelease(r, '0.2.0', 'installed');
    expect(got.ok).toBe(false);
    expect(rules.readRelease(withAsset((a) => ({ ...a, digest: null })), '0.2.0', 'installed').ok).toBe(false);
  });

  it('every wrong digest is refused', () => {
    for (const digest of ['', SHA, `sha1:${SHA}`, `sha256:${SHA.slice(1)}`, `sha256:${SHA}0`, `sha256:${'A'.repeat(64)}`, `sha256:${'g'.repeat(64)}`, ` sha256:${SHA}`, `sha256:${SHA} `, `SHA256:${SHA}`, 5, {}]) {
      const r = withAsset((a) => ({ ...a, digest }));
      expect(rules.readRelease(r, '0.2.0', 'installed').ok, String(digest)).toBe(false);
    }
  });

  it('every wrong download address is refused', () => {
    const good = 'https://github.com/sagecsharp/ncut/releases/download/v0.3.0/ncut-0.3.0-setup.exe';
    for (const url of [
      undefined,
      null,
      good.replace('https', 'http'),
      good.replace('sagecsharp', 'someone'),
      good.replace('/ncut/', '/other/'),
      good.replace('v0.3.0/', 'v0.2.0/'),
      good.replace('github.com', 'evil.example'),
      good.replace('github.com', 'objects.githubusercontent.com'),
      `${good}?x=1`,
      `${good}#x`,
      `${good}/`,
      good.replace('github.com', 'github.com:8443'),
      good.replace('https://', 'https://user:pw@'),
      good.toUpperCase(),
      ` ${good}`,
    ]) {
      const r = withAsset((a) => ({ ...a, browser_download_url: url }));
      expect(rules.readRelease(r, '0.2.0', 'installed').ok, String(url)).toBe(false);
    }
  });

  it('a sha256 line in the text that says something else is refused', () => {
    const r = release({ body: `## sha256\n\n${OTHER_SHA}  ncut-0.3.0-setup.exe\n` });
    expect(rules.readRelease(r, '0.2.0', 'installed')).toMatchObject({ ok: false });
    expect(rules.readRelease(release({ body: `${SHA}\tncut-0.3.0-setup.exe\n${OTHER_SHA}  ncut-0.3.0-setup.exe` }), '0.2.0', 'installed').ok).toBe(false);
    expect(rules.readRelease(release({ body: `${OTHER_SHA} *ncut-0.3.0-setup.exe` }), '0.2.0', 'installed').ok).toBe(false);
    expect(rules.readRelease(release({ body: `  ${OTHER_SHA.toUpperCase()}  ncut-0.3.0-setup.exe  \r\n` }), '0.2.0', 'installed').ok).toBe(false);
  });

  it('prose in the release text is not a sha256 line, even when it ends in the file name', () => {
    for (const line of [
      'get   ncut-0.3.0-setup.exe',
      'installer ncut-0.3.0-setup.exe',
      'abc  ncut-0.3.0-setup.exe',
      `${'a'.repeat(63)}  ncut-0.3.0-setup.exe`,
      `${'a'.repeat(65)}  ncut-0.3.0-setup.exe`,
      `${'g'.repeat(64)}  ncut-0.3.0-setup.exe`,
      `${OTHER_SHA} and then ncut-0.3.0-setup.exe`,
      `- ${OTHER_SHA}  ncut-0.3.0-setup.exe`,
    ]) {
      expect(rules.readRelease(release({ body: line }), '0.2.0', 'installed').ok, line).toBe(true);
    }
  });

  it('a huge line of spaces in the release text costs next to nothing', () => {
    // the old pattern took seconds on such a line: this has to be linear
    for (const body of [`a b${' '.repeat(500_000)}x`, `${OTHER_SHA}${' '.repeat(500_000)}x`, `\t${' '.repeat(500_000)}`, `x${'\n'.repeat(200_000)}`]) {
      const t0 = Date.now();
      const r = rules.readRelease(release({ body }), '0.2.0', 'installed');
      expect(r.ok).toBe(true);
      expect(Date.now() - t0).toBeLessThan(500);
    }
  });

  it('the text may be missing, may not mention the file, or may say the same in capitals', () => {
    expect(rules.readRelease(release({ body: undefined }), '0.2.0', 'installed').ok).toBe(true);
    expect(rules.readRelease(release({ body: null }), '0.2.0', 'installed').ok).toBe(true);
    expect(rules.readRelease(release({ body: 'nothing here' }), '0.2.0', 'installed').ok).toBe(true);
    expect(rules.readRelease(release({ body: `${OTHER_SHA}  ncut-0.3.0-portable.exe` }), '0.2.0', 'installed').ok).toBe(true);
    expect(rules.readRelease(release({ body: `${SHA.toUpperCase()}  ncut-0.3.0-setup.exe` }), '0.2.0', 'installed').ok).toBe(true);
    expect(rules.readRelease(release({ body: `${SHA}  ncut-0.3.0-setup.exe\r\n` }), '0.2.0', 'installed').ok).toBe(true);
  });

  it('a release that is not newer is not newer, whatever else it holds', () => {
    expect(rules.readRelease(release({}, 'installed', '0.2.0'), '0.2.0', 'installed')).toEqual({ ok: true, version: '0.2.0', newer: false });
    expect(rules.readRelease(release({}, 'installed', '0.1.9'), '0.2.0', 'installed')).toEqual({ ok: true, version: '0.1.9', newer: false });
    // no files at all, no digest, a wrong size: still just "not newer"
    expect(rules.readRelease(release({ assets: [], body: 'x' }, 'installed', '0.2.0'), '0.2.0', 'portable')).toEqual({ ok: true, version: '0.2.0', newer: false });
    expect(rules.readRelease(withAsset((a) => ({ ...a, digest: undefined, size: 3 }), 'installed', '0.1.0'), '0.2.0', 'installed')).toEqual({ ok: true, version: '0.1.0', newer: false });
  });

  it('a draft or a bad tag is refused even when it is old', () => {
    expect(rules.readRelease(release({ draft: true }, 'installed', '0.1.0'), '0.2.0', 'installed').ok).toBe(false);
    expect(rules.readRelease(release({ tag_name: '0.1.0' }, 'installed', '0.1.0'), '0.2.0', 'installed').ok).toBe(false);
  });
});

describe('which addresses may be followed', () => {
  const API = 'https://api.github.com/repos/sagecsharp/ncut/releases/latest';
  const DL = 'https://github.com/sagecsharp/ncut/releases/download/v0.3.0/ncut-0.3.0-setup.exe';

  it('the api call is exactly the releases address of this repository', () => {
    expect(rules.checkUrl(API, 'api')).toBe(API);
    for (const bad of [
      API.replace('latest', 'tags/v0.3.0'),
      API.replace('sagecsharp', 'someone'),
      `${API}?per_page=1`,
      API.replace('api.github.com', 'github.com'),
      API.replace('https', 'http'),
      API.replace('https://', 'https://u:p@'),
      API.replace('.com', '.com:444'),
      API.replace('.com', '.com.'),
      'https://api.github.com.evil.example/repos/sagecsharp/ncut/releases/latest',
      'https://evil.example/api.github.com/repos/sagecsharp/ncut/releases/latest',
    ]) {
      expect(rules.checkUrl(bad, 'api'), bad).toBeNull();
    }
  });

  it('the first hop of a download is github.com below this repository', () => {
    expect(rules.checkUrl(DL, 'download')).toBe(DL);
    expect(rules.checkUrl(DL.replace('github.com', 'api.github.com'), 'download')).toBeNull();
    expect(rules.checkUrl(DL.replace('sagecsharp/ncut', 'someone/else'), 'download')).toBeNull();
    expect(rules.checkUrl('https://objects.githubusercontent.com/x', 'download')).toBeNull();
  });

  it('a redirect may go to github.com or below githubusercontent.com', () => {
    for (const ok of [
      DL,
      'https://release-assets.githubusercontent.com/github-production-release-asset/1?sig=abc&x=%2F',
      'https://objects.githubusercontent.com/github-production-release-asset-2e65be/1/2',
      'https://a.b.githubusercontent.com/x',
      'https://github.com:443/x',
      'https://GitHub.com/x',
    ]) {
      expect(rules.checkUrl(ok, 'redirect'), ok).not.toBeNull();
    }
  });

  it('lookalike hosts are refused', () => {
    for (const bad of [
      'https://githubusercontent.com.evil.example/x',
      'https://xgithubusercontent.com/x',
      'https://evilgithubusercontent.com/x',
      'https://githubusercontent.com/x',
      'https://github.com.evil.example/x',
      'https://evilgithub.com/x',
      'https://github.com.evil.example:443/x',
      'https://github.com./x',
      'https://objects.githubusercontent.com./x',
      'https://objects-githubusercontent.com/x',
      'https://evil.example/https://objects.githubusercontent.com/x',
      'https://evil.example?objects.githubusercontent.com',
      'https://evil.example#.githubusercontent.com',
      'https://github.com@evil.example/x',
      'https://objects.githubusercontent.com@evil.example/x',
      'https://evil.example\\@github.com/x',
      'https://evil.example/\\.githubusercontent.com',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://localhost/x',
      'https://xn--githubusercontent-9kb.com/x',
    ]) {
      expect(rules.checkUrl(bad, 'redirect'), bad).toBeNull();
    }
  });

  it('http, other schemes, credentials and other ports are refused', () => {
    for (const bad of [
      'http://github.com/x',
      'http://objects.githubusercontent.com/x',
      'ftp://github.com/x',
      'file:///C:/x',
      'data:text/plain,x',
      'javascript:alert(1)',
      '//github.com/x',
      '/x',
      'github.com/x',
      'https://user@github.com/x',
      'https://user:pw@github.com/x',
      'https://:pw@github.com/x',
      'https://github.com:80/x',
      'https://github.com:8443/x',
      'https://objects.githubusercontent.com:444/x',
      'https://github.com:0/x',
    ]) {
      expect(rules.checkUrl(bad, 'redirect'), bad).toBeNull();
    }
  });

  it('anything that is not an address, or hides characters, is refused', () => {
    for (const bad of ['', ' ', 'https://', 'https://github.com/\tx', 'https://git\nhub.com/x', 'https://github.com/x y', ' https://github.com/x', 'https://github.com/x\u0000', null, undefined, 5, {}, ['https://github.com/x'], `https://github.com/${'a'.repeat(2100)}`]) {
      expect(rules.checkUrl(bad, 'redirect')).toBeNull();
    }
    expect(rules.checkUrl(DL, 'nonsense')).toBeNull();
  });

  it('the fragment is dropped from what is requested', () => {
    expect(rules.checkUrl(`${DL}#frag`, 'download')).toBe(DL);
  });

  it('a redirect target is resolved against the address it came from', () => {
    expect(rules.redirectTarget(DL, 'https://objects.githubusercontent.com/a')).toBe('https://objects.githubusercontent.com/a');
    expect(rules.redirectTarget(DL, '/other/path')).toBe('https://github.com/other/path');
    expect(rules.redirectTarget(DL, '//evil.example/x')).toBe('https://evil.example/x');
    expect(rules.checkUrl(rules.redirectTarget(DL, '//evil.example/x'), 'redirect')).toBeNull();
    expect(rules.checkUrl(rules.redirectTarget(DL, 'http://github.com/x'), 'redirect')).toBeNull();
    for (const bad of [undefined, null, 5, '', 'https://x\ty', 'a\\b', 'x'.repeat(3000)]) expect(rules.redirectTarget(DL, bad)).toBeNull();
    expect(rules.MAX_REDIRECTS).toBe(5);
  });
});

describe('what the page is told', () => {
  const good = { kind: 'portable', auto: false, phase: 'downloading', current: '0.2.0', latest: '0.3.0', progress: 0.5, error: null, checkedAt: 1700000000000 };

  it('keeps a good state and drops what it does not know', () => {
    expect(rules.cleanUpdateState(good)).toEqual(good);
    const dirty = rules.cleanUpdateState({ ...good, file: 'C:\\x\\y.exe', url: 'https://github.com', path: '/x', ready: { file: 'C:\\x' } });
    expect(Object.keys(dirty).sort()).toEqual(['auto', 'checkedAt', 'current', 'error', 'kind', 'latest', 'phase', 'progress']);
  });

  it('turns every wrong value into a safe one', () => {
    expect(rules.cleanUpdateState(null)).toEqual({ kind: 'none', auto: true, phase: 'idle', current: '', latest: null, progress: 0, error: null, checkedAt: null });
    const s = rules.cleanUpdateState({ kind: 'weird', auto: 'no', phase: 'dancing', current: 'v1', latest: '1.2', progress: 7, error: 5, checkedAt: -1 });
    expect(s).toEqual({ kind: 'none', auto: true, phase: 'idle', current: '', latest: null, progress: 0, error: null, checkedAt: null });
    expect(rules.cleanUpdateState({ ...good, progress: 7 }).progress).toBe(1);
    expect(rules.cleanUpdateState({ ...good, progress: -3 }).progress).toBe(0);
    expect(rules.cleanUpdateState({ ...good, progress: NaN }).progress).toBe(0);
    expect(rules.cleanUpdateState({ ...good, phase: 'idle' }).progress).toBe(0);
    expect(rules.cleanUpdateState({ ...good, checkedAt: 1.5 }).checkedAt).toBeNull();
    expect(rules.cleanUpdateState({ ...good, auto: false }).auto).toBe(false);
  });

  it('never lets a path or an address through in the error', () => {
    for (const text of [
      'could not write C:\\Users\\boss\\AppData\\Roaming\\ncut\\updates\\ncut-0.3.0-setup.exe',
      'failed at D:/stick/ncut.exe now',
      'failed at \\\\server\\share\\ncut.exe now',
      'could not read /home/me/.config/ncut/updates/x.exe',
      'see https://github.com/sagecsharp/ncut/releases/latest for more',
    ]) {
      const e = rules.cleanUpdateState({ ...good, phase: 'failed', error: text }).error;
      expect(e).not.toMatch(/[A-Za-z]:[\\/]/);
      expect(e).not.toMatch(/\\\\/);
      expect(e).not.toMatch(/https?:/);
      expect(e).not.toMatch(/\/home|\/Users|ncut-0\.3\.0|boss|\.exe/);
    }
  });

  it('the error is a short lowercase sentence without control characters', () => {
    expect(rules.cleanError('Github Is\tLimiting\nRequests')).toBe('github is limiting requests');
    expect(rules.cleanError('   ')).toBeNull();
    expect(rules.cleanError('')).toBeNull();
    expect(rules.cleanError(undefined)).toBeNull();
    expect(rules.cleanError('x'.repeat(500)).length).toBeLessThanOrEqual(160);
    // an ordinary slash is not a path
    expect(rules.cleanError('the answer and/or the file')).toBe('the answer and/or the file');
  });
});

describe('the state file', () => {
  const ready = { version: '0.3.0', file: 'C:\\u\\updates\\ncut-0.3.0-setup.exe', sha256: SHA, size: 90 * MIB };

  it('defaults to auto on, never checked, nothing ready', () => {
    for (const raw of [null, undefined, 5, 'x', [], {}, { auto: 'x' }]) {
      expect(rules.cleanStateFile(raw)).toEqual({ auto: true, checkedAt: null, ready: null, swapFails: 0 });
    }
  });

  it('keeps what is right', () => {
    expect(rules.cleanStateFile({ auto: false, checkedAt: 5, ready, swapFails: 2 })).toEqual({ auto: false, checkedAt: 5, ready, swapFails: 2 });
  });

  it('a failure count is a small whole number, else none', () => {
    for (const swapFails of [-1, 1.5, '2', NaN, 100, 2 ** 60, null, {}]) expect(rules.cleanStateFile({ swapFails }).swapFails, String(swapFails)).toBe(0);
    expect(rules.cleanStateFile({ swapFails: 99 }).swapFails).toBe(99);
  });

  it('drops a ready entry with any wrong part', () => {
    const bad = [
      { ...ready, version: '0.3' },
      { ...ready, version: undefined },
      { ...ready, file: '' },
      { ...ready, file: 5 },
      { ...ready, file: 'a\0b' },
      { ...ready, file: 'x'.repeat(2000) },
      { ...ready, sha256: 'A'.repeat(64) },
      { ...ready, sha256: 'a'.repeat(63) },
      { ...ready, size: 10 },
      { ...ready, size: 2 ** 40 },
      { ...ready, size: 1.5 * MIB + 0.5 },
      'x',
      null,
    ];
    for (const r of bad) expect(rules.cleanStateFile({ ready: r }).ready).toBeNull();
    expect(rules.cleanStateFile({ ready: { ...ready, extra: 1 } }).ready).toEqual(ready);
  });

  it('believes a file only directly inside the updates folder with the right name', () => {
    const w = path.win32;
    const dir = 'C:\\Users\\me\\AppData\\Roaming\\ncut\\updates';
    const entry = (file, version = '0.3.0') => ({ version, file, sha256: SHA, size: 90 * MIB });
    expect(rules.readyFileOk(entry(`${dir}\\ncut-0.3.0-setup.exe`), dir, 'installed', w)).toBe(true);
    expect(rules.readyFileOk(entry(`${dir.toLowerCase()}\\NCUT-0.3.0-setup.exe`.replace('NCUT', 'ncut')), dir, 'installed', w)).toBe(true);
    expect(rules.readyFileOk(entry(`${dir}\\ncut-0.3.0-portable.exe`), dir, 'installed', w)).toBe(false);
    expect(rules.readyFileOk(entry(`${dir}\\ncut-0.3.0-portable.exe`), dir, 'portable', w)).toBe(true);
    expect(rules.readyFileOk(entry(`${dir}\\ncut-0.3.1-setup.exe`), dir, 'installed', w)).toBe(false);
    expect(rules.readyFileOk(entry(`${dir}\\ncut-0.3.0-setup.exe`), dir, 'manual', w)).toBe(false);
    expect(rules.readyFileOk(entry('C:\\Windows\\System32\\ncut-0.3.0-setup.exe'), dir, 'installed', w)).toBe(false);
    expect(rules.readyFileOk(entry(`${dir}\\..\\ncut-0.3.0-setup.exe`), dir, 'installed', w)).toBe(false);
    expect(rules.readyFileOk(entry(`${dir}\\sub\\ncut-0.3.0-setup.exe`), dir, 'installed', w)).toBe(false);
    expect(rules.readyFileOk(entry(`${dir}2\\ncut-0.3.0-setup.exe`), dir, 'installed', w)).toBe(false);
    expect(rules.readyFileOk(entry(`${dir}\\sub\\..\\ncut-0.3.0-setup.exe`), dir, 'installed', w)).toBe(true);
    expect(rules.readyFileOk(entry('ncut-0.3.0-setup.exe'), dir, 'installed', w)).toBe(false);
    const p = path.posix;
    expect(rules.readyFileOk(entry('/u/updates/ncut-0.3.0-setup.exe'), '/u/updates', 'installed', p)).toBe(true);
    expect(rules.readyFileOk(entry('/u/updates/../x/ncut-0.3.0-setup.exe'), '/u/updates', 'installed', p)).toBe(false);
    expect(rules.readyFileOk(entry('/u/UPDATES/ncut-0.3.0-setup.exe'), '/u/updates', 'installed', p)).toBe(false);
    expect(rules.readyFileOk(null, dir, 'installed', w)).toBe(false);
  });
});

describe('how the installer is started', () => {
  it('silent and updating, with force-run only for a restart', () => {
    expect(rules.installerArgs(false)).toEqual(['--updated', '/S']);
    expect(rules.installerArgs(true)).toEqual(['--updated', '/S', '--force-run']);
    expect(rules.installerArgs(undefined)).toEqual(['--updated', '/S']);
    expect(rules.installerArgs('yes')).toEqual(['--updated', '/S']);
  });
});

describe('what a restarted portable app is started with', () => {
  it('carries the profile folder and nothing else', () => {
    expect(rules.carriedArgs(['C:\\x\\ncut.exe'])).toEqual([]);
    expect(rules.carriedArgs(['C:\\x\\ncut.exe', 'C:\\p\\film.ncut'])).toEqual([]);
    expect(rules.carriedArgs(['C:\\x\\ncut.exe', '--user-data-dir=E:\\ncut profile', 'C:\\p\\film.ncut', '--remote-debugging-port=9222'])).toEqual([
      '--user-data-dir=E:\\ncut profile',
    ]);
    // the first argument is the exe, whatever it looks like
    expect(rules.carriedArgs(['--user-data-dir=C:\\a'])).toEqual([]);
    // only the first one counts
    expect(rules.carriedArgs(['x', '--user-data-dir=C:\\a', '--user-data-dir=C:\\b'])).toEqual(['--user-data-dir=C:\\a']);
  });

  it('carries nothing odd', () => {
    for (const bad of ['--user-data-dir=', '--user-data-dir=C:\\a"b', '--user-data-dir=C:\\a\nb', '--user-data-dir=C:\\a|b', `--user-data-dir=C:\\${'a'.repeat(1100)}`]) {
      expect(rules.carriedArgs(['x', bad]), bad.slice(0, 40)).toEqual([]);
    }
    expect(rules.carriedArgs(null)).toEqual([]);
    expect(rules.carriedArgs(['x', 5, null, {}])).toEqual([]);
    expect(rules.carriedArgs(['x', '--USER-DATA-DIR=C:\\a', '-user-data-dir=C:\\a', 'x--user-data-dir=C:\\a'])).toEqual([]);
  });

  it('a relative profile folder is made absolute against the folder ncut was started in', () => {
    // the restarted exe starts in the folder of the exe: the same words would mean another folder there
    expect(rules.carriedArgs(['x', '--user-data-dir=.\\profile'], 'D:\\stick\\work')).toEqual(['--user-data-dir=D:\\stick\\work\\profile']);
    expect(rules.carriedArgs(['x', '--user-data-dir=..\\p q'], 'D:\\stick\\work')).toEqual(['--user-data-dir=D:\\stick\\p q']);
    // an absolute one goes on exactly as it was written
    expect(rules.carriedArgs(['x', '--user-data-dir=E:\\p\\'], 'D:\\stick')).toEqual(['--user-data-dir=E:\\p\\']);
    // no folder to resolve against, or one that makes it too long
    expect(rules.carriedArgs(['x', '--user-data-dir=p'], '')).toEqual([]);
    expect(rules.carriedArgs(['x', '--user-data-dir=p'], 'D:\\a'.padEnd(1100, 'a'))).toEqual([]);
  });
});

describe('what the swap helper is started with', () => {
  const entry = { version: '0.3.0', file: 'C:\\data\\updates\\ncut-0.3.0-portable.exe', sha256: 'ab'.repeat(32), size: 5_000_000 };
  const exe = 'D:\\tools\\my ncut.exe';

  it('is the file, the place, the hash, the size and whether to start it', () => {
    expect(rules.swapArgs(entry, exe, false, [], 'win32')).toEqual([entry.file, exe, entry.sha256, '5000000', 'quiet']);
    expect(rules.swapArgs(entry, exe, true, [], 'win32')).toEqual([entry.file, exe, entry.sha256, '5000000', 'start']);
    expect(rules.swapArgs(entry, exe, 'yes', undefined, 'win32')[4]).toBe('quiet');
  });

  it('takes one extra argument for the new exe at most, and only a plain one', () => {
    expect(rules.swapArgs(entry, exe, true, ['--user-data-dir=E:\\p', '--more'], 'win32')).toEqual([entry.file, exe, entry.sha256, '5000000', 'start', '--user-data-dir=E:\\p']);
    for (const bad of ['', 'a"b', 'a\nb', 7, null, 'x'.repeat(1025)]) {
      expect(rules.swapArgs(entry, exe, true, [bad], 'win32'), String(bad).slice(0, 20)).toHaveLength(5);
    }
  });

  it('refuses anything that is not what the helper takes', () => {
    expect(rules.swapArgs(null, exe, false, [], 'win32')).toBeNull();
    expect(rules.swapArgs({ ...entry, file: 'updates\\x.exe' }, exe, false, [], 'win32')).toBeNull();
    expect(rules.swapArgs({ ...entry, file: 'C:\\data\\x.txt' }, exe, false, [], 'win32')).toBeNull();
    expect(rules.swapArgs(entry, 'ncut.exe', false, [], 'win32')).toBeNull();
    expect(rules.swapArgs(entry, 'C:\\a"b.exe', false, [], 'win32')).toBeNull();
    expect(rules.swapArgs({ ...entry, sha256: 'AB'.repeat(32) }, exe, false, [], 'win32')).toBeNull();
    expect(rules.swapArgs({ ...entry, sha256: 'ab'.repeat(31) }, exe, false, [], 'win32')).toBeNull();
    for (const size of [0, -1, 1.5, '5', NaN, 2 ** 60]) expect(rules.swapArgs({ ...entry, size }, exe, false, [], 'win32'), String(size)).toBeNull();
  });

  it('every result number of the helper has a sentence, an unknown one is an error', () => {
    for (const code of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) expect(rules.swapResult(code), String(code)).not.toBe('an error');
    for (const code of [11, 255, -1, 'toString', '__proto__', null]) expect(rules.swapResult(code), String(code)).toBe('an error');
    expect(rules.swapResult(7)).toBe('the exe stayed in use');
  });

  it('only a swap that comes again every time counts as a failure', () => {
    for (const code of [1, 3, 4, 5, 6, 9, 10, 99]) expect(rules.swapFailureCounts(code), String(code)).toBe(true);
    // 7 and 8: ncut was started again right after it closed
    for (const code of [0, 7, 8, -1, 1.5, '3', null, undefined]) expect(rules.swapFailureCounts(code), String(code)).toBe(false);
  });

  it('paths the helper can not take (260 characters or more, with the copy next to the exe) are refused', () => {
    const entry = { version: '0.3.0', file: 'C:\\data\\updates\\ncut-0.3.0-portable.exe', sha256: 'ab'.repeat(32), size: 5_000_000 };
    const fit = (len) => 'C:\\' + 'a'.repeat(len - 7) + '.exe';
    expect(fit(255)).toHaveLength(255);
    expect(rules.swapArgs(entry, fit(255), false, [], 'win32')).not.toBeNull();
    expect(rules.swapArgs(entry, fit(256), false, [], 'win32')).toBeNull();
    expect(rules.swapArgs({ ...entry, file: fit(259) }, 'C:\\a.exe', false, [], 'win32')).not.toBeNull();
    expect(rules.swapArgs({ ...entry, file: fit(260) }, 'C:\\a.exe', false, [], 'win32')).toBeNull();
  });
});

describe('which kind of app this is', () => {
  const win = (over = {}) => ({
    platform: 'win32',
    packaged: true,
    portableFile: undefined,
    execPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\ncut\\ncut.exe',
    tempDir: 'C:\\Users\\me\\AppData\\Local\\Temp',
    isFile: () => false,
    ...over,
  });
  // where the portable starter unpacks the app: below the temp folder
  const unpacked = 'C:\\Users\\me\\AppData\\Local\\Temp\\abc123\\ncut.exe';

  it('none when not packaged, not windows, or no facts', () => {
    expect(rules.decideKind(win({ packaged: false }))).toEqual({ kind: 'none', portableFile: null });
    expect(rules.decideKind(win({ platform: 'linux' }))).toEqual({ kind: 'none', portableFile: null });
    expect(rules.decideKind(win({ platform: 'darwin' }))).toEqual({ kind: 'none', portableFile: null });
    expect(rules.decideKind(win({ packaged: 1 }))).toEqual({ kind: 'none', portableFile: null });
    expect(rules.decideKind(null)).toEqual({ kind: 'none', portableFile: null });
    expect(rules.decideKind(undefined)).toEqual({ kind: 'none', portableFile: null });
  });

  it('portable when the starter names an exe that is there', () => {
    const file = 'C:\\Games\\ncut\\ncut.exe';
    expect(rules.decideKind(win({ execPath: unpacked, portableFile: file, isFile: (p) => p === file }))).toEqual({ kind: 'portable', portableFile: file });
    // a share works too
    const unc = '\\\\nas\\tools\\ncut.exe';
    expect(rules.decideKind(win({ execPath: unpacked, portableFile: unc, isFile: (p) => p === unc }))).toEqual({ kind: 'portable', portableFile: unc });
    // the temp folder under another spelling (case, a slash at the end, the app in a folder below the unpack folder)
    for (const [exec, temp] of [
      ['c:\\users\\ME\\appdata\\local\\temp\\abc123\\ncut.exe', 'C:\\Users\\me\\AppData\\Local\\Temp\\'],
      ['C:\\Users\\me\\AppData\\Local\\Temp\\ns1.tmp\\app\\ncut.exe', 'C:\\Users\\me\\AppData\\Local\\Temp'],
    ]) {
      expect(rules.decideKind(win({ execPath: exec, tempDir: temp, portableFile: file, isFile: (p) => p === file })).kind, exec).toBe('portable');
    }
  });

  it('a portable file that is not believable is not used', () => {
    for (const bad of ['ncut.exe', '.\\ncut.exe', 'C:\\x\\ncut.txt', 'C:\\x\\"ncut".exe', 'C:\\x\\n<c>.exe', 'C:\\x\\a|b.exe', 'C:\\x\\a?.exe', 'C:\\x\\a*.exe', 'C:\\x\\a\u0001.exe', '/usr/bin/ncut.exe', 'C:\\' + 'a'.repeat(1100) + '.exe', 5, null]) {
      expect(rules.decideKind(win({ execPath: unpacked, portableFile: bad, isFile: (p) => p === bad })).kind, String(bad)).toBe('manual');
    }
    // not there, or not a file
    expect(rules.decideKind(win({ execPath: unpacked, portableFile: 'C:\\Games\\ncut.exe', isFile: () => false })).kind).toBe('manual');
    expect(rules.decideKind(win({ execPath: unpacked, portableFile: 'C:\\Games\\ncut.exe', isFile: () => { throw new Error('x'); } })).kind).toBe('manual');
    // a path the helper can not take (it is a .net framework 4 program: 260 characters are too many with the copy next to it)
    const long = 'C:\\' + 'a'.repeat(256 - 7) + '.exe';
    expect(long).toHaveLength(256);
    expect(rules.decideKind(win({ execPath: unpacked, portableFile: long, isFile: (p) => p === long })).kind).toBe('manual');
  });

  it('an unpacked or extracted copy of ncut that another portable program started stays manual', () => {
    // PORTABLE_EXECUTABLE_FILE is inherited by every child: this copy must not take the exe of the other program for
    // itself, the update would replace that program with ncut
    const other = 'D:\\tools\\SomeOtherPortableApp.exe';
    const isFile = (p) => p === other;
    for (const exec of [
      'C:\\builds\\ncut\\win-unpacked\\ncut.exe',
      'C:\\Users\\me\\Downloads\\ncut-zip\\ncut.exe',
      // below a folder that only begins like the temp folder
      'C:\\Users\\me\\AppData\\Local\\Temp2\\abc\\ncut.exe',
      // the temp folder itself is not below it
      'C:\\Users\\me\\AppData\\Local\\Temp',
    ]) {
      expect(rules.decideKind(win({ execPath: exec, portableFile: other, isFile })), exec).toEqual({ kind: 'manual', portableFile: null });
    }
    // no temp folder given, or none that makes sense
    for (const tempDir of [undefined, '', 'Temp', null, 5]) {
      expect(rules.decideKind(win({ execPath: unpacked, tempDir, portableFile: other, isFile })).kind, String(tempDir)).toBe('manual');
    }
    // the portable exe in the folder of the running exe is the folder build, not the starter
    const same = 'C:\\Users\\me\\AppData\\Local\\Temp\\abc123\\other.exe';
    expect(rules.decideKind(win({ execPath: unpacked, portableFile: same, isFile: (p) => p === same })).kind).toBe('manual');
  });

  it('installed when the uninstaller sits next to the running exe', () => {
    const uninstaller = 'C:\\Users\\me\\AppData\\Local\\Programs\\ncut\\Uninstall ncut.exe';
    expect(rules.decideKind(win({ isFile: (p) => p === uninstaller }))).toEqual({ kind: 'installed', portableFile: null });
    expect(rules.decideKind(win({ isFile: (p) => p === 'C:\\Users\\me\\AppData\\Local\\Programs\\ncut\\ncut.exe' })).kind).toBe('manual');
    expect(rules.decideKind(win({ isFile: (p) => p === 'C:\\other\\Uninstall ncut.exe' })).kind).toBe('manual');
  });

  it('an uninstaller next to the running exe wins over an inherited PORTABLE_EXECUTABLE_FILE', () => {
    // a child of a portable ncut (or of anything that sets the variable) inherits it: an installed ncut must not
    // take that other exe for itself and swap it
    const uninstaller = 'C:\\Users\\me\\AppData\\Local\\Programs\\ncut\\Uninstall ncut.exe';
    const other = 'D:\\tools\\other.exe';
    expect(rules.decideKind(win({ portableFile: other, isFile: (p) => p === other || p === uninstaller }))).toEqual({ kind: 'installed', portableFile: null });
  });

  it('the portable run has no uninstaller next to its exe and so stays portable', () => {
    const file = 'C:\\Games\\ncut\\ncut.exe';
    expect(rules.decideKind(win({ execPath: unpacked, portableFile: file, isFile: (p) => p === file })).kind).toBe('portable');
  });

  it('manual for a packaged folder that is neither', () => {
    expect(rules.decideKind(win())).toEqual({ kind: 'manual', portableFile: null });
    expect(rules.decideKind(win({ execPath: 'ncut.exe' }))).toEqual({ kind: 'manual', portableFile: null });
    expect(rules.decideKind(win({ execPath: undefined }))).toEqual({ kind: 'manual', portableFile: null });
  });
});

describe('the portable path syntax', () => {
  it('takes windows paths on windows and posix ones only elsewhere', () => {
    expect(rules.isPortablePath('C:\\a\\b.exe', 'win32')).toBe(true);
    expect(rules.isPortablePath('C:/a/b.EXE', 'win32')).toBe(true);
    expect(rules.isPortablePath('/a/b.exe', 'win32')).toBe(false);
    expect(rules.isPortablePath('/a/b.exe', 'linux')).toBe(true);
    expect(rules.isPortablePath('a/b.exe', 'linux')).toBe(false);
  });
});
