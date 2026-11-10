# ncut architecture

ncut is an in-browser video editor: multi-track timeline, real-time canvas preview, keyframes, an unlit
3d space with cameras, gpu effects and transitions, animated text, local-only storage (indexeddb),
export through webcodecs up to 240 fps. no server, no accounts, no watermark.

stack: vite 8, react 19, typescript 7 (strict), zustand 5, mediabunny (muxing/encoding/decoding),
lucide-react (icons). plain css with tokens. package manager is npm.

## layout of src/

```
types.ts                 data model. read this first.
lib/time.ts              clamp, snapToFrame, formatTimecode, formatDuration, formatBytes
lib/timelineOps.ts       pure helpers: clipEnd, projectDuration, getTrackClips, isRangeFree, findFreeStart,
                         findTrackWithRoom, clipsAtTime, sourceTimeAt, fadeFactor, collectSnapPoints, snapTime
lib/factory.ts           createProject, createClipFromAsset, createTextClip, CANVAS_PRESETS, FPS_OPTIONS, FONT_FAMILIES
lib/dnd.ts               drag payloads between media panel and timeline/preview
lib/anim.ts              keyframes: animProps, valueAt, resolveClip (bakes keys into a clip for one time), easings
lib/transitions.ts       where a clip's transition sits in time (transitionSpan, transitionsAt, transitionHolds)
lib/links.ts             ids that point at other clips: parent (attach), look target, camera target, the clip an effect
                         sits on, groups. cycle checks, relinking copies and split halves
lib/subtitles.ts         .srt / .vtt parsing and writing, splitting a text into caption sized cues
lib/templates.ts         starter timelines for the new project dialog
lib/gif.ts               dependency-free gif encoder (palette, dithering, lzw)
lib/fonts.ts             font catalog: bundled (lazy css imports), system, local and imported fonts
lib/perf.ts              frame-time monitor behind the fps counter
lib/appearance.ts        theme mode (auto/black/white) + tint, saved in localStorage, applied to <html>
store/editorStore.ts     useEditor: project, selection, undo/redo, clipboard, zoom, snapping + every edit action
store/playback.ts        usePlayback: the master clock (time, playing, loop, volume, speed, rate + shuttle)
store/ui.ts              useUi: open dialog, toasts, preview mode (output | scene)
store/session.ts         open/create/close/duplicate/delete projects, url hash routing, autosave
storage/db.ts            indexeddb: projects + media blobs
storage/projectFile.ts   one .ncut file = project + media
storage/posters.ts       small pictures of the preview for the project cards (localStorage)
media/registry.ts        runtime assetId -> blob + object url
media/importer.ts        importFiles, deleteAsset, detectKind            (media feature)
media/derived.ts         getThumbnail, getFilmstrip, getWaveform         (media feature)
engine/draw.ts           renderFrame(ctx, project, time, resolver, opts) + renderSceneView, getClipBox, hitTestBox
engine/text.ts           text layout and drawing (styles, wrap, curve, per-glyph animation states)
engine/textAnim.ts       the per-letter text animations (in / out / loop)
engine/counter.ts        running numbers in text clips (counterValue, counterText, resolveCounter)
engine/shape.ts          shape clips (rect, ellipse, polygon, star ...), shapeOutline (the outline as one path)
engine/shapeTrim.ts      draw on: flatten an outline and cut it to a share of its length (drawStart / drawEnd)
engine/textDepth.ts      block text in 3d: how many side layers a text gets, where they sit, how they are shaded
engine/clipAnim.ts       ready-made motions for whole clips (in / out / loop), some only for 3d clips
engine/parent.ts         attached clips: world pose of a clip under its parents (2d, 3d, camera parents)
engine/clipLook.ts       per-clip color correction + green screen (one small webgl2 program per channel)
engine/mask.ts           clip masks (box, oval, half, strip, star, heart) with a soft edge
engine/clipFx.ts         which effect clips sit on which clip (EffectClip.target), cached per clips array
engine/blurStyle.ts      sample times and weights of the per-clip motion blur kinds (even, trail, ghost)
engine/effects/          effect registry + defs (glsl, one file per pack) + the webgl2 runner for adjustment layers
engine/transitions/      transition registry + defs (glsl) + the webgl2 runner
engine/scene3d/          3d math, camera rig, model matrices, the unlit webgl2 scene renderer, depth of field (focus.ts),
                         meshes.ts (plane, box, ball ... and solids pushed out of a 2d outline: outline2d.ts)
components/ui/           Dialog, NumberField, Toasts, FpsCounter, AppearanceSettings
features/editor/         EditorLayout (header, media | preview | properties, timeline) with splitters
features/projects/       ProjectsScreen
features/shell/          Header, ProjectSettingsDialog, ShortcutsDialog, useShortcuts, the command palette (ctrl+k)
features/media/          MediaPanel (media, text, shapes, effects, transitions, layers tabs), captions tools,
                         favorites.ts (starred effects / transitions, kept in localStorage), transitionBatch.ts
                         (a transition on every cut of a track, shuffle, same length) + transitionApply.ts
                         (a transition never longer than its cut allows, the last used one)
features/fonts/          FontPicker
features/timeline/       Timeline. effectFollow.ts / followMoves.ts / followApply.ts: effects put on a clip follow it
                         through every way a clip can move (drag, trim, inspector fields, gaps, speed, freeze frame).
                         beats.ts + beatActions.ts (markers on the beats of a clip's sound, from its waveform peaks).
                         sequence.ts + sequenceActions.ts (clips in a row, fitted to the markers, cut at the markers)
features/preview/        Preview. SceneOverlay (the scene view tools), sceneGizmo.ts (handles, axis lock),
                         sceneHelpers.ts (focus plane, floor grid, readouts)
features/properties/     PropertiesPanel. arrange3d.ts (layouts), place3d.ts + placeActions.ts (in front of the camera,
                         frame with the camera, floor), FocusSection (depth of field), splitLayout.ts + splitActions.ts
                         (split screen: the canvas cut into cells, every selected clip fitted into one),
                         repeat.ts + repeatActions.ts (a row of copies, each a step further), keyTools.ts +
                         keyActions.ts + keyClipboard.ts (reverse / fit / repeat / wiggle / copy a whole animation),
                         textSplit.ts + textSplitActions.ts (a text into one clip per letter, word or line),
                         cascade.ts + cascadeActions.ts (a selection staggered in time, fly in / out keys),
                         pathMoves.ts + pathActions.ts (motion paths written as position keys)
features/export/         ExportDialog + the offline renderer
styles/theme.css         design tokens
styles/base.css          shared classes (.btn, .icon-btn, .input, .select, .range, .panel, .tabs, .menu, .dialog ...)
```

