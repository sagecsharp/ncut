import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { NEW_IN, SITE, releaseFiles, releaseNotes, sizeText } = require('./release-notes.cjs');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
const pages = fs.readFileSync(path.join(root, '.github', 'workflows', 'pages.yml'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

describe('a release', () => {
  it('has the files the builds write, under the names they write them', () => {
    const names = releaseFiles('1.2.3').map((f) => f.file);
    const name = (pattern) => pattern.replace('${version}', '1.2.3');
    expect(names).toEqual([name(manifest.build.nsis.artifactName), name(manifest.build.portable.artifactName), 'ncut-1.2.3-web.zip']);
    expect(manifest.build.directories.output).toBe('release');
  });

  it('the notes list every file with its size and sha256', () => {
    const files = releaseFiles('1.2.3').map((f, i) => ({ ...f, bytes: (i + 1) * 3 * 1024 * 1024, sha256: String(i).repeat(64) }));
    const text = releaseNotes('1.2.3', files);
    for (const f of files) {
      expect(text).toContain(`- \`${f.file}\` (${sizeText(f.bytes)}) ${f.what}`);
      expect(text).toContain(`${f.sha256}  ${f.file}`);
    }
    expect(text).toContain('/blob/v1.2.3/docs/FEATURES.md');
    expect(text).toContain(SITE);
    expect(text).not.toContain('\r');
    expect(sizeText(155093441)).toBe('147.9 mb');
  });

  it('says what is new for a version that has an entry, and nothing for one that has none', () => {
    const files = releaseFiles('9.9.9').map((f) => ({ ...f, bytes: 1024 * 1024, sha256: 'a'.repeat(64) }));
    expect(releaseNotes('9.9.9', files)).not.toContain('## new');
    const [version, lines] = Object.entries(NEW_IN)[0];
    const text = releaseNotes(version, files);
    expect(text).toContain('## new\n\n- ' + lines[0] + '\n');
    for (const line of lines) expect(text).toContain(`- ${line}\n`);
    // the section sits above the downloads
    expect(text.indexOf('## new')).toBeLessThan(text.indexOf('## downloads'));
    // the version being released has its entry (a release without one would silently say nothing new)
    expect(NEW_IN[manifest.version], `scripts/release-notes.cjs NEW_IN has no entry for ${manifest.version}`).toBeDefined();
    for (const list of Object.values(NEW_IN)) for (const line of list) expect(line).not.toMatch(/[\r\n]/);
  });

  it('the workflow builds with the scripts of package.json and uploads those three files', () => {
    expect(manifest.scripts.exe).toContain('electron-builder');
    expect(manifest.scripts.web).toContain('--base=./');
    expect(manifest.scripts.web).toContain('--outDir dist-web');
    expect(manifest.scripts.web).toContain('scripts/make-web-zip.cjs');
    expect(workflow).toContain('npm run exe -- --publish never');
    expect(workflow).toContain('npm run web');
    expect(workflow).toContain('node scripts/release-notes.cjs');
    for (const f of releaseFiles('$VERSION')) expect(workflow).toContain(`release/${f.file}`);
    // the token is only there for the step that makes the release
    expect(workflow.split('GH_TOKEN').length - 1).toBe(1);
    expect(workflow).not.toContain('\r');
  });

  it('the pages workflow hosts the web zip of a release, after the workflow that makes it', () => {
    // it waits for the release workflow by its name
    expect(workflow).toMatch(/^name: release$/m);
    expect(pages).toMatch(/workflow_run:\n    workflows:\n      - release\n/);
    // the pattern it downloads is the name the web zip gets, and the folder it uploads is the one inside the zip
    const zipName = releaseFiles('1.2.3')[2].file;
    expect(zipName).toMatch(/^ncut-.*-web\.zip$/);
    expect(pages).toContain("--pattern 'ncut-*-web.zip'");
    expect(pages).toContain('path: site/ncut-web');
    expect(fs.readFileSync(path.join(root, 'scripts', 'make-web-zip.cjs'), 'utf8')).toContain('`ncut-web/${f.name}`');
    // the address in the readme and the release text is where a project site of this repo lands
    const [, owner, repo] = manifest.repository.url.match(/github\.com\/([^/]+)\/([^/.]+)/);
    expect(SITE).toBe(`https://${owner}.github.io/${repo}/`);
    expect(readme).toContain(SITE);
    expect(pages).not.toContain('\r');
  });
});
