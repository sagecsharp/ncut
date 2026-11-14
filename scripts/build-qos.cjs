'use strict';
// builds the two small helpers of the desktop app with the c# compiler that is part of windows (.net framework 4, on
// every windows 10 and 11):
//   build/bin/ncut-qos.exe   from electron/qos.cs    full speed exports in a minimized window
//   build/bin/ncut-swap.exe  from electron/swap.cs   the last step of an update of the portable exe (docs/UPDATE.md)
// the desktop app works without them: an export in a minimized window is just slower, and the portable exe only says
// that a new version is out instead of updating itself. so a machine without the compiler only gets a note.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'build', 'bin');
const HELPERS = [
  { name: 'ncut-qos.exe', source: path.join(root, 'electron', 'qos.cs') },
  { name: 'ncut-swap.exe', source: path.join(root, 'electron', 'swap.cs') },
];

function findCompiler() {
  if (process.platform !== 'win32') return null;
  const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  for (const dir of ['Framework64', 'Framework']) {
    const csc = path.join(windir, 'Microsoft.NET', dir, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(csc)) return csc;
  }
  return null;
}

const csc = findCompiler();
if (!csc) {
  console.log('[qos] no c# compiler here: the app is built without ncut-qos.exe and ncut-swap.exe');
  process.exit(0);
}
fs.mkdirSync(outDir, { recursive: true });
for (const helper of HELPERS) {
  const out = path.join(outDir, helper.name);
  try {
    // winexe: no console window flashes up when the app starts it
    execFileSync(csc, ['/nologo', '/optimize+', '/target:winexe', '/platform:anycpu', `/out:${out}`, helper.source], { stdio: 'inherit' });
    console.log(`[qos] built ${path.relative(root, out)} (${fs.statSync(out).size} bytes)`);
  } catch (err) {
    console.log(`[qos] ${helper.name} could not be built, the app is built without it:`, err instanceof Error ? err.message : String(err));
  }
}
