import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { releaseFiles, releaseNotes, sizeText } = require('./release-notes.cjs');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');

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
    expect(text).not.toContain('\r');
    expect(sizeText(155093441)).toBe('147.9 mb');
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
});
