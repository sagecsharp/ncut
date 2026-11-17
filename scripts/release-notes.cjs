'use strict';
// prints the text of a github release for what is in release/: the three files, what each is for and their sha256.
// used by .github/workflows/release.yml, after `npm run exe` and `npm run web`. with --version it only prints the
// version in package.json (the workflow checks the tag against it).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** where the browser version is hosted (.github/workflows/pages.yml puts the web zip of the latest release there) */
const SITE = 'https://sagecsharp.github.io/ncut/';

/**
 * what is new per version, a few plain lines each (the release text shows them under "new"). a version without an
 * entry just has no such section.
 */
const NEW_IN = {
  '0.4.0': [
    'every number in the properties is a slider: drag it sideways (shift is finer, ctrl lands on round steps), click to type, double click for the rest value. the properties are split in tabs (basic, look, animate, sound, all), and with several clips selected a drag changes all of them',
    'bend: roll a picture clip like a cinema screen or a page, or bend several clips as one surface, up to a closed ring. keyable',
    'pivot: give a clip the point it rotates and scales around, on one of nine spots, by dragging it on the preview, or where it meets the clip it is attached to. with attach this builds a rig (shoulder, elbow, wrist)',
    'trim mode (y): ripple, roll, slip, slide and stretch by dragging, q / w ripple trim to the playhead, u picks the edit and , . trim it by frames. the preview shows both sides while you trim',
    'in and out: i and o mark a range on the timeline, ; lifts it, \' extracts it, shift+space plays it, the export can render just it. the keyframe key is shift+k now',
    'source view: a click on a media card shows it with its own playhead (shift+v), i and o mark the part to use. insert (f9), overwrite (f10), replace, fit to the range and append put it on the timeline',
    'separate the sound of a video from its picture, timecode in the transport (click the time or press g to type one)',
    'scopes (shift+w): waveform, parade, vectorscope and histogram next to the preview',
    'grade: four wheels and seven curves on every picture clip, copy and paste a grade, a grade effect clip for everything below it. luts: import a .cube and put it on a grade, or save a grade as a .cube',
    'mixer (shift+6): fader, pan, mute and solo per track, meters, and a loudness strip (momentary, short term, integrated, range, true peak). the export has a loudness target and a peak limit',
    'tracks: change the height of a track, drag a header to reorder, sync lock per track',
    'audio crossfades (shift+t) with equal power, linear and smooth shapes, and the same shapes on fades',
    'keyframe panel (shift+u) with one row per animated value, and a graph (shift+g) with value and speed graphs, handles for a custom ease and easy ease',
    'matte: one clip shows through another, by alpha or luma',
    'advanced export (ctrl+shift+e): video codec, bitrate, key frame interval, size, see-through background, audio codec, audio bitrate and sample rate, and five new presets. every default is the file the export always made',
    'mcp: 66 tools now. new ones crossfade the sound, move, ease, copy and sample keyframes, save a grade as a lut and measure the loudness, and update_clip, update_track, set_keyframe and export_video take the new settings',
  ],
  '0.3.3': [
    'skyboxes: import a cube map under project > sky (a cross, a strip or six pictures named like px, posx, right or rt), or press "use as sky" after importing one. it is drawn behind every layer, turns with the camera, and lit 3d clips take their light from it. mcp: update_project takes sky',
    'effects on a clip now move its outline with the picture (shake, zoom, blur, glitch and the like), before the picture moved inside the old outline',
    'the chroma key effect makes the color really see-through, it used to fill it with black. on a track of its own it keys the video or picture right under it',
  ],
  '0.3.2': [
    'settings open without a project: the projects screen has a settings button, and ctrl+, works there like in the editor. theme, tint, wallpaper, layout reset, unity 3d controls, mcp and updates are all in it',
  ],
  '0.3.1': [
    'lit 3d clips: a 3d video, image, text or shape can take the light of the scene. switch "lit" on in its 3d section, "how lit" says how much (it can be keyed). the light comes from the background, the 2d shapes under the 3d clips and the fog, with nothing to set up: tops take the sky, sides the horizon, undersides the ground. or set an own light with a sun under project > light. light only darkens or tints a clip, a white surrounding leaves it as it is',
    'new template "lit room"',
    '3d video with motion blur exports about twice as fast',
    'mcp: update_project takes fog and light, update_clip takes lit, delete_project deletes a stored project, remove_media removes media (by id, or all that no clip uses)',
  ],
  '0.3.0': [
    'auto update: the desktop app asks github now and then whether a newer release is out, downloads it in the background, checks it against the checksum github gives for it, and installs it when you close ncut. "restart to update" in the settings does it at once. the installed app runs its setup silently, the portable exe is replaced in place and keeps its name. settings > updates, with an off switch and "check now"',
    'this is the first version that can update itself: 0.1.0 and 0.2.0 can not, so get this one by hand once',
  ],
  '0.2.0': [
    'mcp cursors: while an mcp client (claude code and others) works in the window you see its cursor, with its name and what it is doing. several agents at once each get their own, up to 8. the client can point at something and leave a note. off switch in the settings',
    'wallpaper: a picture of yours behind the whole ui, with fit, dim, blur and how solid the panels are. settings > appearance',
  ],
};

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
  out.push(`use it right in the browser: ${SITE}`);
  out.push('');
  const fresh = NEW_IN[version];
  if (fresh && fresh.length > 0) {
    out.push('## new');
    out.push('');
    for (const line of fresh) out.push(`- ${line}`);
    out.push('');
  }
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

module.exports = { NEW_IN, SITE, releaseFiles, releaseNotes, sizeText };

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
