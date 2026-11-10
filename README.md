# ncut

a flat, monochrome video editor that runs entirely in your browser.

- multi-track timeline: video, image, text, shape and audio clips. move, trim, split, ripple delete, duplicate, copy/paste, snapping, markers, groups, freeze frame, undo/redo
- real-time preview on a canvas, with on-canvas move / scale / rotate, zoom and pan, guides, and a quality switch (full / half / quarter) for heavy timelines
- keyframes on almost every number (position, scale, rotation, opacity, volume, effect settings, camera), with easing
- 3d, set up like a small game engine scene: any clip can become a plane, box, ball, tube, cone, pyramid or ring in one shared unlit 3d space, mixed freely with flat 2d layers. camera clips move through it (with ready-made moves: push in, orbit, dolly zoom, handheld), a scene view lets you orbit around the set with move / rotate / scale tools, and distance fog fades far things out
- attach clips to each other (or to the camera) so they move together, see the whole set as a tree in the layers tab, and make any clip turn to face the camera or another clip
- motion blur four ways: a real shutter as an adjustment layer (centered, trailing, leading), per-clip motion blur that follows keyframes and motions, echo / frame blend, and directional / zoom / spin blur
- 59 effects as adjustment layers (color, blur, distortion, stylize, motion) and 71 transitions (fades, slides, pushes, wipes, 3d turns, glitches) you drop on a cut
- per-clip color (brightness, contrast, saturation, warmth, hue), green screen with spill cleanup, masks with a soft edge (box, oval, half, strip, star, heart), blend modes, crop, rounded corners
- text: 29 bundled fonts plus system fonts and your own font files, outline, shadow, gradient, block depth, curved and wrapped text, per-letter animations in, out and looping, karaoke highlighting
- captions: import .srt / .vtt, split a long text into captions, export .srt
- shapes and ready-made clip motions in, out and looping (some just for 3d: turntable, tumble, fly in)
- fades, per-clip volume, speed and opacity. swap the media of a clip and keep everything else
- export to mp4 or webm with webcodecs at up to 240 fps, gif, or audio only (wav / ogg), whole timeline or a range. no upload, no watermark. what you see in the preview is what gets exported
- start from an empty timeline or a template (3d title, 3d shapes, name tag, countdown, lyrics)
- everything stays on your machine: projects and media live in indexeddb. save a project as one `.ncut` file (project + media) to back it up or move it to another computer
- monochrome, high contrast, flat ui in kode mono. follows your system: black at night, white by day. optional color tint in settings. no glow.
- a small fps counter in the corner so you can see how the editor is performing

## run it

```bash
npm install
```

```bash
npm run dev
```

then open http://localhost:5173. use a chromium based browser (chrome, edge, brave) for export, it needs webcodecs.

## scripts

- `npm run dev` start the dev server
- `npm run build` typecheck + production build into `dist/`
- `npm run test` unit tests (vitest)
- `npm run typecheck` typescript only

## shortcuts

press `?` in the editor for the full list. the main ones:

- `space` play / pause, `j` `k` `l` shuttle
- `s` split at the playhead
- `delete` delete, `shift+delete` ripple delete
- `ctrl+z` / `ctrl+shift+z` undo / redo
- `ctrl+c` `ctrl+x` `ctrl+v` `ctrl+d` copy, cut, paste, duplicate
- `ctrl+g` / `ctrl+shift+g` group / ungroup
- `shift+f` freeze frame
- `left` / `right` step one frame
- `m` add a marker at the playhead, `alt+,` / `alt+.` jump between markers
- `w` `e` `r` move / rotate / scale tool in the scene view
- `ctrl+wheel` zoom the timeline (or the preview when the pointer is over it)
- `ctrl+e` export

## how it is built

vite, react, typescript, zustand, [mediabunny](https://mediabunny.dev) for encoding and decoding, lucide icons, plain css.
see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the layout of the code and the rules it follows.
