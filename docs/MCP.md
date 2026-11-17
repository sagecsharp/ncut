# mcp server (desktop app)

the desktop app can run a small [model context protocol](https://modelcontextprotocol.io) server, so an mcp client
(claude code, claude desktop, anything that speaks mcp) can work in the open editor window: open or make a project,
import media, add clips / text / shapes / effects / cameras, set transforms and keyframes, put clips on the sides
of a solid, look at a frame, export. it is **off by default** and exists only in the exe (a browser tab has no way
to listen on a port).

## for the user

- turn it on: settings (the gear button in the editor header or on the projects screen, ctrl+,) -> "mcp server".
- claude code: press "copy claude code command" and run it in a terminal. it looks like
  `claude mcp add --transport http ncut http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"`.
- other http clients: "copy http config" (url + the Authorization header).
- clients that only do stdio: "copy stdio config". it runs `node <userData>/mcp-bridge.cjs`, a small script the app
  writes next to its settings. it needs node on the path. the token is not in that config, the script reads it.
- "new token" makes every old config stop working.
- ncut has to be running, with the server on. tools act on the project that is open in the window, and every
  edit is a normal undo step (except media imports and removals and deleting a project, which cannot be undone; the in and out points and media marks are not undo steps either, and neither is a track height: `update_track` with only `height` is a view setting, undo keeps the heights).
- while a client works you see its cursor in the window, with a name tag (see "cursors"). "show cursors" under the server switch turns that off.

## shape

```
mcp client --http (127.0.0.1, bearer token)--> electron main (electron/mcp.cjs)
                                                   | ipc (ncut:mcp-call / ncut:mcp-reply)
                                                   v
                                              the page (src/mcp/**): the tools, run against the stores
```

- main owns the socket, the token, the files and the clipboard. the page owns the tools.
- the page never sees the token and never sends or gets a path. main reads the files a tool needs and hands over
  bytes; a file a tool makes leaves through the normal download path and main picks where it goes.
- main only uses electron and node builtins (node_modules is not packaged). no dependency was added.

## the http side (electron/mcp.cjs, pure rules in electron/mcpRules.cjs)

transport: "streamable http", protocol versions `2025-06-18`, `2025-03-26`, `2024-11-05`. one endpoint: `POST /mcp`.
no sessions, no sse, no batches: every POST carries one json-rpc message and a request is answered with one
`application/json` body.

- listens on `127.0.0.1` only. port: kept in `<userData>/mcp.json` (`{ enabled, port, token }`); first run tries
  `41713`, then the next 20, then any free one. a saved port that is taken -> another one is picked and saved, and a new token is made with it (old client configs point at the old port, whatever sits there now must not get a working token).
- token: 32 random bytes, base64url, made on first enable, kept in `mcp.json`.
- every request, in this order (first failure answers):
  1. path is `/mcp`, else 404. method is POST, else 405 with `Allow: POST`.
  2. `Host` is `127.0.0.1:<port>` or `localhost:<port>`, else 403 (dns rebinding).
  3. no `Origin` header at all, else 403 (a browser page never gets in, token or not).
  4. `Authorization: Bearer <token>`, compared in constant time, else 401 with `WWW-Authenticate: Bearer`.
  5. `Content-Type` is `application/json`, else 415. body at most 1 MiB, else 413.
  6. `MCP-Protocol-Version`, when sent, is one of ours, else 400.
  7. the body is one json-rpc 2.0 object: bad json -> 400 with error -32700, an array or a wrong shape -> 400 with -32600.
- a notification or a response -> 202, no body. a request -> 200 with the json-rpc response.
- methods: `initialize` (answers the asked version when it is one of ours, else `2025-06-18`; capabilities
  `{ tools: { listChanged: false } }`; serverInfo `{ name: 'ncut', title: 'ncut', version }`; instructions),
  `ping`, `tools/list`, `tools/call`. anything else -> error -32601.
- `tools/list` and `tools/call` are relayed to the page. no window, the page not ready, or no answer in time
  (10 s for a list, 180 s for a call): a call gets a tool result with `isError` that says so, a list gets error -32000
  (a list answer has to hold a tool list). the page says the tool name is unknown -> error -32602.
  at most 8 calls wait at once (-32000 beyond). a reload, a crash or the closing of the window fails the calls that wait on it at once (a tool result with isError "the ncut window was reloaded or closed while this ran", a list gets -32000). turning the server off does the same, also for a call that is still reading files.
- batches are refused for every version (2025-03-26 allowed them; no client in use sends them).
- no cors headers, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, at most 16 sockets, a header that takes more than 3 s ends the connection (checked every 2 s), a request more than 30 s.
- nothing about a request is logged with its token.

## ipc (preload: `window.ncutShell.mcp`, page wrapper: `shell.mcp` in src/lib/shell.ts)

every handler goes through main's `trustedWindow` check like the other channels.

page -> main, invoke:
- `ncut:mcp-state` () -> McpState `{ enabled, running, port, error, bridge }` (never the token)
- `ncut:mcp-enable` (on: boolean) -> McpState. on: makes the token when missing, writes the bridge script, listens. off: closes the server.
- `ncut:mcp-rotate` () -> McpState. new token.
- `ncut:mcp-copy` (kind: 'claude' | 'http' | 'stdio') -> boolean. main builds the text and writes the clipboard, only while the main window is focused (else false, the clipboard is never cleared afterwards). any other kind -> false.
- `ncut:mcp-save` (ticket: number) -> `{ ok, name }`. see "files a tool makes".

page -> main, send:
- `ncut:mcp-reply` (id: number, json: string). json is at most 24 MiB of text.
  - for a list call: `{ "tools": [ { name, title, description, inputSchema, annotations? } ] }`
  - for a tool call: `{ "content": [ { type: 'text', text } | { type: 'image', data, mimeType } ], "isError"?: boolean, "saved"?: number | null }`
    or `{ "unknown": true }` when there is no such tool.
  - main checks the shape again, drops every other field, and for `saved` adds a text item `saved to <full path>`
    when it holds a finished file for that ticket.

main -> page:
- `ncut:mcp-changed` (McpState)
- `ncut:mcp-call` `{ id, kind: 'list' | 'call', name, args, files: [{ name, bytes }], ticket: number | null }`

### files a tool needs (main reads them)

two tools take paths. main checks and reads them, removes the argument, and passes `files` instead (`name` is the base name):
- `import_media` `{ paths: string[] }`: 1 to 16 files. extensions: the importer's list (mp4 m4v mov webm mkv ogv avi ts mts 3gp,
  mp3 wav ogg oga m4a aac flac opus weba aiff aif, png jpg jpeg gif webp bmp avif svg, cube).
