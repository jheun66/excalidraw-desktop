/*
 * Drawing while a save is still writing: an image re-export runs for a while,
 * and the strokes made in the meantime are genuinely unsaved.
 */
const {
  check, report, fail, sleep, element, countIn,
  workspace, stub, start, dialogs, onDialog,
} = require("./support.cjs");

const WRITE_MS = 2000;

const ws = workspace("save-during-edit");
const drawing = ws.drawing("drawing.excalidraw", [element("a1")]);
ws.session({ open: [drawing] });

stub({ slowWrite: (file) => (file.includes(".excalidraw") ? WRITE_MS : 0) });

start(ws).then(async (ui) => {
  try {
    onDialog(() => null);
    const marker = () => ui.js("!!document.querySelector('.exd-tab .exd-mark-dirty')");

    await ui.draw();
    check("the first stroke shows as unsaved", (await marker()) === true);

    await ui.menu("save", 120);
    await ui.draw({ offset: 120, settle: 400 }); // still inside the write
    const duringWrite = await marker();
    await sleep(WRITE_MS + 600);
    const afterWrite = await marker();

    check("the file kept the snapshot the save started from", countIn(drawing) === 2, countIn(drawing));
    check("the stroke made during the write is still unsaved", afterWrite === true, { duringWrite, afterWrite });
    check("the macOS edited dot is still set", ui.win.isDocumentEdited() === true);

    dialogs.length = 0;
    await ui.win.close();
    await sleep(1200);
    check("closing still asks about it", dialogs.some((m) => /unsaved changes/.test(m)), dialogs);
    check("Cancel keeps the window", !ui.win.isDestroyed());

    await ui.menu("save", WRITE_MS + 1500);
    check("a second save writes that stroke", countIn(drawing) === 3, countIn(drawing));
    check("nothing is left unsaved", (await marker()) === false);
  } catch (err) {
    fail(err);
  }
  report();
});
