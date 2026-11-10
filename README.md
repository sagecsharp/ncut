# ncut

a flat, monochrome video editor that runs entirely in your browser.

- multi-track timeline: video, image, text, shape and audio clips. move, trim, split, ripple delete, duplicate, copy/paste, snapping, markers, undo/redo
- real-time preview on a canvas, with on-canvas move / scale / rotate
- keyframes on almost every number (position, scale, rotation, opacity, volume, effect settings, camera), with easing
- 3d: any clip can become a plane, box, sphere or cylinder in one shared unlit 3d space, mixed freely with flat 2d layers. camera clips move through it, clips can face the camera, and a scene view lets you orbit around the set
- effects as adjustment layers: motion blur with a real shutter (centered, trailing, leading), echo, directional / zoom / spin blur, color, distortion and stylize effects
- transitions between clips (fades, slides, pushes, wipes, 3d turns, glitches) by dropping one on a cut
- text: bundled and system fonts, your own font files, outline, shadow, gradient, curved and wrapped text, per-letter animations in, out and looping
- shapes, blend modes, crop, rounded corners and ready-made clip motions
- fades, per-clip volume, speed and opacity
- export to mp4 or webm with webcodecs at up to 240 fps, no upload, no watermark. what you see in the preview is what gets exported
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

- `space` play / pause
- `s` split at the playhead
- `delete` delete, `shift+delete` ripple delete
- `ctrl+z` / `ctrl+shift+z` undo / redo
- `ctrl+c` `ctrl+x` `ctrl+v` `ctrl+d` copy, cut, paste, duplicate
- `left` / `right` step one frame
- `m` add a marker at the playhead
- `ctrl+wheel` zoom the timeline
- `ctrl+e` export

## how it is built

vite, react, typescript, zustand, [mediabunny](https://mediabunny.dev) for encoding and decoding, lucide icons, plain css.
see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the layout of the code and the rules it follows.
