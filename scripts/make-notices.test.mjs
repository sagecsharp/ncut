import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { OUT, buildNotices } = require('./make-notices.cjs');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

describe('third party notices', () => {
  const built = buildNotices(root);

  it('the file in the repo is what the script writes (run npm run notices after a dependency changed)', () => {
    const stored = fs.readFileSync(path.join(root, OUT), 'utf8').replace(/\r/g, '');
    expect(stored).toBe(built);
  });

  it('names every bundled dependency with its license', () => {
    for (const name of Object.keys(manifest.dependencies)) expect(built).toContain(`${name} `);
    for (const id of ['MIT', 'ISC', 'MPL-2.0', 'OFL-1.1', 'Apache-2.0']) expect(built).toContain(id);
  });

  it('names what the dependencies bring along at run time', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages;
    let seen = 0;
    for (const name of Object.keys(manifest.dependencies)) {
      for (const dep of Object.keys(lock[`node_modules/${name}`]?.dependencies ?? {})) {
        if (dep.startsWith('@types/')) {
          expect(built).not.toContain(`### ${dep} `);
          continue;
        }
        expect(built).toContain(`### ${dep} `);
        seen++;
      }
    }
    // react-dom needs scheduler today: when this is 0 the lock file is read the wrong way
    expect(seen).toBeGreaterThan(0);
  });

  it('carries the license texts once each', () => {
    const count = (s) => built.split(s).length - 1;
    expect(count('SIL OPEN FONT LICENSE Version 1.1')).toBe(1);
    expect(count('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION')).toBe(1);
    expect(built).toContain('David Hoskins');
    expect(built).toContain('https://mozilla.org/MPL/2.0/');
  });

  it('is shipped with the desktop app, next to the mit license', () => {
    expect(manifest.build.extraResources).toContain(OUT);
    expect(manifest.build.extraResources).toContain('LICENSE');
  });
});