## data model in one paragraph

a `Project` has `assets` (metadata of imported files), `tracks` and a flat `clips` list (each clip has a `trackId`).
`tracks[0]` is the top row and the top visual layer. video tracks (video, image, text clips) always come before
audio tracks (audio clips). all times are seconds. clips on one track never overlap. a clip covers
`[start, start + duration)`. for video/audio clips, source time = `trimStart + (t - start) * speed`.
`transform.x/y` are offsets from the canvas center in canvas pixels, `scale: 1` = contain-fit for media and
natural size for text. `fadeIn/fadeOut` scale opacity (visual) and gain (audio).

more clip types live on video tracks: `shape` (a drawn figure, visual like an image), `effect` (an adjustment
layer: changes the picture made by everything below its track) and `camera` (the 3d camera for its time range).

## the frame renderer

`engine/draw.ts` `renderFrame` draws one frame of a project at a time onto a 2d canvas. the live preview
and the exporter both call it with their own source resolver, so they always match. the rule that keeps
them matching: a frame depends only on `(project, time)`. never on the wall clock, never on random
numbers at draw time (effects get a per-clip `seed`).

- layers are painted bottom track first. a run of consecutive 3d clips is rendered together through the
  camera by `engine/scene3d/renderer.ts` (depth tested, unlit) and laid over the canvas.
