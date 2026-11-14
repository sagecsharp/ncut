# auto update (desktop app)

the desktop app keeps itself up to date: it asks github now and then whether a newer release is out, downloads the file that fits how ncut is installed, checks it, and installs it when ncut closes. it is **on by default** and exists only in the exe (a browser tab always loads the current page anyway). main does all of it (`electron/update.cjs`, pure rules in `electron/updateRules.cjs`, and for the portable exe the helper `electron/swap.cs`), the page only shows the state and sends booleans.

## for the user

- what you see: whether a new version is out or downloading, "restart now" when one is ready, a "check now" button, the switch "update automatically", and (for the plain folder build) a link to the releases page. it is the section "updates" in the settings (the appearance dialog on the projects screen and the project settings in the editor), and a toast says once when a version is ready.
- a new version is downloaded in the background while you work. it installs when you close ncut. "restart now" does the same at once and starts the new version. if an export is running ncut asks first, like every close; "keep working" cancels the restart.
- nothing opens a dialog on its own. a failed check or download only shows a short reason in the update line, and the next try comes later (an hour after a failure).
- switch it off: turn "update automatically" off. then ncut never asks github on its own, never downloads on its own and never installs on close. "check now" still works when you press it, and "restart now" still applies an update that is already downloaded.

## kinds

what the app is decides how an update is applied (`decideKind`, electron/updateRules.cjs):

- `installed`: set up with the setup exe. detected by the file `Uninstall ncut.exe` next to the running exe (the name electron-builder gives the uninstaller for productName ncut: `UNINSTALL_FILENAME` in nsis `common.nsh:17`, written by `include/installer.nsh:100`). updates run the setup exe silently. this is asked first: environment variables are inherited by child processes, so an installed ncut that was started by a program carrying a `PORTABLE_EXECUTABLE_FILE` must not take that other exe for itself. a portable run never has an uninstaller next to its (temp folder) exe, so nothing is lost by asking this first.
- `portable`: the one file exe. detected by the environment variable `PORTABLE_EXECUTABLE_FILE` that the portable starter sets (`portable.nsi:78`), when no uninstaller sits next to the running exe and the value is an absolute windows path to an existing plain `.exe` without `" < > | ? * ` or control characters. updates swap that file in place, which needs the helper `ncut-swap.exe` in the app's `resources` folder: a build without it is a `manual` one.
- `manual`: a packaged app that is neither (the unpacked folder). it checks like the others but never downloads: it only says that a new version is out and offers the releases page.
- `none`: not packaged (dev) or not windows. no updater at all, the page shows nothing.

## what it asks github, and when

