# Development notes

How the app is put together, and the pitfalls that shaped it. For what the app does and how to
install it, see the [README](../README.md).

## Getting started

```bash
npm install
npm run dev          # Vite dev server + Electron
npm run typecheck    # tsc --noEmit
npm run dist         # .dmg for Apple Silicon, in release/
npm run dist:intel   # .dmg for Intel
```

## Layout

```
electron/main.cjs      main process — window, menu, file IPC, OS file association (open-file)
electron/preload.cjs   exposes window.api through contextBridge
src/main.tsx           renderer entry; import order matters (see File System Access API)
src/App.tsx            state, saving, switching files
src/Sidebar.tsx        drawing tabs on the left
src/formats.ts         which file formats are recognised, display names
src/signature.ts       content signature (decides whether a file changed)
src/normalize.ts       fixes bound-text ordering
src/fsa-shim.ts        removes the File System Access API before Excalidraw loads
src/asset-path.ts      points Excalidraw at the bundled fonts
src/debug.ts           load timeline log
src/types.ts           OpenFile and the window.api contract
src/styles.css         app chrome tokens + tab styles
vite.config.mts        renderer bundle config, font copying
```

## Security

The preload gives the main window `window.api`, which can read, write, rename, and trash any path
the user can. Everything below exists to keep that API out of reach of anything but the app's own
page.

- **The main window never navigates after its initial load.** `will-navigate` is always cancelled,
  and `will-redirect` is allowed only back to the app's own URL. The preload runs on whatever
  document the window holds, so a page it navigated to would get `window.api`. Excalidraw opens
  links it considers "local" in the same window, and on `file://` `location.origin` is `"file://"`
  — so any link merely *containing* that string used to qualify.
- **Hyperlinks go through `onLinkOpen`.** Element links (`?element=`) scroll within the canvas.
  Everything else is sent to the `link:open` IPC, which hands only `http:`, `https:`, and `mailto:`
  to the OS. Both `setWindowOpenHandler`s use the same filter: `file:` URLs and custom schemes can
  launch programs.
- **Every IPC channel is registered through `handleIpc` / `onIpc`**, which drop messages that do not
  come from the app's top-level document (`isAppUrl`: the dev server origin in development,
  `dist/index.html` in a build). Never register a channel on `ipcMain` directly.
- The main window runs with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`.
- The library window is matched by exact origin (a prefix check would also accept
  `https://libraries.excalidraw.com.evil`), runs in its own session, and has no preload.

## Saving and change detection

- **Saving**: nothing is written until you press ⌘S. Closing a tab or the window with unsaved files
  asks first.
- **A failed save never closes anything.** `save()` resolves false only when the write failed, and
  the error has already been shown. ⌘W → Save keeps the tab open in that case. For the window, the
  main process tracks `closeState` (`idle` → `asking` → `saving` → `closing`). "Save and Close" only
  closes once the renderer reports that every save succeeded (`save-all:done` with `true`);
  otherwise it drops back to `idle` so the next close asks again. `closeState` is reset for each new
  window (a window reopened from the Dock must ask too), on every page load, and when the renderer
  process dies, so a renderer that can no longer answer never leaves the window stuck in `saving`.
- **A save never declares the file clean.** The signature is taken before the write, and a PNG/SVG
  re-export can run for hundreds of milliseconds, so strokes made in the meantime are genuinely
  unsaved. `save()` therefore sets the baseline to what it wrote and calls `evaluateDirty()`, rather
  than forcing `dirty: false` over whatever happened during the write.
- **Anything that can lose work asks `isDirty()`, never the `dirty` flag.** The flag is only
  refreshed DIRTY_CHECK_MS after an edit, so a stroke followed straight away by ⌘Q would look clean.
  Closing the window therefore asks the renderer for a fresh count over `dirty:query` /
  `dirty:reply` (falling back to the last reported `dirtyCount` if it cannot answer), and `saveAll`
  writes any file that `isDirty()` reports, flag or not. The flag stays what the sidebar marker and
  the macOS edited-dot are drawn from.
