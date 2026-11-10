# ncut

a flat, dark video editor that runs entirely in your browser.

- multi-track timeline: video, image, text and audio clips. move, trim, split, ripple delete, duplicate, copy/paste, snapping, undo/redo
- real-time preview on a canvas, with on-canvas move / scale / rotate
- text overlays, fades, per-clip volume, speed and opacity
- export to mp4 or webm with webcodecs, no upload, no watermark
- everything stays on your machine: projects and media live in indexeddb
- linux mint inspired dark theme. flat. no glow.
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
- `ctrl+wheel` zoom the timeline
- `ctrl+e` export

## how it is built

vite, react, typescript, zustand, [mediabunny](https://mediabunny.dev) for encoding and decoding, lucide icons, plain css.
see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the layout of the code and the rules it follows.
