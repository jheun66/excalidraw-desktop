# End-to-end tests

These boot the real `electron/main.cjs` against the built `dist/` and drive the
app the way a person would: clicking tabs, dragging on the canvas, answering the
close prompt. What they protect is the thing the app exists for — the drawing on
disk — so most of them assert about a file, not about the UI.

```bash
npm run build:renderer     # the tests run against dist/
npm run test:e2e           # all suites, about 8 minutes
npm run test:e2e -- closing security
```

**They need a real screen.** Windows open, move and take focus while they run,
so they are for running locally before a release, not in CI. macOS only.

Each test writes to `test/.work/<name>/` and nowhere else: the app's userData is
pointed there too, so a run never touches your real drawings or session.

| Suite | What breaks if it fails |
|---|---|
| `dirty-state` | Edits look saved after a tab switch or rename and get dropped |
| `closing` | A failed save still closes the tab or window, and the edit is gone |
| `save-during-edit` | Strokes made during a slow save are marked as saved |
| `non-scene-files` | A `package.json` opens as a canvas and ⌘S overwrites it |
| `file-operations` | Renaming refuses `Flow` → `flow`; ⌘N empties an open drawing |
| `concurrent-writes` | Overlapping saves interleave, or report a failure for a good write |
| `image-round-trip` | A 2× PNG comes back at 1×, transparent gains a background, dark turns light |
| `library-install` | The library window makes the app fetch `file://` or an intranet URL |
| `reload-guard` | ⌘R silently discards every unsaved drawing |
| `security` | A link in a drawing reaches `window.api`, which reads and writes any file |
| `startup-open` | A double-clicked file loses the active tab, or opens twice |

## Writing one

`support.cjs` holds the scaffolding: a workspace, the Electron stubs (packaged
mode, canned dialogs, slow or delayed file I/O), and the `ui` helpers that click
tabs and draw. A test reads:

```js
const ws = workspace("my-test");
const file = ws.drawing("a.excalidraw", [element("a1")]);
ws.session({ open: [file] });
stub();

start(ws).then(async (ui) => {
  await ui.draw();
  check("drawing marks the file unsaved", await ui.waitDirty("a"));
  report();
});
```

Wait for state, never sample it: the unsaved marker lands 250ms after an edit,
and longer on a busy machine. `ui.waitDirty()` and `waitFor()` exist for that —
a test that samples once will pass on your machine and fail on a slower one.

The fixtures in `fixtures/` are real Excalidraw exports (2×, dark, transparent).
Regenerate them with `node tools/make-fixtures.cjs` while `npx vite` is running.