- **A built app has no Reload.** Unsaved drawings live only in the renderer, so ⌘R would drop them
  all; `reload` / `forceReload` are in the View menu only in development, and `toggleDevTools` only
  when `DEBUG` (development, or `EXD_DEBUG=1` in a build). Any unload that still happens — ⌘R in
  development, or anything else navigating the page — is caught by a `beforeunload` handler in the
  renderer that cancels while anything is unsaved; the main process turns that into a real prompt in
  `will-prevent-unload` (where `preventDefault()` confusingly means "go ahead and unload"). A close
  that has already been through its own prompt (`closeState === "closing"`) is waved through, or the
  guard would block the window from ever closing.
- **⌘Q resumes after the prompt.** Cancelling a quit to ask about unsaved work leaves `app.quit()`
  abandoned, so `before-quit` sets a `quitting` flag and the window's `closed` handler calls
  `app.quit()` again. Cancelling the prompt, or a failed save, clears the flag — otherwise the next
  ordinary window close would quit the app.
- **Change detection** (`signature.ts`): two kinds of fields are left out of the signature.

  1. **Bookkeeping** — `version`, `versionNonce`, `updated`. `getSceneVersion` also counts the
     internal version bumps Excalidraw makes while restoring a scene, so relying on it alone makes
     an untouched file read as "changed" the moment it opens.
  2. **Derived geometry** — the size of text boxes (computed from content + font metrics), the
     position of text bound to a shape, and **the path of bound arrows**. These values change when
     fonts load or bindings are recalculated, and crucially **undo does not restore the original
     numbers.** Move a shape and undo, and the shape goes back where it was while the arrow settles
     on freshly computed values. With these in the signature, a file moved once and undone would be
     "unsaved" forever.

  `boundElements` is an unordered set, so it is sorted before comparing.

  The version comparison is only a cheap filter up front; the real signature is computed once,
  250ms after changes stop. That keeps the cost flat even while dragging.

  > The price of leaving out derived geometry is that an edit which only drags an arrow's midpoint
  > while keeping its bindings may be missed by the marker. That is why **⌘S always writes,
  > regardless of the dirty state.** The signature can make the marker quieter, but it can never
  > block a save.
- **Deleted elements (tombstones) excluded**: `onChange` hands over deleted elements too — Excalidraw
  keeps them in the array so undo and collaboration can bring them back. Left in, they would be
  written into the user's file, and the scene would stay "changed" forever. (Double-click the canvas
  to start editing text, press Esc without typing, and the discarded empty text stays behind as a
  tombstone — an unsaved marker that not even undo clears.) So `isDeleted` elements are filtered out
  of the array `onChange` provides before it is used for the cache, the signature, or saving.
  Excalidraw's own app persists `getNonDeletedElements()` for the same reason.
- **Safe writes**: the file is written to a temp file and swapped in with `rename`, so if the app
  dies mid-save the original is not truncated. The temp name carries a `randomUUID()`, and every
  write goes through `queueWrite`, which runs one write at a time per path (drawings, `state.json`
  and `library.json` alike). Saves overlap easily — ⌘S during a slow PNG export, Save All on top of
  a manual save — and two writes sharing one temp file would interleave their bytes; the loser's
  `rename` then fails with ENOENT and reports a save failure for a file that was written, or lands
  on top of the winner. A failed write also removes its temp file rather than leaving it next to the
  drawing. The renderer keeps its own guard: one save runs per path with at most one waiting behind
  it, and ⌘S ignores auto-repeat, so holding the key cannot queue a save every few milliseconds.
- **Switching files**: each file gets its own Excalidraw instance (`key={path}`). Switching
  unmounts it, so the latest scene is cached in memory and restored when you come back.
- **Re-baselining happens once per open, not once per mount.** The first `onChange` after a file
  is read from disk re-takes its baseline (so Excalidraw's load-time repairs don't count as edits)
  and runs the empty-scene guard below. A remount — tab switch, ⌘1–9, rename — restores from the
  in-memory cache, which may hold **unsaved** edits. Re-baselining there would quietly mark those
  edits as saved: ⌘W would close without asking and Save All would skip the file. The guard would
  also flag a drawing you emptied on purpose as broken. `pendingBaseline` tracks which files still
  owe their first-load pass; `excalidrawAPI` fires on every mount, so `mountedAt` is only used for
  the timing log.
- **Automatic repair of broken files**: Excalidraw requires text bound to a shape to come right
  after its container in the element array. For a file where that order is off, index validation
  throws during scene restore and **the canvas comes up empty**. Saving in that state would turn the
  original into an empty file, so `normalizeBoundText` fixes the order when the file is read (it only
  moves elements — nothing is added, removed, or modified — and the disk is untouched until you
  save).