- one request: `GET https://api.github.com/repos/sagecsharp/ncut/releases/latest` with exactly two headers, `Accept: application/vnd.github+json` and `User-Agent: ncut-updater/<version>`. no cookies, no token, no account, nothing about you, your machine or your projects. github sees an ip address and the version of ncut, like any http client.
- when (only with auto on): 15 s after the start, then every 6 hours while ncut runs, but never more often than once an hour counting the `checkedAt` of `update.json` (starting ncut ten times in a row asks github once). a failed check is tried again after an hour. nothing is asked on its own while an update is already ready.
- "check now" asks at once, whatever the hour rule says, also with auto off. never while a check or download runs (it answers with the state, no second request), and never again within 10 s of the end of the last one (a page that asks in a loop gets the state back, github's limit for one address is small). it also works while an update is ready: the same version is not downloaded again, a newer one replaces the ready one, and a failed check or a failed newer download leaves the ready one ready.
- a download asks `github.com` for the asset and follows github's redirect to its file host, nothing else (see below).

## what is trusted, and why

the exe files are **not code signed**. the only proof that a download is the real one is that it came from github over https and that its sha256 is the one github's own api names for that asset. that is the whole trust story, so every part is checked:

- https only, tls certificate checks as node does them (minimum tls 1.2). no credentials in an address, no port but 443.
- hosts: the api call goes to `api.github.com` and to exactly the releases address of this repository (no redirect is followed there). the first hop of a download goes to `github.com` below `/sagecsharp/ncut/releases/download/`. a redirect of the download may go to `github.com` or to a host that ends in `.githubusercontent.com` (today `release-assets.githubusercontent.com`, earlier `objects.githubusercontent.com`). lookalikes (`githubusercontent.com.evil.example`, `xgithubusercontent.com`, `github.com@evil.example`, http, other ports) are refused. every hop is checked again; at most 5 redirects.
- the release answer is read as untrusted json (`readRelease`): the tag is exactly `v` + a version (three numbers), draft and prerelease are false, the asset is the one named exactly `ncut-<version>-setup.exe` (installed) or `ncut-<version>-portable.exe` (portable), its size is a safe integer from 1 MiB to 1 GiB, its `digest` is exactly `sha256:` + 64 lowercase hex (no digest = refused, never installed unverified), its address is exactly `https://github.com/sagecsharp/ncut/releases/download/v<version>/<name>`, and when the release text has a `<hash>  <file name>` line for that file it says the same hash (the release text ends with a `## sha256` block). only a line whose first word is exactly 64 hex characters and whose rest is exactly that file name counts, every other line is prose and is ignored; lines over 512 characters are skipped and the text is walked without a backtracking pattern, so a hostile release text costs nothing. a release that is not newer than the running version is "not newer" whatever else it holds: never a downgrade, never the same version.
- the api answer is capped at 1 MiB, has to be status 200 and json (403 / 429 = rate limited, shown as such). 20 s for the api call.
- the download goes to `<userData>/updates/<asset name>.part`. while it streams: the bytes are counted (more than announced = abort at once), a content-length that differs from the announced size is refused, the sha256 is computed, and a download that gets no byte for 30 s dies. at the end the size must be exactly the announced size and the hash exactly the announced hash. only then the file is renamed to its real name and written into `update.json`. any failure deletes the `.part` file. a download that fails its size or hash checks is remembered (version, hash and size, in memory): the same bytes are not fetched again on their own for 24 hours, the hourly api question still happens and says so; the user's "check now" and a release that names other bytes or a newer version fetch at once.
- at the next start a "ready" entry is only believed when its version is still newer than the running one, its file is directly inside `<userData>/updates` with exactly the name this kind downloads for that version, and the file's size and sha256 are checked again (hashed in the background, so the start is not delayed). anything else in `updates/` is deleted. an entry that points outside the folder is ignored and its file is never touched.
- right before it is used, the file is hashed once more: it sat in a folder the user can write. the setup exe is hashed by ncut while it closes: not what it was = deleted, dropped from `update.json`, nothing applied; not done within about 2 seconds = nothing applied (the file stays for the next try). the portable exe is hashed by the helper, after ncut has closed (so closing never waits for it): not what it was = nothing is changed, and the next start of ncut finds the bad file with its own check and deletes it.

what this does not protect against: a program that already runs as you can change `update.json` and the files in `userData` as well as the app itself. the checks keep a damaged or half written download, a wrong server and a mistaken release from being installed.

## applying

it happens when ncut really ends, never earlier (see "the order at quit"), in two cases: the user pressed restart (apply and start the new version), or ncut is closing normally while an update is ready and auto is on (apply, do not start it).

installed: the setup exe is started detached with exactly `--updated /S` (and `--force-run` for a restart), no shell, `stdio` ignored, `windowsHide`, `cwd` = the updates folder, then unref'd. what those flags do in electron-builder 26.18's nsis scripts for an installer built with `oneClick: false`, `perMachine: false`:

- `updated` and `force-run` are flags the generated script defines (`NsisTarget.js:688`, `nsisScriptGenerator.js:29-38`: `isUpdated` / `isForceRun` test the command line for `--updated` / `--force-run`).
- `/S` is nsis' silent switch. with `--updated` the directory page is skipped (`common.nsh:110-120`) and the install folder is the one registered by the earlier install (`multiUser.nsh:21-28`, read from `InstallLocation`).
- `--updated` makes the installer wait for the app to exit: it sleeps 300 ms, and when ncut still runs it sleeps another second and then stops it (`allowOnlyOneInstallerInstance.nsh:105-130`). ncut applies at will-quit, when its window is already gone, so this is a safety net only.
- `--force-run` starts the app afterwards when the install was silent (`installSection.nsh:105-109`, the non one click branch), through the start menu link, with `--updated` as its argument (`common.nsh:123-130`; ncut ignores flags it does not know).
- this installer asks for no rights (`installer.nsi:22-27`, `RequestExecutionLevel user`), so starting it from node works. when the earlier install was per machine, the silent update elevates itself (`installer.nsi:101-106`) and windows shows its elevation question. a limit that stays: the file is hashed through an open handle but started by its path, and a per machine setup relaunches itself elevated by path; a program running as the same user could swap the file in that short time (the file sits in a folder that user can write), and then the elevation question would be for that other file. that is the same power that can change ncut itself, and the unsigned exe has nothing that would show the difference.
- the update is handed over once: `ready` goes from `update.json` when the installer process exists, so an installer that fails afterwards (a refused elevation) is not run again at every close; the next check downloads again. a setup exe that could not be started at all (no process: removed by a virus scanner, no right to run it) is not counted as applied: the entry stays ready, the state says `failed`, and a restart brings the old ncut back.

portable: the file the user started keeps its name (shortcuts and the taskbar pin point at it). ncut can not swap its own exe: the portable exe is a starter (an nsis self extractor) that unpacks the app into a temp folder and waits for it (`portable.nsi:86`), and as long as it runs windows refuses to rename or replace its file (tried with a real build: `EBUSY`, reading the file works). so the swap is done by a small helper, `ncut-swap.exe` (`electron/swap.cs`, built like `ncut-qos.exe` by `scripts/build-qos.cjs`, shipped in `resources`), once ncut has closed:

1. while it closes, ncut tries to create a file next to the exe (`<file>.check`, deleted at once): a folder that can not be written (a read only stick, program files) is found here, nothing is started and the error says so.
2. ncut copies the helper from its `resources` folder to `<userData>/updates/ncut-swap.exe` (the app's own folder is deleted when the starter ends, a helper running from there would be in the way) and starts it detached, no shell, with exactly: the downloaded exe, the portable exe, the sha256, the size, `start` or `quiet`, and for a restart the `--user-data-dir=...` argument ncut itself was started with, if any (`swapArgs`, `carriedArgs`). ncut hashes nothing here and is gone right after.
3. the helper checks its arguments again (full paths to `.exe` files, 64 hex, a size), then the download: exactly that size and that sha256, else it changes nothing.
4. it copies the download to `<file>.new` and reads the copy back from the disk and hashes it again.
5. it waits until `<file>` can be renamed, which is the moment the old starter has ended (it tries every 250 ms, for two minutes at most), renames it to `<file>.old` and `<file>.new` to `<file>`. if the second rename fails the old file is put back. the real name never holds half an exe.
6. it deletes `<file>.old` and the download, and for `start` starts the new exe (with the one argument, and without the `PORTABLE_EXECUTABLE_*` variables of the old starter).
7. it writes one number to `<userData>/updates/swap.log`: 0 = done, 1 = swapped but the new exe did not start, 3 = the exe was not at its place, 4 = the download was not the checked one, 5 = `<file>.new` could not be written, 6 = the copy did not read back right, 7 = the exe stayed in use for two minutes, 8 = another helper was already at it, 10 = the new file could not take its place and the old one was put back, 2 = wrong arguments (then nothing is written). the next start of ncut reads it, writes a failure to its log and deletes it.

- the helper takes nothing but those arguments, asks nobody and shows no window. one helper per exe at a time (a named mutex).
- the `ready` entry stays in `update.json` when the helper is started: the new version drops it at its first start (its version is not newer than itself), and when the swap did not happen the old version finds the download still there and verified, says ready again, and the next close tries again.
- ncut started again before the helper got the file (within a second or two of closing): the starter holds the exe again, the helper gives up after two minutes and removes `<file>.new`, the update stays ready. a close while that helper still waits starts no second one ("an earlier update step is still running").
- on its start the app deletes a leftover `<file>.old` (that exact name, only a plain file) and a `<file>.new` that is older than 15 minutes (a younger one may belong to a helper that still waits).
- the portable starter unpacks into a temp folder named per build (`NsisTarget.js:353-355`, a ksuid), so the old and the new version never share one, and the old starter deletes only its own (`portable.nsi:86-90`).
- why a helper exe and not a script: a child that node starts without `detached` dies with the app (libuv puts it into a job), and a detached one has no console, in which `powershell.exe` runs nothing. a small windows program has neither problem. tried on a real build: restart pressed in 0.1.9, 7 seconds later the same file was the released 0.2.0 exe (same sha256) and running; a normal close swapped it without starting it.
- when "restart now" could not hand the update over (folder not writable, helper not started), main starts the old exe again (`app.relaunch`, with the same `--user-data-dir`), so the app does not just vanish.

## the order at quit

electron: the window closes (`close` is cancelled, the page autosaves, the busy question is asked, then `destroy()`) -> `closed` -> `window-all-closed` -> `app.quit()` -> `before-quit` -> `will-quit` -> `quit`. `before-quit` does not touch the updater: a quit can still be called off after it (an export is running, the user answers "keep working"), and an updater that was stopped there would stay dead. the apply step and the stop of the updater (`dispose()`: timers, a running request) both sit in `will-quit`: it comes once, when every window is gone and nothing in ncut can stop the quit, so they run exactly once and only when the app really ends. it first releases the single instance lock (`app.releaseSingleInstanceLock()`), so the new version does not find the old one holding it and quit, then calls `applyAtQuit({ restart })`, then stops the updater. the apply step is synchronous and short: the hash of the setup exe is bounded (about 2 s), the portable exe only gets its helper started, so quitting is never held up longer. a windows shutdown or log off does not send `before-quit` / `will-quit`: then nothing is applied and it happens at a later close.

restart: the page calls `restart()`; main sets "restart wanted" and closes the window the normal way (`win.close()`), so autosave and the question "an export is running, close anyway?" still happen. "keep working" clears the mark. the new version is then started by the installer (`--force-run`) or by the helper (`start`).

## ipc (preload: `window.ncutShell.update`)

every handler goes through main's `trustedWindow` check like the other channels. the page sends nothing but a boolean: never an address, a path or a version, and it never gets a path.

page -> main, invoke:
- `ncut:update-state` () -> UpdateState
- `ncut:update-auto` (on: boolean) -> UpdateState. anything but `true` is false.
- `ncut:update-check` () -> UpdateState right after a check started (a check or download that runs is not started twice)
- `ncut:update-restart` () -> boolean. false when nothing is ready (or this kind cannot apply).
- `ncut:update-open` () -> boolean. opens `https://github.com/sagecsharp/ncut/releases/latest` in the browser. the address is fixed in main.

main -> page: `ncut:update-changed` (UpdateState).

```
UpdateState {
  kind: 'installed' | 'portable' | 'manual' | 'none'
  auto: boolean                // default true
  phase: 'idle' | 'checking' | 'downloading' | 'ready' | 'failed'
  current: string              // the running version
  latest: string | null        // the newest version github has, as far as known
  progress: number             // 0..1 while downloading, else 0
  error: string | null         // short lowercase sentence, never a path or an address
  checkedAt: number | null     // ms since epoch of the last check that finished, fine or failed
}
```

main cleans the state before it leaves (`cleanUpdateState`), preload cleans it again (the same version rule, written out in `preload.cjs` because a sandboxed preload can not require our files; a test loads the real preload source against a fake electron), the page cleans it a third time. progress is sent at most 4 times a second.

## files in userData

- `update.json`: `{ auto, checkedAt, ready: { version, file, sha256, size } | null }`. written atomically (temp file, rename). a broken file means the defaults (auto on).
- `updates/`: `<asset name>.part` while a download runs, `<asset name>` when it is verified and ready, `ncut-swap.exe` and `swap.log` after a portable update was handed over. at every start everything in it but the ready file is deleted.
- next to the portable exe: `<file>.check` for a moment while ncut closes, `<file>.new` and `<file>.old` while the helper swaps, as above.

## when things fail

- no network, a rate limit, a bad answer, a wrong hash, a short or too big file, a stalled download: phase `failed` with a short reason, the `.part` file is deleted, the next try is an hour later (a download that failed its checks is not fetched again on its own for 24 hours, see above). nothing is shown as a dialog. while an update is ready a failed check or newer download only goes to the log: the ready one stays ready.
- a download that was running when ncut closed is stopped and its `.part` deleted.
- a file that changed between download and apply is deleted and not run.
- an update that could not be applied (folder not writable, no room, file in use, installer or helper not started, a helper that gave up) stays ready and is tried again at the next close; at a restart that could not be handed over the old file is started again. the reason is in the state of that moment and in the log, but the app is closing then, so nobody reads it: the user only sees that the version did not change.

## known limits

- apply budget (installed only): hashing the setup exe must finish in about 2 s while ncut closes, or nothing is applied and the file stays for the next close. on a very slow disk this repeats at every close, and "restart now" has the same budget. the start of ncut hashes the ready file in the background, which warms the disk cache for the next close. the portable exe has no such budget: its helper works after ncut is gone.
- a portable swap that fails after ncut has closed (the helper gave up, no room for `<file>.new`) is only seen at the next start, in the log: the page just says ready again.
- not run for real yet: the installed kind (the silent setup exe, `--force-run`). its flags are read from the nsis scripts, the portable and the manual kind were run for real.
- installed and portable ncut that run on one windows account share `userData` (same app name), so one `update.json` and one `updates/` folder: the one that starts deletes the other's ready download and downloads its own again. only bandwidth is lost.

## tests

`electron/updateRules.test.mjs` (every refusal of the release reader, the url rules, the state cleaning, the kind decision) and `electron/update.test.mjs` (the updater against a fake network, a fake clock and real files in a temp folder: the checks and their timing, redirects, size and hash, the start clean up, the apply step for both kinds with injected failures) and `electron/swap.test.mjs` (the real helper: compiled from `swap.cs` with the c# compiler of windows and run against files in a temp folder; skipped where there is no such compiler). nothing in the tests touches the network or starts an installer.
