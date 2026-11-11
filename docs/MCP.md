# mcp server (desktop app)

the desktop app can run a small [model context protocol](https://modelcontextprotocol.io) server, so an mcp client
(claude code, claude desktop, anything that speaks mcp) can work in the open editor window: open or make a project,
import media, add clips / text / shapes / effects / cameras, set transforms and keyframes, put clips on the sides
of a solid, look at a frame, export. it is **off by default** and exists only in the exe (a browser tab has no way
to listen on a port).

## for the user

- turn it on: project settings (or the appearance button on the projects screen) -> "mcp server".
- claude code: press "copy claude code command" and run it in a terminal. it looks like
  `claude mcp add --transport http ncut http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"`.
- other http clients: "copy http config" (url + the Authorization header).
- clients that only do stdio: "copy stdio config". it runs `node <userData>/mcp-bridge.cjs`, a small script the app
  writes next to its settings. it needs node on the path. the token is not in that config, the script reads it.
- "new token" makes every old config stop working.
- ncut has to be running, with the server on. tools act on the project that is open in the window, and every
  edit is a normal undo step.

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
  mp3 wav ogg oga m4a aac flac opus weba aiff aif, png jpg jpeg gif webp bmp avif svg).
- `import_project` `{ path: string }`: one `.ncut` file.

