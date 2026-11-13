'use strict';
// writes THIRD-PARTY-NOTICES.md: the licences of everything ncut bundles into the web build and the desktop app
// (the dependencies in package.json and what they bring along at run time, read from node_modules) plus the one
// snippet in the source that has an owner.
// run `npm run notices` after a dependency is added, removed or updated. scripts/make-notices.test.mjs fails when
// the file in the repo is not what this script writes.
const fs = require('node:fs');
const path = require('node:path');

const OUT = 'THIRD-PARTY-NOTICES.md';

/** code in the source tree that follows somebody else's work (not a package) */
const SNIPPETS = [
  {
    where: 'src/engine/effects/glsl.ts (hash11, hash21, hash22, hash31)',
    what: '"hash without sine" by david hoskins',
    url: 'https://www.shadertoy.com/view/4djSRW',
    license: 'MIT',
    text: [
      'Copyright (c) 2014 David Hoskins.',
      '',
      'Permission is hereby granted, free of charge, to any person obtaining a copy',
      'of this software and associated documentation files (the "Software"), to deal',
      'in the Software without restriction, including without limitation the rights',
      'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
      'copies of the Software, and to permit persons to whom the Software is',
      'furnished to do so, subject to the following conditions:',
      '',
      'The above copyright notice and this permission notice shall be included in all',
      'copies or substantial portions of the Software.',
      '',
      'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
      'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
      'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
      'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
      'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
      'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
      'SOFTWARE.',
    ].join('\n'),
  },
];

const OFL_MARK = 'This Font Software is licensed under the SIL Open Font License';
const OFL_BODY = 'SIL OPEN FONT LICENSE Version 1.1';
const APACHE_END = 'END OF TERMS AND CONDITIONS';

function block(text) {
  return ['```text', text.replace(/\s+$/, ''), '```'].join('\n');
}

function repoUrl(pkg) {
  const r = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository && pkg.repository.url;
  return r ? r.replace(/^git\+/, '').replace(/\.git$/, '') : pkg.homepage || '';
}

function readPackage(root, name) {
  const dir = path.join(root, 'node_modules', ...name.split('/'));
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const file = fs.readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
  if (!file) throw new Error(`${name} has no licence file`);
  const text = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r/g, '');
  return { name, version: pkg.version, license: String(pkg.license), url: repoUrl(pkg), home: pkg.homepage || '', text };
}

/**
 * the dependencies of package.json plus what they need at run time (package-lock.json says what that is), each with
 * the package that brought it in. type only packages are left out: nothing of them is in a build.
 */
function bundledNames(root, manifest) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages || {};
  const via = new Map();
  const queue = Object.keys(manifest.dependencies || {}).map((name) => ({ name, from: null }));
  while (queue.length) {
    const { name, from } = queue.shift();
    if (via.has(name) || name.startsWith('@types/')) continue;
    via.set(name, from);
    const entry = lock[`node_modules/${name}`];
    for (const dep of Object.keys((entry && entry.dependencies) || {})) queue.push({ name: dep, from: name });
  }
  return [...via.keys()].sort().map((name) => ({ name, via: via.get(name) }));
}

/** the whole file as one string (lf line ends, no dates, the same input gives the same output) */
function buildNotices(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const packages = bundledNames(root, manifest).map((n) => ({ ...readPackage(root, n.name), via: n.via }));
  const fonts = packages.filter((p) => p.name.startsWith('@fontsource/'));
  const code = packages.filter((p) => !p.name.startsWith('@fontsource/'));

  const out = [];
  out.push('# third party notices');
  out.push('');
  out.push(
    'ncut itself is under the mit license ([LICENSE](LICENSE)). the web build and the desktop app also carry the',
    'things below, each under its own license. this file is written by `npm run notices` from what is installed.',
  );
  out.push('');
  out.push('## code');
  out.push('');
  const seen = new Map();
  for (const p of code) {
    out.push(`### ${p.name} ${p.version} (${p.license})`);
    out.push('');
    if (p.url) out.push(p.url, '');
    if (p.via) out.push(`comes with ${p.via}.`, '');
    if (p.license === 'MPL-2.0') {
      out.push(
        'used as published, not changed. its source is at the address above, the license text is at',
        'https://mozilla.org/MPL/2.0/ and in the package (`LICENSE`).',
        '',
      );
      continue;
    }
    const first = seen.get(p.text);
    if (first) {
      out.push(`the same license text as ${first} above.`, '');
      continue;
    }
    seen.set(p.text, p.name);
    out.push(block(p.text), '');
  }

  out.push('## code that follows a published snippet');
  out.push('');
  for (const s of SNIPPETS) {
    out.push(`### ${s.what} (${s.license})`);
    out.push('');
    out.push(`${s.url}`, '', `in ${s.where}.`, '');
    out.push(block(s.text), '');
  }

  out.push('## fonts');
  out.push('');
  out.push('the font files come from fontsource (https://fontsource.org) and are bundled as published, not changed.');
  out.push('');
  const bodies = new Map();
  for (const p of fonts) {
    const family = p.name.slice('@fontsource/'.length).replace(/-/g, ' ');
    out.push(`### ${family} (${p.name} ${p.version}, ${p.license})`);
    out.push('');
    let notice;
    let body;
    if (p.license === 'OFL-1.1') {
      const mark = p.text.indexOf(OFL_MARK);
      const start = p.text.indexOf(OFL_BODY);
      if (mark < 0 || start < 0) throw new Error(`${p.name}: not the open font license text that was expected`);
      notice = p.text.slice(0, mark).trim();
      body = p.text.slice(p.text.lastIndexOf('\n', p.text.lastIndexOf('\n', start) - 1) + 1).trim();
    } else if (p.license === 'Apache-2.0') {
      const end = p.text.indexOf(APACHE_END);
      if (end < 0) throw new Error(`${p.name}: not the apache license text that was expected`);
      notice = p.text
        .slice(end)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^Copyright \(c\)/.test(l))
        .join('\n');
      body = p.text.slice(0, end + APACHE_END.length).trim();
    } else {
      throw new Error(`${p.name}: a font under ${p.license}, this script only knows OFL-1.1 and Apache-2.0`);
    }
    if (notice) out.push(block(notice), '');
    if (!bodies.has(p.license)) bodies.set(p.license, body);
    else if (bodies.get(p.license) !== body) throw new Error(`${p.name}: its ${p.license} text is not the same as the others`);
  }
  const titles = { 'OFL-1.1': 'sil open font license 1.1', 'Apache-2.0': 'apache license 2.0' };
  for (const id of [...bodies.keys()].sort()) {
    out.push(`## ${titles[id]} (${id})`);
    out.push('');
    out.push(block(bodies.get(id)), '');
  }

  out.push('## the desktop app');
  out.push('');
  out.push(
    'the windows app is built on electron and chromium. their licenses are in `LICENSE.electron.txt` and',
    '`LICENSES.chromium.html` next to `ncut.exe`.',
  );
  out.push('');
  return out.join('\n');
}

module.exports = { OUT, buildNotices };

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const text = buildNotices(root);
  fs.writeFileSync(path.join(root, OUT), text);
  console.log(`[notices] wrote ${OUT} (${text.length} bytes)`);
}
