'use strict';
// prints the text of a github release for what is in release/: the three files, what each is for and their sha256.
// used by .github/workflows/release.yml, after `npm run exe` and `npm run web`. with --version it only prints the
// version in package.json (the workflow checks the tag against it).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** the files of a release, in the order they are listed */
function releaseFiles(version) {
  return [
    { file: `ncut-${version}-setup.exe`, what: 'windows, installer with a start menu entry' },
    { file: `ncut-${version}-portable.exe`, what: 'windows, one file, just run it' },
    {
      file: `ncut-${version}-web.zip`,
      what: 'the browser version: unzip it onto any static web host (https), or run `npx serve .` in the folder to try it',
    },
  ];
}

function sizeText(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} mb`;
}

/** `files`: { file, what, bytes, sha256 } */
function releaseNotes(version, files) {
  const out = [];
  out.push('a flat, monochrome video editor. runs in your browser or as a windows app, nothing gets uploaded.');
  out.push('');
  out.push('## downloads');
  out.push('');
  for (const f of files) out.push(`- \`${f.file}\` (${sizeText(f.bytes)}) ${f.what}`);
  out.push('');
  out.push(
    'the exe files are not code signed: windows smartscreen may ask before the first start (more info, run anyway).',
    'the browser version needs a chromium based browser (chrome, edge, brave).',
  );
  out.push('');
  out.push(`what is in it: [docs/FEATURES.md](https://github.com/sagecsharp/ncut/blob/v${version}/docs/FEATURES.md)`);
  out.push('');
  out.push('## sha256');
  out.push('');
  out.push('```text');
  for (const f of files) out.push(`${f.sha256}  ${f.file}`);
  out.push('```');
  out.push('');
  return out.join('\n');
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n <= 0) break;
      hash.update(chunk.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

module.exports = { releaseFiles, releaseNotes, sizeText };

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (process.argv.includes('--version')) {
    process.stdout.write(`${version}\n`);
    return;
  }
  const files = releaseFiles(version).map((f) => {
    const full = path.join(root, 'release', f.file);
    if (!fs.existsSync(full)) throw new Error(`release/${f.file} is not there: run \`npm run exe\` and \`npm run web\` first`);
    return { ...f, bytes: fs.statSync(full).size, sha256: sha256(full) };
  });
  process.stdout.write(releaseNotes(version, files));
}