- **Empty-scene guard**: if the scene still comes up empty when the file is opened (N elements on
  disk, 0 on screen), saving is blocked for that file entirely and a notice is shown. The original
  is never overwritten. The on-disk count is updated after every save, so a drawing saved empty
  reopens normally, and `forget()` clears the broken mark with the tab — otherwise a file repaired
  in another app would still refuse to load until the next restart.
- **New drawings never land on an open file.** ⌘N writes an empty scene to the chosen path, so
  `dialog:new` is handed the paths that are open and refuses one of them: the tab would otherwise
  keep showing the old drawing, marked saved, and closing it would lose it. When the `.excalidraw`
  extension has to be appended, the file is created with `flag: "wx"` as well — the save dialog
  asked about replacing the name the user typed, not the one with the extension on it.
- **Case-only renames work.** `Flow` → `flow` is the same file on a case-insensitive disk, so the
  "already exists" check (`samePath`) has to skip it or every such rename is refused.
- **Session restore**: the list of open files is saved to
  `~/Library/Application Support/Excalidraw Desktop/state.json` and comes back on the next launch. Files that
  were deleted or moved in the meantime are dropped automatically.

## File formats

| Extension | Contents | Saving |
|---|---|---|
| `.excalidraw` | scene JSON | rewritten as is |
| `.excalidraw.json` | scene JSON | rewritten as is |
| `.excalidraw.png` | PNG with an embedded scene | re-exported as PNG |
| `.excalidraw.svg` | SVG with an embedded scene | re-exported as SVG |

The image formats are what Excalidraw's **Embed scene** export produces. They can be dropped in
anywhere an image can, while the scene JSON lives in a PNG metadata chunk / an SVG `<metadata>`
element. On read, `loadFromBlob` pulls it out; on save, it is written back through `exportToBlob` /
`exportToSvg` with `exportEmbedScene: true` — **the format never changes.**

**Export settings are measured off the file, not read from the scene** (`src/export-settings.ts`).
Excalidraw marks `exportScale`, `exportBackground` and `exportWithDarkMode` as `export: false`, so
they are never part of the embedded scene — a reopened file carries defaults only. Re-exporting from
those defaults rewrote the image on every save: a 2× drawing came back at 1× (and `exportToBlob`
ignores `exportScale` altogether unless `getDimensions` is passed), a transparent one gained a
background, a dark one turned light.

So the settings are recovered when the file is opened:

- An SVG states them: scale is `width` ÷ `viewBox` width, dark mode is the `filter` on the root, and
  the background is a rect covering the whole canvas.
