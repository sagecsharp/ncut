# ncut

a flat, monochrome video editor that runs entirely in your browser.

- multi-track timeline: video, image, text, shape and audio clips. move, trim, split, ripple delete, duplicate, copy/paste, snapping, markers, markers on the beats of a song, groups, freeze frame (the still keeps the mask, the effects and the fades of the clip), undo/redo
- real-time preview on a canvas, with on-canvas move / scale / rotate, zoom and pan, guides, and a quality switch (full / half / quarter) for heavy timelines. preview speed from 0.25x to 2x and j / k / l shuttle in both directions
- keyframes on almost every number (position, scale, rotation, opacity, volume, effect settings, camera), with easing, and tools for a whole animation: reverse it, fit it to the clip, repeat it, ping pong, copy it to another clip, or add a wiggle (a seeded shake on any value)
- 3d, set up like a small game engine scene: any clip can become a plane, box, ball, tube, cone, pyramid, ring, capsule, prism, hexagon, star or heart in one shared unlit 3d space, mixed freely with flat 2d layers. camera clips move through it (with ready-made moves: push in, orbit, dolly zoom, handheld), a scene view lets you orbit around the set with move / rotate / scale tools (ctrl snaps to a grid, x / y / z lock an axis, alt + drag leaves a copy) while a small inset shows what the camera sees, distance fog fades far things out, and the camera has depth of field: pick what is sharp, keyframe it to pull the focus, or drag the focus plane right in the scene view
- attach clips to each other (or to the camera, or to an invisible "empty") so they move together, see the whole set as a tree in the layers tab, and make any clip turn to face the camera or another clip. arrange a selection in 3d in one click: ring, row, stack, fan, grid, spiral, sphere, scatter, wave, stairs. put a clip in front of the camera, frame it with the camera, lay it flat or drop it on the floor. repeat a clip: a row of copies, each a step further in position, depth, turn, size, opacity or time (an echo, a staircase, a tunnel). send a clip along a path in one click: circle, figure eight, spiral, swing, hop, zigzag, drift, written as ordinary keyframes, and it can turn to face the way it moves
- motion blur many ways: a real shutter as an adjustment layer (centered, trailing, leading), per-clip motion blur that follows keyframes and motions in three kinds (smooth, trail, ghost) on 2d and 3d clips, echo / frame blend, and directional / zoom / spin / tilt shift / lens / soft focus / rgb trail blur
- 86 effects (color, blur, distortion, stylize, motion, looks like sketch, neon edges, hologram, oil paint, glass and led screen, and overlays like snow, rain, confetti, bokeh, light rays, lens flare) as adjustment layers over everything below, or put on one clip only (a blur on a text really goes soft at the edges), with favorites, and 87 transitions (fades, slides, pushes, wipes, 3d turns, glitches) you drop on a cut, or put on every cut of a track at once (one kind or shuffled)
- per-clip color (brightness, contrast, saturation, warmth, hue), green screen with spill cleanup, masks with a soft edge (box, oval, half, strip, star, heart), blend modes, crop, rounded corners. split screen in one click: side by side, stacked, grid, one big, picture in picture
- text: 29 bundled fonts plus system fonts and your own font files, outline, second outline, hollow letters, shadow, gradient, block depth (real thickness when the text stands in 3d), underline and strike, a box per line, curved and wrapped text, per-letter animations in, out and looping, karaoke highlighting, split a text into letters, words or lines (every piece becomes its own clip, right where it stood, ready to be arranged in 3d), and running numbers that count up or down, as plain numbers or as a timer (m:ss) with steady digits
- captions: import .srt / .vtt, split a long text into captions, export .srt
- shapes with outlines that draw themselves on, and ready-made clip motions in, out and looping (some just for 3d: turntable, tumble, fly in)
- fades, per-clip volume, speed and opacity. swap the media of a clip and keep everything else
- cascade a selection: start the clips one after the other (left to right, middle outwards, random ...) and let them fly in or out (scatter, rise, fall, zoom, spin, from the depth). made for a text split into letters
- cut to the music: mark the beats of a song, then lay the selected clips in a row, fit them to the markers (every beat, every 2nd, every 4th) or cut a clip at every marker
- export to mp4 or webm with webcodecs at up to 240 fps, gif, or audio only (wav / ogg), whole timeline or a range, with one click presets. no upload, no watermark. what you see in the preview is what gets exported
- start from an empty timeline or a template (3d title, 3d shapes, name tag, countdown, lyrics, numbers, snow title, carousel, rack focus, block title, tunnel, letter ring, orbit, letters fly in, timer)
- everything stays on your machine: projects and media live in indexeddb. save a project as one `.ncut` file (project + media + the font files you imported for it) to back it up or move it to another computer. an export tells you when a font of the project is missing on this machine
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

- `space` play / pause, `j` `k` `l` play backwards / pause / play forward (press again to go faster)
- `ctrl+k` search every action
- `s` split at the playhead
- `delete` delete, `shift+delete` ripple delete
- `ctrl+z` / `ctrl+shift+z` undo / redo
- `ctrl+c` `ctrl+x` `ctrl+v` `ctrl+d` copy, cut, paste, duplicate
- `ctrl+g` / `ctrl+shift+g` group / ungroup
- `shift+f` freeze frame
- `left` / `right` step one frame
- `m` add a marker at the playhead, `alt+,` / `alt+.` jump between markers
- `w` `e` `r` move / rotate / scale tool in the scene view, `f` frame the selection, `x` `y` `z` lock an axis while moving, `alt` + drag an arrow leaves a copy, `esc` cancels a drag
- `alt` + drop media on a clip swaps its media, `alt` + drop an effect on a clip puts the effect on that clip only
- `ctrl+wheel` zoom the timeline (or the preview when the pointer is over it)
- `ctrl+e` export

## how it is built

vite, react, typescript, zustand, [mediabunny](https://mediabunny.dev) for encoding and decoding, lucide icons, plain css.
see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the layout of the code and the rules it follows.