- keyframes: `resolveClip(clip, time)` returns the clip with every animated property baked in. always
  edit animatable numbers through the store's `setClipValue` (it writes a key when the property is animated).
- effects: an effect clip post-processes the canvas below it in webgl2 (`engine/effects/runner.ts`).
  an effect with `temporal` (motion blur, echo) instead asks the renderer to draw the layers below at
  several sub-frame times and averages them. that is a real shutter: it blurs transform, camera and
  effect motion, in preview and export alike.
- transitions: `clip.transition` belongs to the INCOMING clip and is centered on the cut. each side is
  painted alone (frozen on its edge frame outside its own range) and mixed by a glsl
  `vec4 transition(vec2 uv, float p)`.
- 3d space: canvas pixels, x right, y down, +z away from the viewer, z = 0 is the canvas plane. the home
  camera sees the canvas plane exactly filling the frame, so a flat 3d clip at z = 0 looks identical to
  a 2d clip. a camera clip stores offsets from that home pose.
- text is laid out per glyph (`engine/text.ts`); 3d text goes through a cached texture.
- block text in 3d (`TextClip.extrude` on a 3d clip): the face is drawn without the flat extrude, and behind
  it a stack of planes with the silhouette of the text in the side color (`engine/textDepth.ts`), so the
  depth is real and turns with the clip. a flat text keeps the painted extrude.
- solids: `Spatial.shape` picks the mesh. capsule, prism, hexagon, star and heart are 2d outlines pushed
  out along z (`scene3d/outline2d.ts`); the clip's picture sits on the front and back, the sides take its edge.
- draw on (`ShapeClip.drawStart` / `drawEnd`, shares of the outline length, keyframable): only the stroke is
  cut (`engine/shapeTrim.ts`), the fill stays whole, an arrow keeps its head at the drawn end.
- attached clips: `clip.parent` is the id of another clip (or a camera). the renderer draws a child at its
  world pose (`engine/parent.ts` `worldTransform`): the parent's pose after keyframes and motions, at the
  time clamped into the parent's range, composed down the chain. a parent does not have to be visible.
  a camera parent pins a 3d clip to the lens (a hud). when ui code attaches or detaches a clip it writes
  the transform from `reparentTransform` in the same undo step so the clip stays where it is on screen.
  drags convert pointer deltas with `worldDeltaToLocal`.
- a clip's picture goes through, in this order: the clip look (`clip.adjust`, `clip.chromaKey`), the mask
  (`clip.mask`), then crop / corners / placement / blend. both helpers return a canvas that is only valid
  until the next call on the same channel ('preview' or 'export'), so cache keys for textures include
  `clipLookSignature` and `maskSignature`.
- per-clip motion blur (`clip.motionBlur`): the clip is painted several times at sub-frame times and
  averaged. only its placement is sampled, the picture stays the one of the frame. a 3d clip is drawn as
  its own 3d run once per sample into the same accumulator (the camera is not sampled: a camera move is
  blurred by the motion blur effect layer).
- depth of field (`CameraClip.focusStrength` and friends): the camera rig carries a focus (distance, range,
  strength; `engine/scene3d/focus.ts`). the 3d renderer blurs each fragment by how far it is from the focus
  distance (a disc of taps read at a matching mip level, the amount a share of the frame height so every
  backing size looks the same) and fades the mesh edge by the same amount. off = no extra cost. the scene
  view never shows it, flat 2d layers are never blurred.
- look at: a 3d clip can turn toward the camera (`lookAt` 'camera' / 'cameraY') or toward another clip
  ('clip' + `lookTarget`). it is applied last, in the world.