- A PNG is measured: its pixel width against the width the scene would export at 1× (bounds from
  `getCommonBounds` plus Excalidraw's export padding of 10) gives the scale, which is snapped to
  1/2/3 when close. The corner pixels — always inside the padding — give the background, and how far
  they sit from the scene's own `viewBackgroundColor` gives light versus dark.

They are then passed back to the exporter on save. The image is still rendered afresh, so the pixels
may not be identical to the original. Known limitation: dark mode cannot be recovered from a PNG
exported *without* a background, since there is no background pixel to compare.

Opening a plain PNG/SVG exported without Embed scene leaves nothing to edit, so a notice is shown
and saving is blocked for that file.

**A `.json` file is only treated as a drawing if it looks like one** (`isSceneJSON`: an object with
`type: "excalidraw"`, or with an `elements` array). `.json` is one of this app's file types, so ⌘O
and Finder's Open With will hand over any JSON — a `package.json` used to open as an empty canvas,
and one ⌘S replaced it with an empty scene. Anything else now opens as an error tab, and a tab with
no scene is never written to.

**Opening files is per file, not per batch.** Each path in `openPaths` is loaded inside its own
try/catch, and a failure becomes an error tab. One malformed file used to throw out of the whole
loop, which on startup left the window empty and then persisted that empty list over the restored
session. For the same reason, `hydrated` is only set once the restore actually finishes: if it
fails, nothing is persisted for the rest of the session, so the saved list survives.

### macOS file association

`.excalidraw` registers this app as the **default app (Owner)**. But as far as Launch Services is
concerned, the extension of `foo.excalidraw.png` is just `png`. Claiming Owner for that would make
**every PNG on the Mac open in this app**, so it does not. Instead `png` / `svg` / `json` are
declared as **Alternate**, which puts the app under right-click → **Open With**.

While the app is running, macOS delivers further double-clicks to it as `open-file`. A second
launch from the command line is caught by the single-instance lock and its paths are forwarded
through `second-instance`. Either way every drawing lands in the same window. Paths that arrive
before the renderer is listening are queued until it sends `renderer:ready`.

**A path handed over during startup waits for the session restore.** Registering `onOpenPath` is
what sends `renderer:ready`, so the queue used to drain straight into `openPaths` while the restore
was still reading files: the restore then finished and its `setActivePath` replaced the file the
user had just double-clicked. Those paths are buffered until the restore is done (successful or
not) and opened last, so they win the active tab.

**`openedPaths` decides what is already open, not `files`.** `files` is state and lags a render
behind, so two overlapping opens of one path — exactly what the startup case produced — both saw it
as new and it ended up in two tabs sharing one React key. The ref is updated the moment a file
starts loading, and moves with `remapPath` / `forget` like every other per-path map.

### Renaming and deleting

- **The extension is preserved.** Renaming `flow.excalidraw.png` to `diagram` gives
  `diagram.excalidraw.png`. The extension chain is never touched.
- **Existing names are refused.** Nothing is overwritten; a notice is shown instead.
- **Deleting only ever goes to the Trash** (`shell.trashItem`). A mis-click has to be recoverable.
  It asks for confirmation once, then closes the tab after moving the file. The file is already
  gone at that point, so it does not ask whether to save.
- The path is the key of every state map, so a rename moves `baseline`, `sceneCache`,
  `lastSeenVersion`, `loadedCount`, and the rest along with it (`remapPath`). Miss one and that file
  stays "unsaved" forever or keeps writing to the old path.

The display name drops the extension chain, so `flow.excalidraw` and `flow.excalidraw.png` can both
show up as "flow". That is why a hint goes on the second line only when names collide — the file
name if the file names differ, or the folder path if even the file names match (different folders).

## File System Access API (important)

Electron exposes `showOpenFilePicker` / `showSaveFilePicker` / `showDirectoryPicker` on `window`,
but **calling one never settles** — no dialog, no exception. Excalidraw uses them through
`browser-fs-access`, and that library picks its implementation with
`"showOpenFilePicker" in self` **at module load time** and caches the choice.
The result is that every button routed through it (the library panel's Open and Save to…, the main
menu's Open, image import) silently does nothing.

`src/fsa-shim.ts` **deletes** those three properties so the feature detection fails. The classic
`<input type="file">` / download path is used instead, and that works in Electron.
It has to run before the detection, so it is the **first import** in `src/main.tsx` — do not
reorder it.

Since "Save to…" now goes through a download, the main process asks where to save it in
`will-download` instead of silently dropping it into the default downloads folder.

Excalidraw itself binds ⌘S to "save to disk" (an export), so the renderer intercepts ⌘S in the
capture phase on `window` and turns it into a save to the original file.

## Libraries

Excalidraw's **Browse libraries** button opens libraries.excalidraw.com with `<a target="_blank">`.
Installing works by the site redirecting to `<referrer>#addLibrary=<library URL>`, and once the
page has been sent to the default browser, that redirect has no way of reaching this app. That is
why clicking it seemed to do nothing.

So the library site alone is opened **in a window inside the app**.

1. In `setWindowOpenHandler`, a URL whose origin is exactly the library origin opens a child
   `BrowserWindow` (other links go to the default browser — only `http`, `https`, and `mailto`).
2. That window's `will-navigate` / `will-redirect` are watched; when `addLibrary=` shows up in the
   URL, the navigation is cancelled and only the library URL is extracted.
3. The `.excalidrawlib` is downloaded **in the main process**. Downloading it in the renderer would
   mean opening the page CSP to the library host, which this avoids. Only `https` URLs (or the
   library origin itself) are fetched: the URL comes from a page that can browse anywhere, so
   without that check a site could have the app read `file:///…` or reach a service on the user's
   own network and hand the response back.
4. The content is sent to the renderer, installed with `updateLibrary({ merge: true })`, and the
   window is closed.

The library window uses **its own session (`persist:library`)**. This app's CSP was written on the
assumption that it bundles all of its own code, so forcing it onto someone else's site blocks that
site's scripts, fonts, and API calls and leaves it half-broken. CSP injection is also limited to the
app's own documents (the dev server URL or `file://`). The session is persistent, so sign-ins
survive.

The `ExcalidrawDesktop/0.1.0 Electron/…` tokens are stripped from the User-Agent. Some sites look
at them and limit features or serve a different page. The first token is the app name with its
spaces removed, so the pattern is built from `app.name` rather than hard-coded.

`libraryReturnUrl` is set to `https://excalidraw-desktop.invalid/library-return`. The navigation is
cancelled anyway, so it never needs to load, and it keeps `file://` from going out as the referrer
in production.

The library is shared across the whole app, not per drawing. It is saved to `library.json`
(userData), passed to every tab as `initialData.libraryItems`, and written back through
`onLibraryChange`. The canvas is not mounted until the saved library has been read, because
`initialData` is only read on mount.

The `EXD_LIBRARY_ORIGIN` environment variable changes where the main process routes to (for testing
against a local stub). The button's link itself is baked into the `@excalidraw/excalidraw` package at
build time, so this variable does not change it.

## Fonts (important)

The Excalidraw package's `index.css` declares **only the UI font (Assistant)** with `@font-face`.
The hand-drawn fonts used on the canvas (Excalifont and others) are registered at runtime with

```js
new FontFace("Excalifont", 'url(./fonts/Excalifont/....woff2)')
```

Those are **plain strings** the bundler cannot follow, so left alone the font files never make it
into the build, every request 404s, and the canvas silently falls back to a system serif. No error
is raised either.

So two things are done.

- The `excalidraw-fonts` plugin in `vite.config.mts` serves the installed package's
  `dist/prod/fonts` through middleware during development and copies it to `dist/fonts` at build
  time. The fonts are not committed to the repository. The middleware resolves the request with
  `path.relative` and refuses anything landing outside the fonts directory: a `startsWith` prefix
  check also accepts a sibling such as `<fontsDir>-other/…`, and a stray `%` makes
  `decodeURIComponent` throw.
- `src/asset-path.ts` points `window.EXCALIDRAW_ASSET_PATH` at the directory containing index.html.
  That resolves to `http://localhost:5178/` in development and `file://…/dist/` in a build, so it
  works in both. It has to run before any font is registered, so it is imported at the top of
  `main.tsx`.

The fonts total 14MB, 13MB of which is Xiaolai (CJK). Korean and other CJK text is drawn with it,
so it stays.

## UI chrome

### CSS class names (important)

Every chrome class in this app uses the **`exd-` prefix**. Excalidraw renders its own UI into the
same document, and the root of its library panel is `class="Island sidebar default-sidebar"`.
Back when this app's sidebar used an unprefixed `.sidebar`, every one of its styles — including
`-webkit-app-region: drag` — **also applied to Excalidraw's panel**, and macOS swallows input in a
drag region as a window move. That is why neither clicks nor keys worked in the library tab.
(Electron on Linux does not swallow the input, so it does not reproduce there.)

For the same reason there are no global selectors. `:focus-visible`, `kbd`, and the `*` in
`prefers-reduced-motion` are all scoped to `.exd-` chrome.

> At one point `.exd-canvas-area *` got `no-drag` as a safeguard, and that **caused the window-drag
> bug described in the next section.** It is gone now — keeping to the prefix is enough.

### Window drag regions (careful)

macOS walks the `-webkit-app-region` declarations **in order** and builds the window drag area by
taking the union of `drag` and subtracting `no-drag`. Two things follow from that.

At one point `.exd-canvas-area, .exd-canvas-area * { -webkit-app-region: no-drag }` was added as a
safeguard, and it attached **one no-drag rectangle to every node Excalidraw renders**. That was
207 of them at rest, growing to 359 with a panel open. As a result, after using the app for a bit
the window would no longer move. Now a single dedicated strip is `drag`, and the canvas side has
**zero** declarations.

| | drag | no-drag |
|---|---|---|
| Expanded | `.exd-drag-strip [0,0,236,36]` | none |
| Collapsed | `.exd-drag-strip` (0 wide), `.exd-topbar [0,0,W,38]` | `.exd-glass-btn` |

The count does not change as you use the app. If you ever need to add a new `app-region`
declaration, check **that the count does not grow, and that a later no-drag does not carve into an
earlier drag**.

### Drawing tabs

Each row is a three-column grid: `[status] [name] [close]`. The unsaved marker (●) and the close
button (×) each have their own column, so they never overlap or hide each other. The active tab is
shown as a frosted chip, and the folder path appears on a second line **only when open files share
a name**.

### Glass

The sidebar sits on native macOS vibrancy. The `BrowserWindow` gets `vibrancy: "sidebar"` +
`visualEffectState: "active"`, and the window ground is left fully transparent (`#00000000`) so the
real material AppKit draws shows through. CSS only adds a translucent tint and edge highlights on
top. The drawing canvas must not become translucent, so `.canvas-area` paints itself opaque.

macOS already blurs what is behind the window, so the CSS does **not add another
`backdrop-filter`.** Blurring twice only costs GPU time and makes the tint look hazy. The blur is
applied only on platforms without a native material.

On platforms without vibrancy the glass would composite onto nothing, so the main process reports
this through `app:flags` and the renderer sets `data-vibrancy="off"`, which paints the ground itself
with `--chrome-base` and raises the tint close to opaque to stand in for the effect.

**Sidebar transparency** is chosen under View → Sidebar Transparency: High / Medium / Low. It swaps
two alpha-only tokens, `--glass-a1` / `--glass-a2`, through `data-glass` on `<html>`, so no
component rule is touched. The choice is saved with the session.

| Transparency | Tint alpha (macOS) |
|---|---|
| High | 0.12 / 0.06 |
| Medium | 0.26 / 0.16 |
| Low | 0.46 / 0.36 |

### Hiding the sidebar

⌘B or the panel button in the header hides the sidebar. Once hidden, nothing reserves the
traffic-light corner anymore, so a 38px glass top bar takes over that job and pushes the canvas
down by the same amount. Excalidraw's toolbar never slides under the window buttons. This state is
saved with the session and kept on the next launch.

## Icon

There is a single `build/icon.png` (1024×1024, with alpha). When you run `npm run dist` on macOS,
electron-builder converts it to `.icns` and puts it in the app bundle. To replace it, overwrite the
same path with a 1024×1024 PNG.

The background must be transparent, and the art is sized to take up about 824 of the 1024 canvas
(a 100px margin on every side). That is Apple's grid, so the icon does not look off-size next to
other apps in the Dock. In development there is no bundle and the Dock would show Electron's
default icon, so `app.dock.setIcon()` points it at the same artwork.

## Debugging slow loads

The timeline is printed in the terminal running `npm run dev`. To see it in a built app:

```bash
EXD_DEBUG=1 "/Applications/Excalidraw Desktop.app/Contents/MacOS/Excalidraw Desktop"
```

How to read it — the step where time jumps is the cause.

```
[exd +63ms] restoring session — [...]        restore starts
[exd +64ms] read foo.excalidraw — 1ms        disk read
[exd +65ms] parsed foo — {elements, textElements, fontFamilies, embeddedFiles}
[exd +68ms] mounting canvas foo              Excalidraw mount starts
[exd +102ms] excalidrawAPI ready foo         component ready
[exd +226ms] first onChange foo — {ms:124}   time until the scene finished restoring
[exd +...] fonts.ready — {after, families}   font decoding finished
```

A long gap between `mounting canvas` and `first onChange` points at scene restore (element count,
bindings); a late `fonts.ready` points at font decoding.

## Auto-update (on hold)

Auto-update on macOS **requires code signing**. From the Electron docs: *"Your application must be
signed for automatic updates on macOS. This is a requirement of Squirrel.Mac."*
`electron-updater` relies on the same mechanism, so an unsigned app fails with
`Code signature ... code object is not signed at all`.

This app uses `mac.identity: null` (unsigned), so it cannot work as is. Turning it on would take the
Apple Developer Program ($99/year) + a Developer ID certificate + somewhere to publish updates
(GitHub Releases, etc.) + the macOS `.zip`/`latest-mac.yml` artifacts. That is too much for a
personal tool, so it is on hold.

The bundled Excalidraw version cannot be swapped at runtime in the first place (it is compiled into
the build). Rebuilding with `npm i && npm run dist` is the only route. If wanted, checking the npm
registry and merely **announcing** a new version would work without signing.