a path has to be absolute with a drive letter (`C:\...` or `C:/...`). no unc (`\\server\share`), no device paths
(`\\?\`, `\\.\`), no nul. it has to be a plain file. at most 1 GiB per call and 1 GiB for all calls together (counted from the file sizes until the call settles; above it a tool result with isError says other imports are still being read). a bad path -> a tool result with
`isError` naming the path and the reason; the page is not asked.

### files a tool makes (main saves them)

`export_video` gets a `ticket` (the call's id) with its call. when the file is ready the page calls
`shell.mcp.save(ticket)` and then starts a normal download named `ncut-mcp-<ticket>-<file name>`
(`mcpDownloadName` in src/lib/shell.ts). main's download handler sees the marker: an armed ticket -> the file goes to
the save folder (the last folder the user saved to, else Downloads) under `<file name>` (cleaned like every download,
never over an existing file: ` (2)`, ` (3)` ... are added), no dialog. only the extensions export_video makes are
saved this way (mp4 webm gif wav ogg, any case): anything else is cancelled and the invoke resolves not ok. the invoke resolves with `{ ok, name }` when the
download ended. a marked download without an armed ticket is cancelled. a ticket works once, is only given to
`export_video`, and lapses after 12 hours; at most 8 are open (a full map drops the oldest unarmed ticket first, an armed one only when there is none). a ticket whose call ended in an error before it was armed is dropped at once. main remembers the full path per ticket so a later
`export_status` answer with `saved: <ticket>` gets the path added.

## the tools (src/mcp/**)

`src/mcp/types.ts` (ToolDef), `validate.ts` (arguments against the schema, unknown fields are errors), `helpers.ts`
(ok / fail / ToolError / needProject / needClip / oneStep ...), `registry.ts` (TOOLS, listTools, callTool),
`dispatch.ts` (startMcp: tool calls run one at a time in the order they came, the tool list is answered at once,
a call that waited or ran past 170 s is answered as failed). in a dev build `window.__ncut.mcp` has
`listTools` and `callTool` for trying tools without the exe.

rules for every tool:
- times are timeline seconds unless a field says otherwise (at most 86400, a day). sizes and positions are project pixels. x 0 / y 0 is the middle of the canvas.
- a value outside its range, a made up id (blend mode, transition, motion, clip) or an object of the wrong shape is refused with the reason, never clamped or stored as it came. a nested object may be given in part: it is laid over what the clip has.
- a tool that changes the project makes exactly one undo step (helpers `oneStep`).
- nothing is done silently: a refused edit (locked track, unknown id, a value that changed nothing) is an error result that says why and what to call instead.
- answers are compact json text. ids are the app's own ids (`get_project` lists them).
- tools never open dialogs and never show toasts for their own errors.

project and view (tools/project.ts):
- `get_state` {}: app version, the open project (id, name, size, fps, duration, counts) or null, playhead time, selected ids, save state, whether an export runs, how many undo / redo steps.
- `list_projects` {}: the stored projects, newest first.
- `open_project` { id }: the project that is already open is not opened again (the answer says so, the undo history stays).
- `create_project` { name?, preset?: '16:9' | '9:16' | '1:1' | '4:3' | '4:5' | '21:9', width?, height?, fps? }: makes and opens it.
- `close_project` {}: back to the projects screen (saved first).
- `update_project` { name?, width?, height?, fps?, background? }
- `get_project` {}: tracks top to bottom (id, kind, name, muted / hidden / locked), every clip as a short line (helpers `clipBrief`), media (id, name, kind, duration, size), markers, duration.
- `get_clip` { id }: the whole clip as stored, plus `animatable` (prop, label, min, max, unit) and, for a solid, its side names.
- `select_clips` { ids }, `seek` { time }, `undo` { steps? }, `redo` { steps? }
- `add_track` { kind: 'video' | 'audio', index?, name? }, `update_track` { id, name?, muted?, hidden?, locked? }, `remove_track` { id } (takes its clips with it; a locked track is refused)
- `add_marker` { time, name? }, `remove_marker` { id }

choices (tools/catalog.ts):
- `list_options` { kind, category? }: `effects` (id, name, category, params with min / max / default / options), `transitions`, `text_presets`,
  `shape_presets`, `shapes` (2d kinds, 3d shapes and the side names of each), `motions` (clip in / out / loop, text in / out / loop),
  `fonts`, `enums` (blend modes, mask shapes, eases, look at, fits, canvas presets, fps), `fields` (what `update_clip` takes per clip type, with units and ranges).

media (tools/media.ts):
- `import_media` { paths }: adds the files to the open project's media. answers the new media and, for every file that was skipped, its name and why.
- `import_project` { path }: adds a .ncut file as a new project. answers its id (not opened).
- `add_media_clip` { asset, track?, start? }: a clip of that media on the timeline.
- `replace_media` { id, asset }: the clip shows other media of the same kind.

new clips (tools/add.ts):
- `add_text` { text?, preset?, track?, start?, duration?, fields? }
- `add_shape` { preset?, kind?, shape3d?, track?, start?, duration?, fields? }
- `add_effect` { effect, track?, start?, duration?, target?, amount?, params? }
- `add_camera` { track?, start?, duration?, fields? }
`fields` is the same thing `update_clip` takes as `patch`, applied in the same undo step. when the clip could not go where it was asked
(the spot was taken) the answer has a `note` that says where it went.

edits (tools/edit.ts):
- `update_clip` { id, patch }: any stored field of the clip (tools/editCheck.ts knows what each may hold). `transform` is a partial transform, an effect's
  `params` are checked against the effect and its ranges, `speed` re-times the clip. `start`, `duration`, `trimStart`, the track, `keyframes`, the sides,
  the media (`assetId`), the group and the effect id are refused with the name of the tool that does it. a property that has keyframes is refused too
  (the keys decide its value). the answer lists the fields that changed; a patch that changes nothing is an error.
- `set_sides` { id, sides }: what a 3d solid shows per side: `{ "front": { "clip": id, "fit"?: 'fill' | 'fit' | 'stretch' }, "top": { "color": "#rrggbb" }, "all": ..., "back": null }`.
  null = that side shows the solid's own picture again. the names come from `get_clip` / `list_options shapes`; a shape with one side (sphere, ring, capsule)
  takes `all`. a clip that shows this solid on one of its own sides is refused as a source (two solids would hide each other).
- `move_clip` { id, start?, track? }, `trim_clip` { id, edge: 'start' | 'end', time }
- `split_clips` { time, ids? }, `delete_clips` { ids, ripple? }, `duplicate_clips` { ids, same_time? }
- `group_clips` { ids }, `ungroup_clips` { ids }

keyframes (tools/keys.ts):
- `set_keyframe` { id, prop, time, value?, ease? } (time on the timeline)
- `remove_keyframe` { id, prop, time }
- `set_keyframes` { id, keyframes }: the whole record at once, `{ prop: [{ t, v, ease? }] }` with t in seconds from the clip's start.
- `clear_keyframes` { id, prop? }

output (tools/output.ts):
- `render_frame` { time?, max_size? }: the picture of the project at that time as a png image (longest side at most max_size, default 960, at most 1920).
  a time at or past the end gives the last frame. fonts that could not be loaded are named in the answer.
- `export_video` { format?: 'mp4' | 'webm' | 'gif' | 'wav' | 'ogg', quality?: 'low' | 'medium' | 'high', scale?: 1 | 0.75 | 0.5, fps?, start?, end?, audio?, name? }:
  starts the export and answers at once. one export at a time.
- `export_status` {}: running (phase, progress 0..1), done (file name, and the full path added by the shell), failed (why) or none.
  when the shell could not save the file on its own, the app shows its usual save dialog instead and the answer says no path is known.
- `export_cancel` {}: too late once the file is being saved.
