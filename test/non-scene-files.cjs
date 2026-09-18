/*
 * `.json` is one of this app's file types, so ⌘O and Finder hand over any JSON.
 * A file that is not a drawing must open as an error tab, must not be written
 * to, and must not take the rest of the restored session with it.
 */
const fs = require("node:fs");
const {
  check, report, fail, sleep, element, scene, countIn,
  workspace, stub, start, onDialog,
} = require("./support.cjs");

const ws = workspace("non-scene-files");
const PACKAGE_JSON = JSON.stringify({ name: "my-project", version: "1.2.3" }, null, 2);

const drawings = {
  // Valid: a plain scene, one as .excalidraw.json, one with no "type" field,
  // and an empty file.
  ok: ws.drawing("ok.excalidraw", [element("ok1")]),
  sceneish: ws.drawing("sceneish.excalidraw.json", [element("s1")]),
  notype: ws.write("notype.excalidraw.json", JSON.stringify({ elements: [element("n1")], appState: {} })),
  blank: ws.write("blank.excalidraw", ""),
  // Not drawings: a package.json, a literal null, a bare array.
  package: ws.write("package.json", PACKAGE_JSON),
  nullish: ws.write("nullish.json", "null"),
  array: ws.write("array.json", "[1, 2, 3]"),
};
// The failing one is first: it used to abort the whole batch.
ws.session({
  open: [drawings.nullish, drawings.ok, drawings.package, drawings.sceneish,
    drawings.array, drawings.notype, drawings.blank],
  active: drawings.ok,
});

stub();

start(ws).then(async (ui) => {
  try {
    onDialog(() => null);
    const names = await ui.waitTabs(7);
    check("every file in the session opened as a tab", !!names, (await ui.tabs()).map((t) => t.name));

    for (const label of ["package", "nullish", "array"]) {
      const found = await ui.select(label);
      const notice = found ? await ui.notice() : null;
      const canvas = found ? await ui.hasCanvas() : null;
      check(`[${label}] opens as an error tab, not a canvas`,
        found && !!notice && !canvas, { found, notice: notice?.slice(0, 60), canvas });
    }

    await ui.select("package");
    await ui.menu("save");
    check("⌘S left package.json untouched",
      fs.readFileSync(drawings.package, "utf8") === PACKAGE_JSON);

    for (const label of ["ok", "sceneish", "notype", "blank"]) {
      await ui.select(label);
      check(`[${label}] opens on the canvas`, (await ui.hasCanvas()) && !(await ui.notice()));
    }

    check("the saved session still lists every file", ws.state().openPaths.length === 7,
      ws.state().openPaths.length);

    await ui.select("ok");
    await ui.draw();
    await ui.menu("save");
    check("a real drawing still saves", countIn(drawings.ok) === 2, countIn(drawings.ok));
  } catch (err) {
    fail(err);
  }
  report();
});