- fog (`project.fog`): 3d clips fade into a color with distance from the camera. 2d clips are untouched.
- groups (`clip.group`) are a selection aid only: clicking one member selects all of them.
- a split keeps the picture: clips that point at a cut clip (parent, look target, camera target, effect
  target) and lie after the cut are re-pointed to the right half (`repointSplitDependents`).
  `duplicateClips(ids, { sameTime })` makes copies that keep their time and go on a track above (alt + drag
  in the scene view).
- an effect on one clip (`EffectClip.target`): the effect is skipped by the adjustment layer walk. when its
  target is drawn, that clip is painted alone into a scratch canvas, the effects run on it and the result is
  laid into the stack with the clip's blend mode. effects that only move or mix pixels (categories blur and
  distortion) run on the premultiplied picture, and the same pass runs once more over the clip's alpha as a
  grey picture to get the new alpha: a blur on a text goes soft at the edges and keeps its colour. every
  other category runs un-premultiplied and is cut back to the clip's old outline. the two tracks can be
  anywhere in the stack. a 3d target is drawn as a run of its own. temporal effects with a target do nothing.
  a clip drawn frozen by a transition (before its start / after its end) keeps the effects of its edge frame.
- per-clip motion blur kinds (`clip.motionBlur.style`): 'even' averages the open shutter, 'trail' keeps the
  clip sharp and leaves a tail fading into the past, 'ghost' draws a few separate copies behind it.
- running numbers (`TextClip.counter`): `resolveVisual` writes the number into the text right after the
  keyframes (`resolveCounter`), so layout, caches and overlays see a plain text clip. ui code that measures
  a text clip does the same (`features/preview/attached.ts` `resolveShown`).
- things that run over the length of a clip carry on across a cut: a split and a head trim write `offset` +
  `fullDuration` on the counter, on the karaoke highlight (`TextHighlight`, read by `highlightProgress`) and
  `timeOffset` + `fullDuration` on effect clips, so both halves show what the whole clip showed.
- playback speed: the clock advances by `dt * rate` (`store/playback.ts`). the frame renderer never sees
  the rate. the preview's media elements follow it (playbackRate forward, pause + seek backwards, audio
  muted backwards and above 4x). the export ignores it.
- `releaseRenderResources(channel)` frees everything a channel holds (scratch canvases, clip look, masks,
  the 3d renderer, effect and transition runners). the export calls it when it ends; everything is rebuilt
  on the next use. channels: 'default' (the preview), 'export' (an OffscreenCanvas) and 'inset' (the small
  camera picture in the scene view, marked with `setCanvasChannel`), so they never resize each other's canvases.

## store rules

- the project is immutable. edit only through `useEditor` actions. never mutate objects you read from the store.
- every action records an undo step unless called with `{ skipHistory: true }`.
  for a drag / slider scrub: call `pushHistory()` once when the gesture really starts, then pass
  `skipHistory: true` on every update. one gesture = one undo step.
- `pushHistory()` only opens the step: it is written with the first `skipHistory` change that follows, so a
  gesture that changes nothing leaves undo and redo exactly as they were. to take back a half done gesture
  (escape during a drag, a plan that failed) call `rollback()`, never `undo()`: it only removes what was
  written since the last `pushHistory()`. undo and redo bring back the selection the step was made with.