- `import_project` `{ path: string }`: one `.ncut` file.

a path has to be absolute with a drive letter (`C:\...` or `C:/...`). no unc (`\\server\share`), no device paths
(`\\?\`, `\\.\`), no nul. it has to be a plain file. at most 1 GiB per call and 1 GiB for all calls together (counted from the file sizes until the call settles; above it a tool result with isError says other imports are still being read). a bad path -> a tool result with
`isError` naming the path and the reason; the page is not asked.

### files a tool makes (main saves them)

`export_video` and `save_grade_lut` get a `ticket` (the call's id) with their call. when the file is ready the page calls
`shell.mcp.save(ticket)` and then starts a normal download named `ncut-mcp-<ticket>-<file name>`
(`mcpDownloadName` in src/lib/shell.ts). main's download handler sees the marker: an armed ticket -> the file goes to
the save folder (the last folder the user saved to, else Downloads) under `<file name>` (cleaned like every download,
never over an existing file: ` (2)`, ` (3)` ... are added), no dialog. only the extensions export_video and save_grade_lut make are
saved this way (mp4 webm gif wav ogg png jpg cube, any case): anything else is cancelled and the invoke resolves not ok. the invoke resolves with `{ ok, name }` when the
download ended. a marked download without an armed ticket is cancelled. a ticket works once, is only given to
`export_video` and `save_grade_lut`, and lapses after 12 hours; at most 8 are open (a full map drops the oldest unarmed ticket first, an armed one only when there is none). a ticket whose call ended in an error before it was armed is dropped at once. main remembers the full path per ticket so a later
`export_status` answer with `saved: <ticket>` gets the path added. `save_grade_lut` answers with `saved: <ticket>` in its own result, and the shell adds the path the same way.

## the tools (src/mcp/**)

`src/mcp/types.ts` (ToolDef), `cursor.ts` + `cursorRun.ts` (the cursor argument and what each call points at), `validate.ts` (arguments against the schema, unknown fields are errors), `helpers.ts`
(ok / fail / ToolError / needProject / needClip / oneStep ...), `registry.ts` (TOOLS, listTools, callTool),
`dispatch.ts` (startMcp: tool calls run one at a time in the order they came, the tool list is answered at once,
a call that waited or ran past 170 s is answered as failed). in a dev build `window.__ncut.mcp` has
`listTools` and `callTool` for trying tools without the exe.

rules for every tool:
- every tool takes an optional `cursor` (a short name, see "cursors"). `callTool` takes it off before the validation, so a tool never sees it and still refuses unknown fields.
- times are timeline seconds unless a field says otherwise (at most 86400, a day). sizes and positions are project pixels. x 0 / y 0 is the middle of the canvas.
- a value outside its range, a made up id (blend mode, transition, motion, clip) or an object of the wrong shape is refused with the reason, never clamped or stored as it came. a nested object may be given in part: it is laid over what the clip has.
- a tool that changes the project makes exactly one undo step (helpers `oneStep`). media and stored projects are not part of the history: `import_media`, `remove_media` and `delete_project` make none and cannot be undone, and `remove_media` can clear the history (its answer says so in `undoCleared`). `set_range` and `set_media_marks` make none either: the in and out points and media marks are not part of the history. `update_track` with only `height` makes none (a view setting: undo keeps the heights). `measure_loudness`, `sample_keyframes` and `save_grade_lut` change nothing in the project.
- nothing is done silently: a refused edit (locked track, unknown id, a value that changed nothing) is an error result that says why and what to call instead.
- answers are compact json text. ids are the app's own ids (`get_project` lists them).
- tools never open dialogs and never show toasts for their own errors.

project and view (tools/project.ts):
- `get_state` {}: app version, the open project (id, name, size, fps, duration, counts) or null, playhead time, selected ids, save state, whether an export runs, how many undo / redo steps, `timeDisplay` ('timecode' | 'frames' | 'seconds', how the editor shows times; no tool sets it) and `source` (what the source view shows: media, time, playing, active) or null.
- `list_projects` {}: the stored projects, newest first.
- `open_project` { id }: the project that is already open is not opened again (the answer says so, the undo history stays).
- `create_project` { name?, preset?: '16:9' | '9:16' | '1:1' | '4:3' | '4:5' | '21:9', width?, height?, fps? }: makes and opens it.
- `close_project` {}: back to the projects screen (saved first).
- `delete_project` { id, name, updated? }: deletes a stored project and its media for good. `name` must be the project's exact name (from `list_projects`), so a wrong id cannot delete the wrong project. when other projects share that name, `updated` from `list_projects` must match too. when it is the open project, it is closed first (another open project stays open). refused while an export runs. there is no undo for it.
- `update_project` { name?, width?, height?, fps?, background?, fog?, light?, sky?, output? }: `output` { volume? or volumeDb? } or null: the level of the whole mix, what gets exported (null = 0 db), with update_track's ranges. the answer carries `output` when set. `fog` is haze over the 3d space { color, near, far, amount } (3d clips blend toward the color the farther they are from the camera, 2d clips are never fogged). `null` switches it off, an object may be given in part. the answer carries `fog` (the object or null), and so does `get_project`. `light` is what 3d clips with `lit` are shaded by { sky, horizon, ground, sun, sunColor, sunTurn, sunHeight }: three hex colors for the sky dome, a sun share 0..1 with its color, its turn (-180..180, 0 = behind the camera, 90 = right) and its height (0..90). `null` takes the light from the sky when there is one, else from the scene (the background, the filled 2d shapes under the lowest 3d clip and the fog; pictures, video and text are not read). light only darkens or tints: on a black background with no own light lit 1 is black and 0.75 keeps about half, so give a bright background, a 2d shape under the 3d clips or an own light. an object may be given in part (laid over the own light, or when there is none over the scene's sky, horizon and ground at the playhead plus a default sun: sun 0.4, sunColor #fff4e0, sunTurn -35, sunHeight 45; send sun 0 for the dome alone). the answer and `get_project` carry `light` (the object or null). `sky` is a skybox from image media: `{ media }` (1 cross or strip picture, or 6 side pictures named like px or right, word names get a seam check that may swap left and right or turn the top and bottom, `notes` says what it did) or `{ faces, turns? }` in side order (right, left, top, bottom, front, back), plus `turn` (-180..180, like a pan), `brightness` (0..2) and `blur` (0..1), alone or with it. lit 3d clips take their light from the sky unless there is an own light; that light is measured and cannot be sent. `null` takes it off. with a sky, a partial light over no own light starts from the light the sky gives, sun included.
- `get_project` {}: tracks top to bottom (id, kind, name, muted / hidden / locked; tracks show volume, volumeDb and pan, `height` (px) and `syncLock: false`, and the project its output, only when set), every clip as a short line (helpers `clipBrief`; a video or audio clip with a sound crossfade carries `crossfade` as stored), media (id, name, kind, duration, size, `marks` only when set, and for a lut media `lut: { size3, size1, title? }`), markers, `range` (the in and out points, or null), fog and light (the object or null), `autoLight` (sky, horizon and ground the scene would give at the playhead, also while an own light is set: then lit clips get `light`, not `autoLight`), duration. `sky` (the object or null, `missing: true` when its pictures are gone; with a sky `autoLight` is the sky's).
- `get_clip` { id }: the whole clip as stored, plus `animatable` (prop, label, min, max, unit) and, for a solid, its side names, and `pair` for one side of a separated sound pair, and for a clip that is the matte of others `matteOf`: their ids.
- `select_clips` { ids }, `undo` { steps? }, `redo` { steps? }
- `seek` { time } or { frame } or { edit: 'previous' | 'next' }: give exactly one. frame counts at the project fps, edit goes to the previous or next clip start or end like up / down (on the selected clips' tracks, else all). the answer has time, frame and duration. playback is not paused.
- `add_track` { kind: 'video' | 'audio', index?, name? }, `update_track` { id, name?, muted?, hidden?, locked?, syncLock?, volume?, volumeDb?, pan?, height?, index? }: volume (linear, 0..3.98, 1 = as recorded) or volumeDb (at most 12, -90 or less = off), not both, set the track fader. pan: -1 left .. 1 right. both apply to the preview and the export. solo is for listening in the app only and has no tool. `height`: row height on the timeline in px, 28 to 240, or null for the normal height (56 video, 48 audio); a view setting, not an undo step (else the error `height must be 28 to 240 px, or null for the normal height`). `index`: new position in the track list (0 = top), clamped inside the video or audio group; for video tracks the order is what draws on top. a track that is locked after this call's own patch refuses it (`the track {id} ({name}) is locked. unlock it with update_track first`). `syncLock`: on (default): ripple, insert and extract on other tracks move this track too; false: it stays where it is unless the edit is on it. the changes of one call (patch and move) are one undo step. nothing sent: `nothing to change: send name, muted, hidden, locked, syncLock, volume, volumeDb, pan, height or index`; nothing that would change anything: the error says the track already has those settings. answers { id, kind, name, muted, hidden, locked, index, height, syncLock, volume, volumeDb, pan }. `remove_track` { id } (takes its clips with it; a locked track is refused)
- `add_marker` { time, name? }, `remove_marker` { id }
- `set_range` { in?, out?, clip?, clear?: 'in' | 'out' | 'both' }: the timeline in and out points (frame snapped; clip marks a clip's edges). not an undo step. edit_media uses them when it gets no at / until, then clears them. `get_project` shows `range`.

choices (tools/catalog.ts):
- `list_options` { kind, category? }: `effects` (id, name, category, alpha, params with min / max / default / options), `transitions`, `text_presets`,
  `shape_presets`, `shapes` (2d kinds, 3d shapes and the side names of each), `motions` (clip in / out / loop, text in / out / loop),
  `fonts`, `enums` (blend modes, mask shapes, eases, fade shapes, look at, fits, canvas presets, fps; the eases include `bezier`, label 'custom (handles)'; fade shapes are `fadeShapes`: power, linear, smooth), `fields` (what `update_clip` takes per clip type, with units and ranges).
  alpha is keep, moves or own: what the effect does to the outline of a clip it is put on.

media (tools/media.ts):
- `import_media` { paths }: adds the files to the open project's media. answers the new media and, for every file that was skipped, its name and why. when the new files look like a skybox, `looksLikeSky` holds their ids for `update_project` sky.media. a .cube file (1d, 3d or both, up to 65 points per side) becomes media of kind `lut` with `lut: { size3, size1, title? }` (the answer and the media of `get_project` show it), for `update_clip` `grade.lut`. there is no `list_media` tool: `get_project` lists the media.
- `import_project` { path }: adds a .ncut file as a new project. answers its id (not opened).
- `add_media_clip` { asset, track?, start?, in?, out?, parts? }: a clip of that media; in / out (else the media's marks) take a part, parts `picture` / `sound` one half.
- `edit_media` { asset, mode, track?, sound_track?, at?, until?, in?, out?, parts?, sound_apart?, clip?, source_time? }: a three point edit like f9 / f10: insert (the clips after the edit point move later on every unlocked track with sync lock on and on the tracks it lands on; the answer adds `syncOffTracks` (track ids) and `outOfSync` (clip ids) when there are any), overwrite, fit (the speed that fills at to until), replace (frame matched, same length) or append. one undo step. without at / until it uses the project's in and out points and clears them.
- `set_media_marks` { asset, in?, out?, clear? }: a media's in and out, like i and o in the source view. not an undo step.
- `match_frame` { clip?, time? }: the clip's media in the source view at the same frame, its used part marked. the playhead does not move, playback pauses.
- `replace_media` { id, asset }: the clip shows other media of the same kind (an audio clip also takes a video with sound).
- `remove_media` { ids? | unused?, with_clips? }: removes media and its stored file for good, not undoable. `unused: true` takes every media no clip uses. media that clips use is refused unless `with_clips: true`, which deletes those clips too and clears the undo history. it is refused when one of those clips is on a locked track. refused while an export runs. `unused: true` is also refused while files are being imported. answers what was removed, clips, undoCleared and the media left. a picture of the sky is refused (take the sky off first), `unused: true` never takes the sky's pictures. a lut is taken off every grade that uses it.
- `add_media_clip`, `edit_media`, `set_media_marks` and `match_frame` refuse a lut (the given media, or the clip's): `the media ${id} is a lut: it is not a clip. put it on a clip with update_clip { grade: { lut: { media: '${id}' } } }`.
- `save_grade_lut` { clip, size?: 17 | 33 | 65, time? }: writes the color and grade of one clip (adjust, wheels, curves and its lut, at the playhead or at `time`) as a .cube 3d lut for other apps. clip: a video, image, text or shape clip, or a grade effect. size 17, 33 or 65 (default 33). the key, masks and effects are not in it. in the desktop app the file goes to the save folder and its path is added to the answer; elsewhere nothing is written and the answer gives size, rows and a hash. answers { clip, file, size, rows, sha (24 hex of sha-256), saved: true | false, lutLeftOut? }. with a ticket the answer carries `saved: <ticket>` and the shell adds the path, like `export_status`; when the file could not be saved, `saved` is false with a note and no dialog opens. errors: `no clip ${id}`, `the clip ${id} is ${type}: it has no picture to grade`, and the text of the app's own "nothing to save" case. changes nothing in the project.

new clips (tools/add.ts):
- `add_text` { text?, preset?, track?, start?, duration?, fields? }
- `add_shape` { preset?, kind?, shape3d?, track?, start?, duration?, fields? }
- `add_effect` { effect, track?, start?, duration?, target?, amount?, params? }: chroma-key (alpha own) without
  target keys the video or image clip right under it, not the whole picture. grade: color wheels, curves and a lut over everything below (or its target). set them with update_clip grade.
- `add_camera` { track?, start?, duration?, fields? }
`fields` is the same thing `update_clip` takes as `patch`, applied in the same undo step. when the clip could not go where it was asked
(the spot was taken) the answer has a `note` that says where it went.

edits (tools/edit.ts):
- `update_clip` { id, patch }: any stored field of the clip (tools/editCheck.ts knows what each may hold). `transform` is a partial transform, an effect's
  `params` are checked against the effect and its ranges, `speed` re-times the clip. `start`, `duration`, `trimStart`, the track, `keyframes`, the sides,
  the media (`assetId`), the group and the effect id are refused with the name of the tool that does it. a property that has keyframes is refused too
  (the keys decide its value). the answer lists the fields that changed; a patch that changes nothing is an error. `lit` (0..1, 3d clips only, 0 = unlit, null = off, what the inspector switch writes when off, 0.75 is what the inspector switch sets when on) shades a clip with the light of the scene (see `update_project` `light`); it can be keyed. light only darkens or tints: on a black background with no own light lit 1 is black.
  `bend` { angle, along?, center?, span? } rolls a picture round a tube (planes only, a 3d solid ignores it); it can be keyed as `bend.angle` (`bend_clips` bends several clips as one).
  `pivot` ({ x, y } in fractions of the clip's own box from its middle, -0.5 = left / top edge, or a spot name like `left`, null = the middle) is the point the clip rotates and scales around, and its x / y / z say where that point is.
  `pivot` and `parent` keep the clip and the clips attached to it where they are on screen at the playhead unless `transform` is in the same patch; the answer then lists the attached clips it moved in `moved`. a clip that looks at something looks from its pivot, so a new pivot can turn and shift a big picture a little, and a ready-made motion is not counted in the place that is kept.
  a rig, for example an arm: three shapes, each with pivot `left`; attach the second to the first and the third to the second (it stays in place); then key or loop each one's rotation.
  `pan` (video and audio clips, -1 left .. 1 right, 0 = the middle) places the clip's sound, times the track's pan. it can be keyed as `pan`.
  `grade` { liftR .. offsetY, curves, lut, off } or null: a color grade after the color correction, on picture clips and the grade effect clip. 16 wheel numbers liftR, liftG, liftB, liftY, then gamma, gain, offset the same: -1..1, 0 = no change, R G B push one channel, Y is the level. lift moves the darks, gamma the middle, gain the lights, offset everything. a partial grade lies over the current one. a wheel's dot at (x, y) on the unit disc (laid out like the vectorscope, red up left) is r = 0.3937 y, b = 0.4639 x, g = -0.0468 x - 0.1170 y. `curves` { y, r, g, b, hueSat, hueHue, lumaSat }: lists of [x, y] points 0..1, at most 16, null drops one. hue x runs red 0, yellow 0.2, green 0.35, cyan 0.5, blue 0.7, magenta 0.85 and wraps; on hueSat, hueHue and lumaSat y 0.5 keeps. `lut` { media, mix 0..1, last, tv } or null: a .cube from the media (`import_media`). last: true runs it after the curves, else before the wheels. tv: true for a lut made for 16 to 235. a lut that is missing or cannot be read is left out. a partial lut lies over the current one, null takes it off. refusals: `no media ${id}`, `the media ${id} is ${kind}, not a lut. import a .cube file with import_media`, and without a current lut `grade.lut needs media: the id of a lut (import a .cube file with import_media)`. `off: true` keeps the grade but hides it, the export too. the wheel numbers key as `grade.liftR` .. `grade.offsetY`, curves do not. a keyed wheel number, and null while grade keys exist, are refused: clear_keyframes first. warm lights, cool darks: { "gainR": 0.06, "gainB": -0.04, "liftR": -0.02, "liftB": 0.04 }.
  `matte` { clip, mode } or null: cut this clip with another picture clip, its matte. clip = a video, image, text or shape clip id, mode alpha (default, inside its outline) | alpha-inv (outside it) | luma (where it is bright) | luma-inv (where it is dark). the matte clip is not drawn on its own and is read at its own time: where it does not play, alpha and luma hide this clip, the inverted modes show it all. a matte clip cannot have a matte. null = no matte. not keyable. the matte clip's keys, effects and 3d shape the matte. a partial matte lies over the current one (`matte` with only `mode` needs a matte already; without one the error is "matte also needs clip"). refused: a clip that is not a picture clip, itself or a gone clip as the matte, a matte that is not a picture clip, a matte clip that has a matte of its own, a clip that is the matte of another clip, a stored chain, and a locked track. deleting the matte clip takes the matte off. `get_clip` of a matte clip names the clips it cuts in `matteOf`.
- `set_sides` { id, sides }: what a 3d solid shows per side: `{ "front": { "clip": id, "fit"?: 'fill' | 'fit' | 'stretch' }, "top": { "color": "#rrggbb" }, "all": ..., "back": null }`.
  null = that side shows the solid's own picture again. the names come from `get_clip` / `list_options shapes`; a shape with one side (sphere, ring, capsule)
  takes `all`. a clip that shows this solid on one of its own sides is refused as a source (two solids would hide each other).
- `move_clip` { id, start?, track? }, `nudge_clips` { ids, frames }, `trim_clip` { id, edge: 'start' | 'end', time, mode?: 'trim' | 'ripple' | 'move-edit' | 'stretch', alone? }, `slip_clip` { id, by? | trim_start?, alone? }, `slide_clip` { id, by? | start?, alone? }
- trim_clip modes: ripple also moves everything after the edit on unlocked tracks with sync lock on (always the trimmed clip's own track), so no gap opens; the answer adds `sync_off_tracks` (names of the tracks with sync lock off that stayed) and `out_of_sync` (names of the clips that are out of sync now), each only when not empty. move-edit moves the edit, stretch changes the speed. group mates come along unless alone; a stop short says why in note.
- `nudge_clips` moves clips a whole number of frames (+ later) like alt+left / alt+right, all or nothing, one undo step. group mates are not added.
- typed times in the editor: a time = seek, an amount on the playhead = seek, on clips = nudge_clips, on a selected edge = trim_clip mode ripple (an edit with both sides selected: mode move-edit).
- `split_clips` { time, ids? }, `delete_clips` { ids, ripple? }, `duplicate_clips` { ids, same_time? }
- `lift_range` {}, `extract_range` {}: take out what is between in and out on unlocked tracks in one undo step. lift leaves the gap. extract closes it: every clip on every unlocked track with sync lock on after the out point moves left by the same amount; locked tracks and tracks with sync lock off stay. the extract answer adds `syncOffTracks` (how many) and `outOfSync` (clip names) when set; when only clips of tracks with sync lock off are inside the range, extract is refused and the error says so. the playhead goes to the in point.
- `group_clips` { ids }, `ungroup_clips` { ids }
- `bend_clips` { ids, angle, along?, together?, middle?, key?, time? }: bends clips round a tube like a cinema screen in one undo step. `angle` -360..360 deg over the whole bent length (+ brings the ends toward the camera, - pushes them away, 360 = a ring). `together` (default true, two or more clips) groups them and bends them as one surface, `together` false bends each round its own middle. `along` width | height, `middle` -0.5..0.5 = where the row stays flat. `key` true writes a keyframe at `time` (default the playhead). angle 0 without `key` takes the bend off. 3d solids are skipped. answers { bent, skipped: [{ id, why }], together, along, angle, onePlane, group }.

sound (tools/sound.ts):
- `separate_sound` { ids, track? }: the sound of video clips becomes a clip of its own on an audio track (same file, part, time, speed, volume, mute, fades, volume and pan and their keys, tempo), the video clip is muted, both share a group. track: the audio track to use (it must not be locked, and needs room and the video track's mute, volume and pan, else the sound goes to another track and the answer has a `note`). one undo step, the exported sound stays the same. answers { pairs: [{ picture, sound, track }], skipped: [{ id, why }], note? }.
- `join_sound` { ids }: picture or sound ids. the sound clip goes, the picture plays its own sound again. only pairs in sync, at one speed, of one length, with the same fades and track sound; the rest is in `skipped`. answers { joined, removed, skipped }.
- `sync_sound` { ids, how?: 'move' | 'slip' | 'speed' }: lines picture and sound up again; with both sides named the sound clip changes. answers { synced, skipped }.
- `crossfade_edits` { ids?, at?: 'start' | 'end' | 'both', track?, length?, before?, after?, place?, shape?, withTransition?, remove? }: adds, changes or removes the sound crossfade at edits: `ids` (1..500 clips with sound, `at` "start", "end" or "both") or a `track` (every edit there but inside one take). new: 0.25 s, equal power, centered. `length` is the total in seconds, `before` / `after` (0..10 s each) set the sides, `place` 'center' | 'start' | 'end' moves the crossfade over the edit, `shape` 'power' | 'linear' | 'smooth', `withTransition` makes the sides follow the clip's transition, `remove: true` takes crossfades away. `ids` with `track`, or `length` with `before` / `after`, is an error. the answer says what fits. one undo step. answers { set: [{ clip, edit, before, after, shape, short? }], removed, skipped: [{ id, why }] }.
a sound clip is an audio clip whose media is a video. `get_clip` of a pair has `pair` { other, offset } (seconds, + = this clip later) (or { other, speeds: 'differ' } when their speeds differ). `replace_media` on such a picture swaps its sound clips too, and an audio clip takes a video with sound. `update_clip` refuses `muted: false`, `bpm`, `beatOffset` and a changed `volume` or `pan` on a picture whose sound is apart, and `set_keyframe` / `set_keyframes` refuse keys for `volume` and `pan` there: set them on the sound clip. it refuses `crossfade`, `fadeInShape` and `fadeOutShape` there too, any value: `crossfade: the sound of this video is the clip <id> on an audio track: set it there` (the field's own name leads the text).
three more `update_clip` fields on video and audio clips (the shapes on sound only):
- `crossfade` { before, after, shape?, withTransition? } or null: the sound of the clip before fades into this one across the edit at its start, from the media past the edit. before and after are 0..10 s each side of the edit and together at least 0.001 (else `crossfade: before + after must be at least 0.001 s (null takes it away)`). shape 'power' (equal power, default), 'linear' or 'smooth'. withTransition true: the sides follow its transition. a side without media plays shorter: the answer has `crossfadePlays` { before, after, short? } (the seconds that play, `short` says why a side is short), or { waits: true } when there is no clip with sound before to fade from yet. a new crossfade starts at 0.125 before + 0.125 after, a partial one lies over the current one, null = a hard edit.
- `fadeInShape` / `fadeOutShape` ('power' | 'linear' | 'smooth' or null): the shape of the sound of fadeIn / fadeOut. linear (or null) when missing and stores no field. the picture always fades straight.

keyframes (tools/keys.ts):
- `set_keyframe` { id, prop, time, value?, ease?, in?, out? } (time on the timeline). ease 'bezier' (custom (handles)) shapes the part after the key with handles: `out` on this key, `in` on the next. a handle is `{ speed, influence }` or null: speed is value units per second right at the key, influence 0.001 to 1 is how far the handle reaches as a share of the time to the neighbour key. a handle on a part that is not bezier turns it into one with the same shape first. errors: `in must be { speed, influence } or null`, `out.influence must be between 0.001 and 1`, `out.speed must be a number between -1000000000 and 1000000000`. the keys in an answer show `in` / `out` only when set.
- `remove_keyframe` { id, prop, time }
- prop `bend.angle` keys a bend (`set_keyframe`, `set_keyframes`).
- prop `pan` keys a clip's pan; `grade.liftR` .. `grade.offsetY` key the grade wheels.
- `set_keyframes` { id, keyframes }: the whole record at once, `{ prop: [{ t, v, ease?, in?, out? }] }` with t in seconds from the clip's start, the handles checked like in `set_keyframe` (the error names the path, for example `keyframes.x[2].out.influence must be between 0.001 and 1`).
- `clear_keyframes` { id, prop? }
- `retime_keyframes` { keys: [{ id, prop?, times? }], by? | frames? | scale?, around? }: moves or stretches keyframes of one or more clips, all in one undo step. `keys` 1..200 entries: a clip id, `prop` (missing = every keyed prop of the clip) and `times` (timeline seconds of the keys, missing = every key inside the clip; a time has to be within half a frame of a key). give one of `by` (seconds), `frames` (a whole number of frames, + later) or `scale` (0 < scale <= 100, a factor on the time between the keys, around `around`, timeline seconds, default the playhead; `around` only with `scale`). not one of them: `give one of by, frames or scale`. a clip on a locked track, a unknown id or a prop without keys is an error (the last lists the keyed props). a prop without a key at a time: `no key of "${prop}" at ${time} s. it has keys at: ...`. keys that would leave the clip: `the keys would leave clip "${name}": they can move ${lo} to ${hi} s` (with scale: `scale can be ${sLo} to ${sHi} here`). a key that would land on one that is not moved: `a key of "${prop}" at ${time} s is in the way: name it too or move less`. no change: `nothing changed`. answers { moved, clips }.
- `ease_keyframes` { keys: [{ id, prop?, times? }], ease? | easy? | join? }: give exactly one of `ease`, `easy` or `join` (else `give one of ease, easy or join`). `ease` is one of the eases of `list_options` enums, 'bezier' too, set on the keys. `easy` 'both' | 'into' | 'out-of' is the easy ease: the keys get handles with speed 0 (influence 1/3), 'into' only on the part into the key (ease into), 'out-of' only on the part out of it (ease out of); a part that is a hold is kept as it is. `join: true` joins the two handles of a key to their mean, so the curve runs smooth through it. one undo step. answers { changed, clips }, and with `easy` also `holds_kept` (how many of the chosen keys kept a hold). only holds: `the keys sit next to holds: a hold has no handles`. no change: `nothing changed`. the same key rules as `retime_keyframes` (limits, locked tracks, the refusals).
- `copy_keyframes` { from, props?, to, at? }: copies the keys of `from` (a clip id, `props` missing = every keyed prop) to the clips in `to` (1..100 ids) in one undo step. `at` is the timeline time of the first copied key in each target (missing = the same place in each clip, that is the target's start plus the source's first key offset). the window's key clipboard is not touched. copying a clip onto itself needs `at` (`copying a clip onto itself needs at`). nothing landed: `no keys land inside the targets: give at inside them`. answers { pasted, clips, left_out }.
- `sample_keyframes` { id, prop, from?, to?, step? }: reads a property's value and speed over time. times are timeline seconds, default the clip's span and a step of 1 / fps; at most 2000 samples (`too many samples: use a bigger step`). answers { id, prop, unit, samples: [{ time, v, speed }] }: `v` is the value, `speed` the change per second. changes nothing in the project.

output (tools/output.ts):
- `render_frame` { time?, max_size?, levels?, scope?, transparent? }: the picture of the project at that time as a png image (longest side at most max_size, default 960, at most 1920). levels: true adds luma_min, luma_max, luma_mean (0..100), black and white (share of pixels at 0 and 100) and rgb_mean to the text. scope (waveform, parade, vectorscope or histogram) adds a second png of that scope.
  a time at or past the end gives the last frame. fonts that could not be loaded are named in the answer. `transparent`: true = no background: the png is see-through where nothing is drawn, as a transparent export makes it. levels and scopes count see-through pixels as black.
- `measure_loudness` { start?, end?, range?: 'all' | 'inout', sample_rate?: 44100 | 48000 }: renders the sound of the project (the range the export would take, with `start` / `end` or `range` like `export_video`, default 48000 Hz) and measures it. answers { integrated_lufs, range_lu, true_peak_dbtp, sample_peak_dbfs, max_momentary_lufs, max_short_term_lufs, seconds, sample_rate, start, end, cached }. `cached` is true when the numbers come from an earlier measure of the same sound. refused while an export runs (`an export is running: measure when it ends`) and without sound (`no clip with sound to measure`). it waits at most 150 s (the call limit is 180), then answers { state: 'measuring', progress, note: 'still measuring. call measure_loudness again with the same arguments' } and the run goes on into the cache. changes nothing in the project.
- `export_video` { format?: 'mp4' | 'webm' | 'gif' | 'wav' | 'ogg' | 'png' | 'jpg', quality?: 'low' | 'medium' | 'high', scale?: 1 | 0.75 | 0.5, fps?, start?, end?, range?: 'all' | 'inout', audio?, name?, codec?, bitrate_mbps?, key_seconds?, width?, height?, fit?, audio_codec?, audio_kbps?, sample_rate?, transparent?, preset?, check?, loudness_target?, peak_limit? }:
  the advanced arguments (the same choices as the advanced part of the export dialog): `codec` 'auto' | 'h264' | 'h265' | 'av1' | 'vp9' (default auto: the first this machine can encode; a webm holds vp9 or av1). `bitrate_mbps` 0.5..240 (instead of quality). `key_seconds` 0.5 | 1 | 2 | 4 | 5 | 10 (default 2). `width`, `height` 16..8192 (both or neither, a video rounds them to even). `fit` 'fit' (whole picture with bars, default) | 'fill' (edges cut). `audio_codec` 'auto' | 'aac' | 'opus' (default aac in mp4, opus in webm and ogg). `audio_kbps` 128 | 160 | 192 | 256 | 320 (default aac 128, opus 69). `sample_rate` 44100 | 48000 (default 48000, opus is always 48000). `transparent` (webm or png only: see-through where nothing is drawn). `preset` 'youtube-1080' | 'youtube-4k' | 'vimeo' | 'reels' | 'master' fills format, quality, frame rate, size and sound; given arguments win. a preset sets no loudness. `check` true = export nothing, answer what the export would make.
  `loudness_target` (-36..-6 lufs) gains the mix to that loudness (-14 streaming, -16 podcast, -23 ebu r128, -24 atsc), `peak_limit` (-9..0 dbtp) keeps the true peak under it (-1 with a target). target alone: limit -1. limit alone: the limit only. neither: off (never the dialog's saved choice). out of range: `loudness_target must be between -36 and -6 lufs, got -40` (and the same for `peak_limit`). either one with a format without sound or with `audio: false`: `loudness needs a format with sound`.
  errors, each names the fix: transparent with an mp4 (`transparent needs format webm or png: an mp4 cannot hold a see-through picture`) or gif, jpg, wav, ogg (`transparent needs format webm or png: a ${container} cannot be see-through`); h264 / h265 with webm (`a webm holds vp9 or av1: codec ${codec} needs format mp4`); another codec than vp9 with a transparent webm (`a transparent webm is always vp9: leave codec out or give vp9`); `give both width and height, or neither`; `width and height are 16 to 8192 pixels`; `bitrate_mbps is 0.5 to 240`; `key_seconds is one of 0.5, 1, 2, 4, 5, 10`; `audio_kbps is one of 128, 160, 192, 256, 320`; `sample_rate is 44100 or 48000`; aac with webm / ogg (`a ${container} holds opus sound: audio_codec aac needs format mp4`).
  notes (in the answer): an argument a format has no use for is named and ignored (`${names} do not apply to a ${container} and were ignored`), sound arguments with no sound in the file (`${names} were ignored: the file has no sound`), a preset made for mp4 with another format (`the preset is made for mp4, format ${container} was kept and the preset's size and sound were used where they fit`), and what the delivery had to settle (the resolve notes).
  `range` 'inout' exports in point to out point: not with start / end, a png / jpg takes the frame at the in point.
  starts the export and answers at once. one export at a time. `png` / `jpg` save one picture (the project size times `scale`, not capped like `render_frame`, or `width` x `height`): the frame at `start` (default the
  first frame). `end`, `fps` and `audio` do not apply there (the answer notes what was ignored), `quality` only squeezes a jpg. a started export adds `delivery` (the set fields, named like the arguments) and the notes, and the width and height it will really make. `check` starts no job and answers { check: true, format, width, height, frames, fps, codec (label or null), bitrate, estimate_bytes, codecs: { h264, h265, av1, vp9 } (mp4 and webm: 'ok, graphics card' | 'ok, processor' | the reason), audio: { codec, kbps, sample_rate } or null, notes, alpha_notes }; it is allowed while an export runs, and then adds `an export is running, this is what the next one would make`.
- `export_status` {}: running (phase, progress 0..1; the phase is 'loudness' while the sound is measured for a target), done (file name, and the full path added by the shell), failed (why) or none. the warnings of a done export carry the notes about the see-through background (what a format could not keep). when there was a loudness choice, done adds `loudness` { integrated_lufs, true_peak_dbtp, range_lu, gain_db, limited_db, limited_share, target_lufs, peak_limit_dbtp, before: { integrated_lufs, true_peak_dbtp, range_lu } } (the numbers of the file, `before` of the mix as it was); nothing to measure gives null, with the note 'null means nothing to measure'.
  when the shell could not save the file on its own, the app shows its usual save dialog instead and the answer says no path is known.
- `export_cancel` {}: too late once the file is being saved.

cursors (tools/cursor.ts):
- `point_at` { clip?, track?, time?, x?, y?, note? }: moves your cursor to a clip, a track, a time on the ruler or a spot on the canvas (`x` and `y` together, project pixels) and shows `note` (up to 120 characters) in a bubble. exactly one kind of target; none or more than one is an error, an unknown id is an error like in the other tools. changes nothing in the project (no undo step), read only. the answer says what it points at, and says plainly when the user has cursors switched off (not an error).

## cursors

while a client works, ncut draws a mouse cursor with a name tag over the window and flies it to the thing each tool call touches. it is for the user: it shows what the agent is doing. it never changes the project, never takes a click and costs no undo step.

what the user sees:
- an arrow in one of 8 colors, a tag with the name and under it what the tool does ("moves a clip"). the cursor flies (about 350 ms) to the clip, track, time on the ruler, spot on the canvas, media card, inspector, preview, top bar button (undo, redo, export) or project card the call touches. a tool that makes something (add_text, add_track, add_media_clip, duplicate_clips ...) moves on to what it made when it is done. a tool that removes its target (delete_clips, remove_track, remove_marker, delete_project, remove_media) points at it before it is gone. a pure lookup (get_state, list_options, get_project) only changes the label, the cursor stays where it was.
- a call that finished makes a ring grow around the arrow. a call that failed shows "failed" in the tag and a red square instead of the ring.
- the cursor stays on its target while the user scrolls, zooms or resizes. a target that is scrolled out of the timeline is shown at the edge of the timeline; the user's scroll and zoom are never changed by a cursor. a target that can not be found (no editor open) leaves the cursor where it was; a cursor that never had a spot starts at the top middle of the window.
- it fades and goes 12 seconds after its last activity (30 seconds when it shows a `point_at` note). a note stays through your next calls and goes 30 seconds after it was set.
- with `prefers-reduced-motion` the cursor still flies (where it goes is the point of it) but does not pulse.

the `cursor` argument (every tool, optional):
- a string, trimmed, 1 to 24 characters: letters, digits, space, dot, dash, underscore. nothing else.
- missing = the name `agent`. several clients (or subagents) pass different names and each has its own cursor, all visible at the same time. pass the same name on every call.
- anything else (not a string, empty, too long, other characters) is an error result that says what a name may be, and the tool is not run.
- main (electron/mcp.cjs) relays it like any argument and never looks at it; the page takes it off in `callTool`.
- the tool list (`tools/list`) adds the property to every tool's input schema, in one place (`listTools`). the tool definitions do not have it.

limits:
- at most 8 cursors (the shell lets 8 calls wait at once). a 9th name takes the place of the cursor that was idle the longest (one that is working is only replaced when all of them work).
- a color is picked when the cursor appears (the lowest of the 8 not in use) and kept while it lives.

the switch:
- "show cursors" in the mcp settings (the settings, from the editor or the projects screen), on by default. it is kept in localStorage under `ncut.mcpCursors` as json (`{"show":false}`); bad json or no storage = on.
- off: nothing is tracked, cursors that are there go at once, `point_at` still answers (and says nothing is drawn).

where it lives: `src/mcp/cursor.ts` (name rules, one target rule + label per tool; a test fails for a tool without a rule), `src/store/mcpCursors.ts` (the cursors, idle sweep, the switch), `src/features/mcp/` (the layer, `locate.ts` turns a target into a point on the screen). the layer is in the page at z-index 150, `aria-hidden`, `pointer-events: none`. frames and timers only run while at least one cursor exists.