- ids that point at other clips (`parent`, `lookTarget`, a camera's target, `group`) are kept right by the
  store: delete unlinks, duplicate and paste relink to the copies, `updateClip` refuses a parent loop.
  read them through `lib/links.ts`, which also guards against loops in old data.
- placement goes through `moveClips` / `trimClip` / `setClipSpeed` / `insertAsset` / `addText`.
  `updateClip` ignores `start`, `duration`, `trackId`, `trimStart`, `speed`.
- zustand v5: a selector must return a stable reference. `useEditor(s => s.project.clips.filter(...))`
  causes an infinite render loop. select the stable slice and derive with `useMemo`, or use
  `useShallow` from `zustand/react/shallow`, or the hooks exported at the bottom of editorStore.ts
  (`useProject`, `useSelectedClips`, `useClip`, `useAsset`, `useCanUndo`, `useCanRedo`).
- outside react (event handlers, engines) use `useEditor.getState()` / `usePlayback.getState()`.

## performance rules (these are requirements, not suggestions)

the editor has an on-screen fps counter. it has to stay at the display refresh rate while playing,
scrubbing, dragging clips and zooming, with dozens of clips.

1. no react state updates per animation frame. `usePlayback` `time` changes every frame while playing:
   never select it in a component that renders more than a tiny leaf. for the playhead, timecode text,
   canvas redraws etc. use `usePlayback.subscribe(...)` and write to the dom / canvas directly through refs.
2. moving things (playhead, drag ghosts, snap lines) are positioned with `transform: translate3d(...)`,
   not `left/top/width`, and never trigger layout of their siblings.
3. components that render per clip / per track / per asset are wrapped in `React.memo` and receive stable
   props (the clip object itself, primitives, stable callbacks). dragging one clip must not re-render the others.
4. pointer-move work is coalesced to one update per animation frame (requestAnimationFrame throttle).
5. no layout reads (`getBoundingClientRect`, `offsetWidth`...) inside per-frame loops. measure once at
   gesture start or with a `ResizeObserver`.
6. canvases: backing store = css size x devicePixelRatio, capped so it never exceeds what is useful
   (the preview never allocates more pixels than the project resolution). redraw only when something changed.
   long timeline canvases only draw the visible range.
7. heavy work stays off the interaction path: thumbnails, filmstrips and waveforms are computed lazily,
   one at a time, cached per asset, and never block a drag or playback. decode/peaks work yields to the
   main thread (or runs in a worker).
8. media elements are pooled and reused. while playing, do not seek a video every frame: let it play and only
   correct when it drifts (> ~0.15 s) from the clock.
9. event listeners on `wheel`/`touch` that do not call preventDefault are passive. clean up every listener,
   observer, object url, raf and ImageBitmap you create.

## visual rules (monochrome, high contrast, flat)

- the ui is monochrome: neutral grays, white accent on the black theme and black accent on the white theme.
  `lib/appearance.ts` sets `data-theme="dark|light"` on `<html>` (auto follows the system) and an optional
  tint (`--tint-h`, `--tint-s`) that every token in `styles/theme.css` mixes in. the user controls both in settings.
- every color must work in BOTH themes and with any tint. colors only through the tokens in `styles/theme.css`:
  never hardcode hex/rgb/oklch values in component css or inline styles. the only non-gray tokens are
  `--danger`, `--warn` (destructive actions, the fps health dot).
- no glow of any kind: no `box-shadow`, `text-shadow`, `filter: blur/drop-shadow`, `backdrop-filter`.
- no gradients. solid fills only. depth = surface tokens + 1px borders.
- canvases that draw with token colors read them through a resolver that is invalidated on the
  `ncut:appearance` window event (see `features/timeline/view.ts` cssVar) and redraw.
- the font is kode mono everywhere (`--font`, bundled via @fontsource/kode-mono). it is monospace and wide:
  labels must truncate with ellipsis instead of overflowing. 12px base text, compact 28px controls, small radii, lowercase copy, no emojis.
- reuse the classes from `styles/base.css` and the components in `components/ui/` before writing new control styles.
- icons: `lucide-react`, 14-16px. check an icon exists in the installed version before using it.
- every interactive control has a `title` (tooltip) and works with the keyboard. focus ring = the global 1px accent outline.

## feature css

each feature keeps its own stylesheet next to its components (for example `features/timeline/timeline.css`)
and imports it from its root component. prefix class names with the feature name (`.timeline-...`, `.media-...`)
to avoid collisions. do not edit `theme.css` / `base.css` from a feature: if a token or shared class is missing,
add it locally and mention it in your report.

## dev hook

in dev builds `window.__ncut = { useEditor, usePlayback, useUi, session, importFiles, fx }` is available for testing.
`fx` has the effect and transition registries plus `checkEffects()` / `checkTransitions()`, which compile
every shader in the browser and return the ones that fail (an empty list = all good).
